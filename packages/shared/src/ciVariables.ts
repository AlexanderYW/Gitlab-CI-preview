/**
 * GitLab predefined CI/CD variables. Their values aren't known at preview time (they
 * depend on the real project/commit/runner), but recognising them lets us:
 *   - avoid flagging `$CI_*` references as "unresolved" in the effective-variables view, and
 *   - seed sensible defaults into the rules-simulation context.
 *
 * GitLab reserves the `CI_` and `GITLAB_` prefixes for predefined variables and warns users
 * not to define their own with those prefixes, so a prefix test is a robust classifier.
 */
export function isPredefinedCiVar(name: string): boolean {
  return name === 'CI'
    || name.startsWith('CI_')
    || name.startsWith('GITLAB_');
}
