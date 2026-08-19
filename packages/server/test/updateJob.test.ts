import { describe, expect, test } from 'bun:test';
import { parseYaml } from '../src/parser.js';
import { buildJobUpdateEdit } from '../src/features/updateJob.js';

describe('buildJobUpdateEdit', () => {
  test('rewrites a top-level job', () => {
    const text = `stages: [build, test]\n\nbuild:\n  stage: build\n  script: ['echo old']\n`;
    const parsed = parseYaml('file:///x.yml', text);
    const edit = buildJobUpdateEdit(parsed.doc, text, 'build', {
      stage: 'build',
      image: 'node:20',
      script: ['npm ci', 'npm run build'],
    });
    expect(edit).not.toBeNull();
    const next = text.slice(0, offset(text, edit!.range.start)) + edit!.newText + text.slice(offset(text, edit!.range.end));
    expect(next).toContain('image: node:20');
    expect(next).toContain('- npm ci');
    expect(next).toContain('- npm run build');
  });

  test('returns null for an unknown job', () => {
    const text = `a:\n  script: [x]\n`;
    const parsed = parseYaml('file:///x.yml', text);
    expect(buildJobUpdateEdit(parsed.doc, text, 'no_such_job', {})).toBeNull();
  });
});

function offset(text: string, pos: { line: number; character: number }): number {
  let line = 0, off = 0;
  for (let i = 0; i < text.length; i++) {
    if (line === pos.line) return off + pos.character;
    if (text.charCodeAt(i) === 10) { line++; off = i + 1; }
  }
  return text.length;
}
