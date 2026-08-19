import { describe, expect, test } from 'bun:test';
import type { Job, PipelineModel } from '@gitlab-ci-preview/shared';
import { evalIf, evaluateRules, evaluateWorkflow, simulatePipeline, type RuleContext } from '../src/rules.js';

function ctx(variables: Record<string, string>): RuleContext {
  return { variables };
}

const ZERO = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
function job(name: string, over: Partial<Job> = {}): Job {
  return {
    name, stage: over.stage ?? 'test', needs: [], dependencies: [], extends: [],
    hidden: name.startsWith('.'), source: { uri: 'file:///.gitlab-ci.yml', range: ZERO }, raw: {}, ...over,
  };
}
function model(jobs: Job[], over: Partial<PipelineModel> = {}): PipelineModel {
  return {
    rootUri: 'file:///.gitlab-ci.yml', stages: ['build', 'test', 'deploy'], jobs,
    includes: [], diagnostics: [], includedSources: {}, globalVariables: {}, ...over,
  };
}

describe('evalIf', () => {
  test('string equality on a variable', () => {
    expect(evalIf('$CI_COMMIT_BRANCH == "main"', ctx({ CI_COMMIT_BRANCH: 'main' }))).toBe(true);
    expect(evalIf('$CI_COMMIT_BRANCH == "main"', ctx({ CI_COMMIT_BRANCH: 'dev' }))).toBe(false);
  });

  test('inequality', () => {
    expect(evalIf('$CI_COMMIT_BRANCH != "main"', ctx({ CI_COMMIT_BRANCH: 'dev' }))).toBe(true);
  });

  test('bare variable truthiness', () => {
    expect(evalIf('$DEPLOY', ctx({ DEPLOY: 'yes' }))).toBe(true);
    expect(evalIf('$DEPLOY', ctx({ DEPLOY: '' }))).toBe(false);
    expect(evalIf('$DEPLOY', ctx({}))).toBe(false);
  });

  test('null comparison for unset variables', () => {
    expect(evalIf('$MISSING == null', ctx({}))).toBe(true);
    expect(evalIf('$MISSING == null', ctx({ MISSING: 'x' }))).toBe(false);
    expect(evalIf('$SET != null', ctx({ SET: 'x' }))).toBe(true);
  });

  test('regex match with =~ and !~', () => {
    expect(evalIf('$CI_COMMIT_BRANCH =~ /^feature\\//', ctx({ CI_COMMIT_BRANCH: 'feature/x' }))).toBe(true);
    expect(evalIf('$CI_COMMIT_BRANCH =~ /^feature\\//', ctx({ CI_COMMIT_BRANCH: 'main' }))).toBe(false);
    expect(evalIf('$CI_COMMIT_BRANCH !~ /^wip\\//', ctx({ CI_COMMIT_BRANCH: 'main' }))).toBe(true);
  });

  test('boolean combinations and precedence', () => {
    const c = ctx({ CI_PIPELINE_SOURCE: 'push', CI_COMMIT_BRANCH: 'main' });
    expect(evalIf('$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == "main"', c)).toBe(true);
    expect(evalIf('$CI_COMMIT_BRANCH == "dev" || $CI_COMMIT_BRANCH == "main"', c)).toBe(true);
    expect(evalIf('$CI_COMMIT_BRANCH == "dev" && $CI_PIPELINE_SOURCE == "push" || $CI_COMMIT_BRANCH == "main"', c)).toBe(true);
  });

  test('parentheses group expressions', () => {
    const c = ctx({ A: '1', B: '0', C: '1' });
    expect(evalIf('$A == "1" && ($B == "1" || $C == "1")', c)).toBe(true);
    expect(evalIf('$A == "1" && ($B == "1" || $C == "0")', c)).toBe(false);
  });

  test('malformed expression returns a boolean instead of throwing', () => {
    expect(typeof evalIf('$ == == ', ctx({}))).toBe('boolean');
    expect(typeof evalIf('((($X', ctx({}))).toBe('boolean');
  });
});

describe('evaluateRules', () => {
  test('no rules → run', () => {
    expect(evaluateRules(undefined, ctx({}))).toBe('run');
    expect(evaluateRules([], ctx({}))).toBe('run');
  });

  test('first matching rule wins', () => {
    const rules = [
      { if: '$CI_COMMIT_BRANCH == "main"', when: 'manual' },
      { if: '$CI_COMMIT_BRANCH == "dev"', when: 'on_success' },
    ];
    expect(evaluateRules(rules, ctx({ CI_COMMIT_BRANCH: 'main' }))).toBe('manual');
    expect(evaluateRules(rules, ctx({ CI_COMMIT_BRANCH: 'dev' }))).toBe('run');
  });

  test('when: never excludes the job', () => {
    const rules = [{ if: '$CI_COMMIT_BRANCH == "main"', when: 'never' }];
    expect(evaluateRules(rules, ctx({ CI_COMMIT_BRANCH: 'main' }))).toBe('never');
  });

  test('rules present but none match → never', () => {
    const rules = [{ if: '$CI_COMMIT_BRANCH == "main"' }];
    expect(evaluateRules(rules, ctx({ CI_COMMIT_BRANCH: 'dev' }))).toBe('never');
  });

  test('rule without if matches (catch-all)', () => {
    const rules = [
      { if: '$CI_COMMIT_BRANCH == "main"', when: 'never' },
      { when: 'on_success' },
    ];
    expect(evaluateRules(rules, ctx({ CI_COMMIT_BRANCH: 'dev' }))).toBe('run');
  });
});

describe('evaluateWorkflow', () => {
  test('no workflow → pipeline runs', () => {
    expect(evaluateWorkflow(undefined, ctx({}))).toBe(true);
    expect(evaluateWorkflow({}, ctx({}))).toBe(true);
  });

  test('workflow never blocks the pipeline', () => {
    const wf = { rules: [{ if: '$CI_PIPELINE_SOURCE == "schedule"', when: 'never' }, { when: 'always' }] };
    expect(evaluateWorkflow(wf, ctx({ CI_PIPELINE_SOURCE: 'schedule' }))).toBe(false);
    expect(evaluateWorkflow(wf, ctx({ CI_PIPELINE_SOURCE: 'push' }))).toBe(true);
  });

  test('workflow rules present but none match → no pipeline', () => {
    const wf = { rules: [{ if: '$CI_COMMIT_BRANCH == "main"' }] };
    expect(evaluateWorkflow(wf, ctx({ CI_COMMIT_BRANCH: 'dev' }))).toBe(false);
  });
});

describe('simulatePipeline (predefined context)', () => {
  test('tag source sets CI_COMMIT_TAG and not CI_COMMIT_BRANCH', () => {
    const m = model([
      job('on_tag', { rules: [{ if: '$CI_COMMIT_TAG' }] }),
      job('on_branch', { rules: [{ if: '$CI_COMMIT_BRANCH' }] }),
    ]);
    const tag = simulatePipeline(m, { ref: 'v1.0.0', pipelineSource: 'tag' });
    expect(tag.outcomes.on_tag).toBe('run');
    expect(tag.outcomes.on_branch).toBe('never');
  });

  test('CI_COMMIT_REF_PROTECTED is true on the default branch', () => {
    const m = model([job('protected_only', { rules: [{ if: '$CI_COMMIT_REF_PROTECTED == "true"' }] })]);
    expect(simulatePipeline(m, { ref: 'main', pipelineSource: 'push' }).outcomes.protected_only).toBe('run');
    expect(simulatePipeline(m, { ref: 'feature', pipelineSource: 'push' }).outcomes.protected_only).toBe('never');
  });

  test('merge_request_event sets target branch and event type', () => {
    const m = model([job('mr', { rules: [{ if: '$CI_PIPELINE_SOURCE == "merge_request_event" && $CI_MERGE_REQUEST_TARGET_BRANCH_NAME == "main"' }] })]);
    expect(simulatePipeline(m, { ref: 'feature', pipelineSource: 'merge_request_event' }).outcomes.mr).toBe('run');
  });

  test('workflow:rules can block the whole pipeline', () => {
    const m = model(
      [job('a', { rules: [{ when: 'on_success' }] })],
      { workflow: { rules: [{ if: '$CI_PIPELINE_SOURCE == "schedule"', when: 'never' }, { when: 'always' }] } },
    );
    expect(simulatePipeline(m, { ref: 'main', pipelineSource: 'schedule' }).pipelineRuns).toBe(false);
    expect(simulatePipeline(m, { ref: 'main', pipelineSource: 'schedule' }).outcomes.a).toBe('never');
  });
});
