import type { Definition, Position } from 'vscode-languageserver';
import type { PipelineModel } from '@gitlab-ci-preview/shared';
import { TextDocument } from 'vscode-languageserver-textdocument';

function within(r: { start: Position; end: Position }, pos: Position): boolean {
  if (pos.line < r.start.line || pos.line > r.end.line) return false;
  if (pos.line === r.start.line && pos.character < r.start.character) return false;
  if (pos.line === r.end.line && pos.character > r.end.character) return false;
  return true;
}

/** Word under cursor (job names may contain dots, underscores, dashes). */
function wordAt(doc: TextDocument, pos: Position): string | null {
  const text = doc.getText();
  const offset = doc.offsetAt(pos);
  const isWord = (ch: string) => /[A-Za-z0-9_.\-:/]/.test(ch);
  let s = offset, e = offset;
  while (s > 0 && isWord(text[s - 1])) s--;
  while (e < text.length && isWord(text[e])) e++;
  const w = text.slice(s, e).trim();
  return w || null;
}

export function definition(model: PipelineModel, doc: TextDocument, pos: Position): Definition | null {
  // Include click → jump to resolved file.
  for (const inc of model.includes) {
    if (inc.source.uri !== doc.uri) continue;
    if (!within(inc.source.range, pos)) continue;
    if (!inc.resolvedUri) return null;
    return {
      uri: inc.resolvedUri,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    };
  }
  // extends: <jobName> click → jump to that job's source location.
  const w = wordAt(doc, pos);
  if (!w) return null;
  const target = model.jobs.find((j) => j.name === w || j.name === '.' + w);
  if (!target) return null;
  return { uri: target.source.uri, range: target.source.range };
}
