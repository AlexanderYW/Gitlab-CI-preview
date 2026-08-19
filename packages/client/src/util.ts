/**
 * Pure helpers with no `vscode` dependency, so they can be unit-tested directly.
 * Keep anything that touches the VS Code API in `extension.ts`.
 */
import * as path from 'node:path';

/**
 * Candidate bundle paths in priority order.
 * Production (packaged `.vsix`) prefers the staged `bundled/` layout; development (F5)
 * prefers the live monorepo `dist/` layout, so a leftover `bundled/` from an interrupted
 * package run can never shadow freshly-built dev bundles.
 */
export function bundleCandidates(root: string, kind: 'server' | 'webview', file: string, preferDev = false): string[] {
  const sub = kind === 'server' ? 'server' : 'webview';
  const packaged = path.join(root, 'bundled', sub, file);
  const dev = path.join(root, '..', sub, 'dist', file);
  return preferDev ? [dev, packaged] : [packaged, dev];
}

/** Extract a bare host from an http(s) URL, scp-style SSH, ssh:// URL, or a plain host string. */
export function toHost(urlOrHost: string): string | null {
  try {
    if (/^https?:\/\//.test(urlOrHost)) return new URL(urlOrHost).host;
    // scp-style SSH: [user@]host:path
    const ssh = /^(?:[^@\s]+@)?([^:\s]+):[^/].*/.exec(urlOrHost);
    if (ssh) return ssh[1];
    // ssh:// URL
    if (/^ssh:\/\//.test(urlOrHost)) return new URL(urlOrHost).host;
    return urlOrHost.replace(/^\/+|\/+$/g, '') || null;
  } catch { return null; }
}

/**
 * Extract the GitLab project path (`group/subgroup/project`) from a git remote URL,
 * stripping protocol/host/`.git`. Returns null if it can't be determined.
 */
export function toProjectPath(remote: string): string | null {
  try {
    let p: string;
    if (/^https?:\/\//.test(remote) || /^ssh:\/\//.test(remote)) {
      p = new URL(remote).pathname;
    } else {
      // scp-style: [user@]host:group/proj.git
      const ssh = /^(?:[^@\s]+@)?[^:\s]+:(.+)$/.exec(remote);
      p = ssh ? ssh[1] : remote;
    }
    p = p.replace(/^\/+/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
    return p || null;
  } catch { return null; }
}

/** Build a GitLab web URL to view a file on a given ref. */
export function blobUrl(host: string, projectPath: string, ref: string, relPath: string): string {
  const clean = relPath.replace(/^\/+/, '');
  return `https://${host}/${projectPath}/-/blob/${encodeURIComponent(ref)}/${clean.split('/').map(encodeURIComponent).join('/')}`;
}

/** A random nonce for the webview Content-Security-Policy. */
export function randomNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
