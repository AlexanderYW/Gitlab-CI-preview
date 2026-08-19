import { URI, Utils } from 'vscode-uri';
import { promises as fs } from 'node:fs';
import type { IncludeRef } from '@gitlab-ci-preview/shared';
import { httpGet, gitlabApiFileUrl, getHttpSettings } from './http.js';

export interface ResolveContext {
  /** The URI of the document that contains the include. */
  baseUri: string;
  /** Workspace folder URIs (file://...) for project include lookups. */
  workspaceFolders: string[];
  /** A way to read open text documents (e.g. unsaved changes). */
  readOpenDocument?: (uri: string) => string | null;
}

export interface ResolveResult {
  uri: string;
  text: string;
}

export interface ResolveFailure {
  error: string;
}

export type Resolution = ResolveResult | ResolveFailure;

export function isFailure(r: Resolution): r is ResolveFailure {
  return (r as ResolveFailure).error !== undefined;
}

/** Resolve a single IncludeRef and return its text. Mutates `ref.resolvedUri` on success. */
export async function resolveInclude(ref: IncludeRef, ctx: ResolveContext): Promise<Resolution> {
  switch (ref.kind) {
    case 'local':   return resolveLocal(ref, ctx);
    case 'remote':  return resolveRemote(ref, ctx);
    case 'template': return resolveTemplate(ref, ctx);
    case 'project': return resolveProject(ref, ctx);
    case 'component': return resolveComponent(ref, ctx);
  }
}

async function resolveLocal(ref: IncludeRef, ctx: ResolveContext): Promise<Resolution> {
  const base = URI.parse(ctx.baseUri);
  const cleaned = ref.raw.replace(/^\//, '');
  const target = Utils.joinPath(Utils.dirname(base), cleaned);
  const uri = target.toString();
  const open = ctx.readOpenDocument?.(uri);
  if (open !== null && open !== undefined) {
    ref.resolvedUri = uri;
    return { uri, text: open };
  }
  try {
    const text = await fs.readFile(target.fsPath, 'utf8');
    ref.resolvedUri = uri;
    return { uri, text };
  } catch (e) {
    return { error: `cannot read local include ${cleaned}: ${(e as Error).message}` };
  }
}

async function resolveRemote(ref: IncludeRef, _ctx: ResolveContext): Promise<Resolution> {
  const res = await httpGet(ref.raw);
  if (!res.ok || res.text === null) return { error: res.error ?? `fetch failed for ${ref.raw}` };
  ref.resolvedUri = `gitlab-ci://remote/${encodeURIComponent(ref.raw)}`;
  return { uri: ref.resolvedUri, text: res.text };
}

async function resolveTemplate(ref: IncludeRef, _ctx: ResolveContext): Promise<Resolution> {
  const name = ref.raw.replace(/^\/+/, '');
  const path = `gitlab-org/gitlab/-/raw/master/lib/gitlab/ci/templates/${name}`;
  const host = getHttpSettings().defaultHost;
  // Self-hosted instances ship their own templates; try the configured host first,
  // then fall back to gitlab.com (which is also the default host, so no double-fetch there).
  const hosts = host && host !== 'gitlab.com' ? [host, 'gitlab.com'] : ['gitlab.com'];
  let lastErr: string | undefined;
  for (const h of hosts) {
    const res = await httpGet(`https://${h}/${path}`);
    if (res.ok && res.text !== null) {
      ref.resolvedUri = `gitlab-ci://template/${encodeURIComponent(name)}`;
      return { uri: ref.resolvedUri, text: res.text };
    }
    lastErr = res.error;
  }
  return { error: lastErr ?? `template not found: ${name}` };
}

async function resolveProject(ref: IncludeRef, ctx: ResolveContext): Promise<Resolution> {
  if (!ref.project || !ref.file) return { error: 'project include missing project or file' };
  // Workspace-first lookup
  for (const folder of ctx.workspaceFolders) {
    try {
      const folderUri = URI.parse(folder);
      const candidate = Utils.joinPath(folderUri, ref.project, ref.file);
      const text = await fs.readFile(candidate.fsPath, 'utf8');
      ref.resolvedUri = candidate.toString();
      return { uri: ref.resolvedUri, text };
    } catch { /* try next */ }
  }
  // API fallback
  const host = getHttpSettings().defaultHost;
  const url = gitlabApiFileUrl(host, ref.project, ref.file, ref.ref ?? 'HEAD');
  const res = await httpGet(url, { ref: ref.ref });
  if (!res.ok || res.text === null) {
    // Include the host so a wrong/stale `gitlabCi.defaultHost` (e.g. the gitlab.com fallback when
    // the workspace actually lives on a self-hosted instance) is visible in the diagnostic.
    const detail = res.error ? `${res.error} on ${host}` : `project file fetch failed on ${host}: ${ref.project}:${ref.file}`;
    return { error: detail };
  }
  ref.resolvedUri = `gitlab-ci://project/${encodeURIComponent(host)}/${encodeURIComponent(ref.project)}/${encodeURIComponent(ref.ref ?? 'HEAD')}/${encodeURIComponent(ref.file)}`;
  return { uri: ref.resolvedUri, text: res.text };
}

/**
 * Components are referenced as `host/path/to/project/component-name@version`.
 * The component template lives at `templates/<component-name>/template.yml` (or
 * `templates/<component-name>.yml` for single-file components) in the project.
 */
async function resolveComponent(ref: IncludeRef, _ctx: ResolveContext): Promise<Resolution> {
  const m = ref.raw.match(/^([^/]+)\/(.+)\/([^/@]+)@(.+)$/);
  if (!m) return { error: `unrecognized component spec: ${ref.raw}` };
  const [, host, projectPath, name, version] = m;
  const tryPaths = [
    `templates/${name}/template.yml`,
    `templates/${name}.yml`,
  ];
  for (const path of tryPaths) {
    const url = gitlabApiFileUrl(host, projectPath, path, version);
    const res = await httpGet(url, { ref: version });
    if (res.ok && res.text !== null) {
      ref.resolvedUri = `gitlab-ci://component/${encodeURIComponent(host)}/${encodeURIComponent(projectPath)}/${encodeURIComponent(version)}/${encodeURIComponent(name)}`;
      return { uri: ref.resolvedUri, text: res.text };
    }
  }
  return { error: `component not found on ${host}: ${ref.raw}` };
}
