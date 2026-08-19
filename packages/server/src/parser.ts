import {
  parseDocument,
  isMap,
  isScalar,
  isSeq,
  type Document,
  type Node,
  type Pair,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml';
import type {
  Diagnostic,
  IncludeRef,
  Job,
  PipelineModel,
  Range,
  SourceLocation,
} from '@gitlab-ci-preview/shared';
import { RESERVED_TOP_LEVEL } from '@gitlab-ci-preview/shared';
import { REFERENCE_TAG } from './referenceTag.js';

export interface ParsedDocument {
  uri: string;
  text: string;
  doc: Document;
  /** Job entries discovered at the top level (excludes reserved keys). */
  jobEntries: Array<{ name: string; valueNode: Node; keyRange: Range }>;
  stagesNode?: Node;
  includeNode?: Node;
  defaultNode?: Node;
  workflowNode?: Node;
  diagnostics: Diagnostic[];
}

/** Convert a 0-based offset to a Position {line, character}. */
function offsetToPosition(text: string, offset: number): { line: number; character: number } {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, character: offset - lineStart };
}

export function nodeRange(text: string, node: { range?: [number, number, number] | null } | null | undefined): Range {
  const r = node?.range;
  if (!r) return { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
  return {
    start: offsetToPosition(text, r[0]),
    end: offsetToPosition(text, r[1]),
  };
}

export function pairKeyRange(text: string, pair: Pair): Range {
  const key = pair.key as { range?: [number, number, number] | null } | null;
  if (key?.range) {
    return {
      start: offsetToPosition(text, key.range[0]),
      end: offsetToPosition(text, key.range[1]),
    };
  }
  return { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
}

export function parseYaml(uri: string, text: string): ParsedDocument {
  const doc = parseDocument(text, {
    keepSourceTokens: true,
    customTags: [REFERENCE_TAG],
  });
  const diagnostics: Diagnostic[] = doc.errors.map((e) => ({
    uri,
    severity: 'error' as const,
    message: e.message,
    source: 'gitlab-ci',
    range: {
      start: offsetToPosition(text, e.pos[0]),
      end: offsetToPosition(text, e.pos[1]),
    },
  }));

  const jobEntries: ParsedDocument['jobEntries'] = [];
  let stagesNode: Node | undefined;
  let includeNode: Node | undefined;
  let defaultNode: Node | undefined;
  let workflowNode: Node | undefined;

  const root = doc.contents;
  if (isMap(root)) {
    for (const pair of root.items as Pair[]) {
      const key = isScalar(pair.key) ? String(pair.key.value) : String((pair.key as any)?.value ?? '');
      if (!key) continue;
      if (key === 'stages') stagesNode = pair.value as Node;
      else if (key === 'include') includeNode = pair.value as Node;
      else if (key === 'default') defaultNode = pair.value as Node;
      else if (key === 'workflow') workflowNode = pair.value as Node;
      else if (!RESERVED_TOP_LEVEL.has(key)) {
        jobEntries.push({ name: key, valueNode: pair.value as Node, keyRange: pairKeyRange(text, pair) });
      }
    }
  }
  return { uri, text, doc, jobEntries, stagesNode, includeNode, defaultNode, workflowNode, diagnostics };
}

function asStringArray(node: Node | null | undefined): string[] {
  if (!node) return [];
  if (isScalar(node)) return [String(node.value)];
  if (isSeq(node)) {
    return (node.items as Node[]).map((n) => (isScalar(n) ? String(n.value) : '')).filter(Boolean);
  }
  return [];
}

function asStringMap(node: Node | null | undefined): Record<string, string> {
  if (!node || !isMap(node)) return {};
  const out: Record<string, string> = {};
  for (const p of node.items as Pair[]) {
    const k = isScalar(p.key) ? String(p.key.value) : '';
    if (!k) continue;
    if (isScalar(p.value)) out[k] = String(p.value.value);
    else if (isMap(p.value)) {
      const v = (p.value as YAMLMap).get('value');
      if (v !== undefined) out[k] = String(v);
    }
  }
  return out;
}

/**
 * Expand `parallel: matrix: [...]` into an explicit list of variants.
 * Each entry's array-valued keys are cross-producted; scalar values stay fixed.
 * Returns undefined when the node isn't a matrix block.
 */
function extractMatrix(parallelNode: Node | null): Array<Record<string, string>> | undefined {
  if (!parallelNode || !isMap(parallelNode)) return undefined;
  const matrixNode = (parallelNode as YAMLMap).get('matrix', true) as Node | undefined;
  if (!matrixNode || !isSeq(matrixNode)) return undefined;
  const out: Array<Record<string, string>> = [];
  for (const entry of (matrixNode as YAMLSeq).items as Node[]) {
    if (!isMap(entry)) continue;
    const keys: string[] = [];
    const valueSets: string[][] = [];
    for (const p of (entry as YAMLMap).items as Pair[]) {
      const k = isScalar(p.key) ? String(p.key.value) : '';
      if (!k) continue;
      const v = p.value as Node | null;
      if (isSeq(v)) {
        const arr = ((v as YAMLSeq).items as Node[])
          .map((n) => (isScalar(n) ? String(n.value) : ''))
          .filter((s) => s !== '');
        if (arr.length === 0) continue;
        keys.push(k);
        valueSets.push(arr);
      } else if (isScalar(v)) {
        keys.push(k);
        valueSets.push([String(v.value)]);
      }
    }
    if (keys.length === 0) continue;
    const cross = (idx: number, acc: Record<string, string>) => {
      if (idx === keys.length) { out.push({ ...acc }); return; }
      for (const val of valueSets[idx]) {
        acc[keys[idx]] = val;
        cross(idx + 1, acc);
      }
    };
    cross(0, {});
  }
  return out.length ? out : undefined;
}

function extractJob(uri: string, text: string, name: string, valueNode: Node, keyRange: Range): Job | null {
  if (!isMap(valueNode)) return null;
  const map = valueNode as YAMLMap;
  const get = (k: string): Node | null => {
    const p = (map.items as Pair[]).find((p) => (isScalar(p.key) ? String(p.key.value) : '') === k);
    return (p?.value as Node) ?? null;
  };
  const stageNode = get('stage');
  const stage = isScalar(stageNode) ? String(stageNode.value) : 'test';
  const imageNode = get('image');
  const image = isScalar(imageNode) ? String(imageNode.value) : isMap(imageNode) ? String((imageNode as YAMLMap).get('name') ?? '') : undefined;
  const script = asStringArray(get('script'));
  const needsRaw = get('needs');
  const needs: string[] = [];
  if (needsRaw && isSeq(needsRaw)) {
    for (const item of (needsRaw as YAMLSeq).items as Node[]) {
      if (isScalar(item)) needs.push(String(item.value));
      else if (isMap(item)) {
        const job = (item as YAMLMap).get('job');
        if (job) needs.push(String(job));
      }
    }
  }
  const dependencies = asStringArray(get('dependencies'));
  const extendsList = asStringArray(get('extends'));
  const variables = asStringMap(get('variables'));
  const rulesNode = get('rules');
  const rules = rulesNode && isSeq(rulesNode)
    ? ((rulesNode as YAMLSeq).items as Node[]).map((n) => (n as any).toJSON?.() ?? null).filter(Boolean)
    : undefined;
  const tags = asStringArray(get('tags'));
  const whenNode = get('when');
  const when = isScalar(whenNode) ? (String(whenNode.value) as Job['when']) : undefined;
  const allowFailureNode = get('allow_failure');
  const allowFailure = isScalar(allowFailureNode) ? Boolean(allowFailureNode.value) : undefined;
  const parallelNode = get('parallel');
  const parallel = isScalar(parallelNode) && typeof parallelNode.value === 'number' ? parallelNode.value : undefined;
  const matrix = extractMatrix(parallelNode);
  const retryNode = get('retry');
  const retry = isScalar(retryNode) && typeof retryNode.value === 'number'
    ? retryNode.value
    : isMap(retryNode) && typeof (retryNode as YAMLMap).get('max') === 'number'
      ? (retryNode as YAMLMap).get('max') as number
      : undefined;
  const trigger = Boolean(get('trigger'));
  const source: SourceLocation = { uri, range: keyRange };
  return {
    name,
    stage,
    image,
    script,
    needs,
    dependencies,
    extends: extendsList,
    rules,
    variables,
    when,
    allowFailure,
    tags: tags.length ? tags : undefined,
    trigger,
    parallel,
    matrix,
    retry,
    hidden: name.startsWith('.'),
    source,
    raw: (map.toJSON?.() ?? {}) as Record<string, unknown>,
  };
}

export function extractJobs(parsed: ParsedDocument): Job[] {
  const out: Job[] = [];
  for (const entry of parsed.jobEntries) {
    const job = extractJob(parsed.uri, parsed.text, entry.name, entry.valueNode, entry.keyRange);
    if (job) out.push(job);
  }
  return out;
}

export function extractStages(parsed: ParsedDocument): string[] {
  return asStringArray(parsed.stagesNode as Node | undefined);
}

/** Parse the `include:` value into a list of IncludeRef (unresolved). */
export function extractIncludes(parsed: ParsedDocument): IncludeRef[] {
  const node = parsed.includeNode;
  if (!node) return [];
  const out: IncludeRef[] = [];
  const push = (ref: IncludeRef) => out.push(ref);

  const fromScalar = (n: Node): IncludeRef => {
    const raw = isScalar(n) ? String(n.value) : '';
    const looksLikeUrl =
      raw.startsWith('http://') ||
      raw.startsWith('https://') ||
      // host-like prefix (e.g. "gitlab.com/foo/bar.yml") — protocol omitted
      /^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}\//.test(raw);
    const kind = looksLikeUrl ? 'remote' : 'local';
    const normalized = looksLikeUrl && !/^https?:\/\//.test(raw) ? `https://${raw}` : raw;
    return {
      kind,
      raw: normalized,
      resolvedUri: null,
      source: { uri: parsed.uri, range: nodeRange(parsed.text, n as any) },
    };
  };

  const fromMap = (n: YAMLMap): IncludeRef => {
    const get = (k: string) => {
      const p = (n.items as Pair[]).find((p) => (isScalar(p.key) ? String(p.key.value) : '') === k);
      return p?.value as Node | undefined;
    };
    const local = get('local');
    const remote = get('remote');
    const template = get('template');
    const project = get('project');
    const component = get('component');
    const ref = get('ref');
    const file = get('file');
    const inputsNode = get('inputs');
    const inputs = inputsNode && isMap(inputsNode) ? ((inputsNode as YAMLMap).toJSON() as Record<string, unknown>) : undefined;
    const baseSource: SourceLocation = { uri: parsed.uri, range: nodeRange(parsed.text, n as any) };

    if (local) return { kind: 'local', raw: String((local as any).value ?? ''), resolvedUri: null, source: baseSource, inputs };
    if (remote) {
      const rawRemote = String((remote as any).value ?? '');
      const normalized = rawRemote && !/^https?:\/\//.test(rawRemote) ? `https://${rawRemote}` : rawRemote;
      return { kind: 'remote', raw: normalized, resolvedUri: null, source: baseSource, inputs };
    }
    if (template) return { kind: 'template', raw: String((template as any).value ?? ''), resolvedUri: null, source: baseSource, inputs };
    if (component) return { kind: 'component', raw: String((component as any).value ?? ''), resolvedUri: null, source: baseSource, inputs };
    if (project) {
      const projectStr = String((project as any).value ?? '');
      const refStr = ref ? String((ref as any).value ?? '') : 'HEAD';
      let files: string[] = [];
      if (file) files = asStringArray(file);
      const fileStr = files[0] ?? '';
      return {
        kind: 'project',
        raw: `${projectStr}@${refStr}:${fileStr}`,
        resolvedUri: null,
        project: projectStr,
        ref: refStr,
        file: fileStr,
        source: baseSource,
        inputs,
      };
    }
    return { kind: 'local', raw: '', resolvedUri: null, source: baseSource, error: 'unknown include shape' };
  };

  const visit = (n: Node) => {
    if (isScalar(n)) push(fromScalar(n));
    else if (isMap(n)) {
      // Special case: if map has a project key with file: as a list, expand per file.
      const map = n as YAMLMap;
      const projectP = (map.items as Pair[]).find((p) => (isScalar(p.key) ? String(p.key.value) : '') === 'project');
      const fileP = (map.items as Pair[]).find((p) => (isScalar(p.key) ? String(p.key.value) : '') === 'file');
      if (projectP && fileP && isSeq(fileP.value as Node)) {
        const refP = (map.items as Pair[]).find((p) => (isScalar(p.key) ? String(p.key.value) : '') === 'ref');
        const project = String((projectP.value as any).value ?? '');
        const ref = refP ? String((refP.value as any).value ?? '') : 'HEAD';
        for (const f of (fileP.value as YAMLSeq).items as Node[]) {
          const file = isScalar(f) ? String(f.value) : '';
          push({
            kind: 'project',
            raw: `${project}@${ref}:${file}`,
            resolvedUri: null,
            project,
            ref,
            file,
            source: { uri: parsed.uri, range: nodeRange(parsed.text, n as any) },
          });
        }
      } else {
        push(fromMap(map));
      }
    } else if (isSeq(n)) {
      for (const item of (n as YAMLSeq).items as Node[]) visit(item);
    }
  };

  visit(node);
  return out;
}

export function buildBaseModel(uri: string, text: string): PipelineModel {
  const parsed = parseYaml(uri, text);
  const jobs = extractJobs(parsed);
  const stages = extractStages(parsed);
  const includes = extractIncludes(parsed);
  const globalVariables = extractGlobalVariables(parsed);
  const defaults = extractDefaults(parsed);
  const workflow = extractWorkflow(parsed);
  return {
    rootUri: uri,
    stages,
    jobs,
    includes,
    diagnostics: parsed.diagnostics,
    includedSources: {},
    globalVariables,
    defaults,
    workflow,
  };
}

/** Extract the top-level `workflow:` block as a raw object, when present. */
export function extractWorkflow(parsed: ParsedDocument): Record<string, unknown> | undefined {
  const node = parsed.workflowNode;
  if (!node || !isMap(node)) return undefined;
  return ((node as YAMLMap).toJSON?.() ?? {}) as Record<string, unknown>;
}

/** Extract the top-level `default:` block as a raw object (keys applied to every job). */
export function extractDefaults(parsed: ParsedDocument): Record<string, unknown> {
  const node = parsed.defaultNode;
  if (!node || !isMap(node)) return {};
  return ((node as YAMLMap).toJSON?.() ?? {}) as Record<string, unknown>;
}

function extractGlobalVariables(parsed: ParsedDocument): Record<string, string> {
  const root = parsed.doc.contents;
  if (!isMap(root)) return {};
  const varsPair = (root.items as Pair[]).find((p) => (isScalar(p.key) ? String(p.key.value) : '') === 'variables');
  return asStringMap(varsPair?.value as Node | undefined);
}
