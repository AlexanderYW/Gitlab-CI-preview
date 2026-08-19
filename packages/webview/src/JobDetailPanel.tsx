import { useEffect, useMemo, useRef, useState } from 'react';
import type { Job, PipelineModel } from '@gitlab-ci-preview/shared';
import { vscode } from './vscode.js';
import { SchemaForm } from './SchemaForm.js';
import { resolveReference } from './referenceUtil.js';
import { composeJobVariables, type VarSource } from './vars.js';

// GitLab Pajamas palette
const GL_PURPLE = '#6e49cb';
const GL_ORANGE = '#fc6d26';
const GL_BLUE = '#1f75cb';
const GL_GREEN = '#108548';
const GL_RED = '#dd2b0e';
const GL_AMBER = '#c17d10';

const STAGE_PALETTE = [GL_BLUE, GL_PURPLE, GL_ORANGE, GL_GREEN, GL_RED, '#0095a8', '#a8740e'];

function stageAccent(stage: string): string {
  let h = 0;
  for (let i = 0; i < stage.length; i++) h = ((h << 5) - h + stage.charCodeAt(i)) | 0;
  return STAGE_PALETTE[Math.abs(h) % STAGE_PALETTE.length];
}

export function JobDetailPanel({
  jobName, model, onClose,
}: {
  jobName: string;
  model: PipelineModel;
  onClose: () => void;
}) {
  const job = useMemo(() => model.jobs.find((j) => j.name === jobName) ?? null, [model, jobName]);

  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const lastModelRaw = useRef<string>('');
  useEffect(() => {
    const next = JSON.stringify(job?.raw ?? null);
    if (next !== lastModelRaw.current) {
      lastModelRaw.current = next;
      setDraft((job?.raw as Record<string, unknown>) ?? {});
    }
  }, [job]);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  function scheduleSave(value: Record<string, unknown>) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      vscode().postMessage({ type: 'updateJob', uri: model.rootUri, jobName, newValue: value });
      setSavedAt(Date.now());
    }, 350);
  }
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  // Escape closes panel
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!job) {
    return (
      <FloatingShell accent="#888">
        <EmptyHeader name={jobName} onClose={onClose} />
        <div style={{ padding: 16, opacity: 0.7 }}>This job is no longer in the pipeline.</div>
      </FloatingShell>
    );
  }

  const isLocal = job.source.uri.startsWith('file://');
  const inIncluded = !isLocal;
  const accent = stageAccent(job.stage);

  function openInEditor() {
    vscode().postMessage({ type: 'revealJob', uri: job!.source.uri, jobName: job!.name });
  }

  function onChange(newValue: Record<string, unknown>) {
    setDraft(newValue);
    if (!inIncluded) scheduleSave(newValue);
  }

  return (
    <FloatingShell accent={accent}>
      <Header
        job={job}
        accent={accent}
        savedAt={savedAt}
        readOnly={inIncluded}
        onClose={onClose}
        onOpenEditor={openInEditor}
      />
      {inIncluded && <ReadOnlyBanner uri={job.source.uri} />}
      {job.triggerIncludeUri && <ChildPipelineBanner uri={job.triggerIncludeUri} accent={accent} />}
      <MetaStrip job={job} />
      <Body>
        <VariablesSection job={job} model={model} accent={accent} />
        <SchemaForm
          value={draft ?? (job.raw as Record<string, unknown>)}
          disabled={inIncluded}
          onChange={onChange}
          pipelineCtx={{
            stages: model.stages,
            jobs: model.jobs.map((j) => ({ name: j.name, stage: j.stage, hidden: j.hidden })),
            currentStage: job.stage,
            currentJobName: job.name,
            resolveReference: (path) => resolveReference(model, path),
          }}
        />
      </Body>
    </FloatingShell>
  );
}

// ---------- chrome ----------

const PANEL_WIDTH_KEY = 'gitlabCi.detailPanelWidth';
const MIN_PANEL_WIDTH = 360;
const MAX_PANEL_WIDTH_VW = 90; // never wider than 90% of the viewport

function loadStoredWidth(): number {
  try {
    const raw = window.localStorage.getItem(PANEL_WIDTH_KEY);
    if (!raw) return 480;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return 480;
    return Math.max(MIN_PANEL_WIDTH, n);
  } catch {
    return 480;
  }
}

function FloatingShell({ accent, children }: { accent: string; children: React.ReactNode }) {
  const [width, setWidth] = useState<number>(loadStoredWidth);
  const [dragging, setDragging] = useState(false);
  const asideRef = useRef<HTMLElement | null>(null);

  // Clamp once on mount in case the viewport shrank since the value was saved.
  useEffect(() => {
    const max = Math.floor(window.innerWidth * (MAX_PANEL_WIDTH_VW / 100));
    setWidth((w) => Math.min(max, Math.max(MIN_PANEL_WIDTH, w)));
  }, []);

  useEffect(() => {
    if (!dragging) return;
    function onMove(e: MouseEvent) {
      // Panel is anchored to the right edge → width = viewport right − cursor X
      const max = Math.floor(window.innerWidth * (MAX_PANEL_WIDTH_VW / 100));
      const next = Math.min(max, Math.max(MIN_PANEL_WIDTH, window.innerWidth - e.clientX));
      setWidth(next);
    }
    function onUp() {
      setDragging(false);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    // Prevent text selection / iframe interception while dragging
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
    };
  }, [dragging]);

  // Persist width changes (debounced via the natural settle when dragging stops).
  useEffect(() => {
    if (dragging) return;
    try { window.localStorage.setItem(PANEL_WIDTH_KEY, String(width)); } catch { /* ignore */ }
  }, [dragging, width]);

  function onResizerKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 50 : 10;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      setWidth((w) => Math.min(Math.floor(window.innerWidth * (MAX_PANEL_WIDTH_VW / 100)), w + step));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      setWidth((w) => Math.max(MIN_PANEL_WIDTH, w - step));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setWidth(480); // reset to default
    }
  }

  return (
    <aside
      ref={asideRef}
      style={{
        position: 'absolute',
        top: 0, right: 0, bottom: 0,
        width, maxWidth: '100%',
        background: 'var(--vscode-sideBar-background)',
        borderLeft: `1px solid var(--vscode-panel-border, #2d2d2d)`,
        boxShadow: '-12px 0 32px rgba(0,0,0,0.45)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        zIndex: 20,
        fontFamily: 'var(--vscode-font-family)',
      }}
    >
      {/* Resize handle on the left edge */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        aria-valuemin={MIN_PANEL_WIDTH}
        aria-valuenow={width}
        tabIndex={0}
        onMouseDown={(e) => { e.preventDefault(); setDragging(true); }}
        onDoubleClick={() => setWidth(480)}
        onKeyDown={onResizerKeyDown}
        title="Drag to resize · double-click to reset · ← / → to nudge"
        style={{
          position: 'absolute',
          top: 0, bottom: 0, left: -3,
          width: 6,
          cursor: 'col-resize',
          zIndex: 21,
          background: dragging ? `${accent}40` : 'transparent',
          transition: dragging ? 'none' : 'background 120ms ease',
        }}
        onMouseEnter={(e) => { if (!dragging) (e.currentTarget as HTMLDivElement).style.background = `${accent}22`; }}
        onMouseLeave={(e) => { if (!dragging) (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
      >
        {/* Visible grip dots, centered vertically */}
        <div
          aria-hidden
          style={{
            position: 'absolute',
            top: '50%', left: 0,
            transform: 'translateY(-50%)',
            width: 6, height: 36,
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            gap: 3,
            opacity: dragging ? 1 : 0.6,
            transition: 'opacity 120ms ease',
          }}
        >
          <span style={gripDot(accent)} />
          <span style={gripDot(accent)} />
          <span style={gripDot(accent)} />
          <span style={gripDot(accent)} />
        </div>
      </div>

      {/* GitLab-style top accent gradient bar */}
      <div style={{
        height: 3,
        background: `linear-gradient(90deg, ${accent}, ${accent}88, transparent)`,
        flex: '0 0 auto',
      }} />

      {/* Live width indicator while dragging */}
      {dragging && (
        <div
          aria-live="polite"
          style={{
            position: 'absolute',
            top: 10, left: 12,
            padding: '2px 8px',
            fontSize: 10, fontWeight: 700,
            background: accent,
            color: 'white',
            borderRadius: 10,
            fontFamily: 'var(--vscode-editor-font-family, monospace)',
            zIndex: 22,
            pointerEvents: 'none',
            boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
          }}
        >
          {Math.round(width)}px
        </div>
      )}
      {children}
    </aside>
  );
}

function gripDot(color: string): React.CSSProperties {
  return {
    width: 2, height: 2, borderRadius: '50%',
    background: color,
    display: 'inline-block',
  };
}

function Header({
  job, accent, savedAt, readOnly, onClose, onOpenEditor,
}: {
  job: Job; accent: string; savedAt: number | null; readOnly: boolean;
  onClose: () => void; onOpenEditor: () => void;
}) {
  return (
    <header style={{
      padding: '14px 16px 12px',
      borderBottom: '1px solid var(--vscode-panel-border, #2d2d2d)',
      background: `linear-gradient(180deg, ${accent}14, transparent)`,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        {/* Vertical accent stripe — matches Legend/Diagnostics headers */}
        <span aria-hidden style={{
          width: 4, alignSelf: 'stretch', borderRadius: 2,
          background: `linear-gradient(180deg, ${accent}, ${accent}99)`,
          marginTop: 2,
        }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Breadcrumb: stage › job */}
          <div style={{
            fontSize: 10, opacity: 0.6, fontWeight: 600,
            letterSpacing: 0.6, textTransform: 'uppercase',
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <span style={{ color: accent }}>{job.stage}</span>
            {job.hidden && <Tag>template</Tag>}
            {readOnly && <Tag color={GL_AMBER}>read-only</Tag>}
          </div>
          <div style={{
            fontSize: 17,
            fontWeight: 600,
            lineHeight: 1.25,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontFamily: 'var(--vscode-editor-font-family, monospace)',
            marginTop: 2,
          }} title={job.name}>{job.name}</div>
        </div>
        <IconButton onClick={onClose} title="Close (Esc)" ariaLabel="Close panel">
          <CloseIcon />
        </IconButton>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
        <button onClick={onOpenEditor} style={glButton(accent)} title="Reveal job source in the YAML editor">
          <ExternalIcon /> <span>Open in editor</span>
        </button>
        <span style={{ flex: 1 }} />
        {savedAt && <SavedIndicator t={savedAt} />}
      </div>
    </header>
  );
}

function EmptyHeader({ name, onClose }: { name: string; onClose: () => void }) {
  return (
    <header style={{ padding: '14px 16px', borderBottom: '1px solid var(--vscode-panel-border, #2d2d2d)', display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, fontWeight: 600 }}>{name}</div>
      <IconButton onClick={onClose} title="Close" ariaLabel="Close panel"><CloseIcon /></IconButton>
    </header>
  );
}

function ChildPipelineBanner({ uri, accent }: { uri: string; accent: string }) {
  const name = decodeURIComponent(uri.split('/').pop() ?? uri);
  return (
    <div style={{
      padding: '8px 16px',
      borderBottom: '1px solid var(--vscode-panel-border, #2d2d2d)',
      display: 'flex', alignItems: 'center', gap: 10,
      background: 'var(--vscode-editor-background)',
    }}>
      <span style={{ fontSize: 11, opacity: 0.75 }}>Triggers child pipeline <code>{name}</code></span>
      <span style={{ flex: 1 }} />
      <button
        onClick={() => vscode().postMessage({ type: 'openChildPipeline', uri })}
        style={glButton(accent)}
        title="Open the triggered child pipeline as its own graph"
      >
        Open child pipeline →
      </button>
    </div>
  );
}

function MetaStrip({ job }: { job: Job }) {
  type Chip = { icon: React.ReactNode; label: string; tone: 'info' | 'warn' | 'good' | 'muted' };
  const chips: Chip[] = [];
  if (job.image) chips.push({ icon: <ImageIcon />, label: job.image, tone: 'info' });
  if (job.when === 'manual') chips.push({ icon: <PlayIcon />, label: 'manual', tone: 'warn' });
  if (job.allowFailure) chips.push({ icon: <WarnIcon />, label: 'allow_failure', tone: 'warn' });
  if (job.trigger) chips.push({ icon: <TriggerIcon />, label: 'trigger', tone: 'good' });
  if (job.parallel && job.parallel > 1) chips.push({ icon: <MultiplyIcon />, label: String(job.parallel), tone: 'info' });
  if (job.matrix && job.matrix.length > 0) chips.push({ icon: <MultiplyIcon />, label: `matrix · ${job.matrix.length}`, tone: 'info' });
  if (job.rules && job.rules.length > 0) chips.push({ icon: <RulesIcon />, label: `rules · ${job.rules.length}`, tone: 'muted' });
  if (job.needs && job.needs.length > 0) chips.push({ icon: <NeedsIcon />, label: `needs · ${job.needs.length}`, tone: 'muted' });
  if (job.tags && job.tags.length > 0) chips.push({ icon: <TagIcon />, label: job.tags.join(', '), tone: 'muted' });
  if (chips.length === 0) return null;
  return (
    <div style={{
      padding: '10px 16px',
      borderBottom: '1px solid var(--vscode-panel-border, #2d2d2d)',
      display: 'flex',
      flexWrap: 'wrap',
      gap: 6,
      background: 'var(--vscode-editor-background)',
    }}>
      {chips.map((c, i) => (
        <span key={i} style={chipStyle(c.tone)} title={c.label}>
          {c.icon}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>{c.label}</span>
        </span>
      ))}
    </div>
  );
}

const VAR_SOURCE_META: Record<VarSource, { label: string; color: string }> = {
  global: { label: 'global', color: GL_BLUE },
  default: { label: 'default', color: '#0095a8' },
  job: { label: 'job', color: GL_GREEN },
  matrix: { label: 'matrix', color: GL_PURPLE },
};

/**
 * Effective variables in precedence order (global → default → job → matrix),
 * with `$VAR` expansion where statically resolvable. Computed client-side from
 * the model — see `vars.ts`.
 */
function VariablesSection({ job, model, accent }: { job: Job; model: PipelineModel; accent: string }) {
  const vars = useMemo(() => composeJobVariables(job, model), [job, model]);
  const [open, setOpen] = useState(true);
  if (vars.length === 0) return null;
  return (
    <section style={{
      marginBottom: 14,
      border: '1px solid var(--vscode-panel-border, #2d2d2d)',
      borderRadius: 6,
      overflow: 'hidden',
      background: 'var(--vscode-editor-background)',
    }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{
          width: '100%',
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 12px',
          background: `linear-gradient(180deg, ${accent}10, transparent)`,
          border: 'none', cursor: 'pointer',
          color: 'var(--vscode-foreground)',
          fontFamily: 'var(--vscode-font-family)',
          fontSize: 12, fontWeight: 600,
          textAlign: 'left',
        }}
      >
        <span style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms ease', display: 'inline-block' }}>▸</span>
        <span>Effective variables</span>
        <span style={{ opacity: 0.6, fontWeight: 500 }}>· {vars.length}</span>
      </button>
      {open && (
        <div style={{ padding: '4px 0 6px' }}>
          {vars.map((v) => (
            <div key={v.name} style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.4fr) auto',
              gap: 8, alignItems: 'baseline',
              padding: '4px 12px',
              fontSize: 11,
              fontFamily: 'var(--vscode-editor-font-family, monospace)',
            }}>
              <span style={{ color: 'var(--vscode-symbolIcon-variableForeground, #75beff)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={v.name}>{v.name}</span>
              <span
                title={
                  v.unresolved ? `${v.value} (contains unresolved references)`
                    : v.runtime ? `${v.value} (references GitLab predefined variables, resolved at runtime)`
                      : v.value
                }
                style={{
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  color: v.unresolved ? GL_AMBER : v.runtime ? 'var(--vscode-descriptionForeground)' : 'var(--vscode-foreground)',
                }}
              >{v.value}{v.unresolved ? ' ⚠' : v.runtime ? ' ·rt' : ''}</span>
              <Tag color={VAR_SOURCE_META[v.source].color}>{VAR_SOURCE_META[v.source].label}</Tag>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ReadOnlyBanner({ uri }: { uri: string }) {
  const filename = (() => {
    try { return new URL(uri).pathname.split('/').pop() || uri; }
    catch { return uri; }
  })();
  return (
    <div style={{
      margin: '12px 16px 0',
      padding: '10px 12px',
      background: 'rgba(193,125,16,0.10)',
      border: '1px solid rgba(193,125,16,0.30)',
      borderLeft: `3px solid ${GL_AMBER}`,
      borderRadius: 4,
      fontSize: 11,
      color: 'var(--vscode-foreground)',
      display: 'flex',
      alignItems: 'flex-start',
      gap: 10,
      lineHeight: 1.45,
    }}>
      <LockIcon color={GL_AMBER} />
      <div>
        Defined in <code style={inlineCode}>{filename}</code>. Edits disabled — the source may be a remote template or component.
      </div>
    </div>
  );
}

function Body({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      flex: 1, overflow: 'auto', padding: 14,
      background: 'var(--vscode-sideBar-background)',
    }}>
      {children}
    </div>
  );
}

// Edits are applied to the document buffer but NOT written to disk — the user still
// needs to save. Say so plainly rather than a misleading green "Saved".
function SavedIndicator({ t }: { t: number }) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 5_000);
    return () => clearInterval(id);
  }, [t]);
  const s = Math.floor((Date.now() - t) / 1000);
  const when = s < 5 ? 'Applied to file' : s < 60 ? `Applied ${s}s ago` : `Applied ${new Date(t).toLocaleTimeString()}`;
  const saveKey = navigator.platform.toLowerCase().includes('mac') ? '⌘S' : 'Ctrl+S';
  return (
    <span
      title={`Your change is in the editor buffer. Press ${saveKey} to write it to disk.`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, color: GL_AMBER, fontWeight: 600 }}
    >
      <CheckIcon color={GL_AMBER} />
      {when} · {saveKey} to save
    </span>
  );
}

function Tag({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <span style={{
      display: 'inline-block',
      padding: '0 6px',
      fontSize: 9,
      fontWeight: 700,
      letterSpacing: 0.4,
      textTransform: 'uppercase',
      color: color ?? 'var(--vscode-descriptionForeground)',
      background: color ? `${color}1f` : 'rgba(255,255,255,0.06)',
      border: `1px solid ${color ? `${color}55` : 'rgba(255,255,255,0.12)'}`,
      borderRadius: 8,
      lineHeight: '14px',
    }}>{children}</span>
  );
}

function IconButton({ onClick, title, ariaLabel, children }: { onClick: () => void; title: string; ariaLabel: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      style={{
        width: 26, height: 26,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: 'transparent',
        color: 'var(--vscode-descriptionForeground)',
        border: 'none', borderRadius: 4, cursor: 'pointer',
        transition: 'background 80ms ease, color 80ms ease',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = 'var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08))';
        (e.currentTarget as HTMLButtonElement).style.color = 'var(--vscode-foreground)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
        (e.currentTarget as HTMLButtonElement).style.color = 'var(--vscode-descriptionForeground)';
      }}
    >{children}</button>
  );
}

// ---------- inline SVG icons ----------

function CloseIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden>
      <path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />
    </svg>
  );
}
function ExternalIcon() {
  return (
    <svg width={11} height={11} viewBox="0 0 12 12" aria-hidden>
      <path d="M5 2 H10 V7 M10 2 L5 7 M2 4 V10 H8" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function CheckIcon({ color }: { color: string }) {
  return (
    <svg width={11} height={11} viewBox="0 0 12 12" aria-hidden>
      <path d="M2.5 6.5 L5 9 L9.5 3.5" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function LockIcon({ color }: { color: string }) {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden style={{ flex: '0 0 auto', marginTop: 1 }}>
      <rect x={3} y={7} width={10} height={7} rx={1.2} fill="none" stroke={color} strokeWidth={1.4} />
      <path d="M5 7 V5 a3 3 0 0 1 6 0 V7" fill="none" stroke={color} strokeWidth={1.4} />
    </svg>
  );
}
function ImageIcon() {
  return (
    <svg width={11} height={11} viewBox="0 0 16 16" aria-hidden>
      <rect x={1.5} y={3} width={13} height={10} rx={1.2} fill="none" stroke="currentColor" strokeWidth={1.4} />
      <circle cx={5.5} cy={6.5} r={1.2} fill="currentColor" />
      <path d="M2 12 L6 8 L9 11 L11.5 9 L14 12" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function PlayIcon() {
  return (
    <svg width={10} height={10} viewBox="0 0 12 12" aria-hidden>
      <path d="M3 2 L10 6 L3 10 Z" fill="currentColor" />
    </svg>
  );
}
function WarnIcon() {
  return (
    <svg width={11} height={11} viewBox="0 0 16 16" aria-hidden>
      <path d="M8 1.5 L15 14 L1 14 Z" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinejoin="round" />
      <rect x={7.4} y={6} width={1.2} height={4.5} rx={0.5} fill="currentColor" />
      <circle cx={8} cy={12} r={0.8} fill="currentColor" />
    </svg>
  );
}
function TriggerIcon() {
  return (
    <svg width={11} height={11} viewBox="0 0 12 12" aria-hidden>
      <path d="M3 9 L9 3 M5 3 H9 V7" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function MultiplyIcon() {
  return (
    <svg width={10} height={10} viewBox="0 0 12 12" aria-hidden>
      <path d="M3 3 L9 9 M9 3 L3 9" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />
    </svg>
  );
}
function RulesIcon() {
  return (
    <svg width={11} height={11} viewBox="0 0 16 16" aria-hidden>
      <path d="M3 4 H13 M3 8 H13 M3 12 H9" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
    </svg>
  );
}
function NeedsIcon() {
  return (
    <svg width={11} height={11} viewBox="0 0 16 16" aria-hidden>
      <circle cx={4} cy={8} r={2} fill="none" stroke="currentColor" strokeWidth={1.3} />
      <circle cx={12} cy={4} r={2} fill="none" stroke="currentColor" strokeWidth={1.3} />
      <circle cx={12} cy={12} r={2} fill="none" stroke="currentColor" strokeWidth={1.3} />
      <path d="M6 7 L10 4.5 M6 9 L10 11.5" stroke="currentColor" strokeWidth={1.3} />
    </svg>
  );
}
function TagIcon() {
  return (
    <svg width={11} height={11} viewBox="0 0 16 16" aria-hidden>
      <path d="M2 2 H8 L14 8 L8 14 L2 8 Z" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinejoin="round" />
      <circle cx={5} cy={5} r={1} fill="currentColor" />
    </svg>
  );
}

// ---------- styles ----------

const inlineCode: React.CSSProperties = {
  padding: '0 4px',
  background: 'rgba(255,255,255,0.06)',
  border: '1px solid rgba(255,255,255,0.10)',
  borderRadius: 3,
  fontFamily: 'var(--vscode-editor-font-family, monospace)',
  fontSize: 10.5,
};

function glButton(accent: string): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '5px 10px',
    fontSize: 11,
    fontWeight: 600,
    background: 'transparent',
    color: accent,
    border: `1px solid ${accent}66`,
    borderRadius: 4,
    cursor: 'pointer',
    transition: 'background 80ms ease',
    fontFamily: 'var(--vscode-font-family)',
  };
}

function chipStyle(tone: 'info' | 'warn' | 'good' | 'muted'): React.CSSProperties {
  const map = {
    info: { fg: GL_BLUE, bg: 'rgba(31,117,203,0.12)', bd: 'rgba(31,117,203,0.35)' },
    warn: { fg: GL_AMBER, bg: 'rgba(193,125,16,0.12)', bd: 'rgba(193,125,16,0.35)' },
    good: { fg: GL_GREEN, bg: 'rgba(16,133,72,0.14)', bd: 'rgba(16,133,72,0.40)' },
    muted: { fg: 'var(--vscode-descriptionForeground)', bg: 'rgba(255,255,255,0.04)', bd: 'rgba(255,255,255,0.10)' },
  }[tone];
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    fontSize: 10.5,
    fontWeight: 600,
    padding: '3px 8px',
    borderRadius: 10,
    color: map.fg,
    background: map.bg,
    border: `1px solid ${map.bd}`,
    whiteSpace: 'nowrap',
    fontFamily: 'var(--vscode-font-family)',
    lineHeight: 1,
  };
}
