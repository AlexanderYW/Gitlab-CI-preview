import { describe, expect, test } from 'bun:test';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { buildBaseModel } from '../src/parser.js';
import { definition } from '../src/features/definition.js';

const URI = 'file:///root/.gitlab-ci.yml';
const docOf = (text: string) => TextDocument.create(URI, 'yaml', 1, text);

describe('definition', () => {
  test('jumps from an extends reference to the parent job', () => {
    const text = ['.base:', '  script: [a]', 'job:', '  extends: .base', '  stage: build'].join('\n');
    const model = buildBaseModel(URI, text);
    const base = model.jobs.find((j) => j.name === '.base')!;
    // Line 3 = "  extends: .base"; char 13 sits inside ".base".
    const def = definition(model, docOf(text), { line: 3, character: 13 });
    expect(def).not.toBeNull();
    expect((def as { uri: string }).uri).toBe(URI);
    expect((def as { range: typeof base.source.range }).range).toEqual(base.source.range);
  });

  test('tolerates a missing leading dot on the referenced name', () => {
    const text = ['.base:', '  script: [a]', 'job:', '  extends: base'].join('\n');
    const model = buildBaseModel(URI, text);
    const def = definition(model, docOf(text), { line: 3, character: 13 });
    expect(def).not.toBeNull();
  });

  test('returns null when the word matches no job', () => {
    const text = ['job:', '  extends: nope', '  script: [a]'].join('\n');
    const model = buildBaseModel(URI, text);
    expect(definition(model, docOf(text), { line: 1, character: 13 })).toBeNull();
  });
});
