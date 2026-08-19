import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { computeSimFiles, clearSimFilesCache } from '../src/simFiles.js';

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString().trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'simfiles-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.test');
  git(dir, 'config', 'user.name', 'test');
  writeFileSync(join(dir, 'README.md'), '# hi\n');
  writeFileSync(join(dir, 'CI.yml'), 'lint: {script: echo}\n');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

describe('computeSimFiles', () => {
  test('changed = files differing between the merge-base and the ref (branch pipeline)', async () => {
    const repo = makeRepo();
    git(repo, 'checkout', '-qb', 'feature');
    writeFileSync(join(repo, 'src/b.ts'), 'export const b = 2;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'feat');
    writeFileSync(join(repo, 'CI.yml'), 'lint: {script: echo 2}\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'feat ci');

    clearSimFilesCache();
    const res = await computeSimFiles(repo, 'feature', 'push', 'main');
    expect(res.available).toBe(true);
    expect(res.changed).toEqual(expect.arrayContaining(['src/b.ts', 'CI.yml']));
    expect(res.changed).not.toContain('README.md');
    expect(res.changed).not.toContain('src/a.ts');
    expect(res.exists).toContain('README.md');
    expect(res.exists).toContain('src/b.ts');
    expect(res.exists).toContain('CI.yml');
  });

  test('diverged branch: only files changed after the fork point are counted', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'src/onlyMain.ts'), 'x;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'main-only');
    git(repo, 'checkout', '-qb', 'feature', 'HEAD~1');
    writeFileSync(join(repo, 'src/feat.ts'), 'y;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'feat');

    clearSimFilesCache();
    const res = await computeSimFiles(repo, 'feature', 'push', 'main');
    expect(res.available).toBe(true);
    expect(res.changed).toEqual(['src/feat.ts']);
  });

  test('tag source diffs against the tag parent commit', async () => {
    const repo = makeRepo();
    git(repo, 'tag', 'v1.0.0');
    writeFileSync(join(repo, 'CHANGELOG.md'), 'v1.0.1\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'chore');
    git(repo, 'tag', 'v1.0.1');

    clearSimFilesCache();
    const res = await computeSimFiles(repo, 'v1.0.1', 'tag', 'main');
    expect(res.available).toBe(true);
    expect(res.changed).toEqual(['CHANGELOG.md']);
    expect(res.exists).toContain('CHANGELOG.md');
  });

  test('recomputes when the ref points at a new commit, and caches otherwise', async () => {
    const repo = makeRepo();
    git(repo, 'checkout', '-qb', 'feature');
    writeFileSync(join(repo, 'src/f.ts'), '1;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'one');

    clearSimFilesCache();
    const first = await computeSimFiles(repo, 'feature', 'push', 'main');
    expect(first.changed).toEqual(['src/f.ts']);
    const cached = await computeSimFiles(repo, 'feature', 'push', 'main'); // no new commit → cached
    expect(cached).toBe(first);

    writeFileSync(join(repo, 'src/f.ts'), '2;\n');
    writeFileSync(join(repo, 'src/g.ts'), '2;\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'two');
    const fresh = await computeSimFiles(repo, 'feature', 'push', 'main'); // new commit → recomputed
    expect(fresh.changed).toEqual(expect.arrayContaining(['src/f.ts', 'src/g.ts']));
  });

  test('unknown ref → available: false', async () => {
    const repo = makeRepo();
    clearSimFilesCache();
    const res = await computeSimFiles(repo, 'does-not-exist', 'push', 'main');
    expect(res.available).toBe(false);
  });

  test('directory that is not a git repo → available: false', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'simfiles-norepo-'));
    clearSimFilesCache();
    const res = await computeSimFiles(dir, 'main', 'push', 'main');
    expect(res.available).toBe(false);
  });

  test('default branch that does not exist → available: false (no bogus diff)', async () => {
    const repo = makeRepo();
    clearSimFilesCache();
    const res = await computeSimFiles(repo, 'main', 'push', 'no-such-branch');
    expect(res.available).toBe(false);
  });
});
