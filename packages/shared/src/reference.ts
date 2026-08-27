/**
 * GitLab `!reference[job[.key.path]]` resolution, shared by the LSP server and the webview.
 *
 * References appear in CI files either in GitLab's documented comma form
 * (`!reference [.setup, before_script]`) or the dot/bracket form
 * (`!reference[.setup.before_script]`). Both normalize to a job name plus a
 * key path into that job's merged spec.
 */

import type { Job } from './model.js';

export interface ParsedReference {
  /** Job name as written (leading dot preserved for hidden jobs). */
  jobName: string;
  /** Nested keys into the job's spec (may be empty for a whole-job reference). */
  keyPath: string[];
}

export interface ResolvedReferenceTarget {
  /** The referenced job (matched case-insensitively, tolerating a missing leading dot). */
  job: Job;
  keyPath: string[];
  /** The resolved value, or undefined when unresolved. */
  value: unknown;
  /** True when every key path segment resolved against the job's spec. */
  resolved: boolean;
}

/** GitLab wildcard segment — statically unresolvable. */
export const REFERENCE_WILDCARD = '*';

/**
 * Parse the raw text inside `!reference[ ... ]`.
 * Accepts `job`, `job[key]`, `job[key.subkey]`, and the comma-separated
 * form `.job, key, subkey`. Returns null for empty/invalid input.
 */
export function parseReference(raw: string): ParsedReference | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  // Brackets act as separators: `job[key.sub]` → `job,key.sub`.
  s = s.replace(/\[/g, ',').replace(/\]/g, '');
  // The job name is the first token; a leading dot belongs to hidden job names.
  const m = s.match(/^(\.?[^\s.,]+)\s*(?:[.,]\s*(.+))?$/);
  if (!m) return null;
  const jobName = m[1];
  if (!/[A-Za-z0-9_]/.test(jobName)) return null;
  const keyPath = (m[2] ?? '')
    .split(/[.,]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return { jobName, keyPath };
}

/**
 * Walk `keyPath` through nested plain objects in `spec`.
 * Missing segments (or non-object intermediates) yield `{ found: false }`
 * with the segment that could not be resolved.
 */
export function resolvePath(
  spec: Record<string, unknown>,
  keyPath: string[],
): { value: unknown; found: boolean; failedSegment?: string } {
  let cur: unknown = spec;
  for (const seg of keyPath) {
    if (
      cur == null ||
      typeof cur !== 'object' ||
      Array.isArray(cur) ||
      !(seg in (cur as Record<string, unknown>))
    ) {
      return { value: undefined, found: false, failedSegment: seg };
    }
    cur = (cur as Record<string, unknown>)[seg];
  }
  return { value: cur, found: true };
}

/**
 * The job's effective spec: typed fields fill gaps in the merged raw spec
 * (raw wins where both exist).
 */
function effectiveSpec(job: Job): Record<string, unknown> {
  const typed: Record<string, unknown> = {};
  if (job.stage !== undefined) typed.stage = job.stage;
  if (job.image !== undefined) typed.image = job.image;
  if (job.script !== undefined) typed.script = job.script;
  if (job.needs.length > 0) typed.needs = job.needs;
  if (job.dependencies.length > 0) typed.dependencies = job.dependencies;
  if (job.extends.length > 0) typed.extends = job.extends;
  if (job.rules !== undefined) typed.rules = job.rules;
  if (job.variables !== undefined) typed.variables = job.variables;
  if (job.when !== undefined) typed.when = job.when;
  if (job.allowFailure !== undefined) typed.allowFailure = job.allowFailure;
  if (job.tags !== undefined) typed.tags = job.tags;
  if (job.trigger !== undefined) typed.trigger = job.trigger;
  if (job.parallel !== undefined) typed.parallel = job.parallel;
  if (job.retry !== undefined) typed.retry = job.retry;
  return { ...typed, ...job.raw };
}

/**
 * Resolve a `!reference` raw payload against a set of jobs.
 * Returns null when the input is unparseable or the job is unknown.
 * A `*` wildcard segment short-circuits with `resolved: false`.
 */
export function resolveReference(raw: string, jobs: Iterable<Job>): ResolvedReferenceTarget | null {
  const parsed = parseReference(raw);
  if (!parsed) return null;
  const list = Array.from(jobs);
  const target = parsed.jobName.toLowerCase();
  const dotted = '.' + target.replace(/^\./, '');
  const job =
    list.find((j) => j.name.toLowerCase() === target) ??
    list.find((j) => j.name.toLowerCase() === dotted);
  if (!job) return null;
  if (parsed.keyPath.includes(REFERENCE_WILDCARD)) {
    return { job, keyPath: parsed.keyPath, value: undefined, resolved: false };
  }
  const { value, found } = resolvePath(effectiveSpec(job), parsed.keyPath);
  return { job, keyPath: parsed.keyPath, value, resolved: found };
}
