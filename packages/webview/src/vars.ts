import type { Job, PipelineModel } from '@gitlab-ci-preview/shared';
import { isPredefinedCiVar } from './ciVariables.js';

/** Where an effective variable's value came from, in increasing precedence. */
export type VarSource = 'global' | 'default' | 'job' | 'matrix';

export interface EffectiveVar {
  name: string;
  /** Pre-expansion value as written. */
  raw: string;
  /** Value after `$VAR` / `${VAR}` substitution against the merged scope. */
  value: string;
  /** Highest-precedence layer that set this variable. */
  source: VarSource;
  /** True when `value` still references variables that are neither defined nor predefined. */
  unresolved: boolean;
  /** True when the remaining references are GitLab predefined vars (resolved at runtime). */
  runtime: boolean;
}

const VAR_PATTERN = '\\$\\{?([A-Za-z_][A-Za-z0-9_]*)\\}?';

/** Expand `$VAR` and `${VAR}` from the given scope. Mirrors the server's hover expansion. */
export function expandVars(s: string, scope: Record<string, string>): string {
  return s.replace(new RegExp(VAR_PATTERN, 'g'), (m, name) => (name in scope ? scope[name] : m));
}

/** Names of every `$VAR` / `${VAR}` reference still present in a string. */
function refNames(s: string): string[] {
  return [...s.matchAll(new RegExp(VAR_PATTERN, 'g'))].map((m) => m[1]);
}

/**
 * Repeatedly expand each value against the scope until it stabilises, so a variable that
 * references another variable (which references another…) fully resolves. Capped to avoid
 * spinning on a self/cyclic reference.
 */
function resolveScope(scope: Record<string, string>): Record<string, string> {
  let cur = scope;
  for (let pass = 0; pass < 10; pass++) {
    let changed = false;
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(cur)) {
      const e = expandVars(v, cur);
      if (e !== v) changed = true;
      next[k] = e;
    }
    cur = next;
    if (!changed) break;
  }
  return cur;
}

function defaultVariables(model: PipelineModel): Record<string, string> {
  const d = model.defaults?.variables;
  if (d && typeof d === 'object' && !Array.isArray(d)) {
    return Object.fromEntries(Object.entries(d as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
  }
  return {};
}

/** Union of matrix axis variables across all variants; multiple values are joined with ` | `. */
function matrixVariables(job: Job): Record<string, string> {
  const variants = job.matrix ?? [];
  if (variants.length === 0) return {};
  const byKey = new Map<string, Set<string>>();
  for (const variant of variants) {
    for (const [k, v] of Object.entries(variant)) {
      if (!byKey.has(k)) byKey.set(k, new Set());
      byKey.get(k)!.add(String(v));
    }
  }
  return Object.fromEntries([...byKey].map(([k, set]) => [k, [...set].join(' | ')]));
}

/**
 * Compose the effective variable set for a job in precedence order
 * (global → default → job → matrix), expanding `$VARS` against the merged scope.
 */
export function composeJobVariables(job: Job, model: PipelineModel): EffectiveVar[] {
  const layers: Array<[VarSource, Record<string, string>]> = [
    ['global', model.globalVariables ?? {}],
    ['default', defaultVariables(model)],
    ['job', job.variables ?? {}],
    ['matrix', matrixVariables(job)],
  ];

  // Later layers win; track both the winning raw value and which layer set it.
  const winning = new Map<string, { raw: string; source: VarSource }>();
  for (const [source, vars] of layers) {
    for (const [name, raw] of Object.entries(vars)) {
      winning.set(name, { raw: String(raw), source });
    }
  }

  // Merged scope for expansion (same precedence, values only), resolved to a fixpoint so
  // chains like A=$B, B=$C, C=x fully expand.
  const scope: Record<string, string> = {};
  for (const [, vars] of layers) for (const [k, v] of Object.entries(vars)) scope[k] = String(v);
  const resolved = resolveScope(scope);

  return [...winning.entries()]
    .map(([name, { raw, source }]) => {
      // Matrix values may be a joined set (`a | b`); don't try to expand those.
      const value = source === 'matrix' && raw.includes(' | ') ? raw : expandVars(raw, resolved);
      const remaining = refNames(value);
      // A reference that survives expansion is fine if it's a GitLab predefined var
      // (resolved at runtime); otherwise it's a genuine unresolved/typo'd reference.
      const runtime = remaining.length > 0 && remaining.every(isPredefinedCiVar);
      const unresolved = remaining.some((n) => !isPredefinedCiVar(n));
      return { name, raw, value, source, unresolved, runtime };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
