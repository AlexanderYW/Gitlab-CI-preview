import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { buildBaseModel } from '../src/parser.js';
import { hover } from '../src/features/hover.js';
import { definition } from '../src/features/definition.js';
import { completion } from '../src/features/completion.js';

const URI = 'file:///root/.gitlab-ci.yml';
const FIXTURE = path.join(import.meta.dir, '..', '..', '..', 'fixtures', 'reference-tag.gitlab-ci.yml');
const FIXTURE_TEXT = readFileSync(FIXTURE, 'utf8');
const fixtureModel = () => buildBaseModel(URI, FIXTURE_TEXT);
const fixtureDoc = () => TextDocument.create(URI, 'yaml', 1, FIXTURE_TEXT);

const valueOf = (h: ReturnType<typeof hover>) => (h && typeof h.contents === 'object' && 'value' in h.contents ? String(h.contents.value) : '');

describe('!reference hover', () => {
  test('shows the resolved value inside a reference tag', () => {
    // Line 21: `  before_script: !reference [.setup, before_script]`
    const h = hover(fixtureModel(), URI, { line: 20, character: 30 }, FIXTURE_TEXT);
    expect(h).not.toBeNull();
    const v = valueOf(h);
    expect(v).toContain('!reference');
    expect(v).toContain('apt-get update');
  });

  test('reports an unknown job inside a reference tag', () => {
    const text = 'build:\n  script: !reference [.nope, script]\n';
    const model = buildBaseModel(URI, text);
    const v = valueOf(hover(model, URI, { line: 1, character: 20 }, text));
    expect(v).toContain('!reference');
    expect(v).toMatch(/unknown job/i);
  });

  test('reports a missing key inside a reference tag', () => {
    const text = '.a:\n  script: [x]\nbuild:\n  script: !reference [.a, nope]\n';
    const model = buildBaseModel(URI, text);
    const v = valueOf(hover(model, URI, { line: 3, character: 20 }, text));
    expect(v).toMatch(/not found/);
  });

  test('keeps regular job hover outside reference tags', () => {
    // Line 19 (`build-job:`) is the job's own key, not inside a tag.
    const model = fixtureModel();
    const job = model.jobs.find((j) => j.name === 'build-job')!;
    const v = valueOf(hover(model, URI, job.source.range.start, FIXTURE_TEXT));
    expect(v).toContain('**build-job**');
    expect(v).not.toContain('!reference');
  });
});

describe('!reference definition', () => {
  test('jumps to the referenced key when it lives in the same document', () => {
    // Line 21: `  before_script: !reference [.setup, before_script]`
    const def = definition(fixtureModel(), fixtureDoc(), { line: 20, character: 30 });
    expect(def).not.toBeNull();
    expect((def as { uri: string }).uri).toBe(URI);
    // The `before_script` value under `.setup` starts on line 4 (0-based).
    expect((def as { range: { start: { line: number } } }).range.start.line).toBe(4);
  });

  test('falls back to the job range for a whole-job reference', () => {
    const text = ['.a:', '  script: [x]', 'job:', '  script: !reference [.a]', '  stage: build'].join('\n');
    const model = buildBaseModel(URI, text);
    const a = model.jobs.find((j) => j.name === '.a')!;
    const def = definition(model, TextDocument.create(URI, 'yaml', 1, text), { line: 3, character: 18 });
    expect(def).not.toBeNull();
    expect((def as { range: typeof a.source.range }).range).toEqual(a.source.range);
  });

  test('returns null when the referenced job does not exist', () => {
    const text = 'build:\n  script: !reference [.nope, script]\n';
    const model = buildBaseModel(URI, text);
    expect(definition(model, TextDocument.create(URI, 'yaml', 1, text), { line: 1, character: 20 })).toBeNull();
  });
});

describe('!reference completion', () => {
  test('completes job names right after the opening bracket', () => {
    // Line 21: cursor just past `!reference [`.
    const labels = completion(fixtureModel(), fixtureDoc(), { line: 20, character: 29 }).map((c) => c.label);
    expect(labels).toContain('.setup');
    expect(labels).toContain('.script-library');
    expect(labels).toContain('build-job');
  });

  test('completes the referenced job\'s top-level keys after the separator', () => {
    // Line 21: cursor after `.setup, `.
    const labels = completion(fixtureModel(), fixtureDoc(), { line: 20, character: 37 }).map((c) => c.label);
    expect(labels).toContain('before_script');
    expect(labels).toContain('variables');
  });

  test('completes job names while typing an unclosed tag', () => {
    const text = '.script-library:\n  install: [x]\nbuild:\n  script: !reference [.sc\n';
    const model = buildBaseModel(URI, text);
    const doc = TextDocument.create(URI, 'yaml', 1, text);
    const labels = completion(model, doc, { line: 3, character: text.split('\n')[3].length }).map((c) => c.label);
    expect(labels).toContain('.script-library');
  });
});
