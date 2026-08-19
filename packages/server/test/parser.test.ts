import { describe, expect, test } from 'bun:test';
import { buildBaseModel, extractIncludes, parseYaml } from '../src/parser.js';
import { REFERENCE_MARKER, isReferenceMarker } from '@gitlab-ci-preview/shared';
import { stringify } from 'yaml';
import { REFERENCE_TAG } from '../src/referenceTag.js';

const URI = 'file:///root/.gitlab-ci.yml';

describe('parser', () => {
  test('extracts jobs and stages from a basic pipeline', () => {
    const text = `stages: [build, test]\nbuild:\n  stage: build\n  script: ['echo hi']\ntest:\n  stage: test\n  needs: [build]\n  script: ['echo bye']\n`;
    const model = buildBaseModel(URI, text);
    expect(model.stages).toEqual(['build', 'test']);
    expect(model.jobs.length).toBe(2);
    const test_ = model.jobs.find((j) => j.name === 'test')!;
    expect(test_.needs).toEqual(['build']);
    expect(test_.script).toEqual(['echo bye']);
  });

  test('detects hidden jobs', () => {
    const text = `.hidden:\n  script: [a]\nreal:\n  script: [b]\n`;
    const model = buildBaseModel(URI, text);
    expect(model.jobs.find((j) => j.name === '.hidden')!.hidden).toBe(true);
    expect(model.jobs.find((j) => j.name === 'real')!.hidden).toBe(false);
  });

  test('parses all include kinds', () => {
    const text = `include:
  - local: /a.yml
  - remote: https://example.com/x.yml
  - template: Auto-DevOps.gitlab-ci.yml
  - project: g/p
    ref: main
    file: /b.yml
  - component: gitlab.com/g/c/comp@1.0.0
`;
    const parsed = parseYaml(URI, text);
    const incs = extractIncludes(parsed);
    expect(incs.map((i) => i.kind)).toEqual(['local', 'remote', 'template', 'project', 'component']);
    const project = incs.find((i) => i.kind === 'project')!;
    expect(project.project).toBe('g/p');
    expect(project.ref).toBe('main');
    expect(project.file).toBe('/b.yml');
  });

  test('reports YAML parse errors as diagnostics', () => {
    const text = `foo: [\n`;
    const parsed = parseYaml(URI, text);
    expect(parsed.diagnostics.length).toBeGreaterThan(0);
    expect(parsed.diagnostics[0].severity).toBe('error');
  });

  test('expands parallel:matrix into variants (cross-product of array values)', () => {
    const text = `deploy:
  stage: deploy
  parallel:
    matrix:
      - PROVIDER: aws
        STACK: [monitoring, app1]
      - PROVIDER: [gcp, vultr]
        STACK: data
`;
    const model = buildBaseModel(URI, text);
    const job = model.jobs.find((j) => j.name === 'deploy')!;
    expect(job.matrix).toEqual([
      { PROVIDER: 'aws', STACK: 'monitoring' },
      { PROVIDER: 'aws', STACK: 'app1' },
      { PROVIDER: 'gcp', STACK: 'data' },
      { PROVIDER: 'vultr', STACK: 'data' },
    ]);
  });

  test('numeric parallel does not produce a matrix', () => {
    const text = `run:\n  parallel: 3\n  script: [a]\n`;
    const model = buildBaseModel(URI, text);
    const job = model.jobs.find((j) => j.name === 'run')!;
    expect(job.parallel).toBe(3);
    expect(job.matrix).toBeUndefined();
  });

  test('preserves !reference tags as markers in job.raw', () => {
    const text = [
      '.setup:',
      '  before_script: [echo go]',
      'build:',
      '  before_script: !reference [.setup, before_script]',
      '  script:',
      '    - !reference [.setup, before_script]',
      '    - echo build',
      '',
    ].join('\n');
    const model = buildBaseModel(URI, text);
    const build = model.jobs.find((j) => j.name === 'build')!;
    expect(isReferenceMarker(build.raw.before_script)).toBe(true);
    expect((build.raw.before_script as any)[REFERENCE_MARKER]).toEqual(['.setup', 'before_script']);
    const script = build.raw.script as unknown[];
    expect(Array.isArray(script)).toBe(true);
    expect(isReferenceMarker(script[0])).toBe(true);
    expect(script[1]).toBe('echo build');
  });

  test('round-trips !reference markers through stringify', () => {
    const value = {
      before_script: { [REFERENCE_MARKER]: ['.setup', 'before_script'] },
      script: [{ [REFERENCE_MARKER]: ['.setup', 'before_script'] }, 'echo done'],
    };
    const out = stringify({ build: value }, { customTags: [REFERENCE_TAG], lineWidth: 0 });
    expect(out).toMatch(/!reference \[\s*\.setup,\s*before_script\s*\]/);
    expect(out).not.toContain('__gitlabReference');
  });

  test('source ranges point at the job key', () => {
    const text = `alpha:\n  script: [x]\n`;
    const model = buildBaseModel(URI, text);
    const j = model.jobs[0];
    expect(j.source.range.start.line).toBe(0);
    expect(j.source.range.start.character).toBe(0);
  });
});
