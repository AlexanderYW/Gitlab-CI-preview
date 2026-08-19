import { isMap, isScalar, stringify, type Document, type Pair, type Scalar, type YAMLMap } from 'yaml';
import type { RenameStageEdit } from '@gitlab-ci-preview/shared';
import { nodeRange } from '../parser.js';
import { REFERENCE_TAG } from '../referenceTag.js';

/**
 * Build a text edit that replaces the YAML value of `jobName` with the supplied JS value.
 *
 * Strategy: find the pair, get the value-node range, stringify the new value with
 * 2-space indent, and re-indent every line after the first to match the column
 * where the existing value starts (so block style works). For inline-on-key-line
 * values, we collapse to a flow style if the value is scalar; for complex values,
 * we move to a new indented line.
 *
 * Limitations: comments inside the value are lost; key ordering is canonical from
 * the stringifier.
 */
export function buildJobUpdateEdit(
  doc: Document, text: string, jobName: string, newValue: unknown,
): RenameStageEdit | null {
  const root = doc.contents;
  if (!isMap(root)) return null;
  const pair = ((root as YAMLMap).items as Pair[]).find((p) => (isScalar(p.key) ? String((p.key as Scalar).value) : '') === jobName);
  if (!pair) return null;

  // Range that covers the whole pair (key + value).
  const keyNode = pair.key as any;
  const valueNode = pair.value as any;
  if (!keyNode?.range) return null;

  const startOffset = keyNode.range[0];
  // End: value's range end (or key's if no value)
  const endOffset = valueNode?.range?.[2] ?? valueNode?.range?.[1] ?? keyNode.range[1];

  const startCol = columnOf(text, startOffset);

  // Stringify the whole `key: value` pair so the YAML library handles quoting + structure.
  const yamlText = stringify({ [jobName]: newValue }, { indent: 2, lineWidth: 0, defaultStringType: 'PLAIN' as any, customTags: [REFERENCE_TAG] });

  // Re-indent: prepend startCol spaces to every line EXCEPT the first (the first already has correct position).
  const reindented = startCol === 0
    ? yamlText.trimEnd()
    : yamlText
        .split('\n')
        .map((line, i) => (i === 0 || !line ? line : ' '.repeat(startCol) + line))
        .join('\n')
        .trimEnd();

  const start = offsetToPos(text, startOffset);
  const end = offsetToPos(text, endOffset);
  return { range: { start, end }, newText: reindented };
}

function columnOf(text: string, offset: number): number {
  let col = 0;
  for (let i = offset - 1; i >= 0 && text[i] !== '\n'; i--) col++;
  return col;
}
function offsetToPos(text: string, offset: number): { line: number; character: number } {
  let line = 0, lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) { line++; lineStart = i + 1; }
  }
  return { line, character: offset - lineStart };
}

// re-export to indicate nodeRange usage if needed elsewhere
export { nodeRange };
