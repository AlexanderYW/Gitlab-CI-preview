import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'yaml';
import { URI } from 'vscode-uri';
import { resolvePipeline } from '../src/resolve.js';
import { buildMergedPipeline } from '../src/features/mergePipeline.js';

let tmp: string;
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'glci-merge-')); });
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

async function write(rel: string, content: string): Promise<string> {
  const full = path.join(tmp, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
  return URI.file(full).toString();
}

describe('buildMergedPipeline', () => {
  test('emits resolved jobs with extends flattened and default merged, as valid YAML', async () => {
    const rootUri = await write('.gitlab-ci.yml',
      `stages: [build, test]\n` +
      `default:\n  image: alpine:3.20\n` +
      `.base:\n  before_script: [setup]\n` +
      `compile:\n  extends: .base\n  stage: build\n  script: [make]\n`,
    );
    const text = await fs.readFile(URI.parse(rootUri).fsPath, 'utf8');
    const model = await resolvePipeline(rootUri, text, { baseUri: rootUri, workspaceFolders: [URI.file(tmp).toString()] });

    const merged = buildMergedPipeline(model);
    const doc = parse(merged) as Record<string, any>;

    expect(doc.stages).toEqual(['build', 'test']);
    expect(doc.default).toEqual({ image: 'alpine:3.20' });
    // extends flattened away; parent's before_script and default image merged in.
    expect(doc.compile.extends).toBeUndefined();
    expect(doc.compile.before_script).toEqual(['setup']);
    expect(doc.compile.image).toBe('alpine:3.20');
    expect(doc.compile.script).toEqual(['make']);
  });

  test('preserves !reference tags rather than expanding them', async () => {
    const rootUri = await write('.gitlab-ci.yml',
      `.setup:\n  script: [echo hi]\n` +
      `job:\n  stage: test\n  script:\n    - !reference [.setup, script]\n`,
    );
    const text = await fs.readFile(URI.parse(rootUri).fsPath, 'utf8');
    const model = await resolvePipeline(rootUri, text, { baseUri: rootUri, workspaceFolders: [URI.file(tmp).toString()] });
    const merged = buildMergedPipeline(model);
    expect(merged).toContain('!reference');
  });
});
