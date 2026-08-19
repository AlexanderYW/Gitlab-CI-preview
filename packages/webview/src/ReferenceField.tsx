import { useState } from 'react';
import { formatReferencePath, isReference, type ResolvedReference } from './referenceUtil.js';

// GitLab fox-orange identifies the !reference indicator everywhere.
const GL_ORANGE = '#fc6d26';
const GL_AMBER = '#c17d10';
const GL_RED = '#dd2b0e';

export interface ReferenceCtx {
  resolveReference?: (path: string[]) => ResolvedReference;
  /** Jobs available as reference targets (the first path segment). */
  jobs?: { name: string; hidden?: boolean }[];
}

function Badge() {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        padding: '0 5px',
        height: 15,
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: 0.5,
        textTransform: 'uppercase',
        color: GL_ORANGE,
        background: 'rgba(252,109,38,0.14)',
        border: `1px solid ${GL_ORANGE}55`,
        borderRadius: 8,
        lineHeight: '13px',
        fontFamily: 'var(--vscode-font-family)',
        flex: '0 0 auto',
      }}
      title="GitLab !reference tag"
    >
      <LinkIcon />
      ref
    </span>
  );
}

function LinkIcon() {
  return (
    <svg width={9} height={9} viewBox="0 0 12 12" aria-hidden>
      <path
        d="M5 7 L7 5 M3.5 8.5 a2 2 0 0 1 0 -2.8 L4.8 4.4 M8.5 3.5 a2 2 0 0 1 0 2.8 L7.2 7.6"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PathCrumbs({ path }: { path: string[] }) {
  return (
    <span
      style={{
        fontFamily: 'var(--vscode-editor-font-family, monospace)',
        fontSize: 11,
        color: 'var(--vscode-foreground)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        minWidth: 0,
      }}
      title={formatReferencePath(path)}
    >
      {path.map((seg, i) => (
        <span key={i}>
          {i > 0 && <span style={{ opacity: 0.4, padding: '0 4px' }}>›</span>}
          <span style={{ color: i === 0 ? GL_ORANGE : 'var(--vscode-foreground)' }}>{seg}</span>
        </span>
      ))}
    </span>
  );
}

function ErrorDot({ message }: { message: string }) {
  return (
    <span
      title={message}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        fontSize: 9,
        fontWeight: 700,
        color: GL_RED,
        padding: '0 5px',
        height: 15,
        background: 'rgba(221,43,14,0.10)',
        border: `1px solid ${GL_RED}55`,
        borderRadius: 8,
        lineHeight: '13px',
      }}
    >
      ⚠ unresolved
    </span>
  );
}

/**
 * Compact inline chip — used when a `!reference` sits inside another list
 * (e.g. one entry of a `script:` array). Click to toggle resolved preview.
 */
export function ReferenceChip({ path, ctx, compact }: { path: string[]; ctx?: ReferenceCtx; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const resolved = ctx?.resolveReference?.(path);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: compact ? '3px 7px' : '5px 9px',
          background: 'rgba(252,109,38,0.07)',
          border: `1px solid ${GL_ORANGE}40`,
          borderLeft: `3px solid ${GL_ORANGE}`,
          borderRadius: 4,
          cursor: 'pointer',
          fontFamily: 'var(--vscode-font-family)',
          color: 'var(--vscode-foreground)',
          textAlign: 'left',
          maxWidth: '100%',
          minWidth: 0,
        }}
        title={`!reference ${formatReferencePath(path)}${resolved && !resolved.ok ? ` — ${resolved.error}` : ''}`}
      >
        <Badge />
        <PathCrumbs path={path} />
        {resolved && !resolved.ok && <ErrorDot message={resolved.error ?? 'unresolved'} />}
        <span style={{ flex: 1 }} />
        <span style={{ opacity: 0.5, fontSize: 10 }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <ResolvedPreview resolved={resolved} path={path} />
      )}
    </div>
  );
}

/**
 * Larger block form — used when an entire field value is `!reference [...]`
 * (e.g. `script: !reference [.setup, script]`). Always shows the resolved preview.
 * When `onChange` is supplied (and not `disabled`), the path becomes editable.
 */
export function ReferenceBlock({
  path, ctx, onChange, disabled,
}: {
  path: string[]; ctx?: ReferenceCtx;
  onChange?: (path: string[]) => void;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const resolved = ctx?.resolveReference?.(path);
  const editable = !!onChange && !disabled;
  return (
    <div
      style={{
        border: `1px solid ${GL_ORANGE}40`,
        borderLeft: `3px solid ${GL_ORANGE}`,
        borderRadius: 4,
        background: 'rgba(252,109,38,0.05)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          borderBottom: '1px solid rgba(252,109,38,0.25)',
        }}
        title={`!reference ${formatReferencePath(path)}`}
      >
        <Badge />
        <PathCrumbs path={path} />
        {resolved && !resolved.ok && <ErrorDot message={resolved.error ?? 'unresolved'} />}
        <span style={{ flex: 1 }} />
        {editable && (
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            title="Edit reference path"
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: GL_ORANGE, fontSize: 10, fontWeight: 600, padding: '2px 4px',
              fontFamily: 'var(--vscode-font-family)',
            }}
          >{editing ? 'Done' : 'Edit'}</button>
        )}
      </div>
      {editing && editable
        ? <ReferencePathEditor path={path} ctx={ctx} onChange={onChange!} />
        : <ResolvedPreview resolved={resolved} path={path} />}
    </div>
  );
}

/**
 * Edit a `!reference [job, key, …]` path: a dropdown for the target job (segment 0) and a
 * field for the key path (remaining segments), with the job's top-level keys suggested.
 * Falls back to a plain job text input when the job list isn't available.
 */
function ReferencePathEditor({ path, ctx, onChange }: { path: string[]; ctx?: ReferenceCtx; onChange: (path: string[]) => void }) {
  const job = path[0] ?? '';
  const keyText = path.slice(1).join(', ');
  const jobs = ctx?.jobs ?? [];
  // Reference targets are usually hidden `.template` jobs — list those first.
  const jobOptions = [...jobs].sort((a, b) => Number(!!b.hidden) - Number(!!a.hidden) || a.name.localeCompare(b.name));

  function rebuild(newJob: string, newKeys: string): string[] {
    const keys = newKeys.split(',').map((s) => s.trim()).filter(Boolean);
    return [newJob, ...keys].filter((_, i) => i === 0 ? newJob !== '' : true);
  }

  // Suggest the selected job's top-level keys for the first key segment.
  const resolvedJob = job ? ctx?.resolveReference?.([job]) : undefined;
  const keySuggestions = resolvedJob?.ok && resolvedJob.value && typeof resolvedJob.value === 'object' && !Array.isArray(resolvedJob.value)
    ? Object.keys(resolvedJob.value as Record<string, unknown>)
    : [];
  const listId = `refkeys-${job || 'none'}`;

  const fieldStyle: React.CSSProperties = {
    boxSizing: 'border-box',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    border: '1px solid var(--vscode-input-border, var(--vscode-panel-border, #444))',
    borderRadius: 3, padding: '4px 6px',
    fontFamily: 'var(--vscode-editor-font-family, monospace)', fontSize: 11,
  };

  return (
    <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        {jobOptions.length > 0 ? (
          <select
            value={job}
            onChange={(e) => onChange(rebuild(e.target.value, keyText))}
            style={{ ...fieldStyle, flex: '0 0 auto', maxWidth: '50%' }}
            aria-label="Reference target job"
          >
            {!jobOptions.some((j) => j.name === job) && <option value={job}>{job || '(select job)'}</option>}
            {jobOptions.map((j) => <option key={j.name} value={j.name}>{j.name}</option>)}
          </select>
        ) : (
          <input
            type="text"
            value={job}
            onChange={(e) => onChange(rebuild(e.target.value, keyText))}
            placeholder=".template"
            style={{ ...fieldStyle, flex: '0 0 auto', maxWidth: '50%' }}
            aria-label="Reference target job"
          />
        )}
        <input
          type="text"
          value={keyText}
          onChange={(e) => onChange(rebuild(job, e.target.value))}
          placeholder="script"
          list={keySuggestions.length ? listId : undefined}
          style={{ ...fieldStyle, flex: 1, minWidth: 0 }}
          aria-label="Reference key path, comma-separated"
        />
        {keySuggestions.length > 0 && (
          <datalist id={listId}>
            {keySuggestions.map((k) => <option key={k} value={k} />)}
          </datalist>
        )}
      </div>
      <span style={{ fontSize: 10, opacity: 0.6 }}>
        Target job, then the nested key path (e.g. <code style={inlineCode}>script</code> or <code style={inlineCode}>variables, MY_VAR</code>).
      </span>
    </div>
  );
}

function ResolvedPreview({ resolved, path }: { resolved: ResolvedReference | undefined; path: string[] }) {
  if (!resolved) {
    return (
      <div style={{ padding: '8px 10px', fontSize: 10.5, color: 'var(--vscode-descriptionForeground)', fontStyle: 'italic' }}>
        Pipeline model not available — cannot resolve <code style={inlineCode}>{formatReferencePath(path)}</code>.
      </div>
    );
  }
  if (!resolved.ok) {
    return (
      <div style={{ padding: '8px 10px', fontSize: 10.5, color: GL_AMBER }}>
        {resolved.error}
      </div>
    );
  }
  return (
    <div style={{ padding: '6px 10px' }}>
      <ValueRender value={resolved.value} />
    </div>
  );
}

function ValueRender({ value }: { value: unknown }) {
  // Strings → one-line code
  if (typeof value === 'string') {
    return <pre style={codeBlockStyle}>{value}</pre>;
  }
  // Arrays of strings → numbered list (typical for script/before_script)
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    return (
      <pre style={codeBlockStyle}>
        {(value as string[]).map((line, i) => `${String(i + 1).padStart(2, ' ')}  ${line}`).join('\n')}
      </pre>
    );
  }
  // Plain object → key:value lines (typical for variables)
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span style={emptyStyle}>(empty object)</span>;
    return (
      <pre style={codeBlockStyle}>
        {entries
          .map(([k, v]) => `${k}: ${formatScalar(v)}`)
          .join('\n')}
      </pre>
    );
  }
  // Fallback — JSON dump (preserves nested references via their marker shape)
  return <pre style={codeBlockStyle}>{safeStringify(value)}</pre>;
}

function formatScalar(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (isReference(v)) return `!reference [${v.__gitlabReference.join(', ')}]`;
  return JSON.stringify(v);
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v, null, 2); }
  catch { return String(v); }
}

const codeBlockStyle: React.CSSProperties = {
  margin: 0,
  padding: '6px 8px',
  background: 'var(--vscode-textCodeBlock-background, rgba(0,0,0,0.25))',
  borderRadius: 3,
  fontFamily: 'var(--vscode-editor-font-family, monospace)',
  fontSize: 11,
  lineHeight: 1.5,
  color: 'var(--vscode-foreground)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 240,
  overflow: 'auto',
};

const inlineCode: React.CSSProperties = {
  padding: '0 4px',
  background: 'rgba(255,255,255,0.06)',
  border: '1px solid rgba(255,255,255,0.10)',
  borderRadius: 3,
  fontFamily: 'var(--vscode-editor-font-family, monospace)',
  fontSize: 10.5,
};

const emptyStyle: React.CSSProperties = {
  fontSize: 11,
  fontStyle: 'italic',
  color: 'var(--vscode-descriptionForeground)',
};
