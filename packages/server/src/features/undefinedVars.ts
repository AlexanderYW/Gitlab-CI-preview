import { isMap, isScalar, isSeq, type Node, type Pair, type YAMLMap, type YAMLSeq } from 'yaml';
import type { Diagnostic, PipelineModel, Range } from '@gitlab-ci-preview/shared';
import { isPredefinedCiVar, REFERENCE_MARKER } from '@gitlab-ci-preview/shared';
import { parseYaml } from '../parser.js';

/** `$VAR` / `${VAR}` reference (the brace is optional and not required to close). */
const VAR_PATTERN = /\${?([A-Za-z_][A-Za-z0-9_]*)(?:})?/g;

export interface SourceDocument {
  uri: string;
  text: string;
}

/**
 * Flag `$VAR` / `${VAR}` references that are neither a predefined CI variable nor defined
 * in the pipeline's global `variables:` or the referencing job's own `variables:` block.
 *
 * Each job scope reports one diagnostic per unique variable at its first occurrence; text
 * outside any job (workflow rules, top-level default, …) is reported per occurrence in the
 * root scope. `!reference[...]` payloads are substituted by GitLab itself, so they're never
 * scanned. Best-effort: documents that fail to parse or nodes without ranges are skipped.
 */
export function findUndefinedVariables(model: PipelineModel, docs: SourceDocument[]): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const globalNames = new Set(Object.keys(model.globalVariables ?? {}));
  for (const doc of docs) {
    try {
      diags.push(...scanDocument(doc, model, globalNames));
    } catch {
      // Never let a malformed document break diagnostics publishing.
    }
  }
  return diags;
}

function scanDocument(doc: SourceDocument, model: PipelineModel, globalNames: Set<string>): Diagnostic[] {
  const parsed = parseYaml(doc.uri, doc.text);
  const diags: Diagnostic[] = [];
  const jobsHere = new Map(
    model.jobs.filter((j) => j.source.uri === doc.uri).map((j) => [j.name, j]),
  );
  const jobEntryNames = new Set(parsed.jobEntries.map((e) => e.name));

  // Job scopes: everything inside a non-hidden job's mapping.
  for (const entry of parsed.jobEntries) {
    const job = jobsHere.get(entry.name);
    if (!job || job.hidden) continue; // hidden templates aren't pipeline jobs — skip entirely
    const defined = new Set([...globalNames, ...Object.keys(job.variables ?? {})]);
    const seen = new Set<string>();
    for (const scalar of collectScalars(entry.valueNode, doc.text)) {
      for (const m of scalar.text.matchAll(VAR_PATTERN)) {
        const name = m[1];
        if (defined.has(name) || isPredefinedCiVar(name) || seen.has(name)) continue;
        seen.add(name);
        diags.push(varDiagnostic(doc, scalar.offset + (m.index ?? 0), m[0].length, name));
      }
    }
  }

  // Root scope: top-level keys that aren't job mappings (variables:, workflow:, default:, …).
  const root = parsed.doc.contents;
  if (isMap(root)) {
    for (const pair of root.items as Pair[]) {
      const key = isScalar(pair.key) ? String(pair.key.value) : '';
      if (!key || jobEntryNames.has(key)) continue;
      for (const scalar of collectScalars(pair.value as Node | undefined, doc.text)) {
        for (const m of scalar.text.matchAll(VAR_PATTERN)) {
          const name = m[1];
          if (globalNames.has(name) || isPredefinedCiVar(name)) continue;
          // Root scope has no dedup — report every occurrence.
          diags.push(varDiagnostic(doc, scalar.offset + (m.index ?? 0), m[0].length, name));
        }
      }
    }
  }
  return diags;
}

function varDiagnostic(doc: SourceDocument, startOffset: number, matchLength: number, name: string): Diagnostic {
  return {
    uri: doc.uri,
    // Cover the whole reference as written: `$VAR` or `${VAR}` (braces included).
    range: offsetRange(doc.text, startOffset, startOffset + matchLength),
    severity: 'warning',
    message: `unknown CI variable "${name}"`,
    source: 'gitlab-ci',
  };
}

interface ScalarHit {
  /** Raw source slice of the scalar (offsets stay valid against the document text). */
  text: string;
  /** Document offset where `text` starts. */
  offset: number;
}

/** Collect every string scalar beneath `node`, descending into maps/seqs but not into `!reference` payloads. */
function collectScalars(node: Node | null | undefined, text: string, out: ScalarHit[] = []): ScalarHit[] {
  if (!node) return out;
  if (isScalar(node)) {
    if (typeof node.value === 'string' && node.range) {
      // Match against the raw source slice (quotes included) so hit offsets are exact.
      out.push({ text: text.slice(node.range[0], node.range[1]), offset: node.range[0] });
    }
    return out;
  }
  if (isMap(node)) {
    for (const p of (node as YAMLMap).items as Pair[]) {
      // `!reference [...]` parses to `{ __gitlabReference: [...] }` — its contents are
      // a path into another job, not variable-bearing script text.
      if (isScalar(p.key) && String(p.key.value) === REFERENCE_MARKER) continue;
      collectScalars(p.value as Node | undefined, text, out);
    }
    return out;
  }
  if (isSeq(node)) {
    for (const item of (node as YAMLSeq).items as Node[]) collectScalars(item, text, out);
  }
  return out;
}

/** Convert a half-open [start, end) offset pair to a Position range. */
function offsetRange(text: string, start: number, end: number): Range {
  return { start: offsetToPosition(text, start), end: offsetToPosition(text, end) };
}

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
