import { describe, expect, mock, test } from 'bun:test';

// extension.ts imports 'vscode' and 'vscode-languageclient', neither of which can
// load under bun:test. Stub 'vscode' with no-op constructor functions for every
// symbol the language client subclasses at import time, so the pure helpers below
// can be imported without the real API.
const stubClass = class Stub {};
const vscodeStub = Object.fromEntries(
  [
    'CallHierarchyItem', 'CancellationError', 'CodeAction', 'CodeLens', 'CompletionItem',
    'Diagnostic', 'DocumentLink', 'InlayHint', 'SymbolInformation', 'TypeHierarchyItem',
  ].map((name) => [name, stubClass]),
);
mock.module('vscode', () => vscodeStub);

const { anchorLintMessage } = await import('../src/extension.js');

/** Mirrors the shape exported from extension.ts (kept local: no `import type` after top-level await). */
interface LspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

const buildJob = (line: number, char = 0): LspRange => ({
  start: { line, character: char },
  end: { line, character: char + 5 },
});

describe('anchorLintMessage', () => {
  test('matches a job name mentioned mid-message and returns its exact range', () => {
    const range = buildJob(3);
    const jobs = new Map([['build', range]]);
    expect(anchorLintMessage("job 'build': unknown keyword 'runn'", jobs)).toBe(range);
  });

  test('returns null when no job name matches', () => {
    const jobs = new Map([['build', buildJob(0)]]);
    expect(anchorLintMessage("job 'deploy' is invalid", jobs)).toBeNull();
  });

  test('first matching job wins when multiple are mentioned', () => {
    const first = buildJob(1);
    const second = buildJob(2);
    const jobs = new Map([['build', first], ['test', second]]);
    expect(anchorLintMessage("'test' cannot depend on 'build'", jobs)).toBe(first);
  });

  test('returns null for an empty job map', () => {
    expect(anchorLintMessage('any message', new Map())).toBeNull();
  });
});
