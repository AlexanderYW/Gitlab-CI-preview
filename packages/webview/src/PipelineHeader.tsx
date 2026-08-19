import type { Job, PipelineModel } from '@gitlab-ci-preview/shared';
import type { LayoutMode } from './layout.js';
import { DiagnosticsBadge } from './DiagnosticsBadge.js';
import { Legend } from './Legend.js';

export function PipelineHeader({
  model, visibleJobs, showHidden, setShowHidden, showEdgeLabels, setShowEdgeLabels, spotlightChain, setSpotlightChain, filter, setFilter, hideUnmatched, setHideUnmatched, matchCount, layout, setLayout, onExportPng,
}: {
  model: PipelineModel;
  visibleJobs: Job[];
  showHidden: boolean;
  setShowHidden: (v: boolean) => void;
  showEdgeLabels: boolean;
  setShowEdgeLabels: (v: boolean) => void;
  spotlightChain: boolean;
  setSpotlightChain: (v: boolean) => void;
  filter: string;
  setFilter: (v: string) => void;
  hideUnmatched: boolean;
  setHideUnmatched: (v: boolean) => void;
  matchCount: number | null;
  layout: LayoutMode;
  setLayout: (v: LayoutMode) => void;
  onExportPng: () => void;
}) {
  const fileName = filenameOf(model.rootUri);
  const errors = model.diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = model.diagnostics.filter((d) => d.severity === 'warning').length;

  const status: 'ok' | 'warn' | 'error' =
    errors > 0 ? 'error' :
    warnings > 0 ? 'warn' :
    'ok';

  return (
    <header style={{
      borderBottom: '1px solid var(--vscode-panel-border, #2d2d2d)',
      background: 'var(--vscode-sideBar-background)',
      fontFamily: 'var(--vscode-font-family)',
    }}>
      {/* Status accent bar */}
      <div style={{ height: 3, background: statusAccent(status) }} />

      {/* Title row */}
      <div style={{
        padding: '12px 18px 8px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}>
        <StatusBadge status={status} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 9, fontWeight: 700, opacity: 0.55, textTransform: 'uppercase', letterSpacing: 1.4 }}>
            Pipeline
          </div>
          <div style={{
            fontSize: 14, fontWeight: 600,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            fontFamily: 'var(--vscode-editor-font-family, monospace)',
          }} title={model.rootUri}>{fileName}</div>
        </div>
        <Legend />
      </div>

      {/* Stats + controls row */}
      <div style={{
        padding: '0 12px 12px',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
      }}>
        <StatTile label="Jobs" value={visibleJobs.length} hint={model.jobs.length !== visibleJobs.length ? `${model.jobs.length - visibleJobs.length} hidden` : null} />
        <StatTile label="Stages" value={model.stages.length} />
        <StatTile label="Includes" value={model.includes.length} hint={unresolvedIncludesHint(model)} />
        {workflowRuleCount(model) !== null && (
          <StatTile label="Workflow" value={workflowRuleCount(model)!} hint="rules gate this pipeline" />
        )}
        <LayoutToggle layout={layout} setLayout={setLayout} />
        <div style={{ flex: 1, minWidth: 8 }} />
        <JobSearch value={filter} onChange={setFilter} matchCount={matchCount} />
        {filter.trim() !== '' && (
          <ToggleChip
            label="Hide unmatched"
            active={hideUnmatched}
            onClick={() => setHideUnmatched(!hideUnmatched)}
            title={hideUnmatched ? 'Dim non-matching jobs instead of hiding them' : 'Remove non-matching jobs from the graph'}
          />
        )}
        <DiagnosticsBadge diagnostics={model.diagnostics} />
        <ToggleChip
          label="Templates"
          active={showHidden}
          onClick={() => setShowHidden(!showHidden)}
          title={showHidden ? 'Hide templates (.hidden jobs)' : 'Show templates (.hidden jobs)'}
        />
        <ToggleChip
          label="Edge labels"
          active={showEdgeLabels}
          onClick={() => setShowEdgeLabels(!showEdgeLabels)}
          title={showEdgeLabels ? 'Hide edge labels' : 'Label needs / dependencies / extends edges'}
        />
        <ToggleChip
          label="Chain spotlight"
          active={spotlightChain}
          onClick={() => setSpotlightChain(!spotlightChain)}
          title={spotlightChain
            ? 'Hover highlights only directly connected jobs'
            : 'Hover highlights the full upstream + downstream chain'}
        />
        <button
          onClick={onExportPng}
          title="Export the pipeline graph as a PNG image"
          style={{
            padding: '4px 10px', fontSize: 11, fontWeight: 600,
            background: 'transparent', color: 'var(--vscode-foreground)',
            border: '1px solid var(--vscode-panel-border, #444)', borderRadius: 3, cursor: 'pointer',
          }}
        >
          Export PNG
        </button>
      </div>
    </header>
  );
}

function LayoutToggle({ layout, setLayout }: { layout: LayoutMode; setLayout: (v: LayoutMode) => void }) {
  const opt = (mode: LayoutMode, label: string, title: string) => {
    const active = layout === mode;
    return (
      <button
        onClick={() => setLayout(mode)}
        title={title}
        aria-pressed={active}
        style={{
          padding: '4px 10px',
          fontSize: 11,
          fontWeight: 600,
          background: active ? 'var(--vscode-button-background, #0e639c)' : 'transparent',
          color: active ? 'var(--vscode-button-foreground, #fff)' : 'var(--vscode-foreground)',
          border: 'none',
          cursor: 'pointer',
        }}
      >
        {label}
      </button>
    );
  };
  return (
    <div
      role="group"
      aria-label="Graph layout"
      style={{ display: 'inline-flex', border: '1px solid var(--vscode-panel-border, #444)', borderRadius: 3, overflow: 'hidden' }}
    >
      {opt('stages', 'Stages', 'Column-per-stage view')}
      {opt('dag', 'Needs', 'Dependency (DAG) view laid out by needs/dependencies')}
    </div>
  );
}

function JobSearch({ value, onChange, matchCount }: { value: string; onChange: (v: string) => void; matchCount: number | null }) {
  return (
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <span aria-hidden style={{ position: 'absolute', left: 8, opacity: 0.5, fontSize: 11, pointerEvents: 'none' }}>⌕</span>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Filter jobs…"
        aria-label="Filter jobs by name"
        spellCheck={false}
        style={{
          width: value ? 180 : 130,
          padding: '5px 8px 5px 22px',
          fontSize: 12,
          background: 'var(--vscode-input-background, #1e1e1e)',
          color: 'var(--vscode-input-foreground, #ccc)',
          border: '1px solid var(--vscode-input-border, var(--vscode-panel-border, #444))',
          borderRadius: 4,
          outline: 'none',
          transition: 'width 120ms ease',
        }}
      />
      {value.trim() !== '' && (
        <span
          style={{ position: 'absolute', right: 8, fontSize: 10, opacity: 0.6, pointerEvents: 'none' }}
          title={`${matchCount ?? 0} matching job(s)`}
        >
          {matchCount ?? 0}
        </span>
      )}
    </div>
  );
}

function StatTile({ label, value, hint }: { label: string; value: number; hint?: string | null }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '6px 12px',
      minWidth: 64,
      background: 'var(--vscode-editor-background)',
      border: '1px solid var(--vscode-panel-border, #2d2d2d)',
      borderRadius: 6,
    }}>
      <span style={{ fontSize: 18, fontWeight: 700, lineHeight: 1, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}>{value}</span>
      <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
        <span style={{ fontSize: 11, opacity: 0.7, letterSpacing: 0.4 }}>{label}</span>
        {hint && (
          <span style={{ fontSize: 9, opacity: 0.55, fontStyle: 'italic' }}>{hint}</span>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: 'ok' | 'warn' | 'error' }) {
  const cfg = {
    ok:    { glyph: '✓', label: 'valid',    bg: 'rgba(16,133,72,0.18)',  fg: '#4ec9b0' },
    warn:  { glyph: '!', label: 'warnings', bg: 'rgba(204,167,0,0.18)',  fg: '#cca700' },
    error: { glyph: '✕', label: 'errors',   bg: 'rgba(221,43,14,0.18)',  fg: '#f48771' },
  }[status];
  return (
    <span title={`Pipeline state: ${cfg.label}`}
      style={{
        width: 36, height: 36, borderRadius: '50%',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: cfg.bg, color: cfg.fg,
        border: `1px solid ${cfg.fg}55`,
        fontSize: 16, fontWeight: 700,
        flexShrink: 0,
      }}>
      {cfg.glyph}
    </span>
  );
}

function ToggleChip({ label, active, onClick, title }: { label: string; active: boolean; onClick: () => void; title?: string }) {
  return (
    <button onClick={onClick} title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        fontSize: 11,
        fontWeight: 600,
        background: active ? 'var(--vscode-button-background, #0e639c)' : 'transparent',
        color: active ? 'var(--vscode-button-foreground, #fff)' : 'var(--vscode-foreground)',
        border: '1px solid ' + (active ? 'var(--vscode-button-background, #0e639c)' : 'var(--vscode-panel-border, #444)'),
        borderRadius: 3,
        cursor: 'pointer',
      }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: active ? 'currentColor' : 'transparent',
        border: '1px solid currentColor',
        opacity: 0.9,
      }} />
      {label}
    </button>
  );
}

function statusAccent(status: 'ok' | 'warn' | 'error'): string {
  return status === 'error' ? '#dd2b0e' : status === 'warn' ? '#e9be74' : '#108548';
}

function filenameOf(uri: string): string {
  try {
    const u = new URL(uri);
    return decodeURIComponent(u.pathname.split('/').pop() || uri);
  } catch {
    return uri;
  }
}

/** Number of `workflow:rules:` entries, or null when there's no workflow block. */
function workflowRuleCount(model: PipelineModel): number | null {
  const wf = model.workflow;
  if (!wf) return null;
  return Array.isArray(wf.rules) ? wf.rules.length : 0;
}

function unresolvedIncludesHint(model: PipelineModel): string | null {
  const unresolved = model.includes.filter((i) => !i.resolvedUri).length;
  if (unresolved === 0) return null;
  return `${unresolved} unresolved`;
}
