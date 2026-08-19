import { describe, expect, test, afterEach, mock } from 'bun:test';
import { httpGet, clearHttpCache } from '../src/includes/http.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  clearHttpCache();
});

describe('httpGet negative caching', () => {
  test('a network failure is cached and not re-fetched within the TTL', async () => {
    const f = mock(async () => { throw new Error('ECONNREFUSED'); });
    globalThis.fetch = f as unknown as typeof fetch;

    const r1 = await httpGet('https://example.com/neg-net.yml');
    const r2 = await httpGet('https://example.com/neg-net.yml');

    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    expect(r2.error).toBe(r1.error);
    expect(f).toHaveBeenCalledTimes(1); // second served from the negative cache
  });

  test('a 404 is cached too', async () => {
    const f = mock(async () => new Response('nope', { status: 404 }));
    globalThis.fetch = f as unknown as typeof fetch;

    const r1 = await httpGet('https://example.com/neg-404.yml');
    const r2 = await httpGet('https://example.com/neg-404.yml');

    expect(r1.status).toBe(404);
    expect(r2.status).toBe(404);
    expect(f).toHaveBeenCalledTimes(1);
  });

  test('clearHttpCache forces a refetch', async () => {
    const f = mock(async () => { throw new Error('boom'); });
    globalThis.fetch = f as unknown as typeof fetch;

    await httpGet('https://example.com/neg-clear.yml');
    clearHttpCache();
    await httpGet('https://example.com/neg-clear.yml');

    expect(f).toHaveBeenCalledTimes(2);
  });

  test('a successful fetch is positively cached (no second request)', async () => {
    const f = mock(async () => new Response('ok-body', { status: 200 }));
    globalThis.fetch = f as unknown as typeof fetch;

    const r1 = await httpGet('https://example.com/pos.yml');
    const r2 = await httpGet('https://example.com/pos.yml');

    expect(r1.text).toBe('ok-body');
    expect(r2.text).toBe('ok-body');
    expect(f).toHaveBeenCalledTimes(1);
  });
});
