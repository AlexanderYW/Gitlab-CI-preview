import { describe, expect, test } from 'bun:test';
import { convertOnlyExceptToRules, hasOnlyExcept } from '../src/migrate.js';

describe('hasOnlyExcept', () => {
  test('true when only or except is present', () => {
    expect(hasOnlyExcept({ only: ['main'] })).toBe(true);
    expect(hasOnlyExcept({ except: ['main'] })).toBe(true);
    expect(hasOnlyExcept({ only: 'main', script: ['x'] })).toBe(true);
  });

  test('false otherwise', () => {
    expect(hasOnlyExcept({ script: ['x'] })).toBe(false);
    expect(hasOnlyExcept({ rules: [{ if: '$CI_COMMIT_BRANCH == "main"' }] })).toBe(false);
    expect(hasOnlyExcept({})).toBe(false);
  });
});

describe('convertOnlyExceptToRules', () => {
  test('only refs minus except refs, with negated except clause', () => {
    expect(convertOnlyExceptToRules(['main', 'dev'], ['dev'])).toEqual([
      { if: '($CI_COMMIT_BRANCH == "main" || $CI_COMMIT_TAG == "main") && !($CI_COMMIT_BRANCH == "dev" || $CI_COMMIT_TAG == "dev")' },
    ]);
  });

  test('only: object with changes → changes rule key, no if', () => {
    expect(convertOnlyExceptToRules([{ changes: ['src/**'] }], undefined)).toEqual([
      { changes: ['src/**'] },
    ]);
  });

  test('bare changes keyword → changes: ["**/*"]', () => {
    expect(convertOnlyExceptToRules(['changes'], undefined)).toEqual([{ changes: ['**/*'] }]);
  });

  test('object events → OR-joined pipeline source conditions', () => {
    expect(convertOnlyExceptToRules([{ events: ['schedule'] }], undefined)).toEqual([
      { if: '$CI_PIPELINE_SOURCE == "schedule"' },
    ]);
    expect(convertOnlyExceptToRules([{ events: ['schedule', 'web'] }], undefined)).toEqual([
      { if: '$CI_PIPELINE_SOURCE == "schedule" || $CI_PIPELINE_SOURCE == "web"' },
    ]);
  });

  test('except-only refs → negated if', () => {
    expect(convertOnlyExceptToRules(undefined, ['prod'])).toEqual([
      { if: '!($CI_COMMIT_BRANCH == "prod" || $CI_COMMIT_TAG == "prod")' },
    ]);
  });

  test('multiple only refs OR-joined', () => {
    expect(convertOnlyExceptToRules(['main', 'dev'], undefined)).toEqual([
      { if: '($CI_COMMIT_BRANCH == "main" || $CI_COMMIT_TAG == "main") || ($CI_COMMIT_BRANCH == "dev" || $CI_COMMIT_TAG == "dev")' },
    ]);
  });

  test('parent_pipeline keyword and object form → trigger source', () => {
    expect(convertOnlyExceptToRules(['parent_pipeline'], undefined)).toEqual([
      { if: '$CI_PIPELINE_SOURCE == "trigger"' },
    ]);
    expect(convertOnlyExceptToRules([{ parent_pipeline: true }], undefined)).toEqual([
      { if: '$CI_PIPELINE_SOURCE == "trigger"' },
    ]);
  });

  test('scalar only/except values are treated as single entries', () => {
    expect(convertOnlyExceptToRules('main', undefined)).toEqual([
      { if: '($CI_COMMIT_BRANCH == "main" || $CI_COMMIT_TAG == "main")' },
    ]);
    expect(convertOnlyExceptToRules(undefined, 'prod')).toEqual([
      { if: '!($CI_COMMIT_BRANCH == "prod" || $CI_COMMIT_TAG == "prod")' },
    ]);
  });

  test('scalar changes is normalized to an array', () => {
    expect(convertOnlyExceptToRules([{ changes: 'src/**' }], undefined)).toEqual([
      { changes: ['src/**'] },
    ]);
  });

  test('variables pass through as a rule key', () => {
    expect(convertOnlyExceptToRules([{ variables: 'DEBUG=1' }], undefined)).toEqual([
      { variables: 'DEBUG=1' },
    ]);
  });

  test('changes + events combine into one rule (if + rule key)', () => {
    expect(convertOnlyExceptToRules([{ changes: ['a/**'], events: ['schedule'] }], undefined)).toEqual([
      { if: '$CI_PIPELINE_SOURCE == "schedule"', changes: ['a/**'] },
    ]);
  });

  test('refs + sources wrap the positive clause in parens before the except negation', () => {
    expect(convertOnlyExceptToRules(['main', { events: ['schedule'] }], ['dev'])).toEqual([
      { if: '(($CI_COMMIT_BRANCH == "main" || $CI_COMMIT_TAG == "main") || $CI_PIPELINE_SOURCE == "schedule") && !($CI_COMMIT_BRANCH == "dev" || $CI_COMMIT_TAG == "dev")' },
    ]);
  });

  test('bare changes keyword in except is unsupported and skipped', () => {
    expect(convertOnlyExceptToRules(['main'], ['changes'])).toEqual([
      { if: '($CI_COMMIT_BRANCH == "main" || $CI_COMMIT_TAG == "main")' },
    ]);
  });

  test('dedupes repeated refs and sources', () => {
    expect(convertOnlyExceptToRules(['main', 'main', 'parent_pipeline', { events: ['trigger'] }], undefined)).toEqual([
      { if: '($CI_COMMIT_BRANCH == "main" || $CI_COMMIT_TAG == "main") || $CI_PIPELINE_SOURCE == "trigger"' },
    ]);
  });

  test('always returns exactly one rule and survives malformed input', () => {
    expect(convertOnlyExceptToRules(undefined, undefined)).toEqual([{}]);
    expect(convertOnlyExceptToRules(null, null)).toEqual([{}]);
    expect(convertOnlyExceptToRules([42, null, [1, 2], { unknown: true }], [])).toEqual([
      { if: '($CI_COMMIT_BRANCH == "42" || $CI_COMMIT_TAG == "42")' },
    ]);
    expect(convertOnlyExceptToRules({ events: 'web' }, { parent_pipeline: false, changes: ['x/**'] })).toEqual([
      { if: '$CI_PIPELINE_SOURCE == "web"' },
    ]);
  });
});
