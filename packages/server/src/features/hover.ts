import type { Hover, Position, Range } from 'vscode-languageserver';
import type { Job, PipelineModel } from '@gitlab-ci-preview/shared';
import { parseReference, resolveReference } from '@gitlab-ci-preview/shared';

/** Expand $VAR and ${VAR} from the given scope (job vars > global vars). */
function expand(s: string, scope: Record<string, string>): string {
  return s.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, name) => (name in scope ? scope[name] : m));
}
function jobVarScope(job: Job, model: PipelineModel): Record<string, string> {
  return { ...model.globalVariables, ...(job.variables ?? {}) };
}

function within(range: { start: Position; end: Position }, pos: Position): boolean {
  if (pos.line < range.start.line || pos.line > range.end.line) return false;
  if (pos.line === range.start.line && pos.character < range.start.character) return false;
  if (pos.line === range.end.line && pos.character > range.end.character) return false;
  return true;
}

export interface ReferenceOccurrence {
  /** Text between the brackets of `!reference[ ... ]`. */
  raw: string;
  /** Offset of the first character after the opening bracket. */
  contentStart: number;
  /** Offset just past the closing bracket (or end of line while typing). */
  contentEnd: number;
  /** Range covering the whole tag, including `!reference[`. */
  range: Range;
}

/**
 * Find a `!reference[ ... ]` / `!reference [ ... ]` tag containing `pos`,
 * scanning the document text. An unclosed bracket (mid-typing) extends to
 * the end of the line.
 */
export function findReferenceAt(text: string, pos: Position): ReferenceOccurrence | null {
  const re = /!reference\s*\[/g;
  const lineStarts: number[] = [];
  for (let i = 0; i <= text.length; i++) {
    if (i === 0 || text.charCodeAt(i - 1) === 10) lineStarts.push(i);
  }
  const offsetToPosition = (offset: number): Position => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, character: offset - lineStarts[lo] };
  };
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const contentStart = m.index + m[0].length;
    let closed = true;
    let contentEnd = text.indexOf(']', contentStart);
    if (contentEnd === -1 || text.slice(contentStart, contentEnd).includes('\n')) {
      // Unterminated (or multiline) — treat the rest of the line as the payload.
      const nl = text.indexOf('\n', contentStart);
      contentEnd = nl === -1 ? text.length : nl;
      closed = false;
    }
    const tagEnd = closed ? contentEnd + 1 : contentEnd;
    const range: Range = { start: offsetToPosition(m.index), end: offsetToPosition(tagEnd) };
    if (!within(range, pos)) continue;
    return { raw: text.slice(contentStart, contentEnd), contentStart, contentEnd, range };
  }
  return null;
}

/** Render a resolved value compactly (JSON-ish), truncated for hover display. */
function renderValue(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    json = String(value);
  }
  if (json.length > 400) json = json.slice(0, 397) + '...';
  return json;
}

export function hover(model: PipelineModel, uri: string, pos: Position, docText?: string): Hover | null {
  // `!reference[...]` tags take precedence over the enclosing job's hover.
  if (docText) {
    const ref = findReferenceAt(docText, pos);
    if (ref) return referenceHover(model, ref.raw, ref.range);
  }
  for (const job of model.jobs) {
    if (job.source.uri !== uri) continue;
    if (!within(job.source.range, pos)) continue;
    const lines = [
      `**${job.name}**${job.hidden ? ' _(template)_' : ''}`,
      ``,
      `- stage: \`${job.stage}\``,
      job.image ? `- image: \`${job.image}\`` : null,
      job.when ? `- when: \`${job.when}\`` : null,
      job.allowFailure ? `- allow_failure: \`true\`` : null,
      job.trigger ? `- trigger: \`true\`` : null,
      job.parallel ? `- parallel: \`${job.parallel}\`` : null,
      job.retry !== undefined ? `- retry: \`${job.retry}\`` : null,
      job.tags && job.tags.length ? `- tags: ${job.tags.map((t) => `\`${t}\``).join(', ')}` : null,
      job.extends.length > 0 ? `- extends: ${job.extends.map((e) => `\`${e}\``).join(', ')}` : null,
      job.needs.length > 0 ? `- needs: ${job.needs.map((n) => `\`${n}\``).join(', ')}` : null,
      job.rules && job.rules.length ? `- rules: ${job.rules.length} entr${job.rules.length === 1 ? 'y' : 'ies'}` : null,
      job.script && job.script.length > 0 ? renderScript(job, model) : null,
    ].filter(Boolean);
    return { contents: { kind: 'markdown', value: lines.join('\n') }, range: job.source.range };
  }
  // Skip ahead to include-hover handling.
  for (const inc of model.includes) {
    if (inc.source.uri !== uri) continue;
    if (!within(inc.source.range, pos)) continue;
    const lines = [
      `**include (${inc.kind})**`,
      `- raw: \`${inc.raw}\``,
      inc.resolvedUri ? `- resolved: \`${inc.resolvedUri}\`` : `- _unresolved_`,
      inc.error ? `- error: ${inc.error}` : null,
    ].filter(Boolean);
    return { contents: { kind: 'markdown', value: lines.join('\n') }, range: inc.source.range };
  }
  return null;
}

function referenceHover(model: PipelineModel, raw: string, range: Range): Hover {
  const parsed = parseReference(raw);
  const shown = raw.trim() || '…';
  const lines = [`**!reference** \`${shown}\``];
  if (!parsed) {
    lines.push(`_not a valid reference_`);
  } else {
    const res = resolveReference(raw, model.jobs);
    if (!res) {
      lines.push(`_unknown job \`${parsed.jobName}\`_`);
    } else if (parsed.keyPath.includes('*')) {
      lines.push(`_wildcard \`*\` — not statically resolvable_`);
    } else if (!res.resolved) {
      lines.push(`_key \`${parsed.keyPath.join('.')}\` not found on \`${res.job.name}\`_`);
    } else {
      lines.push('```json\n' + renderValue(res.value) + '\n```');
    }
  }
  return { contents: { kind: 'markdown', value: lines.join('\n') }, range };
}

function renderScript(job: Job, model: PipelineModel): string {
  const scope = jobVarScope(job, model);
  const raw = job.script!.slice(0, 10);
  const expanded = raw.map((line) => expand(line, scope));
  const anyChanged = expanded.some((line, i) => line !== raw[i]);
  if (!anyChanged) return `\n\`\`\`sh\n${raw.join('\n')}\n\`\`\``;
  return `\n**script** (raw)\n\`\`\`sh\n${raw.join('\n')}\n\`\`\`\n**expanded**\n\`\`\`sh\n${expanded.join('\n')}\n\`\`\``;
}
