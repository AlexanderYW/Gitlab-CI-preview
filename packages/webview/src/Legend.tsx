import { useEffect, useRef, useState } from 'react';

interface BadgeDef {
  symbol: string;
  title: string;
  yamlKey: string;
  description: string;
}

const BADGES: BadgeDef[] = [
  {
    symbol: '▶',
    title: 'Manual job',
    yamlKey: 'when: manual',
    description: 'Job runs only when an operator explicitly starts it from the GitLab UI. Useful for production deploys or destructive actions.',
  },
  {
    symbol: '⚠',
    title: 'Allowed to fail',
    yamlKey: 'allow_failure: true',
    description: 'If this job fails the pipeline still succeeds. Typical for non-blocking scans (linting, security scanners), preview jobs, or experimental steps.',
  },
  {
    symbol: '↗',
    title: 'Pipeline trigger',
    yamlKey: 'trigger:',
    description: 'Starts a downstream pipeline (a child pipeline in the same project, or a multi-project pipeline elsewhere) instead of running a script.',
  },
  {
    symbol: '×N',
    title: 'Parallel',
    yamlKey: 'parallel: N',
    description: 'The job is executed N times in parallel. Each instance gets CI_NODE_INDEX / CI_NODE_TOTAL variables — commonly used to split test suites.',
  },
  {
    symbol: '⊞ N',
    title: 'Matrix',
    yamlKey: 'parallel: matrix: [...]',
    description: 'The job expands into N variants, one per combination of the matrix variables. Rendered as a single stacked card rather than N separate nodes.',
  },
  {
    symbol: '⚙',
    title: 'Has services',
    yamlKey: 'services: [...]',
    description: 'The job starts one or more service containers (e.g. a database or Docker-in-Docker) alongside the job for the duration of the run.',
  },
  {
    symbol: '🌐',
    title: 'Deploys to environment',
    yamlKey: 'environment:',
    description: 'The job targets a GitLab environment (e.g. staging or production), tracked on the project’s Environments page and Deployments history.',
  },
  {
    symbol: 'rules:N',
    title: 'Has rules',
    yamlKey: 'rules: [...]',
    description: 'The job has N rule entries that determine when (or whether) it runs — typically gating on branch name, MR state, file changes, or variables.',
  },
];

const EDGE_LEGEND: { label: string; stroke: string; dash?: string; description: string }[] = [
  { label: 'needs:', stroke: '#1f75cb', description: 'Job will not start until the source job finishes successfully (DAG edge).' },
  { label: 'dependencies:', stroke: '#1f75cb', dash: '4 3', description: 'Job downloads artifacts from the source job (still stage-ordered).' },
  { label: 'extends:', stroke: '#8f8f8f', dash: '2 3', description: 'Job inherits configuration from the source template job.' },
];

// GitLab brand palette (Pajamas)
const GL_ORANGE = '#FC6D26';
const GL_ORANGE_DARK = '#E24329';

export function Legend() {
  const [open, setOpen] = useState(false);
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

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="What do these badges mean?"
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
          transition: 'background 120ms ease, border-color 120ms ease',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.borderColor = GL_ORANGE;
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--vscode-panel-border, #444)';
        }}
      >
        <InfoIcon />
        <span>Legend</span>
        <Chevron open={open} />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Pipeline legend"
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            right: 0,
            width: 400,
            maxHeight: 480,
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--vscode-editorWidget-background, #252526)',
            color: 'var(--vscode-foreground)',
            border: '1px solid var(--vscode-panel-border, #444)',
            borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
            zIndex: 50,
            fontSize: 12,
            overflow: 'hidden',
          }}
        >
          {/* Header bar with GitLab-orange accent */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 14px',
              borderBottom: '1px solid var(--vscode-panel-border, #444)',
              background: 'linear-gradient(180deg, rgba(252,109,38,0.08), rgba(252,109,38,0))',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                aria-hidden
                style={{
                  width: 4,
                  height: 16,
                  borderRadius: 2,
                  background: `linear-gradient(180deg, ${GL_ORANGE}, ${GL_ORANGE_DARK})`,
                  display: 'inline-block',
                }}
              />
              <span style={{ fontWeight: 600, fontSize: 13 }}>Pipeline legend</span>
            </div>
            <button
              onClick={() => setOpen(false)}
              aria-label="Close legend"
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--vscode-foreground)',
                opacity: 0.6,
                cursor: 'pointer',
                fontSize: 14,
                lineHeight: 1,
                padding: 2,
              }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.opacity = '1')}
              onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.opacity = '0.6')}
            >
              ✕
            </button>
          </div>

          <div style={{ overflowY: 'auto', padding: '4px 0' }}>
            <Section title="Job badges">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {BADGES.map((b) => (
                  <div key={b.symbol} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    <span style={badgePill}>{b.symbol}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 600 }}>{b.title}</span>
                        <code style={codeChip}>{b.yamlKey}</code>
                      </div>
                      <div style={{ opacity: 0.78, marginTop: 3, lineHeight: 1.45 }}>{b.description}</div>
                    </div>
                  </div>
                ))}
              </div>
            </Section>

            <Divider />

            <Section title="Edges">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {EDGE_LEGEND.map((e) => (
                  <div key={e.label} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <EdgeSwatch stroke={e.stroke} dash={e.dash} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <code style={codeChip}>{e.label}</code>{' '}
                      <span style={{ opacity: 0.85 }}>{e.description}</span>
                    </div>
                  </div>
                ))}
              </div>
            </Section>

            <Divider />

            <Section title="Interactions">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <Interaction kbd="Click" text="job → opens the side panel to inspect/edit." />
                <Interaction kbd="Double-click" text="job → jumps to its source in the YAML editor." />
                <Interaction kbd="Click" text="stage header → rename it (Enter to save, Esc to cancel)." />
                <Interaction kbd="Tab / Arrows" text="move focus between job nodes." />
                <Interaction kbd="Enter" text="open the focused job's side panel." />
                <Interaction kbd="Esc" text="close the side panel or this legend." />
                <div style={{ opacity: 0.65, fontSize: 11, marginTop: 2 }}>
                  Stage left-accent color is a stable hash of the stage name (purely cosmetic).
                </div>
              </div>
            </Section>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: '10px 14px' }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 0.8,
          textTransform: 'uppercase',
          opacity: 0.55,
          marginBottom: 8,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function Divider() {
  return <div style={{ height: 1, background: 'var(--vscode-panel-border, #444)', opacity: 0.5, margin: '0 14px' }} />;
}

function Interaction({ kbd, text }: { kbd: string; text: string }) {
  return (
    <div style={{ lineHeight: 1.5 }}>
      <span style={kbdStyle}>{kbd}</span>{' '}
      <span style={{ opacity: 0.85 }}>{text}</span>
    </div>
  );
}

function EdgeSwatch({ stroke, dash }: { stroke: string; dash?: string }) {
  return (
    <svg width={36} height={10} aria-hidden style={{ flex: '0 0 auto' }}>
      <line
        x1={0}
        y1={5}
        x2={36}
        y2={5}
        stroke={stroke}
        strokeWidth={2}
        strokeDasharray={dash}
        strokeLinecap="round"
      />
    </svg>
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
      <path d="M2 3.5 L5 6.5 L8 3.5" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" aria-hidden style={{ color: GL_ORANGE }}>
      <circle cx={8} cy={8} r={7} fill="none" stroke="currentColor" strokeWidth={1.4} />
      <circle cx={8} cy={4.5} r={1} fill="currentColor" />
      <rect x={7.25} y={6.75} width={1.5} height={5} rx={0.6} fill="currentColor" />
    </svg>
  );
}

const badgePill: React.CSSProperties = {
  flex: '0 0 auto',
  minWidth: 36,
  height: 22,
  padding: '0 8px',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 11,
  fontWeight: 700,
  color: GL_ORANGE,
  background: 'rgba(252,109,38,0.10)',
  border: `1px solid rgba(252,109,38,0.35)`,
  borderRadius: 10,
  fontFamily: 'var(--vscode-editor-font-family, monospace)',
};

const codeChip: React.CSSProperties = {
  display: 'inline-block',
  padding: '1px 6px',
  fontSize: 11,
  background: 'var(--vscode-textCodeBlock-background, rgba(255,255,255,0.06))',
  border: '1px solid var(--vscode-panel-border, #444)',
  borderRadius: 3,
  fontFamily: 'var(--vscode-editor-font-family, monospace)',
  whiteSpace: 'nowrap',
};

const kbdStyle: React.CSSProperties = {
  display: 'inline-block',
  padding: '1px 6px',
  fontSize: 10,
  fontWeight: 600,
  color: 'var(--vscode-foreground)',
  background: 'var(--vscode-keybindingLabel-background, rgba(255,255,255,0.08))',
  border: '1px solid var(--vscode-keybindingLabel-border, rgba(255,255,255,0.2))',
  borderBottomWidth: 2,
  borderRadius: 3,
  fontFamily: 'var(--vscode-editor-font-family, monospace)',
};
