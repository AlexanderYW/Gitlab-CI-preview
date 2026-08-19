import { describe, expect, test } from 'bun:test';
import { bundleCandidates, toHost, toProjectPath, blobUrl, randomNonce } from '../src/util.js';

describe('toHost', () => {
  test('extracts host from https URLs', () => {
    expect(toHost('https://gitlab.com/group/proj')).toBe('gitlab.com');
    expect(toHost('http://gitlab.mycorp.io:8080/x')).toBe('gitlab.mycorp.io:8080');
  });

  test('extracts host from scp-style and ssh:// remotes', () => {
    expect(toHost('git@gitlab.com:group/proj.git')).toBe('gitlab.com');
    expect(toHost('ssh://git@gitlab.mycorp.io/group/proj.git')).toBe('gitlab.mycorp.io');
  });

  test('treats a bare host as a host and trims slashes', () => {
    expect(toHost('gitlab.com')).toBe('gitlab.com');
    expect(toHost('/gitlab.com/')).toBe('gitlab.com');
  });

  test('returns null for empty input', () => {
    expect(toHost('')).toBeNull();
  });
});

describe('bundleCandidates', () => {
  test('prod prefers the packaged bundled/ path over the dev dist/ path', () => {
    const [packaged, dev] = bundleCandidates('/ext', 'server', 'server.js');
    expect(packaged).toBe('/ext/bundled/server/server.js');
    expect(dev).toBe('/server/dist/server.js'); // path.join collapses /ext/.. → /
  });

  test('dev mode prefers the live dist/ path first', () => {
    const [first, second] = bundleCandidates('/ext', 'server', 'server.js', true);
    expect(first).toBe('/server/dist/server.js');
    expect(second).toBe('/ext/bundled/server/server.js');
  });

  test('uses the webview subtree for webview assets', () => {
    expect(bundleCandidates('/ext', 'webview', 'webview.js')[0]).toBe('/ext/bundled/webview/webview.js');
  });
});

describe('toProjectPath', () => {
  test('strips protocol/host and .git from https and scp remotes', () => {
    expect(toProjectPath('https://gitlab.com/group/sub/proj.git')).toBe('group/sub/proj');
    expect(toProjectPath('git@gitlab.com:group/proj.git')).toBe('group/proj');
    expect(toProjectPath('ssh://git@gitlab.mycorp.io/group/proj')).toBe('group/proj');
  });

  test('returns null for empty input', () => {
    expect(toProjectPath('')).toBeNull();
  });
});

describe('blobUrl', () => {
  test('builds a GitLab blob URL with an encoded ref and path', () => {
    expect(blobUrl('gitlab.com', 'group/proj', 'main', 'ci/build.yml'))
      .toBe('https://gitlab.com/group/proj/-/blob/main/ci/build.yml');
    expect(blobUrl('gitlab.com', 'group/proj', 'feature/x', '/.gitlab-ci.yml'))
      .toBe('https://gitlab.com/group/proj/-/blob/feature%2Fx/.gitlab-ci.yml');
  });
});

describe('randomNonce', () => {
  test('is 32 alphanumeric chars and differs between calls', () => {
    const a = randomNonce();
    expect(a).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(a).not.toBe(randomNonce());
  });
});
