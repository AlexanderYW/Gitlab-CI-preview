import { describe, expect, test } from 'bun:test';
import type { Job, PipelineModel } from '@gitlab-ci-preview/shared';
import { composeJobVariables, expandVars } from '../src/vars.js';

const ZERO = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

function job(name: string, over: Partial<Job> = {}): Job {
  return {
    name,
    stage: over.stage ?? 'test',
    needs: over.needs ?? [],
    dependencies: over.dependencies ?? [],
    extends: over.extends ?? [],
    hidden: over.hidden ?? name.startsWith('.'),
    source: { uri: 'file:///.gitlab-ci.yml', range: ZERO },
    raw: over.raw ?? {},
    ...over,
  };
}

function model(j: Job, over: Partial<PipelineModel> = {}): PipelineModel {
  return {
    rootUri: 'file:///.gitlab-ci.yml',
    stages: ['build', 'test', 'deploy'],
    jobs: [j],
    includes: [],
    diagnostics: [],
    includedSources: {},
    globalVariables: {},
    ...over,
  };
}

describe('expandVars', () => {
  test('expands $VAR and ${VAR}', () => {
    expect(expandVars('a-$FOO-${BAR}', { FOO: '1', BAR: '2' })).toBe('a-1-2');
  });
  test('leaves unknown references intact', () => {
    expect(expandVars('$UNKNOWN', {})).toBe('$UNKNOWN');
  });
});

describe('composeJobVariables', () => {
  test('job vars override global vars (precedence + source)', () => {
    const j = job('build', { variables: { ENV: 'prod' } });
    const m = model(j, { globalVariables: { ENV: 'dev', REGION: 'eu' } });
    const vars = composeJobVariables(j, m);
    const env = vars.find((v) => v.name === 'ENV')!;
    const region = vars.find((v) => v.name === 'REGION')!;
    expect(env.value).toBe('prod');
    expect(env.source).toBe('job');
    expect(region.source).toBe('global');
  });

  test('expands references against the merged scope', () => {
    const j = job('build', { variables: { URL: 'https://$HOST/api' } });
    const m = model(j, { globalVariables: { HOST: 'example.com' } });
    const url = composeJobVariables(j, m).find((v) => v.name === 'URL')!;
    expect(url.value).toBe('https://example.com/api');
    expect(url.unresolved).toBe(false);
  });

  test('flags unresolved references', () => {
    const j = job('build', { variables: { TOKEN: '$SECRET_TOKEN' } });
    const out = composeJobVariables(j, model(j)).find((v) => v.name === 'TOKEN')!;
    expect(out.unresolved).toBe(true);
    expect(out.runtime).toBe(false);
  });

  test('predefined CI vars are runtime, not unresolved', () => {
    const j = job('build', { variables: { IMG: 'registry/$CI_PROJECT_PATH:$CI_COMMIT_SHA' } });
    const out = composeJobVariables(j, model(j)).find((v) => v.name === 'IMG')!;
    expect(out.unresolved).toBe(false);
    expect(out.runtime).toBe(true);
  });

  test('multi-pass expansion resolves chained references', () => {
    const j = job('build', { variables: { A: '$B', B: '$C', C: 'final' } });
    const out = composeJobVariables(j, model(j)).find((v) => v.name === 'A')!;
    expect(out.value).toBe('final');
    expect(out.unresolved).toBe(false);
  });

  test('a self/cyclic reference does not hang and stays unresolved', () => {
    const j = job('build', { variables: { LOOP: '$LOOP' } });
    const out = composeJobVariables(j, model(j)).find((v) => v.name === 'LOOP')!;
    expect(out.unresolved).toBe(true);
  });

  test('matrix axis values join distinct variants', () => {
    const j = job('build', { matrix: [{ NODE: '18' }, { NODE: '20' }] });
    const node = composeJobVariables(j, model(j)).find((v) => v.name === 'NODE')!;
    expect(node.source).toBe('matrix');
    expect(node.value).toBe('18 | 20');
  });

  test('returns empty array when no variables are defined', () => {
    const j = job('build');
    expect(composeJobVariables(j, model(j))).toEqual([]);
  });
});
