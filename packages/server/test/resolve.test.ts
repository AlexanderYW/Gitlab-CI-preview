import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { URI } from 'vscode-uri';
import { resolvePipeline } from '../src/resolve.js';

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'glci-'));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<string> {
  const full = path.join(tmp, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
  return URI.file(full).toString();
}

describe('resolvePipeline', () => {
  test('merges jobs from local includes', async () => {
    await write('child.yml', `child:\n  stage: test\n  script: [a]\n`);
    const rootUri = await write('.gitlab-ci.yml', `include:\n  - local: child.yml\nroot:\n  stage: build\n  script: [b]\n`);
    const text = await fs.readFile(URI.parse(rootUri).fsPath, 'utf8');
    const model = await resolvePipeline(rootUri, text, { baseUri: rootUri, workspaceFolders: [URI.file(tmp).toString()] });
    const names = model.jobs.map((j) => j.name).sort();
    expect(names).toEqual(['child', 'root']);
  });

  test('detects include cycles', async () => {
    const aUri = await write('a.yml', `include: { local: b.yml }\n`);
    await write('b.yml', `include: { local: a.yml }\nx:\n  script: [hi]\n`);
    const text = await fs.readFile(URI.parse(aUri).fsPath, 'utf8');
    const model = await resolvePipeline(aUri, text, { baseUri: aUri, workspaceFolders: [URI.file(tmp).toString()] });
    expect(model.diagnostics.some((d) => /cycle/.test(d.message))).toBe(true);
  });

  test('flags unresolvable local includes', async () => {
    const rootUri = await write('.gitlab-ci.yml', `include:\n  - local: missing.yml\n`);
    const text = await fs.readFile(URI.parse(rootUri).fsPath, 'utf8');
    const model = await resolvePipeline(rootUri, text, { baseUri: rootUri, workspaceFolders: [URI.file(tmp).toString()] });
    expect(model.diagnostics.some((d) => /cannot resolve include/.test(d.message))).toBe(true);
  });

  test('applies extends chains', async () => {
    const rootUri = await write('.gitlab-ci.yml', `\n.base:\n  image: alpine:3\n  script: [a]\nreal:\n  extends: .base\n  stage: build\n`);
    const text = await fs.readFile(URI.parse(rootUri).fsPath, 'utf8');
    const model = await resolvePipeline(rootUri, text, { baseUri: rootUri, workspaceFolders: [URI.file(tmp).toString()] });
    const real = model.jobs.find((j) => j.name === 'real')!;
    expect(real.image).toBe('alpine:3');
    expect(real.script).toEqual(['a']);
  });

  test('merges top-level default: into jobs that do not override it', async () => {
    const rootUri = await write('.gitlab-ci.yml',
      `default:\n  image: alpine:3.20\n  before_script: [setup]\n  tags: [docker]\n` +
      `inherits:\n  stage: build\n  script: [a]\n` +
      `overrides:\n  stage: test\n  image: node:20\n  script: [b]\n`,
    );
    const text = await fs.readFile(URI.parse(rootUri).fsPath, 'utf8');
    const model = await resolvePipeline(rootUri, text, { baseUri: rootUri, workspaceFolders: [URI.file(tmp).toString()] });
    const inherits = model.jobs.find((j) => j.name === 'inherits')!;
    const overrides = model.jobs.find((j) => j.name === 'overrides')!;
    // Job without its own image/tags inherits the defaults.
    expect(inherits.image).toBe('alpine:3.20');
    expect(inherits.tags).toEqual(['docker']);
    expect(inherits.raw.before_script).toEqual(['setup']);
    // Job that sets image keeps its own; before_script still inherited.
    expect(overrides.image).toBe('node:20');
    expect(overrides.raw.before_script).toEqual(['setup']);
  });

  test('captures the top-level workflow block', async () => {
    const rootUri = await write('.gitlab-ci.yml',
      `workflow:\n  rules:\n    - if: '$CI_COMMIT_BRANCH'\n    - when: never\n` +
      `job:\n  stage: test\n  script: [x]\n`,
    );
    const text = await fs.readFile(URI.parse(rootUri).fsPath, 'utf8');
    const model = await resolvePipeline(rootUri, text, { baseUri: rootUri, workspaceFolders: [URI.file(tmp).toString()] });
    expect(Array.isArray(model.workflow?.rules)).toBe(true);
    expect((model.workflow!.rules as unknown[]).length).toBe(2);
  });

  test('resolves a local child-pipeline trigger include to a URI', async () => {
    await write('child.yml', `child-job:\n  stage: test\n  script: [x]\n`);
    const rootUri = await write('.gitlab-ci.yml',
      `trigger-child:\n  stage: build\n  trigger:\n    include:\n      - local: child.yml\n`,
    );
    const text = await fs.readFile(URI.parse(rootUri).fsPath, 'utf8');
    const model = await resolvePipeline(rootUri, text, { baseUri: rootUri, workspaceFolders: [URI.file(tmp).toString()] });
    const t = model.jobs.find((j) => j.name === 'trigger-child')!;
    expect(t.triggerIncludeUri).toBeDefined();
    expect(t.triggerIncludeUri!).toContain('child.yml');
    // The child's jobs are NOT merged into this pipeline (trigger is not an include).
    expect(model.jobs.some((j) => j.name === 'child-job')).toBe(false);
  });

  test('warns when needs references an unknown job', async () => {
    const rootUri = await write('.gitlab-ci.yml', `job:\n  stage: test\n  needs: [ghost]\n  script: [x]\n`);
    const text = await fs.readFile(URI.parse(rootUri).fsPath, 'utf8');
    const model = await resolvePipeline(rootUri, text, { baseUri: rootUri, workspaceFolders: [URI.file(tmp).toString()] });
    expect(model.diagnostics.some((d) => /unknown job "ghost"/.test(d.message))).toBe(true);
  });
});
