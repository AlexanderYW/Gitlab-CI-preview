/**
 * Pure conversion of legacy `only:`/`except:` job specs into `rules:`.
 *
 * All `only` entries combine into ONE rule object:
 *  - ref names (plain branch/tag strings) become `($CI_COMMIT_BRANCH == "X" || $CI_COMMIT_TAG == "X")` disjuncts,
 *  - the `changes` keyword / `changes` objects and `variables` objects become `changes` / `variables` rule keys,
 *  - source conditions (the `parent_pipeline` keyword, `events`) become `$CI_PIPELINE_SOURCE == "X"` disjuncts.
 * `except` entries are folded into the same rule's `if` as a negated OR clause
 * (`&& !(...)`), or as the entire `if` when there is no `only`.
 *
 * Known limitation: a bare `changes` keyword inside `except` has no counterpart in
 * rules syntax (there is no "did NOT change" predicate), so it is skipped.
 */

/** True when a job mapping carries a legacy `only` or `except` key. */
export function hasOnlyExcept(spec: Record<string, unknown>): boolean {
  return 'only' in spec || 'except' in spec;
}

/**
 * Convert legacy `only`/`except` values into a `rules:` array of plain JSON rule
 * objects (always exactly one rule — all entries combine into it).
 *
 * Tolerant of malformed input: unknown entry shapes are ignored, and a scalar
 * `only:`/`except:` value (not a list) is treated as a single entry. When neither
 * input yields any condition or rule key the single rule is an empty object.
 */
export function convertOnlyExceptToRules(only: unknown, except: unknown): unknown[] {
  const onlyRefs: string[] = [];
  const onlySources = new Set<string>();
  let changes: unknown;
  let variables: unknown;

  for (const entry of entries(only)) {
    if (typeof entry === 'string' || typeof entry === 'number') {
      const name = String(entry);
      if (name === '') continue;
      if (name === 'changes') {
        // first occurrence wins
        if (changes === undefined) changes = ['**/*'];
      } else if (name === 'parent_pipeline') {
        onlySources.add('trigger');
      } else if (!onlyRefs.includes(name)) {
        onlyRefs.push(name);
      }
    } else if (isPlainObject(entry)) {
      // first occurrence wins for `changes` / `variables`
      if (entry.changes !== undefined && changes === undefined) changes = normalizeChanges(entry.changes);
      if (entry.variables !== undefined && variables === undefined) variables = entry.variables;
      for (const e of asStringList(entry.events)) onlySources.add(e);
      if (entry.parent_pipeline === true) onlySources.add('trigger');
    }
    // anything else (nested lists, null, …): malformed — ignore
  }

  const exceptRefs: string[] = [];
  const exceptSources = new Set<string>();
  for (const entry of entries(except)) {
    if (typeof entry === 'string' || typeof entry === 'number') {
      const name = String(entry);
      if (name === '') continue;
      // LIMITATION: the bare `changes` keyword in `except` is not expressible in rules
      // syntax, so it is skipped (documented in the module comment).
      if (name === 'changes') continue;
      if (name === 'parent_pipeline') exceptSources.add('trigger');
      else if (!exceptRefs.includes(name)) exceptRefs.push(name);
    } else if (isPlainObject(entry)) {
      // only ref/source conditions are representable — `changes`/`variables` in
      // `except` are skipped for the same reason as the bare `changes` keyword.
      for (const e of asStringList(entry.events)) exceptSources.add(e);
      if (entry.parent_pipeline === true) exceptSources.add('trigger');
    }
  }

  // Refs present in both lists cancel each other out: drop them from the positive
  // clause; the negated except clause below still guards against them.
  const effectiveRefs = onlyRefs.filter((r) => !exceptRefs.includes(r));

  const onlyDisjuncts: string[] = [
    ...effectiveRefs.map((r) => `($CI_COMMIT_BRANCH == "${r}" || $CI_COMMIT_TAG == "${r}")`),
    ...[...onlySources].map((s) => `$CI_PIPELINE_SOURCE == "${s}"`),
  ];
  const exceptDisjuncts: string[] = [
    ...exceptRefs.map((r) => `$CI_COMMIT_BRANCH == "${r}" || $CI_COMMIT_TAG == "${r}"`),
    ...[...exceptSources].map((s) => `$CI_PIPELINE_SOURCE == "${s}"`),
  ];

  const rule: Record<string, unknown> = {};
  if (onlyDisjuncts.length > 0 || exceptDisjuncts.length > 0) {
    const parts: string[] = [];
    if (onlyDisjuncts.length > 0) {
      // Parenthesize only when needed: a lone disjunct stands as-is, and with no
      // trailing negation `||` alone is unambiguous — but a `&& !(...)` suffix
      // must not reassociate (GitLab `&&` binds tighter than `||`).
      const positive =
        onlyDisjuncts.length === 1 || exceptDisjuncts.length === 0
          ? onlyDisjuncts.join(' || ')
          : `(${onlyDisjuncts.join(' || ')})`;
      parts.push(positive);
    }
    if (exceptDisjuncts.length > 0) {
      parts.push(`!(${exceptDisjuncts.join(' || ')})`);
    }
    rule.if = parts.join(' && ');
  }
  if (changes !== undefined) rule.changes = changes;
  if (variables !== undefined) rule.variables = variables;
  return [rule];
}

/** Normalize an `only`/`except` value into a list of entries (list, or single scalar/object). */
function entries(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asStringList(v: unknown): string[] {
  if (typeof v === 'string' || typeof v === 'number') return [String(v)];
  if (Array.isArray(v)) {
    return v
      .map((x) => (typeof x === 'string' || typeof x === 'number' ? String(x) : ''))
      .filter((s) => s !== '');
  }
  return [];
}

/** `changes` values are normalized to arrays (`changes: 'src/**'` → `['src/**']`). */
function normalizeChanges(v: unknown): unknown {
  return Array.isArray(v) ? v : [v];
}
