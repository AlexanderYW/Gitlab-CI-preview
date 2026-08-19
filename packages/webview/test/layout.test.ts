import { describe, expect, test } from 'bun:test';
import type { Job, PipelineModel } from '@gitlab-ci-preview/shared';
import { buildGraph, connectedNodeIds, reachableNodeIds, nearestNodeInDirection, type NodeCenter } from '../src/layout.js';

const ZERO = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

function job(name: string, over: Partial<Job> = {}): Job {
  return {
    name,
    stage: over.stage ?? 'test',
    needs: over.needs ?? [],
    dependencies: over.dependencies ?? [],
    extends: over.extends ?? [],
    hidden: over.hidden ?? name.startsWith('.'),
    source: { uri: 'file:///.gitlab-ci.yml', range: ZERO },
    raw: over.raw ?? {},
    ...over,
  };
}

function model(jobs: Job[], over: Partial<PipelineModel> = {}): PipelineModel {
  return {
    rootUri: 'file:///.gitlab-ci.yml',
    stages: over.stages ?? ['build', 'test', 'deploy'],
    jobs,
    includes: [],
    diagnostics: [],
    includedSources: {},
    globalVariables: {},
    ...over,
  };
}

const jobNodes = (g: { nodes: { id: string }[] }) => g.nodes.filter((n) => !n.id.startsWith('__stage_'));
const stageNodes = (g: { nodes: { id: string }[] }) => g.nodes.filter((n) => n.id.startsWith('__stage_'));

describe('connectedNodeIds', () => {
  // a → b → c  (needs edges), plus an isolated d
  const g = buildGraph(
    model([job('a', { stage: 'build' }), job('b', { stage: 'test', needs: ['a'] }), job('c', { stage: 'deploy', needs: ['b'] }), job('d', { stage: 'build' })]),
    { showHidden: false },
  );

  test('includes the node itself and its direct neighbours only', () => {
    expect([...connectedNodeIds(g.edges, 'b')].sort()).toEqual(['a', 'b', 'c']);
  });

  test('a node with one edge has just itself plus that neighbour', () => {
    expect([...connectedNodeIds(g.edges, 'a')].sort()).toEqual(['a', 'b']);
  });

  test('an isolated node is connected only to itself', () => {
    expect([...connectedNodeIds(g.edges, 'd')]).toEqual(['d']);
  });

  test('reachableNodeIds spans the full upstream + downstream chain', () => {
    // From b: upstream a, downstream c — the whole chain, but not isolated d.
    expect([...reachableNodeIds(g.edges, 'b')].sort()).toEqual(['a', 'b', 'c']);
    expect([...reachableNodeIds(g.edges, 'a')].sort()).toEqual(['a', 'b', 'c']);
    expect([...reachableNodeIds(g.edges, 'd')]).toEqual(['d']);
  });
});

describe('buildGraph filter modes', () => {
  const m = model([job('build_app', { stage: 'build' }), job('run_tests', { stage: 'test' })]);

  test("'dim' mode keeps all nodes (default)", () => {
    const g = buildGraph(m, { showHidden: false, filter: 'build' });
    expect(jobNodes(g).map((n) => n.id).sort()).toEqual(['build_app', 'run_tests']);
  });

  test("'hide' mode drops non-matching jobs and their empty stages", () => {
    const g = buildGraph(m, { showHidden: false, filter: 'build', filterMode: 'hide' });
    expect(jobNodes(g).map((n) => n.id)).toEqual(['build_app']);
    // The 'test' stage has no surviving jobs → its header is dropped too.
    expect(stageNodes(g).map((n) => n.id)).toEqual(['__stage_build']);
  });

  test("'hide' mode with an empty filter keeps everything", () => {
    const g = buildGraph(m, { showHidden: false, filter: '', filterMode: 'hide' });
    expect(jobNodes(g).length).toBe(2);
  });
});

describe('buildGraph', () => {
  test('creates one node per visible job plus a header per stage', () => {
    const g = buildGraph(model([job('a', { stage: 'build' }), job('b', { stage: 'test' })]), { showHidden: false });
    expect(jobNodes(g).map((n) => n.id).sort()).toEqual(['a', 'b']);
    expect(stageNodes(g).length).toBe(3); // build, test, deploy
  });

  test('hides hidden jobs unless showHidden is set', () => {
    const jobs = [job('real', { stage: 'build' }), job('.tmpl', { stage: 'build' })];
    expect(jobNodes(buildGraph(model(jobs), { showHidden: false })).map((n) => n.id)).toEqual(['real']);
    expect(jobNodes(buildGraph(model(jobs), { showHidden: true })).map((n) => n.id).sort()).toEqual(['.tmpl', 'real']);
  });

  test('stage headers are not keyboard-focusable', () => {
    const g = buildGraph(model([job('a')]), { showHidden: false });
    for (const n of stageNodes(g)) expect((n as any).focusable).toBe(false);
  });

  test('DAG layout drops stage headers and ranks dependents to the right of their needs', () => {
    const jobs = [job('a', { stage: 'build' }), job('b', { stage: 'test', needs: ['a'] })];
    const g = buildGraph(model(jobs), { showHidden: false, layout: 'dag' });
    expect(stageNodes(g).length).toBe(0); // no stage columns in DAG mode
    const a = jobNodes(g).find((n) => n.id === 'a') as any;
    const b = jobNodes(g).find((n) => n.id === 'b') as any;
    expect(b.position.x).toBeGreaterThan(a.position.x); // dependent is downstream (to the right)
  });

  test('builds needs edges only for jobs in the graph', () => {
    const g = buildGraph(model([job('a', { stage: 'build' }), job('b', { stage: 'test', needs: ['a', 'ghost'] })]), { showHidden: false });
    const ids = g.edges.map((e) => e.id);
    expect(ids).toContain('n-a->b');
    expect(ids.some((id) => id.includes('ghost'))).toBe(false);
  });

  test('edge labels appear only when showEdgeLabels is set', () => {
    const jobs = [job('a', { stage: 'build' }), job('b', { stage: 'test', needs: ['a'] })];
    expect(buildGraph(model(jobs), { showHidden: false }).edges[0].label).toBeUndefined();
    expect(buildGraph(model(jobs), { showHidden: false, showEdgeLabels: true }).edges[0].label).toBe('needs');
  });

  test('dims non-matching job nodes when a filter is set (layout stays stable)', () => {
    const jobs = [job('build-app', { stage: 'build' }), job('run-tests', { stage: 'test' })];
    const g = buildGraph(model(jobs), { showHidden: false, filter: 'test' });
    const match = jobNodes(g).find((n) => n.id === 'run-tests') as any;
    const other = jobNodes(g).find((n) => n.id === 'build-app') as any;
    expect(jobNodes(g).length).toBe(2); // nothing removed
    expect(other.style.opacity).toBe(0.12);
    expect(match.style.opacity).not.toBe(0.12);
  });

  test('flags services and environment in the node label and aria-label', () => {
    const jobs = [
      job('svc', { stage: 'test', raw: { services: ['postgres:16'] } }),
      job('dep', { stage: 'deploy', raw: { environment: 'production' } }),
    ];
    const g = buildGraph(model(jobs), { showHidden: false });
    const svc = jobNodes(g).find((n) => n.id === 'svc') as any;
    const dep = jobNodes(g).find((n) => n.id === 'dep') as any;
    expect(String(svc.data.label)).toContain('⚙');
    expect(svc.ariaLabel).toContain('services');
    expect(String(dep.data.label)).toContain('🌐');
    expect(dep.ariaLabel).toContain('environment');
  });
});

describe('nearestNodeInDirection', () => {
  // grid: a(0,0) b(0,100)   c(300,0) d(300,100)
  const grid: NodeCenter[] = [
    { id: 'a', x: 0, y: 0 }, { id: 'b', x: 0, y: 100 },
    { id: 'c', x: 300, y: 0 }, { id: 'd', x: 300, y: 100 },
  ];

  test('right/left move between stage columns, up/down within a column', () => {
    expect(nearestNodeInDirection(grid, 'a', 'ArrowRight')).toBe('c');
    expect(nearestNodeInDirection(grid, 'c', 'ArrowLeft')).toBe('a');
    expect(nearestNodeInDirection(grid, 'a', 'ArrowDown')).toBe('b');
    expect(nearestNodeInDirection(grid, 'b', 'ArrowUp')).toBe('a');
  });

  test('returns null at an edge (no candidate in that direction)', () => {
    expect(nearestNodeInDirection(grid, 'a', 'ArrowLeft')).toBeNull();
    expect(nearestNodeInDirection(grid, 'a', 'ArrowUp')).toBeNull();
  });

  test('with no current focus, falls back to the first node', () => {
    expect(nearestNodeInDirection(grid, null, 'ArrowRight')).toBe('a');
    expect(nearestNodeInDirection([], null, 'ArrowRight')).toBeNull();
  });
});
