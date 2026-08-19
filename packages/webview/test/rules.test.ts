import { describe, expect, test } from 'bun:test';
import type { Job, PipelineModel } from '@gitlab-ci-preview/shared';
import { evalIf, evaluateRules, evaluateWorkflow, simulatePipeline, type RuleContext } from '../src/rules.js';

function ctx(variables: Record<string, string>, files?: { changed?: string[]; exists?: string[] }): RuleContext {
  return {
    variables,
    ...(files?.changed ? { changedFiles: new Set(files.changed) } : {}),
    ...(files?.exists ? { existsFiles: new Set(files.exists) } : {}),
  };
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

describe('rules:changes / exists', () => {
  const files = { changed: ['src/app.ts', 'docs/notes.md'], exists: ['README.md', 'src/app.ts', 'package.json'] };

  test('changes: matches when a changed file matches a glob', () => {
    expect(evaluateRules([{ changes: ['src/*.ts'] }], ctx({}, files))).toBe('run');
    expect(evaluateRules([{ changes: ['*.json'] }], ctx({}, files))).toBe('never');
  });

  test('changes: accepts a single string', () => {
    expect(evaluateRules([{ changes: 'src/app.ts' }], ctx({}, files))).toBe('run');
    expect(evaluateRules([{ changes: 'nope.yml' }], ctx({}, files))).toBe('never');
  });

  test('changes: when: never inverts the match', () => {
    const rule = [{ changes: ['docs/**', { when: 'never' }] }];
    expect(evaluateRules(rule, ctx({}, { changed: ['src/app.ts'] }))).toBe('run');
    expect(evaluateRules(rule, ctx({}, { changed: ['docs/a.md'] }))).toBe('never');
  });

  test('changes: without a file list falls back to matching (optimistic)', () => {
    expect(evaluateRules([{ changes: ['src/**'] }], ctx({}))).toBe('run');
    expect(evaluateRules([{ changes: ['src/**', { when: 'never' }] }], ctx({}))).toBe('run');
  });

  test('if: and changes: must both match', () => {
    const rules = [{ if: '$CI_COMMIT_BRANCH == "main"', changes: ['src/**'] }];
    expect(evaluateRules(rules, ctx({ CI_COMMIT_BRANCH: 'main' }, files))).toBe('run');
    expect(evaluateRules(rules, ctx({ CI_COMMIT_BRANCH: 'dev' }, files))).toBe('never');
  });

  test('exists: matches when the file is present in the ref', () => {
    expect(evaluateRules([{ exists: ['README.md'] }], ctx({}, files))).toBe('run');
    expect(evaluateRules([{ exists: ['missing.yml'] }], ctx({}, files))).toBe('never');
  });

  test('exists: without a file list falls back to matching (optimistic)', () => {
    expect(evaluateRules([{ exists: ['anything'] }], ctx({}))).toBe('run');
  });

  test('workflow:rules can gate on changes', () => {
    const wf = { rules: [{ changes: ['infra/**'], when: 'on_success' }, { when: 'never' }] };
    expect(evaluateWorkflow(wf, ctx({}, { changed: ['infra/main.tf'] }))).toBe(true);
    expect(evaluateWorkflow(wf, ctx({}, { changed: ['src/a.ts'] }))).toBe(false);
  });
});

describe('legacy only/except', () => {
  test('only: branch name matches CI_COMMIT_BRANCH', () => {
    const m = model([job('deploys', { raw: { only: ['main'] } })]);
    expect(simulatePipeline(m, { ref: 'main', pipelineSource: 'push' }).outcomes.deploys).toBe('run');
    expect(simulatePipeline(m, { ref: 'dev', pipelineSource: 'push' }).outcomes.deploys).toBe('never');
  });

  test('only: tag name matches CI_COMMIT_TAG on tag pipelines', () => {
    const m = model([job('release', { raw: { only: ['v1.0.0'] } })]);
    expect(simulatePipeline(m, { ref: 'v1.0.0', pipelineSource: 'tag' }).outcomes.release).toBe('run');
    expect(simulatePipeline(m, { ref: 'main', pipelineSource: 'push' }).outcomes.release).toBe('never');
  });

  test('only: events keyword matches the pipeline source', () => {
    const m = model([job('nightly', { raw: { only: [{ events: ['schedule'] }] } })]);
    expect(simulatePipeline(m, { ref: 'main', pipelineSource: 'schedule' }).outcomes.nightly).toBe('run');
    expect(simulatePipeline(m, { ref: 'main', pipelineSource: 'push' }).outcomes.nightly).toBe('never');
  });

  test('only: variables keyword requires every VAR=VAL to hold', () => {
    const noVars = model([job('flagged', { raw: { only: [{ variables: ['DEPLOY=yes'] }] } })]);
    expect(simulatePipeline(noVars, { ref: 'main', pipelineSource: 'web' }).outcomes.flagged).toBe('never');
    const withVars = model(
      [job('flagged', { raw: { only: [{ variables: ['DEPLOY=yes'] }] } })],
      { globalVariables: { DEPLOY: 'yes' } },
    );
    expect(simulatePipeline(withVars, { ref: 'main', pipelineSource: 'web' }).outcomes.flagged).toBe('run');
  });

  test('only: parent_pipeline keyword matches trigger pipelines', () => {
    const m = model([job('child', { raw: { only: [{ parent_pipeline: true }] } })]);
    expect(simulatePipeline(m, { ref: 'main', pipelineSource: 'trigger' }).outcomes.child).toBe('run');
    expect(simulatePipeline(m, { ref: 'main', pipelineSource: 'push' }).outcomes.child).toBe('never');
  });

  test('only: changes entry uses the changed file list', () => {
    const m = model([job('rebuild', { raw: { only: [{ changes: ['src/**'] }] } })]);
    const sim = (files?: string[]) => simulatePipeline(m, { ref: 'main', pipelineSource: 'push', changedFiles: files });
    expect(sim(['src/a.ts']).outcomes.rebuild).toBe('run');
    expect(sim(['docs/a.md']).outcomes.rebuild).toBe('never');
    expect(sim(undefined).outcomes.rebuild).toBe('run'); // optimistic when no file data is available
  });

  test('except: excludes matching refs', () => {
    const m = model([job('stable', { raw: { except: ['dev'] } })]);
    expect(simulatePipeline(m, { ref: 'dev', pipelineSource: 'push' }).outcomes.stable).toBe('never');
    expect(simulatePipeline(m, { ref: 'main', pipelineSource: 'push' }).outcomes.stable).toBe('run');
  });

  test('only + except: only counts when except does not match', () => {
    const m = model([job('both', { raw: { only: ['main', 'dev'], except: ['dev'] } })]);
    expect(simulatePipeline(m, { ref: 'main', pipelineSource: 'push' }).outcomes.both).toBe('run');
    expect(simulatePipeline(m, { ref: 'dev', pipelineSource: 'push' }).outcomes.both).toBe('never');
    expect(simulatePipeline(m, { ref: 'feature', pipelineSource: 'push' }).outcomes.both).toBe('never');
  });

  test('rules: takes precedence over only/except', () => {
    // The parser populates the typed `rules` field from the merged raw spec.
    const m = model([
      job('wins', { rules: [{ when: 'manual' }], raw: { rules: [{ when: 'manual' }], only: ['dev'] } }),
    ]);
    expect(simulatePipeline(m, { ref: 'main', pipelineSource: 'push' }).outcomes.wins).toBe('manual');
  });

  test('workflow:only gates the whole pipeline', () => {
    const m = model([job('a', { rules: [{ when: 'on_success' }] })], { workflow: { only: ['main'] } });
    expect(simulatePipeline(m, { ref: 'main', pipelineSource: 'push' }).pipelineRuns).toBe(true);
    expect(simulatePipeline(m, { ref: 'dev', pipelineSource: 'push' }).pipelineRuns).toBe(false);
  });

  test('workflow:except blocks the whole pipeline', () => {
    const m = model([job('a', { rules: [{ when: 'on_success' }] })], { workflow: { except: ['dev'] } });
    expect(simulatePipeline(m, { ref: 'dev', pipelineSource: 'push' }).pipelineRuns).toBe(false);
    expect(simulatePipeline(m, { ref: 'main', pipelineSource: 'push' }).pipelineRuns).toBe(true);
  });
});
