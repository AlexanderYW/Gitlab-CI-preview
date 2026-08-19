/**
 * HTTP helper with public→PAT auth fallback and in-memory LRU cache.
 * Disk caching is delegated to the client (passes through globalStorageUri).
 */

export interface HttpSettings {
  /** host -> private token */
  tokens: Record<string, string>;
  defaultHost: string;
  cacheTtlMs: number;
  /** Abort a remote include fetch that takes longer than this. */
  fetchTimeoutMs: number;
}

const DEFAULT_SETTINGS: HttpSettings = {
  tokens: {},
  defaultHost: 'gitlab.com',
  cacheTtlMs: 15 * 60 * 1000,
  fetchTimeoutMs: 10_000,
};

let settings: HttpSettings = { ...DEFAULT_SETTINGS };
export function setHttpSettings(next: Partial<HttpSettings>) {
  // `tokens`, when provided, replaces wholesale rather than merging: callers (config changes)
  // always pass the complete token map, so merging would resurrect a token the user just
  // deleted/renamed and keep authenticating with a stale value until restart.
  const tokens = next.tokens ? { ...next.tokens } : settings.tokens;
  settings = { ...settings, ...next, tokens };
}
export function getHttpSettings(): HttpSettings {
  return settings;
}

interface CacheEntry { text: string; expiresAt: number }
const CACHE_MAX = 200;
const cache = new Map<string, CacheEntry>();

// Negative cache: remember failed fetches briefly so a transient/offline failure (or a
// genuinely-missing include) isn't re-requested on every keystroke-triggered resolution.
// Kept short so recovery is quick; `clearHttpCache()` (called when a token is added) wipes it.
const NEG_CACHE_TTL_MS = 30_000;
interface NegEntry { result: FetchResult; expiresAt: number }
const negCache = new Map<string, NegEntry>();

function negCacheGet(key: string): FetchResult | null {
  const e = negCache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { negCache.delete(key); return null; }
  return e.result;
}
function negCacheSet(key: string, result: FetchResult) {
  if (negCache.size >= CACHE_MAX) {
    const firstKey = negCache.keys().next().value;
    if (firstKey !== undefined) negCache.delete(firstKey);
  }
  negCache.set(key, { result, expiresAt: Date.now() + NEG_CACHE_TTL_MS });
}

/** fetch() with an AbortController timeout, so a slow remote include can't hang resolution forever. */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const timeoutMs = settings.fetchTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      throw new Error(`request timed out after ${timeoutMs}ms`, { cause: e });
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function cacheGet(key: string): string | null {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) {
    cache.delete(key);
    return null;
  }
  // refresh LRU position
  cache.delete(key);
  cache.set(key, e);
  return e.text;
}

function cacheSet(key: string, text: string, ttlMs: number) {
  if (cache.size >= CACHE_MAX) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(key, { text, expiresAt: Date.now() + ttlMs });
}

export function clearHttpCache() {
  cache.clear();
  negCache.clear();
  notifiedHosts.clear();
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return ''; }
}

function tokenFor(host: string): string | undefined {
  // Self-hosted GitLab often runs on a non-standard port (e.g. gitlab.acme.com:8443),
  // but users configure tokens under the bare hostname. Try host as-is, then with the
  // port and/or leading `www.` stripped, so any of those config shapes matches.
  for (const candidate of hostTokenCandidates(host)) {
    const token = settings.tokens[candidate];
    if (token) return token;
  }
  return undefined;
}
function hostTokenCandidates(host: string): string[] {
  const noWww = host.replace(/^www\./, '');
  const stripPort = (h: string) => h.replace(/:\d+$/, '');
  return [...new Set([host, noWww, stripPort(host), stripPort(noWww)])];
}

/** Choose TTL: pinned refs (sha/tag) → indefinite-ish (24h), branches → configured TTL. */
function ttlForRef(ref: string | undefined): number {
  if (!ref) return settings.cacheTtlMs;
  const isPinned = /^[0-9a-f]{7,40}$/i.test(ref) || /^v?\d/.test(ref);
  return isPinned ? 24 * 60 * 60 * 1000 : settings.cacheTtlMs;
}

export interface FetchOptions {
  /** Optional ref hint (for cache TTL). */
  ref?: string;
  /** Pass-through extra headers. */
  headers?: Record<string, string>;
}

export interface FetchResult {
  ok: boolean;
  status: number;
  text: string | null;
  url: string;
  /** True if we retried with a token. */
  authenticated: boolean;
  error?: string;
}

export async function httpGet(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const cacheKey = url;
  const cached = cacheGet(cacheKey);
  if (cached !== null) {
    return { ok: true, status: 200, text: cached, url, authenticated: false };
  }
  const negative = negCacheGet(cacheKey);
  if (negative !== null) return negative;
  const host = hostOf(url);
  const token = tokenFor(host);
  const baseHeaders: Record<string, string> = { 'User-Agent': 'gitlab-ci-preview', ...(opts.headers ?? {}) };
  // Send the configured PAT on the first request. Sending it only as a fallback after an
  // unauthenticated 401 meant self-hosted instances that 302-redirect anonymous requests to a
  // login page (returning 200 HTML) would cache that HTML as the include body. The token is
  // configured per-host by the user, so sending it to that host up front is expected.
  //
  // GitLab personal access tokens authenticate via the PRIVATE-TOKEN header only. The previous
  // code *also* set `Authorization: Bearer <pat>`, which makes GitLab treat the request as OAuth2
  // and reject the (non-OAuth) token with 401 before it ever consults PRIVATE-TOKEN — so valid
  // tokens appeared to fail. Send PRIVATE-TOKEN exclusively.
  const headers = token ? { ...baseHeaders, 'PRIVATE-TOKEN': token } : baseHeaders;

  const fail = (result: FetchResult): FetchResult => { negCacheSet(cacheKey, result); return result; };

  let res: Response;
  try {
    res = await fetchWithTimeout(url, { headers });
  } catch (e) {
    return fail({ ok: false, status: 0, text: null, url, authenticated: !!token, error: (e as Error).message });
  }
  if (res.ok) {
    const text = await res.text();
    cacheSet(cacheKey, text, ttlForRef(opts.ref));
    return { ok: true, status: res.status, text, url, authenticated: !!token };
  }
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    // No token configured and the server denied us — let the listener know once per host.
    // GitLab returns 404 (not 401/403) for private resources the caller can't see, to avoid
    // leaking their existence, so we must prompt on 404 too or self-hosted private includes
    // would fail silently with no token prompt ever shown.
    if (!token) notifyNeedsAuth(host);
    return fail({
      ok: false, status: res.status, text: null, url, authenticated: !!token,
      error: token ? `HTTP ${res.status} (with token)` : `HTTP ${res.status}`,
    });
  }
  return fail({ ok: false, status: res.status, text: null, url, authenticated: !!token, error: `HTTP ${res.status}` });
}

// Listener wiring (server.ts calls onNeedsAuth to subscribe).
type NeedsAuthListener = (host: string) => void;
let needsAuthListener: NeedsAuthListener | null = null;
const notifiedHosts = new Set<string>();
export function onNeedsAuth(fn: NeedsAuthListener) { needsAuthListener = fn; }
function notifyNeedsAuth(host: string) {
  if (!host || notifiedHosts.has(host)) return;
  notifiedHosts.add(host);
  needsAuthListener?.(host);
}

/** Build a GitLab API URL for a project file. */
export function gitlabApiFileUrl(host: string, project: string, file: string, ref: string): string {
  const cleanFile = file.replace(/^\/+/, '');
  return `https://${host}/api/v4/projects/${encodeURIComponent(project)}/repository/files/${encodeURIComponent(cleanFile)}/raw?ref=${encodeURIComponent(ref)}`;
}
