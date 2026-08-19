import type { Edge, Node } from '@xyflow/react';
import type { Job, PipelineModel } from '@gitlab-ci-preview/shared';
import dagre from 'dagre';
import type { JobOutcome } from './rules.js';
import { detectCycles, edgeKey } from './cycles.js';

const CYCLE_COLOR = '#dd2b0e'; // GitLab red — jobs/edges in a needs cycle
const MANUAL_COLOR = '#c17d10'; // GitLab amber — jobs whose rules resolve to `when: manual`

export type LayoutMode = 'stages' | 'dag';

export interface LayoutOptions {
  showHidden: boolean;
  /** Render text labels on needs/dependencies/extends edges. */
  showEdgeLabels?: boolean;
  /** Case-insensitive substring; non-matching job nodes are dimmed (layout stays stable). */
  filter?: string;
  /** 'dim' (default) fades non-matching jobs; 'hide' removes them from the layout. */
  filterMode?: 'dim' | 'hide';
  /** 'stages' = column-per-stage (default); 'dag' = needs-based dependency layout via dagre. */
  layout?: LayoutMode;
  /** When set (rules simulation active), per-job outcome; jobs that wouldn't run are dimmed. */
  outcomes?: Record<string, JobOutcome>;
}

// GitLab-style sizing
const NODE_WIDTH = 200;
const NODE_HEIGHT = 36;
const NODE_VGAP = 16;
const STAGE_HGAP = 80;
const STAGE_HEADER_HEIGHT = 28;
const STAGE_HEADER_TO_FIRST_JOB = 16;
const TOP_PAD = 16;
const LEFT_PAD = 16;

const EDGE_LABEL_STYLE: React.CSSProperties = {
  fontSize: 10,
  fontFamily: 'var(--vscode-font-family)',
  fill: 'var(--vscode-descriptionForeground, #aaa)',
};

/**
 * A graph-level "job" — one node per Job, including matrix parents (which render as a
 * single stacked card rather than N spawned nodes).
 */
interface DisplayJob {
  name: string;
  stage: string;
  hidden: boolean;
  when?: Job['when'];
  allowFailure?: boolean;
  trigger?: boolean;
  parallel?: number;
  /** Number of `parallel:matrix:` variants (0/undefined when not a matrix job). */
  matrixCount?: number;
  /** True when the job declares one or more `services:`. */
  hasServices?: boolean;
  /** True when the job declares an `environment:`. */
  hasEnvironment?: boolean;
  job: Job;
}

function hasServices(job: Job): boolean {
  const s = (job.raw as Record<string, unknown>).services;
  return Array.isArray(s) && s.length > 0;
}

function hasEnvironment(job: Job): boolean {
  const e = (job.raw as Record<string, unknown>).environment;
  return typeof e === 'string' ? e.length > 0 : !!e && typeof e === 'object';
}

function toDisplay(jobs: Job[]): DisplayJob[] {
  return jobs.map((j) => ({
    name: j.name,
    stage: j.stage,
    hidden: j.hidden,
    when: j.when,
    allowFailure: j.allowFailure,
    trigger: j.trigger,
    parallel: j.parallel,
    matrixCount: j.matrix?.length,
    hasServices: hasServices(j),
    hasEnvironment: hasEnvironment(j),
    job: j,
  }));
}

/** Ids directly connected to `id` by any edge (either direction), including `id` itself. */
export function connectedNodeIds(edges: Edge[], id: string): Set<string> {
  const set = new Set<string>([id]);
  for (const e of edges) {
    if (e.source === id) set.add(e.target);
    else if (e.target === id) set.add(e.source);
  }
  return set;
}

/**
 * Ids reachable from `id` along edge direction in either sense — the full upstream
 * ancestors + downstream descendants chain — including `id` itself.
 */
export function reachableNodeIds(edges: Edge[], id: string): Set<string> {
  const downAdj = new Map<string, string[]>();
  const upAdj = new Map<string, string[]>();
  for (const e of edges) {
    (downAdj.get(e.source) ?? downAdj.set(e.source, []).get(e.source)!).push(e.target);
    (upAdj.get(e.target) ?? upAdj.set(e.target, []).get(e.target)!).push(e.source);
  }
  const result = new Set<string>([id]);
  const walk = (adj: Map<string, string[]>) => {
    const stack = [id];
    const seen = new Set<string>([id]);
    while (stack.length) {
      const n = stack.pop()!;
      for (const m of adj.get(n) ?? []) if (!seen.has(m)) { seen.add(m); result.add(m); stack.push(m); }
    }
  };
  walk(downAdj);
  walk(upAdj);
  return result;
}

export interface NodeCenter { id: string; x: number; y: number; }
export type ArrowKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

/**
 * Pick the nearest node in the arrow's direction (for keyboard navigation).
 * `fromId === null` (no current focus) returns the first node. Candidates must lie in
 * the correct half-plane; ties break toward better cross-axis alignment.
 */
export function nearestNodeInDirection(centers: NodeCenter[], fromId: string | null, key: ArrowKey): string | null {
  if (centers.length === 0) return null;
  const from = fromId ? centers.find((c) => c.id === fromId) : undefined;
  if (!from) return centers[0].id;
  const horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
  const sign = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : -1;
  let best: string | null = null;
  let bestScore = Infinity;
  for (const c of centers) {
    if (c.id === from.id) continue;
    const primary = horizontal ? c.x - from.x : c.y - from.y;
    const cross = horizontal ? c.y - from.y : c.x - from.x;
    if (Math.sign(primary) !== sign || primary === 0) continue;
    const score = Math.abs(primary) + Math.abs(cross) * 2;
    if (score < bestScore) { bestScore = score; best = c.id; }
  }
  return best;
}

export function buildGraph(model: PipelineModel, opts: LayoutOptions): { nodes: Node[]; edges: Edge[] } {
  const filter = opts.filter?.trim().toLowerCase() ?? '';
  const matches = (name: string) => filter === '' || name.toLowerCase().includes(filter);
  // In 'hide' mode a non-empty filter drops non-matching jobs from the layout entirely
  // (rather than dimming them) so large pipelines collapse to just the jobs of interest.
  const hideMode = opts.filterMode === 'hide' && filter !== '';

  let baseJobs = model.jobs.filter((j) => opts.showHidden || !j.hidden);
  if (hideMode) baseJobs = baseJobs.filter((j) => matches(j.name));
  const jobs = toDisplay(baseJobs);
  const jobNames = new Set(jobs.map((j) => j.name));
  let stageOrder = orderStages(model.stages, jobs);
  if (hideMode) {
    const usedStages = new Set(jobs.map((j) => j.stage));
    stageOrder = stageOrder.filter((s) => usedStages.has(s));
  }

  // Compute per-job positions and (for the stage view) stage-header nodes.
  const { positions, headers } =
    (opts.layout ?? 'stages') === 'dag'
      ? { positions: dagPositions(jobs, jobNames), headers: [] as Node[] }
      : stagePositions(jobs, stageOrder, model.rootUri);

  const outcomes = opts.outcomes;
  const cycles = detectCycles(baseJobs);
  const nodes: Node[] = [...headers];
  for (const dj of jobs) {
    const pos = positions.get(dj.name) ?? { x: 0, y: 0 };
    const outcome = outcomes ? outcomes[dj.name] : undefined;
    const skipped = outcome === 'never';
    const isManual = outcome === 'manual';
    const inCycle = cycles.nodes.has(dj.name);
    let baseStyle = nodeStyle(dj);
    // Cycle (an error) wins; otherwise mark rules-derived manual jobs with an amber ring.
    if (inCycle) {
      baseStyle = { ...baseStyle, border: `2px solid ${CYCLE_COLOR}`, boxShadow: `0 0 0 1px ${CYCLE_COLOR}66` };
    } else if (isManual) {
      baseStyle = { ...baseStyle, border: `1px dashed ${MANUAL_COLOR}`, boxShadow: `0 0 0 1px ${MANUAL_COLOR}55` };
    }
    // Filter dim takes priority; otherwise rules-simulation dims jobs that wouldn't run.
    const style = !matches(dj.name)
      ? { ...baseStyle, opacity: 0.12 }
      : skipped
        ? { ...baseStyle, opacity: 0.28, filter: 'grayscale(0.8)' }
        : baseStyle;
    // Prepend a manual marker only when the static label doesn't already carry one
    // (renderNodeLabel adds ▶ for jobs with a literal `when: manual`).
    const baseLabel = renderNodeLabel(dj);
    const label = isManual && !baseLabel.includes('▶') ? `▶ ${baseLabel}` : baseLabel;
    nodes.push({
      id: dj.name,
      type: 'default',
      position: pos,
      data: { label, accent: stageAccent(dj.stage) },
      ariaLabel: ariaLabelFor(dj)
        + (skipped ? ' This job would not run for the selected ref.' : '')
        + (isManual ? ' This job would run manually for the selected ref.' : '')
        + (inCycle ? ' This job is part of a needs cycle.' : ''),
      sourcePosition: 'right' as any,
      targetPosition: 'left' as any,
      style,
    });
  }

  // Edges
  const showLabels = !!opts.showEdgeLabels;
  const edges: Edge[] = [];
  for (const dj of jobs) {
    const job = dj.job;
    for (const dep of job.needs) {
      if (jobNames.has(dep)) {
        const cyclic = cycles.edges.has(edgeKey(dep, dj.name));
        edges.push({
          id: `n-${dep}->${dj.name}`,
          source: dep,
          target: dj.name,
          type: 'smoothstep',
          animated: cyclic,
          label: showLabels ? 'needs' : undefined,
          labelStyle: EDGE_LABEL_STYLE,
          style: cyclic
            ? { stroke: CYCLE_COLOR, strokeWidth: 2 }
            : { stroke: 'var(--gl-edge, #999)', strokeWidth: 1.5 },
        });
      }
    }
    for (const dep of job.dependencies) {
      if (jobNames.has(dep) && !job.needs.includes(dep)) {
        edges.push({
          id: `d-${dep}->${dj.name}`,
          source: dep,
          target: dj.name,
          type: 'smoothstep',
          label: showLabels ? 'dependencies' : undefined,
          labelStyle: EDGE_LABEL_STYLE,
          style: { stroke: 'var(--gl-edge, #999)', strokeDasharray: '4 4', opacity: 0.6 },
        });
      }
    }
    for (const parent of job.extends) {
      if (jobNames.has(parent) && parent !== dj.name) {
        edges.push({
          id: `e-${parent}->${dj.name}`,
          source: parent,
          target: dj.name,
          type: 'smoothstep',
          label: showLabels ? 'extends' : undefined,
          labelStyle: EDGE_LABEL_STYLE,
          style: { stroke: 'var(--gl-edge-extend, #6b6b6b)', strokeDasharray: '2 3', opacity: 0.35 },
        });
      }
    }
  }

  return { nodes, edges };
}

/** Stage view: a column per stage, jobs stacked top-down. Returns positions + header nodes. */
function stagePositions(jobs: DisplayJob[], stageOrder: string[], rootUri: string): { positions: Map<string, { x: number; y: number }>; headers: Node[] } {
  const jobsByStage = groupByStage(jobs, stageOrder);
  const colX = (i: number) => LEFT_PAD + i * (NODE_WIDTH + STAGE_HGAP);
  const firstJobY = TOP_PAD + STAGE_HEADER_HEIGHT + STAGE_HEADER_TO_FIRST_JOB;
  const jobY = (row: number) => firstJobY + row * (NODE_HEIGHT + NODE_VGAP);

  const headers: Node[] = stageOrder.map((stage, i) => ({
    id: `__stage_${stage}`,
    type: 'stageHeader',
    position: { x: colX(i), y: TOP_PAD },
    data: { label: stage, stage, uri: rootUri },
    draggable: false,
    selectable: false,
    connectable: false,
    focusable: false,
    style: { width: NODE_WIDTH, height: STAGE_HEADER_HEIGHT, background: 'transparent', border: 'none' },
  }));

  const positions = new Map<string, { x: number; y: number }>();
  for (let i = 0; i < stageOrder.length; i++) {
    const jobsInStage = jobsByStage.get(stageOrder[i]) ?? [];
    jobsInStage.forEach((dj, row) => positions.set(dj.name, { x: colX(i), y: jobY(row) }));
  }
  return { positions, headers };
}

/** DAG view: rank jobs by their needs/dependencies edges using dagre (left → right). */
function dagPositions(jobs: DisplayJob[], jobNames: Set<string>): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: NODE_VGAP, ranksep: STAGE_HGAP, marginx: LEFT_PAD, marginy: TOP_PAD });
  g.setDefaultEdgeLabel(() => ({}));
  for (const dj of jobs) g.setNode(dj.name, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const dj of jobs) {
    for (const dep of dj.job.needs) if (jobNames.has(dep)) g.setEdge(dep, dj.name);
    for (const dep of dj.job.dependencies) if (jobNames.has(dep) && !dj.job.needs.includes(dep)) g.setEdge(dep, dj.name);
  }
  dagre.layout(g);
  const positions = new Map<string, { x: number; y: number }>();
  for (const dj of jobs) {
    const n = g.node(dj.name) as { x: number; y: number } | undefined;
    // dagre reports node centers; React Flow positions are top-left.
    if (n) positions.set(dj.name, { x: n.x - NODE_WIDTH / 2, y: n.y - NODE_HEIGHT / 2 });
  }
  return positions;
}

function orderStages(declared: string[], jobs: DisplayJob[]): string[] {
  const seen = new Set(declared);
  const out = [...declared];
  for (const j of jobs) if (!seen.has(j.stage)) { seen.add(j.stage); out.push(j.stage); }
  return out;
}

function groupByStage(jobs: DisplayJob[], stages: string[]): Map<string, DisplayJob[]> {
  const m = new Map<string, DisplayJob[]>();
  for (const s of stages) m.set(s, []);
  for (const j of jobs) {
    if (!m.has(j.stage)) m.set(j.stage, []);
    m.get(j.stage)!.push(j);
  }
  return m;
}

/** Screen-reader description of a job node (read on focus). */
function ariaLabelFor(job: DisplayJob): string {
  const parts = [`Job ${job.name}`, `stage ${job.stage}`];
  if (job.when === 'manual') parts.push('manual');
  if (job.allowFailure) parts.push('allowed to fail');
  if (job.trigger) parts.push('triggers a downstream pipeline');
  if (job.parallel && job.parallel > 1) parts.push(`${job.parallel} parallel instances`);
  if (job.matrixCount && job.matrixCount > 1) parts.push(`${job.matrixCount} matrix variants`);
  if (job.hasServices) parts.push('has services');
  if (job.hasEnvironment) parts.push('deploys to an environment');
  return parts.join(', ') + '. Press Enter to open details.';
}

function renderNodeLabel(job: DisplayJob): string {
  // GitLab-style: just the job name. Badges go via separate visual treatment.
  const badges: string[] = [];
  if (job.when === 'manual') badges.push('▶');
  if (job.allowFailure) badges.push('⚠');
  if (job.trigger) badges.push('↗');
  if (job.parallel && job.parallel > 1) badges.push(`×${job.parallel}`);
  if (job.matrixCount && job.matrixCount > 1) badges.push(`⊞ ${job.matrixCount}`);
  if (job.hasServices) badges.push('⚙');
  if (job.hasEnvironment) badges.push('🌐');
  const prefix = badges.length ? `${badges.join(' ')}  ` : '';
  return `${prefix}${job.name}`;
}

function nodeStyle(job: DisplayJob): React.CSSProperties {
  // GitLab pipeline graph uses a pill-shaped, light-bordered card.
  // Matrix jobs render with a "stacked card" shadow to hint at multiple variants
  // behind the front card, without spawning N nodes in the graph.
  const isMatrix = !!(job.matrixCount && job.matrixCount > 1);
  const accent = stageAccent(job.stage);
  const borderColor = 'var(--vscode-editorWidget-border, #444)';
  const stackShadow = isMatrix
    ? [
        // Two offset card silhouettes behind the front card.
        `3px 3px 0 0 var(--vscode-editorWidget-background, #2b2b2b)`,
        `3px 3px 0 1px ${borderColor}`,
        `6px 6px 0 0 var(--vscode-editorWidget-background, #2b2b2b)`,
        `6px 6px 0 1px ${borderColor}`,
        `0 1px 0 rgba(0,0,0,0.2)`,
      ].join(', ')
    : '0 1px 0 rgba(0,0,0,0.2)';
  return {
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
    background: 'var(--vscode-editorWidget-background, #2b2b2b)',
    border: `1px solid ${borderColor}`,
    borderLeft: `3px solid ${accent}`,
    borderRadius: 18,
    padding: '0 14px',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 13,
    fontWeight: 500,
    color: 'var(--vscode-foreground)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-start',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    opacity: job.hidden ? 0.6 : (job.allowFailure ? 0.9 : 1),
    boxShadow: stackShadow,
    transition: 'opacity 120ms ease',
  };
}

// Stable per-stage accent color (subtle, GitLab-ish blues/oranges/greens).
function stageAccent(stage: string): string {
  const palette = [
    '#1f75cb', // GitLab blue
    '#6e49cb', // purple
    '#e24329', // GitLab orange
    '#108548', // green
    '#dc143c', // crimson
    '#0095a8', // teal
    '#a8740e', // amber
  ];
  let h = 0;
  for (let i = 0; i < stage.length; i++) h = ((h << 5) - h + stage.charCodeAt(i)) | 0;
  return palette[Math.abs(h) % palette.length];
}
