import {
  CodeActionKind,
  createConnection,
  ProposedFeatures,
  StreamMessageReader,
  StreamMessageWriter,
  TextDocuments,
  TextDocumentSyncKind,
  type CodeAction,
  type InitializeResult,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { PipelineModel } from '@gitlab-ci-preview/shared';
import {
  RESOLVE_PIPELINE_REQUEST,
  PIPELINE_UPDATED_NOTIFICATION,
  READ_INCLUDED_FILE_REQUEST,
  RENAME_STAGE_REQUEST,
  UPDATE_JOB_REQUEST,
  MERGE_PIPELINE_REQUEST,
  MIGRATE_ONLY_EXCEPT_REQUEST,
  CLEAR_CACHE_REQUEST,
  NEEDS_AUTH_NOTIFICATION,
  SET_TOKENS_NOTIFICATION,
  type ResolvePipelineParams,
  type ReadIncludedFileParams,
  type ReadIncludedFileResult,
  type RenameStageParams,
  type RenameStageResult,
  type UpdateJobParams,
  type UpdateJobResult,
  type MergePipelineParams,
  type MergePipelineResult,
  type MigrateOnlyExceptParams,
  type MigrateOnlyExceptResult,
  type SetTokensParams,
} from '@gitlab-ci-preview/shared';
import { resolvePipeline } from './resolve.js';
import { buildMergedPipeline } from './features/mergePipeline.js';
import { parseYaml } from './parser.js';
import { collectStageRenameEdits } from './features/renameStage.js';
import { buildJobUpdateEdit } from './features/updateJob.js';
import { collectMigrateOnlyExceptEdits, findMigratableJobAt } from './features/migrateOnlyExcept.js';
import { setHttpSettings, clearHttpCache, onNeedsAuth } from './includes/http.js';
import { publishDiagnostics } from './features/diagnostics.js';
import { hover } from './features/hover.js';
import { definition } from './features/definition.js';
import { completion } from './features/completion.js';
import { codeLenses } from './features/codeLens.js';

// Explicit stdio transport — works regardless of how the client launched us.
const connection = createConnection(
  ProposedFeatures.all,
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
);
// Anything we accidentally print would corrupt the JSON-RPC stream.
console.log = (...args) => connection.console.log(args.map(String).join(' '));
console.error = (...args) => connection.console.error(args.map(String).join(' '));
process.on('uncaughtException', (e) => connection.console.error(`uncaughtException: ${e.stack ?? e.message}`));
process.on('unhandledRejection', (e) => connection.console.error(`unhandledRejection: ${String(e)}`));
const documents = new TextDocuments(TextDocument);

let workspaceFolders: string[] = [];
const modelCache = new Map<string, PipelineModel>();
const debouncers = new Map<string, NodeJS.Timeout>();
const includedTexts = new Map<string, string>();

interface Settings {
  defaultHost?: string;
  cacheTtlMinutes?: number;
  fetchTimeoutSeconds?: number;
}

connection.onInitialize((params): InitializeResult => {
  workspaceFolders = (params.workspaceFolders ?? []).map((f) => f.uri);
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      hoverProvider: true,
      definitionProvider: true,
      codeActionProvider: true,
      codeLensProvider: { resolveProvider: false },
      completionProvider: { triggerCharacters: [':', ' ', '-'] },
      workspace: {
        workspaceFolders: { supported: true, changeNotifications: true },
      },
    },
  };
});

connection.onInitialized(() => {
  onNeedsAuth((host) => {
    connection.sendNotification(NEEDS_AUTH_NOTIFICATION, { host });
  });
  connection.workspace.getConfiguration('gitlabCi').then((cfg: Settings | null) => {
    if (cfg) applySettings(cfg);
  }).catch((e: unknown) => {
    connection.console.error(`failed to load gitlabCi configuration (cache TTL falls back to defaults): ${(e as Error).message}`);
  });
  // Tokens never come from settings — the client owns them (SecretStorage) and pushes
  // the full map here; setHttpSettings replaces the map wholesale.
  connection.onNotification(SET_TOKENS_NOTIFICATION, (p: SetTokensParams) => {
    setHttpSettings({ tokens: p.tokens ?? {} });
  });
  connection.workspace.onDidChangeWorkspaceFolders((evt) => {
    for (const a of evt.added) workspaceFolders.push(a.uri);
    workspaceFolders = workspaceFolders.filter((u) => !evt.removed.some((r) => r.uri === u));
  });
});

connection.onDidChangeConfiguration((change) => {
  applySettings((change.settings?.gitlabCi ?? {}) as Settings);
  for (const doc of documents.all()) scheduleResolve(doc);
});

function applySettings(cfg: Settings) {
  // No `tokens` here — they arrive via SET_TOKENS_NOTIFICATION from the client.
  setHttpSettings({
    defaultHost: cfg.defaultHost ?? 'gitlab.com',
    cacheTtlMs: (cfg.cacheTtlMinutes ?? 15) * 60 * 1000,
    fetchTimeoutMs: Math.max(1, cfg.fetchTimeoutSeconds ?? 10) * 1000,
  });
}

function isGitlabCiFile(uri: string): boolean {
  return /gitlab-ci.*\.ya?ml$/i.test(uri) || /\/\.gitlab\/ci\/.*\.ya?ml$/i.test(uri);
}

documents.onDidOpen((e) => { if (isGitlabCiFile(e.document.uri)) scheduleResolve(e.document); });
documents.onDidChangeContent((e) => { if (isGitlabCiFile(e.document.uri)) scheduleResolve(e.document); });
documents.onDidClose((e) => { connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] }); });

function scheduleResolve(doc: TextDocument) {
  const prev = debouncers.get(doc.uri);
  if (prev) clearTimeout(prev);
  debouncers.set(doc.uri, setTimeout(() => runResolve(doc), 250));
}

async function runResolve(doc: TextDocument) {
  try {
    const model = await resolvePipeline(doc.uri, doc.getText(), {
      baseUri: doc.uri,
      workspaceFolders,
      readOpenDocument: (uri) => documents.get(uri)?.getText() ?? null,
    });
    modelCache.set(doc.uri, model);
    for (const [uri, text] of Object.entries(model.includedSources)) {
      includedTexts.set(uri, text);
    }
    publishDiagnostics(connection, model);
    connection.sendNotification(PIPELINE_UPDATED_NOTIFICATION, { uri: doc.uri, model });
  } catch (e) {
    connection.console.error(`resolve failed for ${doc.uri}: ${(e as Error).message}`);
  }
}

connection.onHover((p) => {
  const model = modelCache.get(p.textDocument.uri);
  if (!model) return null;
  return hover(model, p.textDocument.uri, p.position, documents.get(p.textDocument.uri)?.getText());
});

connection.onDefinition((p) => {
  const model = modelCache.get(p.textDocument.uri);
  const doc = documents.get(p.textDocument.uri);
  if (!model || !doc) return null;
  return definition(model, doc, p.position);
});

connection.onCompletion((p) => {
  const model = modelCache.get(p.textDocument.uri);
  const doc = documents.get(p.textDocument.uri);
  if (!model || !doc) return [];
  return completion(model, doc, p.position);
});

connection.onCodeLens((p) => codeLenses(p.textDocument.uri));

/** Resolve a pipeline for the given URI: re-resolve synced docs, else read from disk. */
async function resolveModelForUri(uri: string): Promise<PipelineModel | null> {
  const doc = documents.get(uri);
  if (doc) {
    await runResolve(doc);
    return modelCache.get(uri) ?? null;
  }
  // File isn't in the LSP-synced set (e.g. user clicked the title-bar preview button
  // on a yaml that doesn't match our documentSelector). Read from disk and resolve
  // directly without caching as an active doc.
  try {
    const fs = await import('node:fs/promises');
    const { URI } = await import('vscode-uri');
    const fsPath = URI.parse(uri).fsPath;
    const text = await fs.readFile(fsPath, 'utf8');
    const model = await resolvePipeline(uri, text, {
      baseUri: uri,
      workspaceFolders,
      readOpenDocument: (u) => documents.get(u)?.getText() ?? null,
    });
    modelCache.set(uri, model);
    for (const [u, t] of Object.entries(model.includedSources)) includedTexts.set(u, t);
    return model;
  } catch (e) {
    connection.console.error(`one-shot resolve failed for ${uri}: ${(e as Error).message}`);
    return null;
  }
}

connection.onRequest(RESOLVE_PIPELINE_REQUEST, (p: ResolvePipelineParams) => resolveModelForUri(p.uri));

connection.onRequest(MERGE_PIPELINE_REQUEST, async (p: MergePipelineParams): Promise<MergePipelineResult> => {
  const model = await resolveModelForUri(p.uri);
  return { text: model ? buildMergedPipeline(model) : null };
});

connection.onRequest(READ_INCLUDED_FILE_REQUEST, (p: ReadIncludedFileParams): ReadIncludedFileResult => {
  return { text: includedTexts.get(p.uri) ?? null };
});

connection.onRequest(CLEAR_CACHE_REQUEST, () => {
  clearHttpCache();
  return null;
});

connection.onRequest(UPDATE_JOB_REQUEST, async (p: UpdateJobParams): Promise<UpdateJobResult> => {
  const doc = documents.get(p.uri);
  if (!doc) return { edit: null };
  const parsed = parseYaml(p.uri, doc.getText());
  const edit = buildJobUpdateEdit(parsed.doc, doc.getText(), p.jobName, p.newValue);
  return { edit };
});

connection.onRequest(RENAME_STAGE_REQUEST, async (p: RenameStageParams): Promise<RenameStageResult> => {
  const doc = documents.get(p.uri);
  if (!doc) return { edits: [], externalRefs: [] };
  const parsed = parseYaml(p.uri, doc.getText());
  const edits = collectStageRenameEdits(parsed.doc, doc.getText(), p.oldName, p.newName);

  // Count occurrences in included files so we can warn the user (we don't edit external files).
  const model = modelCache.get(p.uri);
  const externalRefs: { uri: string; count: number }[] = [];
  if (model) {
    for (const [incUri, text] of Object.entries(model.includedSources)) {
      try {
        const incParsed = parseYaml(incUri, text);
        const incEdits = collectStageRenameEdits(incParsed.doc, text, p.oldName, p.newName);
        if (incEdits.length > 0) externalRefs.push({ uri: incUri, count: incEdits.length });
      } catch (e) {
        connection.console.error(`stage-rename scan skipped for included file ${incUri}: ${(e as Error).message}`);
      }
    }
  }
  return { edits, externalRefs };
});

connection.onRequest(MIGRATE_ONLY_EXCEPT_REQUEST, async (p: MigrateOnlyExceptParams): Promise<MigrateOnlyExceptResult> => {
  const doc = documents.get(p.uri);
  if (!doc) return { jobs: [], edits: [] };
  const parsed = parseYaml(p.uri, doc.getText());
  return collectMigrateOnlyExceptEdits(parsed.doc, doc.getText());
});

connection.onCodeAction((p): CodeAction[] | null => {
  const doc = documents.get(p.textDocument.uri);
  if (!doc) return null;
  const parsed = parseYaml(doc.uri, doc.getText());
  const found = findMigratableJobAt(parsed.doc, doc.getText(), p.range.start);
  if (!found) return null;
  return [
    {
      title: `Convert only/except to rules: ${found.name}`,
      kind: CodeActionKind.RefactorRewrite,
      edit: {
        changes: {
          [doc.uri]: [{ range: found.edit.range, newText: found.edit.newText }],
        },
      },
    },
  ];
});

documents.listen(connection);
connection.listen();
