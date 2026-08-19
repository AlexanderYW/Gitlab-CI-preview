import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { URI } from 'vscode-uri';
import { resolvePipeline } from '../src/resolve.js';

let tmp: string;
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'glci-schema-')); });
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

async function write(rel: string, content: string): Promise<string> {
  const full = path.join(tmp, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
  return URI.file(full).toString();
}

describe('schema diagnostics', () => {
  test('flags unknown top-level / job properties', async () => {
    const uri = await write('.gitlab-ci.yml', `\nbuild:\n  stage: build\n  scrippt: ['typo here']\n`);
    const text = await fs.readFile(URI.parse(uri).fsPath, 'utf8');
    const model = await resolvePipeline(uri, text, { baseUri: uri, workspaceFolders: [URI.file(tmp).toString()] });
    const schemaIssues = model.diagnostics.filter((d) => d.source === 'gitlab-ci/schema');
    // Schema may flag the typo as an unknown property in any of several places; just assert it
    // surfaces something.
    expect(schemaIssues.length).toBeGreaterThan(0);
  });
});
