import { describe, expect, test } from 'bun:test';
import { DiagnosticSeverity, type Connection } from 'vscode-languageserver';
import type { Diagnostic, PipelineModel } from '@gitlab-ci-preview/shared';
import { publishDiagnostics } from '../src/features/diagnostics.js';

const ROOT = 'file:///ws/.gitlab-ci.yml';
const ZERO = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

/** Capture every sendDiagnostics call so we can assert on what was published. */
function fakeConnection() {
  const calls: Array<{ uri: string; diagnostics: any[] }> = [];
  const connection = { sendDiagnostics: (p: any) => calls.push(p) } as unknown as Connection;
  return { connection, calls };
}

function model(diagnostics: Diagnostic[], rootUri = ROOT): PipelineModel {
  return { rootUri, diagnostics } as unknown as PipelineModel;
}

describe('publishDiagnostics', () => {
  test('always clears the root URI even when there are no diagnostics', () => {
    const { connection, calls } = fakeConnection();
    publishDiagnostics(connection, model([]));
    const root = calls.find((c) => c.uri === ROOT);
    expect(root).toBeDefined();
    expect(root!.diagnostics).toEqual([]);
  });

  test('groups diagnostics by URI', () => {
    const otherFile = 'file:///ws/included.yml';
    const { connection, calls } = fakeConnection();
    publishDiagnostics(connection, model([
      { uri: ROOT, range: ZERO, severity: 'error', message: 'a' },
      { uri: ROOT, range: ZERO, severity: 'warning', message: 'b' },
      { uri: otherFile, range: ZERO, severity: 'error', message: 'c' },
    ]));
    expect(calls.find((c) => c.uri === ROOT)!.diagnostics.length).toBe(2);
    expect(calls.find((c) => c.uri === otherFile)!.diagnostics.length).toBe(1);
  });

  test('does not publish to non-file (virtual include) URIs', () => {
    const virtual = 'gitlab-ci://template/Foo.yml';
    const { connection, calls } = fakeConnection();
    publishDiagnostics(connection, model([
      { uri: virtual, range: ZERO, severity: 'error', message: 'in a remote include' },
    ]));
    expect(calls.some((c) => c.uri === virtual)).toBe(false);
  });

  test('maps severities to the LSP enum', () => {
    const { connection, calls } = fakeConnection();
    publishDiagnostics(connection, model([
      { uri: ROOT, range: ZERO, severity: 'error', message: 'e' },
      { uri: ROOT, range: ZERO, severity: 'warning', message: 'w' },
      { uri: ROOT, range: ZERO, severity: 'info', message: 'i' },
      { uri: ROOT, range: ZERO, severity: 'hint', message: 'h' },
    ]));
    const sev = calls.find((c) => c.uri === ROOT)!.diagnostics.map((d) => d.severity);
    expect(sev).toEqual([
      DiagnosticSeverity.Error,
      DiagnosticSeverity.Warning,
      DiagnosticSeverity.Information,
      DiagnosticSeverity.Hint,
    ]);
  });

  test('defaults the diagnostic source to "gitlab-ci"', () => {
    const { connection, calls } = fakeConnection();
    publishDiagnostics(connection, model([
      { uri: ROOT, range: ZERO, severity: 'error', message: 'no source' },
      { uri: ROOT, range: ZERO, severity: 'error', message: 'custom', source: 'gitlab-ci/schema' },
    ]));
    const published = calls.find((c) => c.uri === ROOT)!.diagnostics;
    expect(published[0].source).toBe('gitlab-ci');
    expect(published[1].source).toBe('gitlab-ci/schema');
  });
});
