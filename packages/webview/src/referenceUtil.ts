import type { Job, PipelineModel } from '@gitlab-ci-preview/shared';
import { REFERENCE_MARKER, isReferenceMarker } from '@gitlab-ci-preview/shared';

export interface ResolvedReference {
  /** Path as written in the !reference tag (job name first, then nested keys). */
  path: string[];
  /** The resolved value, or undefined if any segment was missing. */
  value: unknown;
  /** The job referenced by the first segment, when found. */
  targetJob: Job | null;
  /** True if every segment of the path resolved. */
  ok: boolean;
  /** A short reason if !ok. */
  error?: string;
}

export function isReference(v: unknown): v is { [REFERENCE_MARKER]: string[] } {
  return isReferenceMarker(v);
}

/**
 * Walk a !reference path against the pipeline model.
 * The first segment is matched against job names (tolerating a missing leading dot).
 * Remaining segments index into the job's raw spec.
 */
export function resolveReference(model: PipelineModel, path: string[]): ResolvedReference {
  if (path.length === 0) return { path, value: undefined, targetJob: null, ok: false, error: 'empty reference' };
  const first = path[0];
  const job = model.jobs.find((j) => j.name === first)
    ?? model.jobs.find((j) => j.name === '.' + first);
  if (!job) return { path, value: undefined, targetJob: null, ok: false, error: `job "${first}" not found` };
  let cur: unknown = job.raw;
  for (let i = 1; i < path.length; i++) {
    const seg = path[i];
    if (cur != null && typeof cur === 'object' && !Array.isArray(cur) && seg in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return { path, value: undefined, targetJob: job, ok: false, error: `key "${seg}" not found on "${job.name}"` };
    }
  }
  return { path, value: cur, targetJob: job, ok: true };
}

/** Human-readable form: `.template › script` */
export function formatReferencePath(path: string[]): string {
  return path.join(' › ');
}
