import { describe, expect, test } from 'bun:test';
import { parseYaml } from '../src/parser.js';
import { schemaDiagnostics } from '../src/features/schemaValidate.js';

const URI = 'file:///test.yml';
function diags(text: string) {
  const { doc } = parseYaml(URI, text);
  return schemaDiagnostics(URI, text, doc);
}

describe('schemaDiagnostics', () => {
  test('a valid pipeline produces no schema diagnostics', () => {
    const text = `stages: [build]\nbuild:\n  stage: build\n  script:\n    - make\n`;
    expect(diags(text)).toEqual([]);
  });

  test('flags an unknown job property with a friendly message and source', () => {
    const text = `build:\n  stage: build\n  scrippt: [oops]\n  script: [make]\n`;
    const out = diags(text);
    expect(out.length).toBeGreaterThan(0);
    const unknown = out.find((d) => d.message.includes('scrippt'));
    expect(unknown).toBeDefined();
    expect(unknown!.severity).toBe('warning');
    expect(unknown!.source).toBe('gitlab-ci/schema');
    expect(unknown!.uri).toBe(URI);
  });

  test('maps a diagnostic to the offending node, not the document start', () => {
    const text = `build:\n  stage: build\n  scrippt: [oops]\n  script: [make]\n`;
    const out = diags(text);
    const unknown = out.find((d) => d.message.includes('scrippt'));
    // The typo is on line 2 (0-based), so the range must not collapse to the top of the file.
    expect(unknown!.range.start.line).toBeGreaterThan(0);
  });

  test('reports an expected-type mismatch', () => {
    // `script` must be a string or array, not a mapping.
    const text = `build:\n  stage: build\n  script:\n    nested: nope\n`;
    const out = diags(text);
    expect(out.length).toBeGreaterThan(0);
  });

  test('returns no diagnostics for an empty document', () => {
    expect(diags(``)).toEqual([]);
  });

  test('de-duplicates identical diagnostics at the same position', () => {
    const text = `build:\n  stage: build\n  scrippt: [oops]\n  script: [make]\n`;
    const out = diags(text);
    const keys = out.map((d) => `${d.range.start.line}:${d.range.start.character}:${d.message}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
