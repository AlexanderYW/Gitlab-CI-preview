export type IncludeKind = 'local' | 'remote' | 'template' | 'project' | 'component';

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface SourceLocation {
  uri: string;
  range: Range;
}

export interface IncludeRef {
  kind: IncludeKind;
  /** Raw spec from YAML (e.g. file path, URL, project ref). */
  raw: string;
  /** Resolved absolute URI (file://, https://, or gitlab-ci://). Null when unresolved. */
  resolvedUri: string | null;
  /** For project/component includes. */
  project?: string;
  ref?: string;
  file?: string;
  inputs?: Record<string, unknown>;
  source: SourceLocation;
  error?: string;
}

export interface Job {
  name: string;
  stage: string;
  image?: string;
  script?: string[];
  needs: string[];
  dependencies: string[];
  extends: string[];
  rules?: unknown[];
  variables?: Record<string, string>;
  when?: 'on_success' | 'on_failure' | 'always' | 'manual' | 'delayed' | 'never';
  allowFailure?: boolean;
  tags?: string[];
  trigger?: boolean; // child/multi-project pipeline trigger
  /** For a child-pipeline `trigger:` with a local `include:`, the resolved file URI of that child pipeline. */
  triggerIncludeUri?: string;
  parallel?: number;
  /** Expanded `parallel:matrix:` variants — one map of variable→value per variant. */
  matrix?: Array<Record<string, string>>;
  retry?: number;
  /** True for hidden/template jobs (name starts with '.'). */
  hidden: boolean;
  source: SourceLocation;
  /** Raw merged job spec (after extends/includes). */
  raw: Record<string, unknown>;
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';

export interface Diagnostic {
  range: Range;
  severity: DiagnosticSeverity;
  message: string;
  source?: string;
  uri: string;
}

export interface PipelineModel {
  rootUri: string;
  stages: string[];
  jobs: Job[];
  includes: IncludeRef[];
  diagnostics: Diagnostic[];
  /** Map of resolved include URI -> fetched text (for content provider). */
  includedSources: Record<string, string>;
  /** Global `variables:` merged across root + includes. */
  globalVariables: Record<string, string>;
  /** Top-level `default:` keys merged across root + includes (applied to every job). */
  defaults?: Record<string, unknown>;
  /** Top-level `workflow:` block (controls whether the pipeline is created at all). */
  workflow?: Record<string, unknown>;
}

/**
 * Sentinel object emitted by the parser when it encounters GitLab's `!reference`
 * YAML tag (e.g. `!reference [.setup, script]`). The wrapped array is the
 * path: first element is the job name (typically a hidden `.template`),
 * subsequent elements are nested keys into that job's spec.
 */
export const REFERENCE_MARKER = '__gitlabReference';
export interface ReferenceMarker { [REFERENCE_MARKER]: string[]; }
export function isReferenceMarker(v: unknown): v is ReferenceMarker {
  return !!v && typeof v === 'object' && Array.isArray((v as any)[REFERENCE_MARKER]);
}

export const DEFAULT_STAGES = ['build', 'test', 'deploy'] as const;
export const RESERVED_TOP_LEVEL = new Set([
  'default', 'include', 'stages', 'variables', 'workflow',
  'image', 'services', 'cache', 'before_script', 'after_script',
  'pages',
]);
