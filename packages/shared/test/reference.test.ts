import { describe, expect, test } from 'bun:test';
import type { Job } from '../src/model.js';
import { parseReference, resolvePath, resolveReference } from '../src/reference.js';

const ZERO = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

function job(name: string, raw: Record<string, unknown>, extra: Partial<Job> = {}): Job {
  return {
    name, stage: 'test', needs: [], dependencies: [], extends: [],
    hidden: name.startsWith('.'),
    source: { uri: 'file:///.gitlab-ci.yml', range: ZERO },
    raw,
    ...extra,
  };
}

describe('parseReference', () => {
  test('parses a bare job name', () => {
    expect(parseReference('build-job')).toEqual({ jobName: 'build-job', keyPath: [] });
  });

  test('parses the bracket form with a single key', () => {
    expect(parseReference('.setup[before_script]')).toEqual({ jobName: '.setup', keyPath: ['before_script'] });
  });

  test('parses the bracket form with a dotted key path', () => {
    expect(parseReference('job[key.subkey]')).toEqual({ jobName: 'job', keyPath: ['key', 'subkey'] });
  });

  test('parses the comma form GitLab documents', () => {
    expect(parseReference(' .setup, before_script ')).toEqual({ jobName: '.setup', keyPath: ['before_script'] });
    expect(parseReference('.script-library, install')).toEqual({ jobName: '.script-library', keyPath: ['install'] });
  });

  test('keeps the leading dot on hidden job names in dot form', () => {
    expect(parseReference('.setup.before_script')).toEqual({ jobName: '.setup', keyPath: ['before_script'] });
  });

  test('returns null for empty or invalid input', () => {
    expect(parseReference('')).toBeNull();
    expect(parseReference('   ')).toBeNull();
    expect(parseReference('.,')).toBeNull();
    expect(parseReference('two words')).toBeNull();
  });
});

describe('resolvePath', () => {
  test('walks nested plain objects', () => {
    const spec = { a: { b: { c: 42 } } };
    expect(resolvePath(spec, ['a', 'b', 'c'])).toEqual({ value: 42, found: true });
  });

  test('reports missing keys and non-object intermediates', () => {
    expect(resolvePath({ a: 1 }, ['a', 'b']).found).toBe(false);
    expect(resolvePath({}, ['nope']).found).toBe(false);
    expect(resolvePath({ a: [1] }, ['a', 'b']).found).toBe(false);
  });

  test('an empty path resolves to the spec itself', () => {
    const spec = { a: 1 };
    expect(resolvePath(spec, [])).toEqual({ value: spec, found: true });
  });
});

describe('resolveReference', () => {
  const jobs = [
    job('.setup', { before_script: ['echo setup'], variables: { NODE_ENV: 'test' } }),
    job('build', { script: ['npm ci'] }),
  ];

  test('resolves a whole-job reference', () => {
    const r = resolveReference('.setup', jobs);
    expect(r).not.toBeNull();
    expect(r!.job.name).toBe('.setup');
    expect(r!.keyPath).toEqual([]);
    expect(r!.resolved).toBe(true);
    expect(r!.value).toMatchObject({ before_script: ['echo setup'], variables: { NODE_ENV: 'test' } });
  });

  test('matches job names case-insensitively and tolerates a missing dot', () => {
    expect(resolveReference('.SETUP, before_script', jobs)?.job.name).toBe('.setup');
    expect(resolveReference('Setup[before_script]', jobs)?.job.name).toBe('.setup');
    expect(resolveReference('BUILD[script]', jobs)?.job.name).toBe('build');
  });

  test('resolves nested paths through the raw spec', () => {
    const nested = [job('.lib', { env: { vars: { A: '1' } } })];
    const r = resolveReference('.lib, env, vars', nested);
    expect(r?.resolved).toBe(true);
    expect(r?.value).toEqual({ A: '1' });
  });

  test('falls back to typed fields when the raw spec lacks them', () => {
    const bare = [job('deploy', {}, { script: ['make deploy'], stage: 'deploy' })];
    const r = resolveReference('deploy[script]', bare);
    expect(r?.resolved).toBe(true);
    expect(r?.value).toEqual(['make deploy']);
  });

  test('reports a missing key as unresolved but keeps the job', () => {
    const r = resolveReference('.setup, nope', jobs);
    expect(r).not.toBeNull();
    expect(r!.job.name).toBe('.setup');
    expect(r!.resolved).toBe(false);
    expect(r!.value).toBeUndefined();
  });

  test('a wildcard segment is unresolved but still names the job', () => {
    const r = resolveReference('build[*]', jobs);
    expect(r).not.toBeNull();
    expect(r!.job.name).toBe('build');
    expect(r!.resolved).toBe(false);
  });

  test('returns null for an unknown job or invalid input', () => {
    expect(resolveReference('nope[script]', jobs)).toBeNull();
    expect(resolveReference('', jobs)).toBeNull();
    expect(resolveReference('!!', jobs)).toBeNull();
  });
});
