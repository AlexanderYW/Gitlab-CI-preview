import { describe, expect, test } from 'bun:test';
import type { PipelineModel } from '@gitlab-ci-preview/shared';
import { buildBaseModel } from '../src/parser.js';
import { findUndefinedVariables } from '../src/features/undefinedVars.js';

const URI = 'file:///t/.gitlab-ci.yml';

function modelFor(text: string): PipelineModel {
  return buildBaseModel(URI, text);
}

const run = (text: string) =>
  findUndefinedVariables(modelFor(text), [{ uri: URI, text }]);

describe('findUndefinedVariables', () => {
  test('never flags predefined CI variables', () => {
    const text = [
      'job:',
      '  script:',
      '    - echo $CI_COMMIT_SHA',
      '    - echo ${GITLAB_USER_LOGIN}',
      '    - echo $CI',
      '',
    ].join('\n');
    expect(run(text)).toEqual([]);
  });

  test('respects global and job-level variables', () => {
    const text = [
      'variables:',
      '  GLOBAL_VAR: "1"',
      'job:',
      '  variables:',
      '    JOB_VAR: "2"',
      '  script:',
      '    - echo $GLOBAL_VAR $JOB_VAR',
      '',
    ].join('\n');
    expect(run(text)).toEqual([]);
  });

  test('flags an undefined variable in a job script', () => {
    const text = ['job:', '  script:', '    - echo $TOTALLY_UNDEFINED', ''].join('\n');
    const diags = run(text);
    expect(diags.length).toBe(1);
    expect(diags[0].message).toBe('unknown CI variable "TOTALLY_UNDEFINED"');
    expect(diags[0].severity).toBe('warning');
    expect(diags[0].source).toBe('gitlab-ci');
    expect(diags[0].uri).toBe(URI);
  });

  test('detects the ${VAR} form and points at its exact position', () => {
    const text = ['job:', '  script:', '    - echo "${BRACED_UNDEF}"', ''].join('\n');
    const diags = run(text);
    expect(diags.length).toBe(1);
    // Line 2 (0-based); the `$` of `${BRACED_UNDEF}` sits at character 12.
    expect(diags[0].range.start).toEqual({ line: 2, character: 12 });
    expect(diags[0].range.end.character).toBe(12 + '${BRACED_UNDEF}'.length);
  });

  test('reports one diagnostic per unique variable per job, at the first occurrence', () => {
    const text = [
      'job:',
      '  script:',
      '    - echo $REPEATED_VAR',
      '    - echo $REPEATED_VAR again',
      '    - echo ${REPEATED_VAR}',
      '',
    ].join('\n');
    const diags = run(text);
    expect(diags.length).toBe(1);
    expect(diags[0].range.start.line).toBe(2);
  });

  test('does not scan !reference payloads', () => {
    const text = [
      '.tmpl:',
      '  script: ["echo $ONLY_USED_IN_TEMPLATE"]',
      'job:',
      '  script: !reference [.tmpl, script]',
      '',
    ].join('\n');
    expect(run(text)).toEqual([]);
  });

  test('scans root-scope text (workflow rules) once per occurrence', () => {
    const text = [
      'workflow:',
      '  rules:',
      '    - if: "$ROOT_SCOPE_UNDEF == \'x\'"',
      '    - if: "$ROOT_SCOPE_UNDEF == \'y\'"',
      'job:',
      '  script: ["true"]',
      '',
    ].join('\n');
    const diags = run(text);
    expect(diags.length).toBe(2);
    for (const d of diags) expect(d.message).toBe('unknown CI variable "ROOT_SCOPE_UNDEF"');
  });

  test('is fail-safe on documents that do not parse', () => {
    const model = modelFor('job: [unclosed');
    expect(() =>
      findUndefinedVariables(model, [{ uri: URI, text: '{{{ not yaml :::' }]),
    ).not.toThrow();
    expect(findUndefinedVariables(model, [{ uri: URI, text: '{{{ not yaml :::' }])).toEqual([]);
  });
});
