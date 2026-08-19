import { describe, expect, test } from 'bun:test';
import type { Job } from '@gitlab-ci-preview/shared';
import { validateJobGraph } from '../src/features/validate.js';

const ZERO = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
function job(name: string, stage: string, needs: string[] = [], hidden = false): Job {
  return {
    name, stage, needs, dependencies: [], extends: [], hidden: hidden || name.startsWith('.'),
    source: { uri: 'file:///.gitlab-ci.yml', range: ZERO }, raw: {},
  };
}
function map(jobs: Job[]): Map<string, Job> {
  return new Map(jobs.map((j) => [j.name, j]));
}
const messages = (jobs: Job[], stages: string[]) => validateJobGraph(map(jobs), stages).map((d) => d.message);

describe('validateJobGraph', () => {
  test('flags a job using an undeclared stage', () => {
    const msgs = messages([job('a', 'nope')], ['build', 'test']);
    expect(msgs.some((m) => /uses stage "nope" which is not defined/.test(m))).toBe(true);
  });

  test('allows implicit .pre and .post stages', () => {
    const msgs = messages([job('a', '.pre'), job('b', '.post')], ['build']);
    expect(msgs.length).toBe(0);
  });

  test('flags needs pointing at a later stage', () => {
    const msgs = messages([job('early', 'build', ['late']), job('late', 'test')], ['build', 'test']);
    expect(msgs.some((m) => /needs "late" from later stage "test"/.test(m))).toBe(true);
  });

  test('allows needs within the same or earlier stage', () => {
    const msgs = messages([job('a', 'build'), job('b', 'test', ['a'])], ['build', 'test']);
    expect(msgs.length).toBe(0);
  });

  test('warns on needs of an unknown job', () => {
    const msgs = messages([job('a', 'test', ['ghost'])], ['test']);
    expect(msgs.some((m) => /needs unknown job "ghost"/.test(m))).toBe(true);
  });

  test('detects a needs cycle and reports it once', () => {
    // a → b → c → a, all in the same stage so the later-stage rule doesn't fire.
    const jobs = [job('a', 'test', ['c']), job('b', 'test', ['a']), job('c', 'test', ['b'])];
    const cycleMsgs = messages(jobs, ['test']).filter((m) => /needs cycle detected/.test(m));
    expect(cycleMsgs.length).toBe(1);
  });

  test('ignores hidden template jobs', () => {
    expect(messages([job('.tmpl', 'whatever')], ['build']).length).toBe(0);
  });
});
