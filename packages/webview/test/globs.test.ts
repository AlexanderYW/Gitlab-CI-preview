import { describe, expect, test } from 'bun:test';
import { matchGlob, anyGlobMatches } from '../src/globs.js';

describe('matchGlob', () => {
  test('literal paths match exactly', () => {
    expect(matchGlob('CI.yml', 'CI.yml')).toBe(true);
    expect(matchGlob('CI.yml', 'ci.yml')).toBe(false);
  });

  test('* matches within a single path segment', () => {
    expect(matchGlob('*.ts', 'a.ts')).toBe(true);
    expect(matchGlob('*.ts', 'src/a.ts')).toBe(false);
    expect(matchGlob('src/*.ts', 'src/a.ts')).toBe(true);
    expect(matchGlob('src/*.ts', 'src/a/b.ts')).toBe(false);
  });

  test('? matches a single character', () => {
    expect(matchGlob('a?.js', 'ab.js')).toBe(true);
    expect(matchGlob('a?.js', 'abc.js')).toBe(false);
    expect(matchGlob('a?.js', 'a.js')).toBe(false);
  });

  test('** matches across path segments', () => {
    expect(matchGlob('**/*.js', 'b.js')).toBe(true);
    expect(matchGlob('**/*.js', 'a/b.js')).toBe(true);
    expect(matchGlob('**/*.js', 'a/b/c.js')).toBe(true);
    expect(matchGlob('src/**', 'src/x')).toBe(true);
    expect(matchGlob('src/**', 'src/x/y')).toBe(true);
    expect(matchGlob('src/**', 'srcx/y')).toBe(false);
  });

  test('**/ prefix allows zero directories', () => {
    expect(matchGlob('**/test', 'test')).toBe(true);
    expect(matchGlob('**/test', 'a/test')).toBe(true);
    expect(matchGlob('**/test', 'a/b/test')).toBe(true);
    expect(matchGlob('**/test', 'atest')).toBe(false);
  });

  test('**/ in the middle allows zero or more directories', () => {
    expect(matchGlob('src/**/*.ts', 'src/a.ts')).toBe(true);
    expect(matchGlob('src/**/*.ts', 'src/a/b/c.ts')).toBe(true);
    expect(matchGlob('src/**/*.ts', 'other/a.ts')).toBe(false);
  });

  test('character classes', () => {
    expect(matchGlob('f[a-z]o.txt', 'foo.txt')).toBe(true);
    expect(matchGlob('f[a-z]o.txt', 'feo.txt')).toBe(true);
    expect(matchGlob('f[a-z]o.txt', 'f0o.txt')).toBe(false);
    expect(matchGlob('f[!a-z]o.txt', 'f9o.txt')).toBe(true);
    expect(matchGlob('f[!a-z]o.txt', 'foo.txt')).toBe(false);
  });

  test('regex special characters are literal', () => {
    expect(matchGlob('a(b).ts', 'a(b).ts')).toBe(true);
    expect(matchGlob('a(b).ts', 'axb.ts')).toBe(false);
    expect(matchGlob('x+1.yml', 'x+1.yml')).toBe(true);
    expect(matchGlob('v1.0.yml', 'v1.0.yml')).toBe(true);
    expect(matchGlob('v1.0.yml', 'v1X0.yml')).toBe(false);
  });
});

describe('anyGlobMatches', () => {
  const files = ['src/a.ts', 'docs/README.md', 'lib/util.js'];

  test('true when any pattern matches', () => {
    expect(anyGlobMatches(['**/*.md', 'src/**'], 'docs/README.md')).toBe(true);
    expect(anyGlobMatches(['*.md', 'src/**'], 'README.md')).toBe(true);
    expect(anyGlobMatches(['*.md', 'src/**'], 'src/a.ts')).toBe(true);
    expect(anyGlobMatches(['*.md', 'src/**'], 'lib/util.js')).toBe(false);
  });

  test('empty pattern list never matches', () => {
    expect(anyGlobMatches([], 'src/a.ts')).toBe(false);
  });
});
