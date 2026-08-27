import { describe, expect, test } from 'bun:test';
import { TokenStore, planMigration, type SecretStorageLike } from '../src/tokenStore.js';

/** In-memory stand-in for vscode.SecretStorage. */
class FakeSecretStorage implements SecretStorageLike {
  private map = new Map<string, string>();
  async get(key: string): Promise<string | undefined> { return this.map.get(key); }
  async store(key: string, value: string): Promise<void> { this.map.set(key, value); }
  async delete(key: string): Promise<void> { this.map.delete(key); }
  /** Test introspection: raw stored values. */
  raw(): [string, string][] { return [...this.map.entries()]; }
}

describe('TokenStore round-trips', () => {
  test('setToken / getAll / deleteToken persist to the secret backend', async () => {
    const storage = new FakeSecretStorage();
    const store = new TokenStore(storage);
    expect(await store.getAll()).toEqual({});

    await store.setToken('gitlab.com', 'glpat-a');
    await store.setToken('gitlab.mycorp.io', 'glpat-b');
    expect(await store.getAll()).toEqual({ 'gitlab.com': 'glpat-a', 'gitlab.mycorp.io': 'glpat-b' });

    // One JSON blob under the default key.
    expect(storage.raw()).toHaveLength(1);

    await store.deleteToken('gitlab.com');
    expect(await store.getAll()).toEqual({ 'gitlab.mycorp.io': 'glpat-b' });
  });

  test('getAll returns a defensive copy (mutating it does not affect the store)', async () => {
    const store = new TokenStore(new FakeSecretStorage());
    await store.setToken('gitlab.com', 't');
    const copy = await store.getAll();
    delete copy['gitlab.com'];
    expect((await store.getAll())['gitlab.com']).toBe('t');
  });

  test('deleteToken on a missing host is a no-op and fires no change event', async () => {
    const store = new TokenStore(new FakeSecretStorage());
    let changes = 0;
    store.onDidChange(() => { changes++; });
    await store.deleteToken('gitlab.com');
    expect(changes).toBe(0);
  });

  test('deleting the last token empties the map and clears the stored blob', async () => {
    const storage = new FakeSecretStorage();
    const store = new TokenStore(storage);
    await store.setToken('gitlab.com', 't');
    await store.deleteToken('gitlab.com');
    expect(await store.getAll()).toEqual({});
    expect(storage.raw()).toHaveLength(0);
  });

  test('corrupt JSON in the secret is treated as an empty map', async () => {
    const storage = new FakeSecretStorage();
    await storage.store('gitlabCiTokens', '{not json');
    const store = new TokenStore(storage);
    expect(await store.getAll()).toEqual({});
  });

  test('honors a custom secret key', async () => {
    const storage = new FakeSecretStorage();
    const store = new TokenStore(storage, 'myKey');
    await store.setToken('gitlab.com', 't');
    expect(storage.raw().map(([k]) => k)).toEqual(['myKey']);
  });
});

describe('TokenStore host-candidate matching', () => {
  const store = async () => {
    const s = new TokenStore(new FakeSecretStorage());
    await s.setToken('gitlab.com', 'bare');
    await s.setToken('www.gitlab.acme.com', 'with-www');
    await s.setToken('gitlab.portly.io', 'no-port-host-key');
    return s;
  };

  test('matches the exact host first', async () => {
    expect(await (await store()).getToken('gitlab.com')).toBe('bare');
  });

  test('strips a leading www. from the lookup host', async () => {
    // Stored without www., looked up with www.
    const s = new TokenStore(new FakeSecretStorage());
    await s.setToken('gitlab.acme.com', 'x');
    expect(await s.getToken('www.gitlab.acme.com')).toBe('x');
  });

  test('strips a trailing port from the lookup host', async () => {
    const s = new TokenStore(new FakeSecretStorage());
    await s.setToken('gitlab.acme.com', 'x');
    expect(await s.getToken('gitlab.acme.com:8443')).toBe('x');
  });

  test('matches a stored www.-keyed token when looked up with www. (exact)', async () => {
    const s = new TokenStore(new FakeSecretStorage());
    await s.setToken('www.gitlab.acme.com', 'x');
    // Candidates only strip www./port — they never add them (same leniency as the server).
    expect(await s.getToken('www.gitlab.acme.com')).toBe('x');
    expect(await s.getToken('gitlab.acme.com')).toBeUndefined();
  });

  test('returns undefined when nothing matches', async () => {
    const s = new TokenStore(new FakeSecretStorage());
    await s.setToken('other.example.com', 'x');
    expect(await s.getToken('gitlab.com')).toBeUndefined();
  });
});

describe('onDidChange', () => {
  test('fires on setToken and deleteToken, and dispose() stops delivery', async () => {
    const store = new TokenStore(new FakeSecretStorage());
    let count = 0;
    const sub = store.onDidChange(() => { count++; });
    await store.setToken('a', '1');       // +1
    await store.setToken('b', '2');       // +1
    await store.deleteToken('b');         // +1
    sub.dispose();
    await store.setToken('c', '3');       // ignored
    expect(count).toBe(3);
  });

  test('supports multiple listeners; disposing one leaves the other live', async () => {
    const store = new TokenStore(new FakeSecretStorage());
    let a = 0, b = 0;
    const subA = store.onDidChange(() => { a++; });
    store.onDidChange(() => { b++; });
    await store.setToken('h', 't');
    subA.dispose();
    await store.setToken('h', 't2');
    expect(a).toBe(1);
    expect(b).toBe(2);
  });
});

describe('planMigration', () => {
  test('returns null for an empty map', () => {
    expect(planMigration({})).toBeNull();
    expect(planMigration(undefined as unknown as Record<string, string>)).toBeNull();
  });

  test('returns entries for a non-empty map', () => {
    expect(planMigration({ 'gitlab.com': 'glpat-1', 'corp.io': 'glpat-2' })).toEqual({
      entries: [['gitlab.com', 'glpat-1'], ['corp.io', 'glpat-2']],
    });
  });
});
