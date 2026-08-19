import { isMap, isScalar, isSeq, type Document, type Pair, type Scalar, type YAMLMap, type YAMLSeq } from 'yaml';
import { nodeRange } from '../parser.js';
import type { RenameStageEdit } from '@gitlab-ci-preview/shared';
import { RESERVED_TOP_LEVEL } from '@gitlab-ci-preview/shared';

/**
 * Collect edits for renaming a stage:
 *  - in the top-level `stages:` sequence, replace the matching item
 *  - in every job, if its `stage:` scalar matches, replace it
 *  - in `default.stage:` if present
 * Position-precise via the YAML CST (nodeRange).
 */
export function collectStageRenameEdits(doc: Document, text: string, oldName: string, newName: string): RenameStageEdit[] {
  const out: RenameStageEdit[] = [];
  const root = doc.contents;
  if (!isMap(root)) return out;

  for (const pair of (root as YAMLMap).items as Pair[]) {
    const key = isScalar(pair.key) ? String((pair.key as Scalar).value) : '';
    if (!key) continue;

    if (key === 'stages' && isSeq(pair.value as any)) {
      for (const item of ((pair.value as YAMLSeq).items as any[])) {
        if (isScalar(item) && String((item as Scalar).value) === oldName) {
          out.push({ range: nodeRange(text, item as any), newText: yamlQuoteIfNeeded(newName) });
        }
      }
    } else if (key === 'default' && isMap(pair.value as any)) {
      const stagePair = ((pair.value as YAMLMap).items as Pair[]).find(
        (p) => (isScalar(p.key) ? String((p.key as Scalar).value) : '') === 'stage',
      );
      if (stagePair && isScalar(stagePair.value as any) && String((stagePair.value as Scalar).value) === oldName) {
        out.push({ range: nodeRange(text, stagePair.value as any), newText: yamlQuoteIfNeeded(newName) });
      }
    } else if (!RESERVED_TOP_LEVEL.has(key) && isMap(pair.value as any)) {
      const stagePair = ((pair.value as YAMLMap).items as Pair[]).find(
        (p) => (isScalar(p.key) ? String((p.key as Scalar).value) : '') === 'stage',
      );
      if (stagePair && isScalar(stagePair.value as any) && String((stagePair.value as Scalar).value) === oldName) {
        out.push({ range: nodeRange(text, stagePair.value as any), newText: yamlQuoteIfNeeded(newName) });
      }
    }
  }
  return out;
}

function yamlQuoteIfNeeded(s: string): string {
  // Quote if the value would otherwise be ambiguous in YAML flow context.
  if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(s)) return s;
  return JSON.stringify(s); // double-quoted, JSON-compatible
}
