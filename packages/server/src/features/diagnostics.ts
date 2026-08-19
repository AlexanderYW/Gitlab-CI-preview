import {
  DiagnosticSeverity,
  type Connection,
  type Diagnostic as LspDiagnostic,
} from 'vscode-languageserver';
import type { Diagnostic, PipelineModel } from '@gitlab-ci-preview/shared';

function toLsp(d: Diagnostic): LspDiagnostic {
  return {
    range: d.range,
    severity:
      d.severity === 'error' ? DiagnosticSeverity.Error :
      d.severity === 'warning' ? DiagnosticSeverity.Warning :
      d.severity === 'info' ? DiagnosticSeverity.Information :
      DiagnosticSeverity.Hint,
    message: d.message,
    source: d.source ?? 'gitlab-ci',
  };
}

export function publishDiagnostics(connection: Connection, model: PipelineModel) {
  const byUri = new Map<string, LspDiagnostic[]>();
  byUri.set(model.rootUri, []);
  for (const d of model.diagnostics) {
    if (!byUri.has(d.uri)) byUri.set(d.uri, []);
    byUri.get(d.uri)!.push(toLsp(d));
  }
  for (const [uri, diagnostics] of byUri) {
    // Only publish to file:// URIs; included sources are read-only virtual.
    if (!uri.startsWith('file://')) continue;
    connection.sendDiagnostics({ uri, diagnostics });
  }
}
