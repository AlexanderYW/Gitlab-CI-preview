import type { Diagnostic, IncludeRef, Job, PipelineModel } from '@gitlab-ci-preview/shared';
import { DEFAULT_STAGES } from '@gitlab-ci-preview/shared';
import { buildBaseModel, parseYaml } from './parser.js';
import { resolveInclude, isFailure, type ResolveContext } from './includes/index.js';
import { schemaDiagnostics } from './features/schemaValidate.js';
import { applyInputs, extractInputDeclarations } from './includes/inputs.js';
import { validateJobGraph, validateExtendsTemplates, findDuplicateJobs } from './features/validate.js';
import { findUndefinedVariables } from './features/undefinedVars.js';

export interface ResolveOptions extends ResolveContext {
  maxDepth?: number;
}

/**
 * Build a fully-resolved PipelineModel: parse root, recursively fetch includes,
 * detect cycles, merge jobs and stages, propagate `extends` chains.
 */
export async function resolvePipeline(rootUri: string, rootText: string, opts: ResolveOptions): Promise<PipelineModel> {
  const maxDepth = opts.maxDepth ?? 10;
  const visited = new Set<string>([rootUri]);
  const allDiagnostics: Diagnostic[] = [];
  const allIncludes: IncludeRef[] = [];
  const includedSources: Record<string, string> = {};
  const jobsByName = new Map<string, Job>();
  const stages: string[] = [];
  const globalVariables: Record<string, string> = {};
  const defaults: Record<string, unknown> = {};
  let workflow: Record<string, unknown> | undefined;

  async function walk(uri: string, text: string, depth: number, chain: string[]) {
    const model = buildBaseModel(uri, text);
    allDiagnostics.push(...model.diagnostics);
    try {
      const parsed = parseYaml(uri, text);
      allDiagnostics.push(...schemaDiagnostics(uri, text, parsed.doc));
    } catch (e) {
      // Schema validation is best-effort, but log so failures aren't silently lost.
      console.error(`schema validation skipped for ${uri}: ${(e as Error).message}`);
    }
    for (const stage of model.stages) if (!stages.includes(stage)) stages.push(stage);
    // Root is walked first; root vars take precedence — only fill missing keys from includes.
    for (const [k, v] of Object.entries(model.globalVariables)) {
      if (!(k in globalVariables)) globalVariables[k] = v;
    }
    // Same root-wins rule for top-level `default:` keys.
    for (const [k, v] of Object.entries(model.defaults ?? {})) {
      if (!(k in defaults)) defaults[k] = v;
    }
    // `workflow:` is pipeline-level and root wins — keep the first one we see (root walks first).
    if (!workflow && model.workflow) workflow = model.workflow;
    for (const job of model.jobs) {
      // last write wins for same-named jobs (root overrides includes in real GitLab;
      // since root is walked first we'd need precedence — instead, included files
      // do not overwrite previously-set jobs.)
      if (!jobsByName.has(job.name)) jobsByName.set(job.name, job);
    }
    // Two jobs with the same name in one document is an error (cross-file overrides are merge semantics).
    allDiagnostics.push(...findDuplicateJobs(model.jobs));
    for (const inc of model.includes) {
      allIncludes.push(inc);
      if (depth >= maxDepth) {
        allDiagnostics.push({
          uri, range: inc.source.range, severity: 'warning',
          message: `include depth limit (${maxDepth}) exceeded`, source: 'gitlab-ci',
        });
        continue;
      }
      const ctx: ResolveContext = {
        baseUri: uri,
        workspaceFolders: opts.workspaceFolders,
        readOpenDocument: opts.readOpenDocument,
      };
      const res = await resolveInclude(inc, ctx);
      if (isFailure(res)) {
        inc.error = res.error;
        allDiagnostics.push({
          uri, range: inc.source.range, severity: 'error',
          message: `cannot resolve include: ${res.error}`, source: 'gitlab-ci',
        });
        continue;
      }
      if (visited.has(res.uri) || chain.includes(res.uri)) {
        allDiagnostics.push({
          uri, range: inc.source.range, severity: 'error',
          message: `include cycle detected: ${[...chain, res.uri].join(' → ')}`, source: 'gitlab-ci',
        });
        continue;
      }
      visited.add(res.uri);
      // Apply inputs (templates/components with spec.inputs)
      let included = res.text;
      const { decls, bodyText } = extractInputDeclarations(included);
      if (decls.length > 0) {
        const applied = applyInputs(bodyText, decls, inc.inputs ?? {});
        included = applied.text;
        for (const name of applied.missingRequired) {
          allDiagnostics.push({
            uri, range: inc.source.range, severity: 'error',
            message: `include is missing required input "${name}"`, source: 'gitlab-ci',
          });
        }
        for (const name of applied.unknown) {
          allDiagnostics.push({
            uri, range: inc.source.range, severity: 'warning',
            message: `unknown input "${name}" (not declared by ${inc.raw})`, source: 'gitlab-ci',
          });
        }
        for (const { name, reason } of applied.invalid) {
          allDiagnostics.push({
            uri, range: inc.source.range, severity: 'error',
            message: `input "${name}" invalid: ${reason}`, source: 'gitlab-ci',
          });
        }
      }
      includedSources[res.uri] = included;
      await walk(res.uri, included, depth + 1, [...chain, res.uri]);
    }
  }

  await walk(rootUri, rootText, 0, [rootUri]);

  // Apply extends: shallow merge raw, then re-derive fields, repeated for chains.
  applyExtends(jobsByName, allDiagnostics, rootUri);

  // Apply top-level `default:` (lowest precedence — only fills keys a job doesn't set).
  applyDefaults(jobsByName, defaults);

  // Pipeline-graph validations: undeclared stage, needs-later-stage, needs cycles, unknown needs,
  // plus `extends:` targets that aren't pipeline jobs/templates or GitLab built-in templates.
  const effectiveStages = stages.length > 0 ? stages : [...DEFAULT_STAGES];
  allDiagnostics.push(...validateJobGraph(jobsByName, effectiveStages));
  allDiagnostics.push(...validateExtendsTemplates(jobsByName));

  // Resolve child-pipeline trigger includes (local files) so the webview can open them.
  for (const job of jobsByName.values()) {
    const tp = localTriggerPath(job.raw.trigger);
    if (!tp) continue;
    const ref: IncludeRef = { kind: 'local', raw: tp, resolvedUri: null, source: job.source };
    const res = await resolveInclude(ref, {
      baseUri: job.source.uri,
      workspaceFolders: opts.workspaceFolders,
      readOpenDocument: opts.readOpenDocument,
    });
    if (!isFailure(res)) job.triggerIncludeUri = res.uri;
  }

  const result: PipelineModel = {
    rootUri,
    stages: stages.length > 0 ? stages : ['build', 'test', 'deploy'],
    jobs: [...jobsByName.values()],
    includes: allIncludes,
    diagnostics: allDiagnostics,
    includedSources,
    globalVariables,
    defaults,
    workflow,
  };

  // Undefined `$VAR` references across the root document and every resolved include.
  // Pushed after construction — `diagnostics` is the same array by reference.
  allDiagnostics.push(...findUndefinedVariables(result, [
    { uri: rootUri, text: rootText },
    ...Object.entries(includedSources).map(([uri, text]) => ({ uri, text })),
  ]));

  return result;
}

/** Extract the first local include path from a child-pipeline `trigger:` value, if any. */
function localTriggerPath(trigger: unknown): string | null {
  if (!trigger || typeof trigger !== 'object') return null;
  const inc = (trigger as Record<string, unknown>).include;
  if (typeof inc === 'string') return inc;
  if (inc && typeof inc === 'object' && !Array.isArray(inc) && typeof (inc as any).local === 'string') {
    return (inc as any).local;
  }
  if (Array.isArray(inc)) {
    for (const it of inc) {
      if (typeof it === 'string') return it;
      if (it && typeof it === 'object' && typeof (it as any).local === 'string') return (it as any).local;
    }
  }
  return null;
}

/** Coerce an image value (string or { name }) to a display string. */
function imageName(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (v && typeof (v as any).name === 'string') return (v as any).name;
  return undefined;
}

/**
 * Apply top-level `default:` keys to every job. GitLab treats these as the lowest
 * precedence: a job's own keys (including ones inherited via extends) always win,
 * so we only fill keys the job doesn't already have in its raw spec. Hidden
 * template jobs are skipped — defaults only apply to real jobs.
 */
function applyDefaults(jobs: Map<string, Job>, defaults: Record<string, unknown>) {
  if (Object.keys(defaults).length === 0) return;
  for (const job of jobs.values()) {
    if (job.hidden) continue;
    for (const [k, v] of Object.entries(defaults)) {
      if (!(k in job.raw)) job.raw[k] = v;
    }
    // Re-derive the typed fields that `default:` can supply, when the job didn't set them.
    if (job.image === undefined) job.image = imageName(defaults.image);
    if (!job.tags && Array.isArray(defaults.tags)) job.tags = (defaults.tags as unknown[]).map(String);
    if (job.retry === undefined) {
      if (typeof defaults.retry === 'number') job.retry = defaults.retry;
      else if (defaults.retry && typeof (defaults.retry as any).max === 'number') job.retry = (defaults.retry as any).max;
    }
  }
}

function applyExtends(jobs: Map<string, Job>, diags: Diagnostic[], rootUri: string) {
  const memo = new Map<string, Record<string, unknown>>();
  function merged(name: string, seen: Set<string>): Record<string, unknown> {
    if (memo.has(name)) return memo.get(name)!;
    const job = jobs.get(name);
    if (!job) return {};
    if (seen.has(name)) {
      diags.push({
        uri: rootUri, range: job.source.range, severity: 'error',
        message: `extends cycle through "${name}"`, source: 'gitlab-ci',
      });
      return {};
    }
    seen.add(name);
    let acc: Record<string, unknown> = {};
    for (const parent of job.extends) {
      // Unknown targets are reported by validateExtendsTemplates (built-in templates allowed).
      if (!jobs.has(parent)) continue;
      acc = { ...acc, ...merged(parent, new Set(seen)) };
    }
    const final = { ...acc, ...job.raw };
    memo.set(name, final);
    return final;
  }
  for (const [name, job] of jobs) {
    if (job.extends.length === 0) continue;
    const m = merged(name, new Set());
    if (typeof m.stage === 'string') job.stage = m.stage;
    if (typeof m.image === 'string') job.image = m.image;
    else if (m.image && typeof (m.image as any).name === 'string') job.image = (m.image as any).name;
    if (Array.isArray(m.script)) job.script = (m.script as unknown[]).map(String);
    if (typeof m.when === 'string') job.when = m.when as Job['when'];
    if (typeof m.allow_failure === 'boolean') job.allowFailure = m.allow_failure;
    if (Array.isArray(m.rules)) job.rules = m.rules as unknown[];
    if (Array.isArray(m.tags)) job.tags = (m.tags as unknown[]).map(String);
    job.raw = m;
  }
}
