/**
 * Git helpers for the rules simulation: compute the file lists GitLab's `changes:` and
 * `exists:` conditions evaluate against, entirely locally.
 *
 * Semantics mirror GitLab:
 *   - branch / push pipeline: files changed between the ref and its merge-base with the
 *     default branch (the "what this branch changed" view)
 *   - tag pipeline: files changed against the tag's parent commit
 *   - `exists:`: every path present in the ref's tree
 *
 * No `vscode` dependency, so it is unit-testable; `extension.ts` supplies the repo root
 * (via the git extension) and the default branch.
 */
import { execFile } from 'node:child_process';

export interface SimFiles {
  /** False when the lists are unknown (not a repo, unknown ref, git failure) — stay optimistic. */
  available: boolean;
  /** Repo-relative paths changed on the ref (drives `changes:`). */
  changed?: string[];
  /** Repo-relative paths present in the ref (drives `exists:`). */
  exists?: string[];
}

const TIMEOUT_MS = 8_000;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/** Run a git command, returning trimmed non-empty lines; null on failure. */
async function gitLines(cwd: string, args: string[]): Promise<string[] | null> {
  try {
    const out = await git(cwd, args);
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

interface CacheEntry { commit: string; files: SimFiles }
const cache = new Map<string, CacheEntry>();

export function clearSimFilesCache(): void {
  cache.clear();
}

/**
 * The repo's default branch: the target of `refs/remotes/origin/HEAD` when the remote
 * is configured for it, falling back to 'main'.
 */
export async function detectDefaultBranch(repoRoot: string): Promise<string> {
  const lines = await gitLines(repoRoot, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
  const m = lines?.[0] ? /^refs\/remotes\/[^/]+\/(.+)$/.exec(lines[0]) : null;
  return m ? m[1] : 'main';
}

/**
 * Compute the changed/exists file lists for `ref` in the repo at `repoRoot`.
 * Results are cached per `(repo, ref, source)` and invalidated when the ref points at a
 * different commit, so ref switches in the sim bar are one computation each.
 */
export async function computeSimFiles(
  repoRoot: string,
  ref: string,
  source: string,
  defaultBranch: string,
): Promise<SimFiles> {
  const key = `${repoRoot}|${ref}|${source}|${defaultBranch}`;
  const head = await gitLines(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (head === null || head.length === 0) {
    cache.delete(key);
    return { available: false };
  }
  const commit = head[0];
  const cached = cache.get(key);
  if (cached && cached.commit === commit) return cached.files;

  let baseRef: string;
  if (source === 'tag') {
    const parent = await gitLines(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^`]);
    baseRef = parent?.[0] ?? '';
    if (!baseRef) {
      // Initial commit has no parent — no "changed" baseline exists; stay optimistic.
      cache.delete(key);
      return { available: false };
    }
  } else {
    const mb = await gitLines(repoRoot, ['merge-base', defaultBranch, ref]);
    if (mb === null || mb.length === 0) {
      cache.delete(key);
      return { available: false };
    }
    baseRef = mb[0];
  }

  const changed = await gitLines(repoRoot, ['diff', '--name-only', baseRef, ref]);
  const exists = await gitLines(repoRoot, ['ls-tree', '-r', '--name-only', ref]);
  if (changed === null || exists === null) {
    cache.delete(key);
    return { available: false };
  }
  const files: SimFiles = { available: true, changed, exists };
  cache.set(key, { commit, files });
  return files;
}
