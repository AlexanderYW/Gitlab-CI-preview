/**
 * SecretStorage-backed store for per-host GitLab personal access tokens.
 *
 * Deliberately free of any `vscode` import so it stays unit-testable with bun:test;
 * callers pass a `vscode.SecretStorage`-shaped object.
 */

/** Minimal shape of `vscode.SecretStorage` that TokenStore depends on. */
export interface SecretStorageLike {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

export type TokensListener = () => void;

const DEFAULT_SECRET_KEY = 'gitlabCiTokens';

/**
 * Stores the host→token map as one JSON blob under a single secret key and keeps an
 * in-memory cache after the first load (SecretStorage reads are async + can be slow).
 */
export class TokenStore {
  private cache: Record<string, string> | null = null;
  private listeners: TokensListener[] = [];

  constructor(
    private readonly storage: SecretStorageLike,
    private readonly secretKey: string = DEFAULT_SECRET_KEY,
  ) {}

  /** Fired (synchronously) whenever the token map changes via setToken/deleteToken. */
  onDidChange(fn: TokensListener): { dispose(): void } {
    this.listeners.push(fn);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== fn);
      },
    };
  }

  /** Load the full token map (cached after first call); returns a defensive copy. */
  async getAll(): Promise<Record<string, string>> {
    if (!this.cache) {
      let parsed: unknown;
      try {
        parsed = JSON.parse((await this.storage.get(this.secretKey)) ?? '{}');
      } catch {
        parsed = {};
      }
      this.cache = isTokenMap(parsed) ? parsed : {};
    }
    return { ...this.cache };
  }

  /**
   * Look up a token with the same leniency as the server's include fetcher: try the
   * host as-is, then strip a leading `www.`, then a trailing port, then both — users
   * configure tokens under whichever shape they think of first.
   */
  async getToken(host: string): Promise<string | undefined> {
    const tokens = await this.getAll();
    for (const candidate of hostTokenCandidates(host)) {
      const token = tokens[candidate];
      if (token) return token;
    }
    return undefined;
  }

  /** Add or replace the token for `host` exactly as given (no key normalization). */
  async setToken(host: string, token: string): Promise<void> {
    const tokens = await this.getAll();
    tokens[host] = token;
    await this.persist(tokens);
  }

  /** Remove the token for `host`; no-op (and no change event) when there is none. */
  async deleteToken(host: string): Promise<void> {
    const tokens = await this.getAll();
    if (!(host in tokens)) return;
    delete tokens[host];
    await this.persist(tokens);
  }

  private async persist(tokens: Record<string, string>): Promise<void> {
    if (Object.keys(tokens).length === 0) {
      await this.storage.delete(this.secretKey);
      this.cache = {};
    } else {
      await this.storage.store(this.secretKey, JSON.stringify(tokens));
      this.cache = tokens;
    }
    for (const fn of [...this.listeners]) fn();
  }
}

function hostTokenCandidates(host: string): string[] {
  const noWww = host.replace(/^www\./, '');
  const stripPort = (h: string) => h.replace(/:\d+$/, '');
  return [...new Set([host, noWww, stripPort(host), stripPort(noWww)])];
}

function isTokenMap(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === 'string');
}

export interface MigrationPlan {
  entries: [string, string][];
}

/** Pure helper: what to move out of the legacy `gitlabCi.tokens` setting; null = nothing to migrate. */
export function planMigration(oldSettings: Record<string, string>): MigrationPlan | null {
  const entries = Object.entries(oldSettings ?? {});
  if (entries.length === 0) return null;
  return { entries };
}
