import { describe, expect, test } from 'bun:test';
import { parseYaml } from '../src/parser.js';
import { collectStageRenameEdits } from '../src/features/renameStage.js';

function editsFor(text: string, oldName: string, newName: string) {
  const { doc } = parseYaml('file:///test.yml', text);
  return collectStageRenameEdits(doc, text, oldName, newName);
}

/** Slice the source at an edit's range so we can assert what text it targets. */
function targetText(text: string, edit: { range: { start: { line: number; character: number }; end: { line: number; character: number } } }): string {
  const lines = text.split('\n');
  const { start, end } = edit.range;
  if (start.line === end.line) return lines[start.line].slice(start.character, end.character);
  return lines[start.line].slice(start.character);
}

describe('collectStageRenameEdits', () => {
  test('renames the entry in stages: and every matching job stage:', () => {
    const text =
      `stages:\n  - build\n  - test\n` +
      `compile:\n  stage: build\n  script: [make]\n` +
      `unit:\n  stage: test\n  script: [run]\n`;
    const edits = editsFor(text, 'build', 'compile-stage');
    // one in the stages: sequence, one in compile.stage — `unit` (stage: test) is untouched.
    expect(edits.length).toBe(2);
    for (const e of edits) {
      expect(e.newText).toBe('compile-stage');
      expect(targetText(text, e)).toBe('build');
    }
  });

  test('renames default.stage', () => {
    const text = `default:\n  stage: build\nbuild_job:\n  script: [x]\n`;
    const edits = editsFor(text, 'build', 'deploy');
    expect(edits.length).toBe(1);
    expect(edits[0].newText).toBe('deploy');
    expect(targetText(text, edits[0])).toBe('build');
  });

  test('quotes the new name when it is not a bare YAML identifier', () => {
    const text = `stages:\n  - build\njob:\n  stage: build\n  script: [x]\n`;
    const edits = editsFor(text, 'build', 'my stage');
    expect(edits.length).toBe(2);
    expect(edits.every((e) => e.newText === '"my stage"')).toBe(true);
  });

  test('returns no edits when the stage name is absent', () => {
    const text = `stages: [build]\njob:\n  stage: build\n  script: [x]\n`;
    expect(editsFor(text, 'nonexistent', 'whatever')).toEqual([]);
  });

  test('ignores a "stage" key nested under a reserved top-level key', () => {
    // `variables` is reserved — a `stage` key inside it is a variable, not a job stage.
    const text =
      `stages: [build]\n` +
      `variables:\n  stage: build\n` +
      `job:\n  stage: build\n  script: [x]\n`;
    const edits = editsFor(text, 'build', 'release');
    // stages[0] + job.stage = 2; variables.stage must NOT be renamed.
    expect(edits.length).toBe(2);
  });

  test('produces well-formed, non-negative edit ranges', () => {
    const text = `stages: [build]\njob:\n  stage: build\n  script: [x]\n`;
    const edits = editsFor(text, 'build', 'release');
    expect(edits.length).toBeGreaterThan(0);
    for (const e of edits) {
      expect(e.range.start.line).toBeGreaterThanOrEqual(0);
      expect(e.range.start.character).toBeGreaterThanOrEqual(0);
      expect(e.range.end.character).toBeGreaterThanOrEqual(e.range.start.character);
    }
  });
});
