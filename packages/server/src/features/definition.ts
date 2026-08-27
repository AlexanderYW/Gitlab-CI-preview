import type { Definition, Position } from 'vscode-languageserver';
import type { PipelineModel, Range } from '@gitlab-ci-preview/shared';
import { parseReference, resolveReference } from '@gitlab-ci-preview/shared';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { isMap, isScalar, type Node, type Pair } from 'yaml';
import { findReferenceAt } from './hover.js';
import { nodeRange, parseYaml } from '../parser.js';

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

/**
 * Range of the nested key a `!reference` points at, when the target job lives
 * in this document. Walks the job's YAML value node through the key path.
 */
function nestedKeyRange(docText: string, jobName: string, keyPath: string[]): Range | null {
  if (keyPath.length === 0) return null;
  const parsed = parseYaml('', docText);
  const target = jobName.toLowerCase();
  const dotted = '.' + target.replace(/^\./, '');
  const entry = parsed.jobEntries.find((e) => e.name.toLowerCase() === target)
    ?? parsed.jobEntries.find((e) => e.name.toLowerCase() === dotted);
  let node: Node | undefined = entry?.valueNode;
  for (const seg of keyPath) {
    if (!node || !isMap(node)) return null;
    const pair = ((node as { items: Pair[] }).items).find(
      (p) => isScalar(p.key) && String((p.key as { value: unknown }).value) === seg,
    );
    if (!pair) return null;
    node = pair.value as Node;
  }
  if (!node) return null;
  return nodeRange(docText, node);
}

export function definition(model: PipelineModel, doc: TextDocument, pos: Position): Definition | null {
  // `!reference[...]` click → jump to the referenced job/key.
  const ref = findReferenceAt(doc.getText(), pos);
  if (ref) {
    const res = resolveReference(ref.raw, model.jobs);
    if (!res) return null;
    // Prefer the exact key's range when the target is defined in this document.
    const parsed = parseReference(ref.raw);
    if (parsed && res.job.source.uri === doc.uri && !parsed.keyPath.includes('*')) {
      const keyRange = nestedKeyRange(doc.getText(), parsed.jobName, parsed.keyPath);
      if (keyRange) return { uri: doc.uri, range: keyRange };
    }
    return { uri: res.job.source.uri, range: res.job.source.range };
  }
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
