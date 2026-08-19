/**
 * GitLab-style glob matching for `rules:changes:`, `rules:exists:` and the legacy
 * `only:`/`except:` `changes` entries. Patterns are matched against repo-relative
 * POSIX file paths:
 *   - `**` matches across path segments; `**` followed by a slash also matches the root
 *   - `*` matches within a single path segment
 *   - `?` matches exactly one character
 *   - `[abc]` / `[a-z]` character classes
 */

const RX_META = new Set(['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', '\\']);

const reCache = new Map<string, RegExp>();

function globToRegExp(glob: string): RegExp {
  const cached = reCache.get(glob);
  if (cached) return cached;
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 3; }
        else { re += '.*'; i += 2; }
        continue;
      }
      re += '[^/]*';
      i++;
      continue;
    }
    if (c === '?') { re += '[^/]'; i++; continue; }
    if (c === '[') {
      // Character class: copy through the closing bracket (GitLab supports [a-z] style).
      let j = i + 1;
      let cls = '[';
      if (glob[j] === '!') { cls += '^'; j++; }
      while (j < glob.length && glob[j] !== ']') cls += glob[j++];
      if (j >= glob.length) { re += '\\['; i++; continue; } // unclosed — treat literally
      cls += ']';
      re += cls;
      i = j + 1;
      continue;
    }
    re += RX_META.has(c) ? `\\${c}` : c; // escape regex metacharacters
    i++;
  }
  const rx = new RegExp(`^${re}$`);
  reCache.set(glob, rx);
  return rx;
}

export function matchGlob(glob: string, path: string): boolean {
  const clean = path.replace(/^\.\//, '');
  return globToRegExp(glob).test(clean);
}

/** True when `path` matches any of the globs; an empty list never matches. */
export function anyGlobMatches(globs: string[], path: string): boolean {
  return globs.some((g) => matchGlob(g, path));
}
