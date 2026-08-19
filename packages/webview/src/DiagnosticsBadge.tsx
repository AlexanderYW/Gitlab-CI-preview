import { useEffect, useRef, useState } from 'react';
import type { Diagnostic } from '@gitlab-ci-preview/shared';
import { vscode } from './vscode.js';

// GitLab Pajamas palette
const GL_DANGER = '#dd2b0e';
const GL_DANGER_BG = 'rgba(221,43,14,0.10)';
const GL_DANGER_BORDER = 'rgba(221,43,14,0.35)';
const GL_WARNING = '#c17d10';
const GL_WARNING_BG = 'rgba(193,125,16,0.12)';
const GL_WARNING_BORDER = 'rgba(193,125,16,0.40)';

type Filter = 'all' | 'error' | 'warning';

export function DiagnosticsBadge({ diagnostics }: { diagnostics: Diagnostic[] }) {
  const errors = diagnostics.filter((d) => d.severity === 'error');
  const warnings = diagnostics.filter((d) => d.severity === 'warning');
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (errors.length === 0 && warnings.length === 0) return null;

  function jumpTo(d: Diagnostic) {
    vscode().postMessage({ type: 'revealLocation', uri: d.uri, range: d.range });
  }

  const hasErrors = errors.length > 0;
  const accentColor = hasErrors ? GL_DANGER : GL_WARNING;
  const visible =
    filter === 'all' ? [...errors, ...warnings] : filter === 'error' ? errors : warnings;

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        title={open ? 'Hide problem details' : 'Show problems and jump to source'}
        aria-expanded={open}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 10px',
          fontSize: 12,
          fontWeight: 500,
          lineHeight: 1,
          background: open ? 'var(--vscode-toolbar-activeBackground, rgba(255,255,255,0.06))' : 'transparent',
          color: 'var(--vscode-foreground)',
          border: '1px solid var(--vscode-panel-border, #444)',
          borderRadius: 4,
          cursor: 'pointer',
          transition: 'border-color 120ms ease, background 120ms ease',
        }}
        onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.borderColor = accentColor)}
        onMouseLeave={(e) =>
          ((e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--vscode-panel-border, #444)')
        }
      >
        {hasErrors && (
          <CountPill
            icon={<ErrorIcon color={GL_DANGER} />}
            count={errors.length}
            color={GL_DANGER}
            bg={GL_DANGER_BG}
            border={GL_DANGER_BORDER}
          />
        )}
        {warnings.length > 0 && (
          <CountPill
            icon={<WarningIcon color={GL_WARNING} />}
            count={warnings.length}
            color={GL_WARNING}
            bg={GL_WARNING_BG}
            border={GL_WARNING_BORDER}
          />
        )}
        <Chevron open={open} />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Pipeline problems"
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            right: 0,
            minWidth: 400,
            maxWidth: 560,
            maxHeight: 420,
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--vscode-editorWidget-background, #252526)',
            color: 'var(--vscode-foreground)',
            border: '1px solid var(--vscode-panel-border, #444)',
            borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
            zIndex: 50,
            overflow: 'hidden',
            fontSize: 12,
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: '10px 14px',
              borderBottom: '1px solid var(--vscode-panel-border, #444)',
              background: `linear-gradient(180deg, ${
                hasErrors ? 'rgba(221,43,14,0.10)' : 'rgba(193,125,16,0.10)'
              }, transparent)`,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                aria-hidden
                style={{
                  width: 4,
                  height: 16,
                  borderRadius: 2,
                  background: accentColor,
                  display: 'inline-block',
                }}
              />
              <span style={{ fontWeight: 600, fontSize: 13 }}>Pipeline problems</span>
              <span style={{ flex: 1 }} />
              <button
                onClick={() => setOpen(false)}
                aria-label="Close"
                style={closeBtnStyle}
                onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.opacity = '1')}
                onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.opacity = '0.6')}
              >
                ✕
              </button>
            </div>
            {/* Filter tabs */}
            <div style={{ display: 'flex', gap: 4, marginTop: 10 }}>
              <FilterTab
                active={filter === 'all'}
                onClick={() => setFilter('all')}
                label="All"
                count={errors.length + warnings.length}
              />
              <FilterTab
                active={filter === 'error'}
                onClick={() => setFilter('error')}
                label="Errors"
                count={errors.length}
                color={GL_DANGER}
                disabled={errors.length === 0}
              />
              <FilterTab
                active={filter === 'warning'}
                onClick={() => setFilter('warning')}
                label="Warnings"
                count={warnings.length}
                color={GL_WARNING}
                disabled={warnings.length === 0}
              />
            </div>
          </div>

          {/* List */}
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', overflowY: 'auto' }}>
            {visible.map((d, i) => (
              <DiagItem key={i} d={d} onClick={() => jumpTo(d)} />
            ))}
            {visible.length === 0 && (
              <li style={{ padding: '24px 16px', textAlign: 'center', opacity: 0.6 }}>
                No problems in this view.
              </li>
            )}
          </ul>

          {/* Footer hint */}
          <div
            style={{
              padding: '6px 14px',
              borderTop: '1px solid var(--vscode-panel-border, #444)',
              fontSize: 10,
              opacity: 0.6,
              background: 'var(--vscode-editorWidget-background, #252526)',
            }}
          >
            Click a row to jump to source.
          </div>
        </div>
      )}
    </div>
  );
}

function DiagItem({ d, onClick }: { d: Diagnostic; onClick: () => void }) {
  const isErr = d.severity === 'error';
  const local = d.uri.startsWith('file://');
  const [hover, setHover] = useState(false);
  const filename = (() => {
    try {
      return new URL(d.uri).pathname.split('/').pop() || d.uri;
    } catch {
      return d.uri;
    }
  })();
  const { friendly, hint } = explain(d.message, d.source);
  const accent = isErr ? GL_DANGER : GL_WARNING;

  return (
    <li
      onClick={local ? onClick : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={local ? 'Click to jump to source' : 'Source is in an included file (read-only)'}
      style={{
        padding: '10px 14px 10px 12px',
        borderBottom: '1px solid var(--vscode-panel-border, #333)',
        cursor: local ? 'pointer' : 'default',
        opacity: local ? 1 : 0.7,
        position: 'relative',
        background: hover && local ? 'var(--vscode-list-hoverBackground, rgba(255,255,255,0.04))' : 'transparent',
        transition: 'background 80ms ease',
      }}
    >
      {/* Left accent stripe */}
      <span
        aria-hidden
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: 3,
          background: accent,
          opacity: 0.85,
        }}
      />
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span
          aria-hidden
          style={{
            flex: '0 0 auto',
            width: 22,
            height: 22,
            borderRadius: '50%',
            background: isErr ? GL_DANGER_BG : GL_WARNING_BG,
            border: `1px solid ${isErr ? GL_DANGER_BORDER : GL_WARNING_BORDER}`,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: accent,
          }}
        >
          {isErr ? <ErrorIcon color={accent} size={12} /> : <WarningIcon color={accent} size={12} />}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 500, lineHeight: 1.4 }}>{friendly}</div>
          {hint && (
            <div
              style={{
                fontSize: 11,
                opacity: 0.78,
                marginTop: 4,
                paddingLeft: 8,
                borderLeft: `2px solid ${accent}`,
                lineHeight: 1.45,
              }}
            >
              {hint}
            </div>
          )}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              flexWrap: 'wrap',
              fontSize: 10,
              opacity: 0.7,
              marginTop: 6,
            }}
          >
            <code style={codeChip}>{filename}</code>
            <span>line {d.range.start.line + 1}</span>
            {d.source && (
              <>
                <Dot />
                <span style={sourceTag}>{d.source}</span>
              </>
            )}
            {!local && (
              <>
                <Dot />
                <span>included</span>
              </>
            )}
            {local && hover && (
              <span style={{ marginLeft: 'auto', color: accent, opacity: 0.9 }}>jump →</span>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

function FilterTab({
  active,
  onClick,
  label,
  count,
  color,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  color?: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 8px',
        fontSize: 11,
        fontWeight: 500,
        background: active
          ? 'var(--vscode-toolbar-activeBackground, rgba(255,255,255,0.10))'
          : 'transparent',
        color: disabled ? 'var(--vscode-disabledForeground, rgba(255,255,255,0.4))' : 'var(--vscode-foreground)',
        border: `1px solid ${active ? (color ?? 'var(--vscode-focusBorder, #007fd4)') : 'var(--vscode-panel-border, #444)'}`,
        borderRadius: 10,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'border-color 120ms ease, background 120ms ease',
      }}
    >
      <span>{label}</span>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: 16,
          padding: '0 5px',
          height: 14,
          fontSize: 10,
          fontWeight: 700,
          color: color ?? 'var(--vscode-foreground)',
          background: color ? `${color}22` : 'var(--vscode-badge-background, rgba(255,255,255,0.10))',
          borderRadius: 7,
        }}
      >
        {count}
      </span>
    </button>
  );
}

function CountPill({
  icon,
  count,
  color,
  bg,
  border,
}: {
  icon: React.ReactNode;
  count: number;
  color: string;
  bg: string;
  border: string;
}) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '1px 7px 1px 5px',
        height: 18,
        background: bg,
        color,
        border: `1px solid ${border}`,
        borderRadius: 10,
        fontSize: 11,
        fontWeight: 700,
        lineHeight: 1,
      }}
    >
      {icon}
      {count}
    </span>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width={10}
      height={10}
      viewBox="0 0 10 10"
      aria-hidden
      style={{ opacity: 0.7, transition: 'transform 150ms ease', transform: open ? 'rotate(180deg)' : 'none' }}
    >
      <path
        d="M2 3.5 L5 6.5 L8 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ErrorIcon({ color, size = 11 }: { color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden style={{ color }}>
      <circle cx={8} cy={8} r={7} fill="none" stroke="currentColor" strokeWidth={1.6} />
      <path d="M5 5 L11 11 M11 5 L5 11" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />
    </svg>
  );
}

function WarningIcon({ color, size = 11 }: { color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden style={{ color }}>
      <path
        d="M8 1.5 L15 14 L1 14 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinejoin="round"
      />
      <rect x={7.25} y={6} width={1.5} height={4.5} rx={0.6} fill="currentColor" />
      <circle cx={8} cy={12} r={0.9} fill="currentColor" />
    </svg>
  );
}

function Dot() {
  return <span aria-hidden style={{ opacity: 0.5 }}>·</span>;
}

const codeChip: React.CSSProperties = {
  display: 'inline-block',
  padding: '1px 6px',
  fontSize: 10,
  background: 'var(--vscode-textCodeBlock-background, rgba(255,255,255,0.06))',
  border: '1px solid var(--vscode-panel-border, #444)',
  borderRadius: 3,
  fontFamily: 'var(--vscode-editor-font-family, monospace)',
  whiteSpace: 'nowrap',
};

const sourceTag: React.CSSProperties = {
  display: 'inline-block',
  padding: '1px 5px',
  fontSize: 10,
  background: 'rgba(252,109,38,0.10)',
  color: '#FC6D26',
  border: '1px solid rgba(252,109,38,0.30)',
  borderRadius: 3,
  fontFamily: 'var(--vscode-editor-font-family, monospace)',
};

const closeBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--vscode-foreground)',
  opacity: 0.6,
  cursor: 'pointer',
  fontSize: 14,
  lineHeight: 1,
  padding: 2,
};

/**
 * Heuristic plain-language hints for common diagnostic patterns.
 */
function explain(message: string, source: string | undefined): { friendly: string; hint: string | null } {
  const m = message;
  if (/unknown property "([^"]+)"/.test(m)) {
    const key = m.match(/unknown property "([^"]+)"/)![1];
    return { friendly: m, hint: `"${key}" isn't a recognized GitLab CI key here. Check spelling or remove it.` };
  }
  if (/missing required property "([^"]+)"/.test(m)) {
    const key = m.match(/missing required property "([^"]+)"/)![1];
    return { friendly: m, hint: `Add a "${key}:" entry — GitLab requires it for this context.` };
  }
  if (/expected (string|number|boolean|array|object)/.test(m)) {
    return { friendly: m, hint: `The value type doesn't match what GitLab expects here.` };
  }
  if (/must be one of (\[.+\])/.test(m)) {
    return { friendly: m, hint: `Replace the value with one of the allowed options listed.` };
  }
  if (/cannot resolve include/.test(m)) {
    return { friendly: m, hint: `The included file couldn't be fetched. For private GitLab projects, configure a token in Settings → GitLab CI Preview → Tokens.` };
  }
  if (/include cycle detected/.test(m)) {
    return { friendly: m, hint: `Two files include each other. Break the loop by removing one of the include entries.` };
  }
  if (/include depth limit/.test(m)) {
    return { friendly: m, hint: `Includes nested too deeply. Flatten by inlining one of the intermediate files.` };
  }
  if (/unknown job "([^"]+)"/.test(m) && /needs/.test(m)) {
    const j = m.match(/unknown job "([^"]+)"/)![1];
    return { friendly: m, hint: `"${j}" is referenced in needs: but isn't defined in this pipeline. Add the job or remove the reference.` };
  }
  if (/extends references unknown job "([^"]+)"/.test(m)) {
    const j = m.match(/extends references unknown job "([^"]+)"/)![1];
    return { friendly: m, hint: `"${j}" is referenced via extends: but doesn't exist. Define it (typically as ".${j}") or fix the reference.` };
  }
  if (/extends cycle through/.test(m)) {
    return { friendly: m, hint: `Two jobs extend each other. Break the chain so it has a clear root.` };
  }
  if (/missing required input "([^"]+)"/.test(m)) {
    const k = m.match(/missing required input "([^"]+)"/)![1];
    return { friendly: m, hint: `Pass "${k}:" under the include's inputs:, e.g. inputs:\n  ${k}: <value>` };
  }
  if (/unknown input "([^"]+)"/.test(m)) {
    return { friendly: m, hint: `The template doesn't declare this input. Remove it or check the template's spec.inputs.` };
  }
  if (/input "([^"]+)" invalid/.test(m)) {
    return { friendly: m, hint: `Adjust the input value to match the type, regex, or options declared by the template.` };
  }
  return { friendly: m, hint: source === 'gitlab-ci/schema' ? 'Schema mismatch — see GitLab CI/CD YAML reference for the expected shape.' : null };
}
