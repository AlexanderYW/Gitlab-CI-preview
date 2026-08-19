import { describe, expect, test } from 'bun:test';
import { buildBaseModel } from '../src/parser.js';
import { hover } from '../src/features/hover.js';

const URI = 'file:///root/.gitlab-ci.yml';
const valueOf = (h: ReturnType<typeof hover>) => (h && typeof h.contents === 'object' && 'value' in h.contents ? String(h.contents.value) : '');

describe('hover', () => {
  test('shows job metadata at a job position', () => {
    const text = `stages: [build]\nbuild:\n  stage: build\n  image: node:20\n  script: ['echo hi']\n`;
    const model = buildBaseModel(URI, text);
    const job = model.jobs.find((j) => j.name === 'build')!;
    const h = hover(model, URI, job.source.range.start);
    expect(h).not.toBeNull();
    const v = valueOf(h);
    expect(v).toContain('build');
    expect(v).toContain('node:20');
  });

  test('expands $VARS in the script preview', () => {
    const text = `variables:\n  GREETING: hello\nbuild:\n  stage: build\n  script: ['echo $GREETING']\n`;
    const model = buildBaseModel(URI, text);
    const job = model.jobs.find((j) => j.name === 'build')!;
    const v = valueOf(hover(model, URI, job.source.range.start));
    expect(v).toContain('echo hello');
  });

  test('hovers an include and reports its kind', () => {
    const text = `include:\n  - local: child.yml\nbuild:\n  script: [a]\n`;
    const model = buildBaseModel(URI, text);
    const inc = model.includes[0];
    const v = valueOf(hover(model, URI, inc.source.range.start));
    expect(v).toContain('include');
    expect(v).toContain('local');
  });

  test('returns null when not over a job or include', () => {
    const text = `stages: [build]\nbuild:\n  stage: build\n  script: [a]\n`;
    const model = buildBaseModel(URI, text);
    // Line 0 is the `stages:` line — not inside any job range.
    expect(hover(model, URI, { line: 0, character: 0 })).toBeNull();
  });

  test('ignores positions in a different document', () => {
    const text = `build:\n  stage: build\n  script: [a]\n`;
    const model = buildBaseModel(URI, text);
    const job = model.jobs.find((j) => j.name === 'build')!;
    expect(hover(model, 'file:///other.yml', job.source.range.start)).toBeNull();
  });
});
