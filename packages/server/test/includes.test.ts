import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { URI } from 'vscode-uri';
import { resolvePipeline } from '../src/resolve.js';
import { clearHttpCache, setHttpSettings, onNeedsAuth } from '../src/includes/http.js';

let tmp: string;
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'glci-inc-'));
  clearHttpCache();
  setHttpSettings({ tokens: {}, defaultHost: 'gitlab.com', cacheTtlMs: 60_000 });
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
  clearHttpCache();
});

async function write(rel: string, content: string): Promise<string> {
  const full = path.join(tmp, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
  return URI.file(full).toString();
}

interface MockResponse { status: number; body: string }
function mockFetch(routes: Record<string, MockResponse | ((init: RequestInit | undefined) => MockResponse)>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers });
    const route = routes[url];
    if (!route) {
      return new Response('not found', { status: 404 });
    }
    const r = typeof route === 'function' ? route(init) : route;
    return new Response(r.body, { status: r.status });
  }) as typeof fetch;
  return calls;
}

describe('remote include resolver', () => {
  test('fetches and merges jobs from a remote URL', async () => {
    const remoteUrl = 'https://example.com/ci/remote.yml';
    mockFetch({
      [remoteUrl]: { status: 200, body: 'remote:job:\n  stage: test\n  script: [r]\n' },
    });
    const rootUri = await write('.gitlab-ci.yml', `include:\n  - remote: '${remoteUrl}'\nlocal:job:\n  stage: build\n  script: [l]\n`);
    const text = await fs.readFile(URI.parse(rootUri).fsPath, 'utf8');
    const model = await resolvePipeline(rootUri, text, { baseUri: rootUri, workspaceFolders: [URI.file(tmp).toString()] });
    const names = model.jobs.map((j) => j.name).sort();
    expect(names).toEqual(['local:job', 'remote:job']);
  });

  test('emits a diagnostic when the remote fetch fails', async () => {
    mockFetch({});
    const rootUri = await write('.gitlab-ci.yml', `include:\n  - remote: 'https://example.com/missing.yml'\n`);
    const text = await fs.readFile(URI.parse(rootUri).fsPath, 'utf8');
    const model = await resolvePipeline(rootUri, text, { baseUri: rootUri, workspaceFolders: [URI.file(tmp).toString()] });
    expect(model.diagnostics.some((d) => /cannot resolve include/.test(d.message))).toBe(true);
  });

  test('times out a hanging remote fetch instead of hanging forever', async () => {
    setHttpSettings({ fetchTimeoutMs: 30 });
    // fetch that never resolves on its own — only settles when the abort signal fires.
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      })) as typeof fetch;
    const rootUri = await write('.gitlab-ci.yml', `include:\n  - remote: 'https://example.com/slow.yml'\n`);
    const text = await fs.readFile(URI.parse(rootUri).fsPath, 'utf8');
    const model = await resolvePipeline(rootUri, text, { baseUri: rootUri, workspaceFolders: [URI.file(tmp).toString()] });
    expect(model.diagnostics.some((d) => /cannot resolve include/.test(d.message))).toBe(true);
  });
});

describe('template include resolver', () => {
  test('fetches from the gitlab-org templates path', async () => {
    const url = 'https://gitlab.com/gitlab-org/gitlab/-/raw/master/lib/gitlab/ci/templates/Bash.gitlab-ci.yml';
    mockFetch({ [url]: { status: 200, body: 'tmpl:job:\n  stage: test\n  script: [t]\n' } });
    const rootUri = await write('.gitlab-ci.yml', `include:\n  - template: Bash.gitlab-ci.yml\n`);
    const text = await fs.readFile(URI.parse(rootUri).fsPath, 'utf8');
    const model = await resolvePipeline(rootUri, text, { baseUri: rootUri, workspaceFolders: [URI.file(tmp).toString()] });
    expect(model.jobs.some((j) => j.name === 'tmpl:job')).toBe(true);
  });
});

describe('project include resolver', () => {
  test('prefers a workspace folder match over the API', async () => {
    await write('my-group/my-project/ci/shared.yml', 'ws:job:\n  stage: build\n  script: [w]\n');
    mockFetch({}); // any HTTP call would 404 — workspace lookup should win
    const rootUri = await write('.gitlab-ci.yml',
      `include:\n  - project: my-group/my-project\n    ref: main\n    file: '/ci/shared.yml'\n`,
    );
    const text = await fs.readFile(URI.parse(rootUri).fsPath, 'utf8');
    const model = await resolvePipeline(rootUri, text, { baseUri: rootUri, workspaceFolders: [URI.file(tmp).toString()] });
    expect(model.jobs.some((j) => j.name === 'ws:job')).toBe(true);
  });

  test('falls back to GitLab API when not present in workspace', async () => {
    const apiUrl = 'https://gitlab.com/api/v4/projects/my-group%2Fmy-project/repository/files/ci%2Fshared.yml/raw?ref=main';
    mockFetch({ [apiUrl]: { status: 200, body: 'api:job:\n  stage: build\n  script: [a]\n' } });
    const rootUri = await write('.gitlab-ci.yml',
      `include:\n  - project: my-group/my-project\n    ref: main\n    file: '/ci/shared.yml'\n`,
    );
    const text = await fs.readFile(URI.parse(rootUri).fsPath, 'utf8');
    const model = await resolvePipeline(rootUri, text, { baseUri: rootUri, workspaceFolders: [URI.file(tmp).toString()] });
    expect(model.jobs.some((j) => j.name === 'api:job')).toBe(true);
  });

  test('sends PRIVATE-TOKEN on the first request (no unauthenticated probe)', async () => {
    const apiUrl = 'https://gitlab.com/api/v4/projects/my-group%2Fmy-project/repository/files/ci%2Fshared.yml/raw?ref=main';
    setHttpSettings({ tokens: { 'gitlab.com': 'secret-pat' } });
    const calls = mockFetch({
      [apiUrl]: (init) => {
        const hdrs = (init?.headers ?? {}) as Record<string, string>;
        if (hdrs['PRIVATE-TOKEN'] === 'secret-pat') {
          return { status: 200, body: 'auth:job:\n  stage: build\n  script: [a]\n' };
        }
        return { status: 401, body: 'denied' };
      },
    });
    const rootUri = await write('.gitlab-ci.yml',
      `include:\n  - project: my-group/my-project\n    ref: main\n    file: '/ci/shared.yml'\n`,
    );
    const text = await fs.readFile(URI.parse(rootUri).fsPath, 'utf8');
    const model = await resolvePipeline(rootUri, text, { baseUri: rootUri, workspaceFolders: [URI.file(tmp).toString()] });
    expect(model.jobs.some((j) => j.name === 'auth:job')).toBe(true);
    // Single authenticated request — no unauthenticated probe that could cache a login page.
    expect(calls.length).toBe(1);
    expect(calls[0].headers['PRIVATE-TOKEN']).toBe('secret-pat');
  });

  test('never sends a PAT as Authorization: Bearer (GitLab would reject it as OAuth)', async () => {
    const apiUrl = 'https://gitlab.com/api/v4/projects/my-group%2Fmy-project/repository/files/ci%2Fshared.yml/raw?ref=main';
    setHttpSettings({ tokens: { 'gitlab.com': 'secret-pat' } });
    const calls = mockFetch({ [apiUrl]: { status: 200, body: 'ok:job:\n  stage: build\n  script: [o]\n' } });
    const rootUri = await write('.gitlab-ci.yml',
      `include:\n  - project: my-group/my-project\n    ref: main\n    file: '/ci/shared.yml'\n`,
    );
    const text = await fs.readFile(URI.parse(rootUri).fsPath, 'utf8');
    await resolvePipeline(rootUri, text, { baseUri: rootUri, workspaceFolders: [URI.file(tmp).toString()] });
    expect(calls[0].headers['Authorization']).toBeUndefined();
  });

  test('matches a token configured under the bare host for a custom port', async () => {
    const apiUrl = 'https://gitlab.acme.com:8443/api/v4/projects/g%2Fp/repository/files/ci%2Fs.yml/raw?ref=main';
    setHttpSettings({ defaultHost: 'gitlab.acme.com:8443', tokens: { 'gitlab.acme.com': 'acme-pat' } });
    const calls = mockFetch({
      [apiUrl]: (init) => {
        const hdrs = (init?.headers ?? {}) as Record<string, string>;
        return hdrs['PRIVATE-TOKEN'] === 'acme-pat'
          ? { status: 200, body: 'port:job:\n  stage: build\n  script: [p]\n' }
          : { status: 401, body: 'denied' };
      },
    });
    const rootUri = await write('.gitlab-ci.yml',
      `include:\n  - project: g/p\n    ref: main\n    file: '/ci/s.yml'\n`,
    );
    const text = await fs.readFile(URI.parse(rootUri).fsPath, 'utf8');
    const model = await resolvePipeline(rootUri, text, { baseUri: rootUri, workspaceFolders: [URI.file(tmp).toString()] });
    expect(model.jobs.some((j) => j.name === 'port:job')).toBe(true);
    expect(calls[0].headers['PRIVATE-TOKEN']).toBe('acme-pat');
  });

  test('prompts for auth on a 404 with no token (GitLab hides private resources as 404)', async () => {
    // Distinct host: setHttpSettings merges tokens, so reusing a host another test configured
    // would leak its token in and suppress the prompt.
    const apiUrl = 'https://gitlab.private.io/api/v4/projects/g%2Fp/repository/files/ci%2Fs.yml/raw?ref=main';
    setHttpSettings({ defaultHost: 'gitlab.private.io', tokens: {} });
    mockFetch({ [apiUrl]: { status: 404, body: '{"message":"404 Not Found"}' } });
    const prompted: string[] = [];
    onNeedsAuth((host) => prompted.push(host));
    const rootUri = await write('.gitlab-ci.yml',
      `include:\n  - project: g/p\n    ref: main\n    file: '/ci/s.yml'\n`,
    );
    const text = await fs.readFile(URI.parse(rootUri).fsPath, 'utf8');
    await resolvePipeline(rootUri, text, { baseUri: rootUri, workspaceFolders: [URI.file(tmp).toString()] });
    expect(prompted).toContain('gitlab.private.io');
  });
});

describe('component include resolver', () => {
  test('tries templates/<name>/template.yml first', async () => {
    const url = 'https://gitlab.com/api/v4/projects/components%2Fsast/repository/files/templates%2Fsast-scanner%2Ftemplate.yml/raw?ref=1.0.0';
    mockFetch({ [url]: { status: 200, body: 'comp:job:\n  stage: test\n  script: [c]\n' } });
    const rootUri = await write('.gitlab-ci.yml',
      `include:\n  - component: gitlab.com/components/sast/sast-scanner@1.0.0\n`,
    );
    const text = await fs.readFile(URI.parse(rootUri).fsPath, 'utf8');
    const model = await resolvePipeline(rootUri, text, { baseUri: rootUri, workspaceFolders: [URI.file(tmp).toString()] });
    expect(model.jobs.some((j) => j.name === 'comp:job')).toBe(true);
  });

  test('falls back to templates/<name>.yml', async () => {
    const dirUrl = 'https://gitlab.com/api/v4/projects/components%2Fsast/repository/files/templates%2Fsast-scanner%2Ftemplate.yml/raw?ref=1.0.0';
    const flatUrl = 'https://gitlab.com/api/v4/projects/components%2Fsast/repository/files/templates%2Fsast-scanner.yml/raw?ref=1.0.0';
    mockFetch({
      [dirUrl]: { status: 404, body: 'nope' },
      [flatUrl]: { status: 200, body: 'flat:job:\n  stage: test\n  script: [f]\n' },
    });
    const rootUri = await write('.gitlab-ci.yml',
      `include:\n  - component: gitlab.com/components/sast/sast-scanner@1.0.0\n`,
    );
    const text = await fs.readFile(URI.parse(rootUri).fsPath, 'utf8');
    const model = await resolvePipeline(rootUri, text, { baseUri: rootUri, workspaceFolders: [URI.file(tmp).toString()] });
    expect(model.jobs.some((j) => j.name === 'flat:job')).toBe(true);
  });
});

describe('extends chains', () => {
  test('resolves a multi-level extends chain', async () => {
    const rootUri = await write('.gitlab-ci.yml',
      `stages: [build, test]\n` +
      `.base:\n  image: alpine:3.20\n  script: [base]\n` +
      `.middle:\n  extends: .base\n  stage: test\n` +
      `.leaf:\n  extends: .middle\n  before_script: [hi]\n` +
      `real:\n  extends: .leaf\n  script: [real]\n`,
    );
    const text = await fs.readFile(URI.parse(rootUri).fsPath, 'utf8');
    const model = await resolvePipeline(rootUri, text, { baseUri: rootUri, workspaceFolders: [URI.file(tmp).toString()] });
    const real = model.jobs.find((j) => j.name === 'real')!;
    expect(real.image).toBe('alpine:3.20');
    expect(real.stage).toBe('test');
    expect(real.script).toEqual(['real']); // child overrides parent script
  });

  test('detects extends cycles', async () => {
    const rootUri = await write('.gitlab-ci.yml',
      `.a:\n  extends: .b\n  script: [a]\n` +
      `.b:\n  extends: .a\n  script: [b]\n` +
      `real:\n  extends: .a\n  stage: build\n`,
    );
    const text = await fs.readFile(URI.parse(rootUri).fsPath, 'utf8');
    const model = await resolvePipeline(rootUri, text, { baseUri: rootUri, workspaceFolders: [URI.file(tmp).toString()] });
    expect(model.diagnostics.some((d) => /extends cycle/.test(d.message))).toBe(true);
  });
});
