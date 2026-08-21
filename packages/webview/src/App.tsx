import { useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, Controls, MiniMap, PanOnScrollMode, getNodesBounds, getViewportForBounds, type Node, type Edge, type NodeProps } from '@xyflow/react';
import { toPng } from 'html-to-image';
import type { PipelineModel } from '@gitlab-ci-preview/shared';
import { buildGraph, connectedNodeIds, reachableNodeIds, nearestNodeInDirection, type ArrowKey, type LayoutMode } from './layout.js';
import { vscode } from './vscode.js';
import { JobDetailPanel } from './JobDetailPanel.js';
import { PipelineHeader } from './PipelineHeader.js';
import { simulatePipeline, PIPELINE_SOURCES, parseVariablePairs, type SimulationResult } from './rules.js';

export function App() {
  const [model, setModel] = useState<PipelineModel | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selectedJobName, setSelectedJobName] = useState<string | null>(null);
  const flowWrapRef = useRef<HTMLDivElement | null>(null);

  function focusNode(id: string) {
    flowWrapRef.current
      ?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`)
      ?.focus();
  }

  /** Render the whole graph (not just the visible viewport) to a PNG and hand it to the extension to save. */
  async function exportPng() {
    const nodes = graph && 'nodes' in graph ? graph.nodes : [];
    const viewportEl = flowWrapRef.current?.querySelector<HTMLElement>('.react-flow__viewport');
    if (nodes.length === 0 || !viewportEl) return;
    const PAD = 24;
    const bounds = getNodesBounds(nodes);
    const w = Math.ceil(bounds.width + PAD * 2);
    const h = Math.ceil(bounds.height + PAD * 2);
    const vp = getViewportForBounds(bounds, w, h, 0.5, 2, PAD);
    const bg = getComputedStyle(document.body).backgroundColor || '#1e1e1e';
    try {
      const dataUrl = await toPng(viewportEl, {
        backgroundColor: bg,
        width: w,
        height: h,
        style: { width: `${w}px`, height: `${h}px`, transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})` },
      });
      const base = decodeURIComponent((model?.rootUri ?? 'pipeline').split('/').pop() ?? 'pipeline').replace(/\.ya?ml$/i, '');
      vscode().postMessage({ type: 'exportPng', dataUrl, suggestedName: `${base}-pipeline.png` });
    } catch (e) {
      setErr(`PNG export failed: ${(e as Error).message}`);
    }
  }

  // Keyboard a11y: Tab focuses nodes (built-in); Enter opens details; arrows move focus
  // spatially between jobs using their laid-out positions (right → next stage, etc.).
  function onFlowKeyDown(e: React.KeyboardEvent) {
    const activeId = (document.activeElement as HTMLElement | null)?.getAttribute?.('data-id') ?? null;
    if (e.key === 'Enter' && activeId && !activeId.startsWith('__stage_')) {
      e.preventDefault();
      setSelectedJobName(activeId);
      return;
    }
    if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(e.key)) return;
    const ns = graph && 'nodes' in graph ? graph.nodes : [];
    const centers = ns
      .filter((n) => !n.id.startsWith('__stage_'))
      .map((n) => ({
        id: n.id,
        x: n.position.x + (Number(n.style?.width) || 200) / 2,
        y: n.position.y + (Number(n.style?.height) || 36) / 2,
      }));
    const next = nearestNodeInDirection(centers, activeId, e.key as ArrowKey);
    if (next) {
      e.preventDefault();
      focusNode(next);
    }
  }

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const msg = e.data;
      if (msg?.type === 'modelUpdated') {
        setModel(msg.model as PipelineModel);
        setErr(null);
      } else if (msg?.type === 'gitRefs') {
        setGitBranches(msg.branches as string[]);
        // Seed the simulated ref from the checked-out branch (once).
        if (!didInitRef.current && msg.current) { setSimRef(msg.current as string); }
        didInitRef.current = true;
      } else if (msg?.type === 'simFilesResult') {
        setSimFiles({
          ref: msg.ref as string,
          source: msg.pipelineSource as string,
          ...(msg.changedFiles ? { changed: msg.changedFiles as string[] } : {}),
          ...(msg.existsFiles ? { exists: msg.existsFiles as string[] } : {}),
        });
      }
    };
    const onError = (e: ErrorEvent) => {
      setErr(`${e.message} (${e.filename}:${e.lineno})`);
    };
    window.addEventListener('message', onMsg);
    window.addEventListener('error', onError);
    vscode().postMessage({ type: 'ready' });
    return () => {
      window.removeEventListener('message', onMsg);
      window.removeEventListener('error', onError);
    };
  }, []);

  const [showHidden, setShowHidden] = useState(false);
  const [showEdgeLabels, setShowEdgeLabels] = useState(false);
  const [filter, setFilter] = useState('');
  const [hideUnmatched, setHideUnmatched] = useState(false);
  const [layout, setLayout] = useState<LayoutMode>('stages');
  // Hover spotlight scope: direct neighbours (default) or the full transitive chain.
  const [spotlightChain, setSpotlightChain] = useState(false);

  // Rules simulation: when enabled, evaluate workflow/job rules for the chosen ref + source.
  const [simEnabled, setSimEnabled] = useState(false);
  const [simRef, setSimRef] = useState('main');
  const [simSource, setSimSource] = useState<string>('push');
  const [simVars, setSimVars] = useState('');
  const [gitBranches, setGitBranches] = useState<string[]>([]);
  const didInitRef = useRef(false);
  // File lists fetched for `changes:` / `exists:` evaluation (best-effort, per ref + source).
  const [simFiles, setSimFiles] = useState<{ ref: string; source: string; changed?: string[]; exists?: string[] } | null>(null);
  const simFilesKey = useRef<string | null>(null);

  const sim = useMemo<SimulationResult | null>(() => {
    if (!model || !simEnabled) return null;
    const files = simFiles && simFiles.ref === simRef && simFiles.source === simSource ? simFiles : null;
    const extraVariables = parseVariablePairs(simVars);
    return simulatePipeline(model, {
      ref: simRef,
      pipelineSource: simSource,
      ...(files?.changed ? { changedFiles: files.changed } : {}),
      ...(files?.exists ? { existsFiles: files.exists } : {}),
      ...(Object.keys(extraVariables).length > 0 ? { extraVariables } : {}),
    });
  }, [model, simEnabled, simRef, simSource, simFiles, simVars]);

  // Best-effort file lists for the simulation: ask the client for the local git file lists
  // of the simulated ref. Results arrive as `simFilesResult`; stale ones are ignored by the
  // memo above (they only apply when ref + source still match).
  useEffect(() => {
    if (!model || !simEnabled) return;
    const key = `${model.rootUri}|${simRef}|${simSource}`;
    if (simFilesKey.current === key) return;
    simFilesKey.current = key;
    setSimFiles(null);
    vscode().postMessage({ type: 'simFiles', uri: model.rootUri, ref: simRef, pipelineSource: simSource });
  }, [model, simEnabled, simRef, simSource]);

  // Hint shown when the pipeline uses file conditions but no local file data is available.
  const simFilesHint = useMemo(() => {
    if (!model || !simEnabled) return null;
    const usesFileConditions = model.jobs.some((j) => j.raw.changes !== undefined || j.raw.exists !== undefined);
    if (!usesFileConditions) return null;
    if (!simFiles) return null;
    if (simFiles.ref !== simRef || simFiles.source !== simSource) return null;
    if (!simFiles.changed && !simFiles.exists) return 'No local file data — changes:/exists: assumed to match';
    return null;
  }, [model, simEnabled, simFiles, simRef, simSource]);

  const graph = useMemo<{ nodes: Node[]; edges: Edge[] } | { error: string } | null>(
    () => {
      if (!model) return null;
      try {
        return buildGraph(model, { showHidden, showEdgeLabels, filter, filterMode: hideUnmatched ? 'hide' : 'dim', layout, outcomes: sim?.outcomes });
      } catch (e) {
        return { error: `Graph layout failed: ${(e as Error).stack ?? (e as Error).message}` };
      }
    },
    [model, showHidden, showEdgeLabels, filter, hideUnmatched, layout, sim],
  );

  // Hovering a node spotlights its neighbourhood: unconnected nodes and non-incident
  // edges fade. Applied as a cheap post-process so layout isn't recomputed on hover.
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const view = useMemo<{ nodes: Node[]; edges: Edge[] }>(() => {
    const base = graph && 'nodes' in graph ? graph : { nodes: [], edges: [] };
    if (!hoveredId) return base;
    const connected = spotlightChain
      ? reachableNodeIds(base.edges, hoveredId)
      : connectedNodeIds(base.edges, hoveredId);
    const nodes = base.nodes.map((n) =>
      n.id.startsWith('__stage_') || connected.has(n.id)
        ? n
        : { ...n, style: { ...n.style, opacity: 0.12 } },
    );
    const edges = base.edges.map((e) =>
      connected.has(e.source) && connected.has(e.target)
        ? e
        : { ...e, style: { ...e.style, opacity: 0.06 } },
    );
    return { nodes, edges };
  }, [graph, hoveredId, spotlightChain]);

  const layoutErr = graph && 'error' in graph ? graph.error : null;
  if (err || layoutErr) {
    return (
      <Center>
        <h3 style={{ color: 'var(--vscode-errorForeground)' }}>Pipeline graph error</h3>
        <pre style={{ whiteSpace: 'pre-wrap', maxWidth: '90vw', overflow: 'auto' }}>{err ?? layoutErr}</pre>
      </Center>
    );
  }
  if (!model) {
    return <Center>Loading pipeline…</Center>;
  }

  const visibleJobs = model.jobs.filter((j) => !j.hidden || showHidden);
  const errors = model.diagnostics.filter((d) => d.severity === 'error');

  if (visibleJobs.length === 0) {
    return (
      <Center>
        <h3>No jobs found</h3>
        <p style={{ opacity: 0.7, maxWidth: 480, textAlign: 'center' }}>
          This file has no visible jobs. Hidden jobs (those starting with <code>.</code>) and template
          definitions are not shown in the graph.
        </p>
        {model.includes.length > 0 && (
          <p style={{ opacity: 0.7 }}>{model.includes.length} include(s) resolved.</p>
        )}
        {errors.length > 0 && (
          <details style={{ marginTop: 16, maxWidth: 640 }}>
            <summary style={{ color: 'var(--vscode-errorForeground)' }}>{errors.length} error(s)</summary>
            <ul>{errors.slice(0, 10).map((d, i) => <li key={i}>{d.message}</li>)}</ul>
          </details>
        )}
      </Center>
    );
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', position: 'relative' }}>
      <PipelineHeader
        model={model}
        visibleJobs={visibleJobs}
        showHidden={showHidden}
        setShowHidden={setShowHidden}
        showEdgeLabels={showEdgeLabels}
        setShowEdgeLabels={setShowEdgeLabels}
        spotlightChain={spotlightChain}
        setSpotlightChain={setSpotlightChain}
        filter={filter}
        setFilter={setFilter}
        hideUnmatched={hideUnmatched}
        setHideUnmatched={setHideUnmatched}
        matchCount={filter.trim() ? visibleJobs.filter((j) => j.name.toLowerCase().includes(filter.trim().toLowerCase())).length : null}
        layout={layout}
        setLayout={setLayout}
        onExportPng={exportPng}
      />
      <SimulationBar
        enabled={simEnabled}
        setEnabled={setSimEnabled}
        refName={simRef}
        setRefName={setSimRef}
        source={simSource}
        setSource={setSimSource}
        vars={simVars}
        setVars={setSimVars}
        result={sim}
        branches={gitBranches}
        wouldRun={sim ? visibleJobs.filter((j) => sim.outcomes[j.name] !== 'never').length : 0}
        total={visibleJobs.length}
        hint={simFilesHint}
      />
      <div
        ref={flowWrapRef}
        role="region"
        aria-label="Pipeline graph. Use Tab or arrow keys to move between jobs, Enter to open job details."
        onKeyDown={onFlowKeyDown}
        // Keyboard parity for the hover spotlight: focusing a node (Tab/arrows) fades its
        // non-neighbours just like mouseenter does. Clear only when focus leaves the graph.
        onFocusCapture={(e) => {
          const id = (e.target as HTMLElement).getAttribute?.('data-id');
          if (id && !id.startsWith('__stage_')) setHoveredId(id);
        }}
        onBlurCapture={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as HTMLElement | null)) setHoveredId(null);
        }}
        style={{ flex: 1, position: 'relative', background: 'var(--vscode-editor-background)', minHeight: 0 }}
      >
        <div style={{ position: 'absolute', inset: 0 }}>
        <ReactFlow
          nodes={view.nodes}
          edges={view.edges}
          nodeTypes={nodeTypes}
          onNodeMouseEnter={(_, node) => { if (!node.id.startsWith('__stage_')) setHoveredId(node.id); }}
          onNodeMouseLeave={() => setHoveredId(null)}
          defaultViewport={{ x: 0, y: 0, zoom: 1 }}
          minZoom={0.2}
          maxZoom={2.5}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={true}
          proOptions={{ hideAttribution: true }}
          // Figma-style trackpad:
          //  • two-finger scroll → pan in both directions
          //  • two-finger pinch  → zoom
          //  • Cmd/Ctrl + scroll → zoom (override)
          //  • click+drag empty area → pan
          panOnScroll
          panOnScrollMode={PanOnScrollMode.Free}
          panOnScrollSpeed={1}
          zoomOnScroll={false}
          zoomOnPinch={true}
          zoomOnDoubleClick={false}
          panOnDrag={true}
          preventScrolling={true}
          zoomActivationKeyCode={['Meta', 'Control']}
          onNodeClick={(_, node) => {
            if (node.id.startsWith('__stage_')) return;
            // Open immediately — no debounce. Double-click additionally jumps to source.
            setSelectedJobName(node.id);
          }}
          onNodeDoubleClick={(_, node) => {
            if (node.id.startsWith('__stage_')) return;
            const job = model.jobs.find((j) => j.name === node.id);
            if (job) vscode().postMessage({ type: 'revealJob', uri: job.source.uri, jobName: job.name });
          }}
          onPaneClick={() => setSelectedJobName(null)}
        >
          <Background gap={20} size={1} color="var(--vscode-editorIndentGuide-background)" />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            nodeBorderRadius={6}
            nodeStrokeWidth={0}
            nodeColor={(n) => {
              if (n.id.startsWith('__stage_')) return 'transparent';
              return String((n.data as any)?.accent ?? '#888');
            }}
            maskColor="rgba(0,0,0,0.65)"
            style={{
              background: 'var(--vscode-sideBar-background, #1e1e1e)',
              border: '1px solid var(--vscode-panel-border, #444)',
            }}
          />
        </ReactFlow>
        </div>
      </div>
      {selectedJobName && (
        <JobDetailPanel
          jobName={selectedJobName}
          model={model}
          onClose={() => setSelectedJobName(null)}
        />
      )}
      <div aria-live="polite" style={visuallyHidden}>
        {selectedJobName ? `Selected job ${selectedJobName}` : ''}
      </div>
    </div>
  );
}

// Off-screen but readable by screen readers.
const visuallyHidden: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

function StageHeaderNode({ data }: NodeProps) {
  const label = String((data as any).label ?? '');
  const originalStage = String((data as any).stage ?? '');
  const uri = String((data as any).uri ?? '');
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(label);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Resync if model updates while not actively editing
  useEffect(() => { if (!editing) setValue(label); }, [label, editing]);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  function commit() {
    const next = value.trim();
    if (next && next !== originalStage && originalStage && uri) {
      vscode().postMessage({ type: 'renameStage', uri, oldName: originalStage, newName: next });
    } else {
      setValue(label);
    }
    setEditing(false);
  }
  function cancel() { setValue(label); setEditing(false); }

  const baseStyle: React.CSSProperties = {
    width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'flex-start',
    color: 'var(--vscode-descriptionForeground, #888)', fontFamily: 'var(--vscode-font-family)',
    fontSize: 11, fontWeight: 700, letterSpacing: 1.2, padding: '0 4px',
    textTransform: 'uppercase',
  };

  if (!editing) {
    return (
      <div
        style={{ ...baseStyle, cursor: 'text', userSelect: 'none' }}
        title="Click to rename stage"
        onClick={() => setEditing(true)}
      >
        {label}
      </div>
    );
  }
  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      }}
      autoFocus
      style={{
        ...baseStyle,
        background: 'var(--vscode-input-background, #1e1e1e)',
        color: 'var(--vscode-input-foreground, #ccc)',
        border: '1px solid var(--vscode-focusBorder, #007fd4)',
        borderRadius: 3,
        textTransform: 'none',
        letterSpacing: 0,
        fontWeight: 600,
        outline: 'none',
        padding: '0 6px',
      }}
    />
  );
}

const nodeTypes = { stageHeader: StageHeaderNode };

/**
 * Toolbar to simulate which jobs would run for a given ref + pipeline source by
 * evaluating `workflow:` and per-job `rules:` / `only:` / `except:`. `changes:` /
 * `exists:` are evaluated against the local git file lists when available; when they
 * are not (no data), they are treated as matching — the `hint` prop surfaces that.
 */
function SimulationBar({
  enabled, setEnabled, refName, setRefName, source, setSource, vars, setVars, result, branches, wouldRun, total, hint,
}: {
  enabled: boolean; setEnabled: (v: boolean) => void;
  refName: string; setRefName: (v: string) => void;
  source: string; setSource: (v: string) => void;
  vars: string; setVars: (v: string) => void;
  result: SimulationResult | null; branches: string[]; wouldRun: number; total: number;
  /** Optional amber note, e.g. when `changes:`/`exists:` fall back to optimistic matching. */
  hint?: string | null;
}) {
  const controlStyle: React.CSSProperties = {
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    border: '1px solid var(--vscode-input-border, var(--vscode-panel-border, #444))',
    borderRadius: 4,
    padding: '2px 6px',
    fontSize: 11,
    fontFamily: 'var(--vscode-font-family)',
  };
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
      padding: '6px 12px',
      borderBottom: '1px solid var(--vscode-panel-border, #2d2d2d)',
      background: 'var(--vscode-sideBar-background)',
      fontSize: 11, fontFamily: 'var(--vscode-font-family)',
    }}>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600, cursor: 'pointer' }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Simulate rules
      </label>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, opacity: enabled ? 1 : 0.5 }}>
        ref
        <input
          type="text"
          value={refName}
          disabled={!enabled}
          onChange={(e) => setRefName(e.target.value)}
          placeholder="branch or tag"
          list="gitlabci-branches"
          style={{ ...controlStyle, width: 140 }}
          aria-label="Commit branch or tag to simulate"
        />
        {branches.length > 0 && (
          <datalist id="gitlabci-branches">
            {branches.map((b) => <option key={b} value={b} />)}
          </datalist>
        )}
      </label>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, opacity: enabled ? 1 : 0.5 }}>
        source
        <select
          value={source}
          disabled={!enabled}
          onChange={(e) => setSource(e.target.value)}
          style={controlStyle}
          aria-label="Pipeline source to simulate"
        >
          {PIPELINE_SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, opacity: enabled ? 1 : 0.5 }}>
        vars
        <input
          type="text"
          value={vars}
          disabled={!enabled}
          onChange={(e) => setVars(e.target.value)}
          placeholder="KEY=VALUE, one per line"
          style={{ ...controlStyle, width: 200 }}
          aria-label="Extra CI variables for the simulation"
        />
      </label>
      {enabled && hint && (
        <span style={{ color: 'var(--vscode-editorWarning-foreground, #dcb678)' }}>{hint}</span>
      )}
      {enabled && result && (
        <span style={{ marginLeft: 'auto', opacity: 0.85 }} aria-live="polite">
          {result.pipelineRuns
            ? <><strong>{wouldRun}</strong> of {total} jobs would run</>
            : <span style={{ color: 'var(--vscode-errorForeground)' }}>workflow:rules block this pipeline</span>}
        </span>
      )}
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      height: '100vh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24,
    }}>
      {children}
    </div>
  );
}
