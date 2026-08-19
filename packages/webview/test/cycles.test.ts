import { describe, expect, test } from 'bun:test';
import type { Job } from '@gitlab-ci-preview/shared';
import { detectCycles, edgeKey } from '../src/cycles.js';

const ZERO = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

function job(name: string, needs: string[] = []): Job {
  return {
    name, stage: 'test', needs, dependencies: [], extends: [],
    hidden: name.startsWith('.'),
    source: { uri: 'file:///.gitlab-ci.yml', range: ZERO }, raw: {},
  };
}

describe('detectCycles', () => {
  test('no cycle in an acyclic graph', () => {
    const out = detectCycles([job('a'), job('b', ['a']), job('c', ['b'])]);
    expect(out.nodes.size).toBe(0);
    expect(out.edges.size).toBe(0);
  });

  test('two-node cycle marks both nodes and both edges', () => {
    const out = detectCycles([job('a', ['b']), job('b', ['a'])]);
    expect([...out.nodes].sort()).toEqual(['a', 'b']);
    expect(out.edges.has(edgeKey('a', 'b'))).toBe(true);
    expect(out.edges.has(edgeKey('b', 'a'))).toBe(true);
  });

  test('three-node cycle', () => {
    const out = detectCycles([job('a', ['c']), job('b', ['a']), job('c', ['b'])]);
    expect([...out.nodes].sort()).toEqual(['a', 'b', 'c']);
  });

  test('ignores needs pointing at unknown jobs', () => {
    const out = detectCycles([job('a', ['ghost'])]);
    expect(out.nodes.size).toBe(0);
  });

  test('a node outside the cycle is not marked', () => {
    const out = detectCycles([job('a', ['b']), job('b', ['a']), job('safe', ['a'])]);
    expect(out.nodes.has('safe')).toBe(false);
  });
});
