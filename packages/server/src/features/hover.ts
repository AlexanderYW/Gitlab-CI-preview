import type { Hover, Position } from 'vscode-languageserver';
import type { Job, PipelineModel } from '@gitlab-ci-preview/shared';

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

export function hover(model: PipelineModel, uri: string, pos: Position): Hover | null {
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

function renderScript(job: Job, model: PipelineModel): string {
  const scope = jobVarScope(job, model);
  const raw = job.script!.slice(0, 10);
  const expanded = raw.map((line) => expand(line, scope));
  const anyChanged = expanded.some((line, i) => line !== raw[i]);
  if (!anyChanged) return `\n\`\`\`sh\n${raw.join('\n')}\n\`\`\``;
  return `\n**script** (raw)\n\`\`\`sh\n${raw.join('\n')}\n\`\`\`\n**expanded**\n\`\`\`sh\n${expanded.join('\n')}\n\`\`\``;
}
