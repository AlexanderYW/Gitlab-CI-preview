import type { PipelineModel } from './model.js';

/** Custom LSP request: client → server */
export const RESOLVE_PIPELINE_REQUEST = 'gitlabCi/resolvePipeline';
export interface ResolvePipelineParams {
  uri: string;
}
export type ResolvePipelineResult = PipelineModel;

/** Custom LSP request: client → server, drop all cached includes. */
export const CLEAR_CACHE_REQUEST = 'gitlabCi/clearCache';

/** Custom LSP notification: server → client, a host needs a token. */
export const NEEDS_AUTH_NOTIFICATION = 'gitlabCi/needsAuth';
export interface NeedsAuthParams { host: string }

/** Custom LSP notification: client → server, push the full host→token map (client owns secrets). */
export const SET_TOKENS_NOTIFICATION = 'gitlabCi/setTokens';
export interface SetTokensParams { tokens: Record<string, string> }

/** Custom LSP notification: server → client, pushed when model changes. */
export const PIPELINE_UPDATED_NOTIFICATION = 'gitlabCi/pipelineUpdated';
export interface PipelineUpdatedParams {
  uri: string;
  model: PipelineModel;
}

/** Custom LSP request: client → server, fetch included source text. */
export const READ_INCLUDED_FILE_REQUEST = 'gitlabCi/readIncludedFile';
export interface ReadIncludedFileParams { uri: string }
export interface ReadIncludedFileResult { text: string | null }

/** Custom LSP request: client → server, render the fully-resolved pipeline as one YAML doc. */
export const MERGE_PIPELINE_REQUEST = 'gitlabCi/mergePipeline';
export interface MergePipelineParams { uri: string }
export interface MergePipelineResult { text: string | null }

/** Custom LSP request: client → server, replace a job's spec. */
export const UPDATE_JOB_REQUEST = 'gitlabCi/updateJob';
export interface UpdateJobParams { uri: string; jobName: string; newValue: unknown }
export interface UpdateJobResult { edit: RenameStageEdit | null }

/** Custom LSP request: client → server, get text edits to rename a stage. */
export const RENAME_STAGE_REQUEST = 'gitlabCi/renameStage';
export interface RenameStageParams { uri: string; oldName: string; newName: string }
export interface RenameStageEdit {
  /** Line + character (0-based). */
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  newText: string;
}
export interface RenameStageResult {
  edits: RenameStageEdit[];
  /** Any edits in OTHER files (included files) — we surface but do not apply automatically. */
  externalRefs: { uri: string; count: number }[];
}

/** Custom LSP request: client → server, convert a document's legacy `only:`/`except:` to `rules:`. */
export const MIGRATE_ONLY_EXCEPT_REQUEST = 'gitlabCi/migrateOnlyExcept';
export interface MigrateOnlyExceptParams { uri: string }
export interface MigrateOnlyExceptResult {
  /** Top-level jobs whose only/except was converted to rules. */
  jobs: string[];
  edits: RenameStageEdit[];
}

/** Webview ↔ client messages */
export type WebviewMessage =
  | { type: 'modelUpdated'; model: PipelineModel }
  | { type: 'gitRefs'; branches: string[]; current: string | null }
  | { type: 'revealJob'; uri: string; jobName: string }
  | { type: 'revealLocation'; uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }
  | { type: 'renameStage'; uri: string; oldName: string; newName: string }
  | { type: 'updateJob'; uri: string; jobName: string; newValue: unknown }
  | { type: 'selectJob'; uri: string; jobName: string }
  | { type: 'openChildPipeline'; uri: string }
  | { type: 'exportPng'; dataUrl: string; suggestedName: string }
  /** Webview → client: fetch the changed/exists file lists for a simulated ref (drives `changes:` / `exists:`). */
  | { type: 'simFiles'; uri: string; ref: string; pipelineSource: string }
  /** Client → webview: file lists for the simulated ref; `available: false` means the sim stays optimistic. */
  | { type: 'simFilesResult'; ref: string; pipelineSource: string; available: boolean; changedFiles?: string[]; existsFiles?: string[] }
  | { type: 'ready' };
