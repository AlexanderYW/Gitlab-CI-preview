import { describe, expect, test } from 'bun:test';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { buildBaseModel } from '../src/parser.js';
import { completion } from '../src/features/completion.js';

const URI = 'file:///root/.gitlab-ci.yml';
const labels = (text: string, line: number, character: number) => {
  const model = buildBaseModel(URI, text);
  const doc = TextDocument.create(URI, 'yaml', 1, text);
  return completion(model, doc, { line, character }).map((c) => c.label);
};

describe('completion', () => {
  test('suggests top-level keys and snippets on an empty line', () => {
    const out = labels('\n', 0, 0);
    expect(out).toContain('stages');
    expect(out).toContain('workflow');
    expect(out).toContain('job'); // snippet
  });

  test('completes stage names after "stage:"', () => {
    const text = 'stages: [build, test]\njob:\n  stage: \n';
    const out = labels(text, 2, '  stage: '.length);
    expect(out).toEqual(['build', 'test']);
  });

  test('completes job names after "needs:"', () => {
    const text = 'a:\n  script: [x]\nb:\n  needs: \n';
    const out = labels(text, 3, '  needs: '.length);
    expect(out).toContain('a');
  });

  test('completes when: values', () => {
    const text = 'job:\n  when: \n';
    const out = labels(text, 1, '  when: '.length);
    expect(out).toEqual(['on_success', 'on_failure', 'always', 'manual', 'delayed', 'never']);
  });

  test('suggests job keys on an indented partial key', () => {
    const text = 'job:\n  \n';
    const out = labels(text, 1, 2);
    expect(out).toContain('script');
  });
});
