import { describe, expect, test } from 'bun:test';
import { parseYaml } from '../src/parser.js';
import { collectMigrateOnlyExceptEdits, findMigratableJobAt } from '../src/features/migrateOnlyExcept.js';

function migrate(text: string) {
  const { doc } = parseYaml('file:///test.yml', text);
  return collectMigrateOnlyExceptEdits(doc, text);
}

/** Apply an edit's range to the source so we can assert the resulting YAML. */
function applyEdit(text: string, edit: { range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }): string {
  const lines = text.split('\n');
  const { start, end } = edit.range;
  if (start.line === end.line) {
    lines[start.line] = lines[start.line].slice(0, start.character) + edit.newText + lines[start.line].slice(end.character);
    return lines.join('\n');
  }
  return [
    ...lines.slice(0, start.line),
    lines[start.line].slice(0, start.character) + edit.newText,
    lines[end.line].slice(end.character),
    ...lines.slice(end.line + 1),
  ].join('\n');
}

describe('collectMigrateOnlyExceptEdits', () => {
  test('converts a job with only refs into a rules block', () => {
    const text =
      `stages: [build]\n` +
      `deploy:\n  only:\n    - main\n    - tags\n  script: [echo hi]\n`;
    const res = migrate(text);
    expect(res.jobs).toEqual(['deploy']);
    expect(res.edits.length).toBe(1);

    const next = applyEdit(text, res.edits[0]);
    expect(next).toContain('rules:');
    expect(next).toContain('- if: ($CI_COMMIT_BRANCH == "main" || $CI_COMMIT_TAG == "main") || ($CI_COMMIT_BRANCH == "tags" || $CI_COMMIT_TAG == "tags")');
    expect(next).not.toContain('only:');
    // untouched keys survive
    expect(next).toContain('echo hi');
    // and the result still parses
    const reparsed = parseYaml('file:///test.yml', next);
    expect(reparsed.diagnostics.length).toBe(0);
  });

  test('folds except into a negated clause and keeps other job keys', () => {
    const text =
      `job_a:\n  stage: build\n  except:\n    - prod\n  script: [x]\n`;
    const res = migrate(text);
    expect(res.jobs).toEqual(['job_a']);
    const next = applyEdit(text, res.edits[0]);
    expect(next).toContain('stage: build');
    expect(next).toContain('!($CI_COMMIT_BRANCH == "prod" || $CI_COMMIT_TAG == "prod")');
    expect(next).not.toContain('except:');
  });

  test('returns no edits when no job uses only/except', () => {
    const text =
      `stages: [build]\n` +
      `build:\n  stage: build\n  rules:\n    - if: '$CI_COMMIT_BRANCH == "main"'\n  script: [x]\n` +
      `other:\n  script: [y]\n`;
    const res = migrate(text);
    expect(res.jobs).toEqual([]);
    expect(res.edits).toEqual([]);
  });

  test('skips reserved top-level keys that happen to contain only/except-shaped maps', () => {
    const text =
      `workflow:\n  only:\n    - main\n` +
      `real_job:\n  only: [main]\n  script: [x]\n`;
    const res = migrate(text);
    expect(res.jobs).toEqual(['real_job']);
  });

  test('leaves jobs that already have rules untouched (no unsafe merge)', () => {
    const text =
      `mixed:\n  only: [main]\n  rules:\n    - if: '"true"'\n  script: [x]\n`;
    const res = migrate(text);
    expect(res.jobs).toEqual([]);
    expect(res.edits).toEqual([]);
  });

  test('edits are non-overlapping and well-formed', () => {
    const text =
      `a:\n  only: [main]\n  script: [x]\n` +
      `b:\n  except: [dev]\n  script: [y]\n`;
    const res = migrate(text);
    expect(res.jobs.sort()).toEqual(['a', 'b']);
    for (const e of res.edits) {
      expect(e.range.start.line).toBeGreaterThanOrEqual(0);
      expect(e.range.end.character).toBeGreaterThanOrEqual(e.range.start.character);
    }
    // Applying both edits yields a document with no legacy keys left.
    let next = text;
    for (const e of [...res.edits].sort((x, y2) => y2.range.start.line - x.range.start.line)) {
      next = applyEdit(next, e);
    }
    expect(next).not.toContain('only:');
    expect(next).not.toContain('except:');
    expect(parseYaml('file:///test.yml', next).diagnostics.length).toBe(0);
  });
});

describe('findMigratableJobAt', () => {
  const text =
    `stages: [build]\n` +
    `deploy:\n  only: [main]\n  script: [echo hi]\n` +
    `plain:\n  script: [x]\n`;

  function at(line: number, character: number) {
    const { doc } = parseYaml('file:///test.yml', text);
    return findMigratableJobAt(doc, text, { line, character });
  }

  test('finds the migratable job under the cursor', () => {
    expect(at(1, 0)?.name).toBe('deploy');   // on the job key
    expect(at(2, 8)?.name).toBe('deploy');   // inside `only: [main]`
  });

  test('returns null outside jobs or on non-migratable ones', () => {
    expect(at(4, 3)).toBeNull();             // inside `plain`
    expect(at(0, 0)).toBeNull();             // stages:
  });
});
