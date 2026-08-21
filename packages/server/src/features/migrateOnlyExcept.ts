import { isMap, isScalar, type Document, type Pair, type YAMLMap } from 'yaml';
import type { RenameStageEdit } from '@gitlab-ci-preview/shared';
import { RESERVED_TOP_LEVEL } from '@gitlab-ci-preview/shared';
import { convertOnlyExceptToRules, hasOnlyExcept } from '@gitlab-ci-preview/shared';
import { buildJobUpdateEdit } from './updateJob.js';

export interface MigrateResult {
  /** Top-level jobs whose only/except was converted to rules. */
  jobs: string[];
  edits: RenameStageEdit[];
}

/**
 * Return the job spec with `only:`/`except:` replaced by a converted `rules:` block,
 * or null when there is nothing to do (no only/except, or a `rules:` key already
 * exists — merging those is not safe, so such jobs are left untouched).
 */
export function migrateJobSpec(spec: Record<string, unknown>): Record<string, unknown> | null {
  if (!hasOnlyExcept(spec) || 'rules' in spec) return null;
  const { only, except, ...rest } = spec;
  return { ...rest, rules: convertOnlyExceptToRules(only, except) };
}

/**
 * Collect one whole-job text edit per top-level job that still uses legacy
 * `only:`/`except:`. Each edit replaces the job's mapping with a re-serialization
 * of the converted spec (same strategy as buildJobUpdateEdit), so comments inside
 * the replaced jobs are lost but indentation and quoting stay correct.
 */
export function collectMigrateOnlyExceptEdits(doc: Document, text: string): MigrateResult {
  const out: MigrateResult = { jobs: [], edits: [] };
  const root = doc.contents;
  if (!isMap(root)) return out;

  for (const pair of root.items as Pair[]) {
    const name = pairName(pair);
    if (!name || RESERVED_TOP_LEVEL.has(name)) continue;
    if (!isMap(pair.value)) continue;
    const migrated = migrateJobSpec((pair.value as YAMLMap).toJSON() as Record<string, unknown>);
    if (!migrated) continue;
    const edit = buildJobUpdateEdit(doc, text, name, migrated);
    if (!edit) continue;
    out.jobs.push(name);
    out.edits.push(edit);
  }
  return out;
}

/** LSP-style position (0-based line/character). */
interface Pos { line: number; character: number }

/**
 * Find the top-level job containing `pos` whose spec is migratable, and build its
 * edit — used by the code action to offer a single-job conversion.
 */
export function findMigratableJobAt(
  doc: Document,
  text: string,
  pos: Pos,
): { name: string; edit: RenameStageEdit } | null {
  const root = doc.contents;
  if (!isMap(root)) return null;

  for (const pair of root.items as Pair[]) {
    const name = pairName(pair);
    if (!name || RESERVED_TOP_LEVEL.has(name)) continue;
    if (!isMap(pair.value)) continue;
    if (!pairContains(text, pair, pos)) continue;
    const migrated = migrateJobSpec((pair.value as YAMLMap).toJSON() as Record<string, unknown>);
    if (!migrated) return null;
    const edit = buildJobUpdateEdit(doc, text, name, migrated);
    return edit ? { name, edit } : null;
  }
  return null;
}

function pairName(pair: Pair): string {
  return isScalar(pair.key) ? String(pair.key.value) : '';
}

/** Does the span covered by this pair (key through value) contain `pos`? */
function pairContains(text: string, pair: Pair, pos: Pos): boolean {
  const keyNode = pair.key as { range?: [number, number, number] | null } | null;
  const valueNode = pair.value as { range?: [number, number, number] | null } | null;
  if (!keyNode?.range) return false;
  const startOffset = keyNode.range[0];
  const endOffset = valueNode?.range?.[2] ?? valueNode?.range?.[1] ?? keyNode.range[1];
  const start = offsetToPos(text, startOffset);
  const end = offsetToPos(text, endOffset);
  if (pos.line < start.line || pos.line > end.line) return false;
  if (pos.line === start.line && pos.character < start.character) return false;
  if (pos.line === end.line && pos.character > end.character) return false;
  return true;
}

function offsetToPos(text: string, offset: number): Pos {
  let line = 0, lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) { line++; lineStart = i + 1; }
  }
  return { line, character: offset - lineStart };
}
