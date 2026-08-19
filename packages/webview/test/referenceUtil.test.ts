import { describe, expect, test } from 'bun:test';
import type { Job, PipelineModel } from '@gitlab-ci-preview/shared';
import { REFERENCE_MARKER } from '@gitlab-ci-preview/shared';
import { isReference, resolveReference, formatReferencePath } from '../src/referenceUtil.js';

const ZERO = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

function job(name: string, raw: Record<string, unknown>): Job {
  return {
    name, stage: 'test', needs: [], dependencies: [], extends: [],
    hidden: name.startsWith('.'),
    source: { uri: 'file:///.gitlab-ci.yml', range: ZERO },
    raw,
  };
}

function model(jobs: Job[]): PipelineModel {
  return {
    rootUri: 'file:///.gitlab-ci.yml', stages: [], jobs, includes: [],
    diagnostics: [], includedSources: {}, globalVariables: {},
  };
}

describe('referenceUtil', () => {
  test('isReference recognises the reference marker', () => {
    expect(isReference({ [REFERENCE_MARKER]: ['.setup', 'script'] })).toBe(true);
    expect(isReference({ foo: 1 })).toBe(false);
  });

  test('resolves a nested !reference path, tolerating a missing leading dot', () => {
    const m = model([job('.setup', { script: ['echo hi'] })]);
    const r = resolveReference(m, ['setup', 'script']); // note: no leading dot
    expect(r.ok).toBe(true);
    expect(r.targetJob?.name).toBe('.setup');
    expect(r.value).toEqual(['echo hi']);
  });

  test('reports a missing job and a missing key distinctly', () => {
    const m = model([job('.setup', { script: ['x'] })]);
    expect(resolveReference(m, ['nope']).error).toMatch(/not found/);
    expect(resolveReference(m, ['setup', 'missing']).error).toMatch(/key "missing"/);
    expect(resolveReference(m, []).ok).toBe(false);
  });

  test('formatReferencePath joins with a separator', () => {
    expect(formatReferencePath(['.template', 'script'])).toBe('.template › script');
  });
});
