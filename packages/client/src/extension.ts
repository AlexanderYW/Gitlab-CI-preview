import * as path from 'node:path';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import {
  LanguageClient,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from 'vscode-languageclient/node';
import {
  PIPELINE_UPDATED_NOTIFICATION,
  READ_INCLUDED_FILE_REQUEST,
  RESOLVE_PIPELINE_REQUEST,
  RENAME_STAGE_REQUEST,
  UPDATE_JOB_REQUEST,
  MERGE_PIPELINE_REQUEST,
  MIGRATE_ONLY_EXCEPT_REQUEST,
  CLEAR_CACHE_REQUEST,
  NEEDS_AUTH_NOTIFICATION,
  type NeedsAuthParams,
  type PipelineUpdatedParams,
  type PipelineModel,
  type RenameStageResult,
  type UpdateJobResult,
  type MergePipelineResult,
  type MigrateOnlyExceptResult,
} from '@gitlab-ci-preview/shared';
import { bundleCandidates as bundleCandidatesFor, toHost, toProjectPath, blobUrl, randomNonce } from './util.js';
import { computeSimFiles, detectDefaultBranch, type SimFiles } from './simFiles.js';

let client: LanguageClient | undefined;
let logChannel: vscode.LogOutputChannel | undefined;
let lintDiagnostics: vscode.DiagnosticCollection | undefined;
const panels = new Map<string, vscode.WebviewPanel>();
function log(msg: string) { logChannel?.appendLine(msg); }

/** Find a bundled asset, preferring the live dev `dist/` layout when running from source (F5). */
function bundleCandidates(ctx: vscode.ExtensionContext, kind: 'server' | 'webview', file: string): string[] {
  const preferDev = ctx.extensionMode !== vscode.ExtensionMode.Production;
  return bundleCandidatesFor(ctx.extensionPath, kind, file, preferDev);
}
function resolveBundle(ctx: vscode.ExtensionContext, kind: 'server' | 'webview', file: string): string | null {
  for (const p of bundleCandidates(ctx, kind, file)) if (fs.existsSync(p)) return p;
  return null;
}
function bundleDir(ctx: vscode.ExtensionContext, kind: 'server' | 'webview'): string {
  const probe = resolveBundle(ctx, kind, kind === 'webview' ? 'webview.js' : 'server.js');
  return probe ? path.dirname(probe) : bundleCandidates(ctx, kind, '.')[0];
}

export async function activate(ctx: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('GitLab CI Preview', { log: true });
  logChannel = output;
  ctx.subscriptions.push(output);
  log('[activate] starting');

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = '$(graph) GitLab CI';
  status.tooltip = 'GitLab CI Preview — click to show pipeline graph';
  status.command = 'gitlabCi.showGraph';
  status.show();
  ctx.subscriptions.push(status);

  try {
    await activateInner(ctx, status);
  } catch (e) {
    const msg = (e as Error).stack ?? (e as Error).message;
    log(`[activate] FATAL: ${msg}`);
    status.text = '$(error) GitLab CI';
    status.tooltip = `Activation failed — see Output → GitLab CI Preview`;
    vscode.window.showErrorMessage(`GitLab CI Preview failed to activate. See Output → GitLab CI Preview.`);
    throw e;
  }
}

async function activateInner(ctx: vscode.ExtensionContext, _status: vscode.StatusBarItem) {

  lintDiagnostics = vscode.languages.createDiagnosticCollection('gitlabCiLint');
  ctx.subscriptions.push(lintDiagnostics);

  const serverModule = resolveBundle(ctx, 'server', 'server.js');
  log(`[activate] server module: ${serverModule ?? '(not found)'}`);
  if (!serverModule) {
    const msg = `Server bundle not found. Searched: ${bundleCandidates(ctx, 'server', 'server.js').join(', ')}`;
    log(`[activate] ERROR: ${msg}`);
    vscode.window.showErrorMessage(msg);
    return;
  }

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.stdio },
    debug: {
      module: serverModule,
      transport: TransportKind.stdio,
      options: { execArgv: ['--nolazy', '--inspect=6009'] },
    },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { language: 'yaml', pattern: '**/.gitlab-ci*.{yml,yaml}' },        // canonical .gitlab-ci.yml
      { language: 'yaml', pattern: '**/*.gitlab-ci*.{yml,yaml}' },       // anything-gitlab-ci-anything.yml
      { language: 'yaml', pattern: '**/.gitlab/ci/**/*.{yml,yaml}' },    // .gitlab/ci tree
    ],
    synchronize: {
      configurationSection: 'gitlabCi',
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*gitlab-ci*.{yml,yaml}'),
    },
    outputChannel: logChannel,
  };
  client = new LanguageClient('gitlabCi', 'GitLab CI Preview', serverOptions, clientOptions);

  log('[activate] calling client.start()');
  await client.start();
  log('[activate] client started');

  client.onNotification(PIPELINE_UPDATED_NOTIFICATION, (params: PipelineUpdatedParams) => {
    const panel = panels.get(params.uri);
    if (panel) panel.webview.postMessage({ type: 'modelUpdated', model: params.model });
  });

  // Content provider for resolved-include virtual files.
  const contentProvider = new (class implements vscode.TextDocumentContentProvider {
    onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
    onDidChange = this.onDidChangeEmitter.event;
    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
      if (!client) return '';
      const res = await client.sendRequest(READ_INCLUDED_FILE_REQUEST, { uri: uri.toString() });
      return (res as { text: string | null }).text ?? `# include not yet resolved: ${uri.toString()}`;
    }
  })();
  ctx.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('gitlab-ci', contentProvider));

  // Auto-import hosts from GitLab.gitlab-workflow if installed/configured.
  importGitlabWorkflowHosts();

  // Token prompt on first 401: server notifies us, we handle UX.
  client.onNotification(NEEDS_AUTH_NOTIFICATION, async ({ host }: NeedsAuthParams) => {
    await promptForToken(host);
  });

  ctx.subscriptions.push(
    vscode.commands.registerCommand('gitlabCi.setTokenForHost', async () => {
      const host = await vscode.window.showInputBox({
        prompt: 'GitLab host (e.g. gitlab.com or gitlab.mycorp.io)',
        value: getDefaultHost(),
      });
      if (!host) return;
      await promptForToken(host);
    }),
    vscode.commands.registerCommand('gitlabCi.showGraph', async (arg?: unknown) => {
      try {
        // Accepts: vscode.Uri (from explorer/editor context menu/title bar),
        // a string URI (from code lens), or nothing (palette / status bar).
        let uri: string | undefined;
        if (arg instanceof vscode.Uri) uri = arg.toString();
        else if (typeof arg === 'string') uri = arg;
        if (!uri) uri = vscode.window.activeTextEditor?.document.uri.toString();
        log(`[showGraph] invoked with uri=${uri ?? 'undefined'}`);
        if (!uri) {
          vscode.window.showWarningMessage('Open or select a .gitlab-ci.yml file first.');
          return;
        }
        await showGraph(ctx, uri);
      } catch (e) {
        log(`[showGraph] FAILED: ${(e as Error).stack ?? (e as Error).message}`);
        vscode.window.showErrorMessage(`Show Graph failed: ${(e as Error).message}`);
      }
    }),
    vscode.commands.registerCommand('gitlabCi.clearIncludeCache', async () => {
      try {
        await client?.sendRequest(CLEAR_CACHE_REQUEST);
        vscode.window.showInformationMessage('GitLab CI include cache cleared.');
      } catch (e) {
        log(`[clearIncludeCache] FAILED: ${(e as Error).stack ?? (e as Error).message}`);
        vscode.window.showErrorMessage(`Couldn't clear the include cache: ${(e as Error).message}`);
      }
    }),
    vscode.commands.registerCommand('gitlabCi.showMergedPipeline', async (arg?: unknown) => {
      try {
        let uri: string | undefined;
        if (arg instanceof vscode.Uri) uri = arg.toString();
        else if (typeof arg === 'string') uri = arg;
        if (!uri) uri = vscode.window.activeTextEditor?.document.uri.toString();
        if (!uri) {
          vscode.window.showWarningMessage('Open or select a .gitlab-ci.yml file first.');
          return;
        }
        if (!client) return;
        const res = (await client.sendRequest(MERGE_PIPELINE_REQUEST, { uri })) as MergePipelineResult;
        if (!res?.text) {
          vscode.window.showWarningMessage('Could not resolve the pipeline to merge.');
          return;
        }
        const doc = await vscode.workspace.openTextDocument({ language: 'yaml', content: res.text });
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside, true);
      } catch (e) {
        log(`[showMergedPipeline] FAILED: ${(e as Error).stack ?? (e as Error).message}`);
        vscode.window.showErrorMessage(`Show Merged Pipeline failed: ${(e as Error).message}`);
      }
    }),
    vscode.commands.registerCommand('gitlabCi.openInGitLab', async (arg?: unknown) => {
      try {
        const uri = uriFromArg(arg);
        if (!uri) { vscode.window.showWarningMessage('Open or select a .gitlab-ci.yml file first.'); return; }
        const fileUri = vscode.Uri.parse(uri);
        const ctx = repoContextFor(fileUri);
        if (!ctx) {
          vscode.window.showWarningMessage('Could not determine a GitLab project from the git remote.');
          return;
        }
        const rel = path.relative(ctx.repoRoot.fsPath, fileUri.fsPath).split(path.sep).join('/');
        await vscode.env.openExternal(vscode.Uri.parse(blobUrl(ctx.host, ctx.projectPath, ctx.branch, rel)));
      } catch (e) {
        log(`[openInGitLab] FAILED: ${(e as Error).stack ?? (e as Error).message}`);
        vscode.window.showErrorMessage(`Open in GitLab failed: ${(e as Error).message}`);
      }
    }),
    vscode.commands.registerCommand('gitlabCi.lintWithGitLab', async (arg?: unknown) => {
      try {
        const uri = uriFromArg(arg);
        if (!uri) { vscode.window.showWarningMessage('Open or select a .gitlab-ci.yml file first.'); return; }
        await lintWithGitLab(vscode.Uri.parse(uri));
      } catch (e) {
        log(`[lint] FAILED: ${(e as Error).stack ?? (e as Error).message}`);
        vscode.window.showErrorMessage(`GitLab CI Lint failed: ${(e as Error).message}`);
      }
    }),
    vscode.commands.registerCommand('gitlabCi.migrateOnlyExcept', async (arg?: unknown) => {
      try {
        const uri = uriFromArg(arg);
        if (!uri) { vscode.window.showWarningMessage('Open or select a .gitlab-ci.yml file first.'); return; }
        await migrateOnlyExcept(uri);
      } catch (e) {
        log(`[migrateOnlyExcept] FAILED: ${(e as Error).stack ?? (e as Error).message}`);
        vscode.window.showErrorMessage(`Convert only/except to rules failed: ${(e as Error).message}`);
      }
    }),
  );
}

/** Save a data:image/png;base64 URL to a user-chosen file. */
async function savePng(dataUrl: string, suggestedName: string) {
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:image/png') || comma < 0) {
    vscode.window.showErrorMessage('Pipeline export produced an unexpected image format.');
    return;
  }
  const bytes = Buffer.from(dataUrl.slice(comma + 1), 'base64');
  const defaultUri = vscode.workspace.workspaceFolders?.[0]
    ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, suggestedName)
    : vscode.Uri.file(suggestedName);
  const target = await vscode.window.showSaveDialog({ defaultUri, filters: { Images: ['png'] } });
  if (!target) return;
  await vscode.workspace.fs.writeFile(target, bytes);
  const open = await vscode.window.showInformationMessage(`Saved pipeline graph to ${target.fsPath}`, 'Open');
  if (open === 'Open') await vscode.commands.executeCommand('vscode.open', target);
}

/** Coerce a command argument (Uri | string | undefined) to a document URI string. */
function uriFromArg(arg: unknown): string | undefined {
  if (arg instanceof vscode.Uri) return arg.toString();
  if (typeof arg === 'string') return arg;
  return vscode.window.activeTextEditor?.document.uri.toString();
}

interface CiLintResponse { valid: boolean; errors?: string[]; warnings?: string[] }

/** Validate the file against the project's GitLab CI Lint API (authoritative, server-side). */
async function lintWithGitLab(fileUri: vscode.Uri) {
  const ctx = repoContextFor(fileUri);
  if (!ctx) {
    vscode.window.showWarningMessage('GitLab CI Lint needs a GitLab git remote to identify the project.');
    return;
  }
  const tokens = vscode.workspace.getConfiguration('gitlabCi').get<Record<string, string>>('tokens') ?? {};
  const token = tokens[ctx.host];
  if (!token) {
    const pick = await vscode.window.showWarningMessage(
      `A token for ${ctx.host} is required to use the GitLab CI Lint API.`, 'Add Token',
    );
    if (pick === 'Add Token') await promptForToken(ctx.host);
    return;
  }
  const doc = await vscode.workspace.openTextDocument(fileUri);
  const url = `https://${ctx.host}/api/v4/projects/${encodeURIComponent(ctx.projectPath)}/ci/lint`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'PRIVATE-TOKEN': token },
      body: JSON.stringify({ content: doc.getText(), dry_run: false }),
    });
  } catch (e) {
    vscode.window.showErrorMessage(`CI Lint request to ${ctx.host} failed: ${(e as Error).message}`);
    return;
  }
  if (!res.ok) {
    vscode.window.showErrorMessage(`CI Lint request failed: HTTP ${res.status} for ${ctx.projectPath} on ${ctx.host}.`);
    return;
  }
  let data: CiLintResponse;
  try {
    data = (await res.json()) as CiLintResponse;
  } catch {
    vscode.window.showErrorMessage(`CI Lint returned an invalid response from ${ctx.host} (expected JSON).`);
    return;
  }
  const errors = data.errors ?? [];
  const warnings = data.warnings ?? [];

  // The CI Lint API returns messages without line numbers — anchor them at the top of the file.
  const topOfFile = new vscode.Range(0, 0, 0, Number.MAX_SAFE_INTEGER);
  const toDiag = (message: string, severity: vscode.DiagnosticSeverity) => {
    const d = new vscode.Diagnostic(topOfFile, message, severity);
    d.source = 'gitlab-ci-lint';
    return d;
  };
  lintDiagnostics?.set(fileUri, [
    ...errors.map((e) => toDiag(e, vscode.DiagnosticSeverity.Error)),
    ...warnings.map((w) => toDiag(w, vscode.DiagnosticSeverity.Warning)),
  ]);

  if (data.valid) {
    vscode.window.showInformationMessage(
      `✓ ${ctx.projectPath}: pipeline is valid${warnings.length ? ` (${warnings.length} warning(s) — see Problems)` : ''}.`,
    );
  } else {
    vscode.window.showErrorMessage(`✕ ${ctx.projectPath}: ${errors.length} CI Lint error(s) — see the Problems panel.`);
  }
}

async function showGraph(ctx: vscode.ExtensionContext, uri: string) {
  const existing = panels.get(uri);
  if (existing) {
    log('[showGraph] panel already exists, revealing');
    existing.reveal();
    return;
  }
  const webviewDistPath = bundleDir(ctx, 'webview');
  const webviewDist = vscode.Uri.file(webviewDistPath);
  const jsPath = path.join(webviewDistPath, 'webview.js');
  log(`[showGraph] webview dist: ${webviewDistPath}`);
  log(`[showGraph] webview.js exists: ${fs.existsSync(jsPath)}`);
  if (!fs.existsSync(jsPath)) {
    vscode.window.showErrorMessage(`Webview bundle missing: ${jsPath}. Run: bun run build:webview`);
    return;
  }
  const panel = vscode.window.createWebviewPanel(
    'gitlabCiGraph',
    `Pipeline: ${path.basename(vscode.Uri.parse(uri).fsPath)}`,
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [webviewDist, vscode.Uri.file(ctx.extensionPath)],
    },
  );
  panels.set(uri, panel);
  panel.onDidDispose(() => panels.delete(uri));

  panel.webview.html = renderHtml(ctx, panel.webview);
  log('[showGraph] panel created and html set');

  panel.webview.onDidReceiveMessage(async (msg) => {
    log(`[webview→ext] ${JSON.stringify(msg).slice(0, 200)}`);
    try {
      if (msg.type === 'ready') {
        const model = await client!.sendRequest(RESOLVE_PIPELINE_REQUEST, { uri });
        log(`[showGraph] resolvePipeline returned ${model ? 'model' : 'null'}`);
        if (model) panel.webview.postMessage({ type: 'modelUpdated', model });
        // Feed the rules-simulation branch picker from the local git repo (best-effort).
        const fileUri = vscode.Uri.parse(uri);
        if (fileUri.scheme === 'file') {
          const refs = gitRefsFor(fileUri);
          panel.webview.postMessage({ type: 'gitRefs', branches: refs.branches, current: refs.current });
        }
      } else if (msg.type === 'revealJob') {
        await revealJob(msg.uri, msg.jobName);
      } else if (msg.type === 'revealLocation') {
        await revealLocation(msg.uri, msg.range);
      } else if (msg.type === 'renameStage') {
        await applyStageRename(msg.uri, msg.oldName, msg.newName);
      } else if (msg.type === 'updateJob') {
        await applyJobUpdate(msg.uri, msg.jobName, msg.newValue);
      } else if (msg.type === 'openChildPipeline') {
        await showGraph(ctx, msg.uri);
      } else if (msg.type === 'exportPng') {
        await savePng(msg.dataUrl, msg.suggestedName);
      } else if (msg.type === 'simFiles') {
        await handleSimFiles(msg.uri, msg.ref, msg.pipelineSource, panel.webview);
      }
    } catch (e) {
      log(`[webview→ext] handler error: ${(e as Error).stack ?? (e as Error).message}`);
      // 'ready' is internal plumbing; the rest are user-triggered, so don't fail silently.
      if (msg.type && msg.type !== 'ready') {
        vscode.window.showErrorMessage(`GitLab CI Preview: ${msg.type} failed — ${(e as Error).message}`);
      }
    }
  });
}

async function applyJobUpdate(uri: string, jobName: string, newValue: unknown) {
  if (!client) return;
  const targetUri = vscode.Uri.parse(uri);
  // Only edit local files.
  if (targetUri.scheme !== 'file') {
    log(`[updateJob] refused: non-file URI ${uri}`);
    return;
  }
  const res = (await client.sendRequest(UPDATE_JOB_REQUEST, { uri, jobName, newValue })) as UpdateJobResult;
  if (!res?.edit) { log(`[updateJob] server returned no edit for ${jobName}`); return; }
  const wsEdit = new vscode.WorkspaceEdit();
  wsEdit.replace(
    targetUri,
    new vscode.Range(
      res.edit.range.start.line, res.edit.range.start.character,
      res.edit.range.end.line, res.edit.range.end.character,
    ),
    res.edit.newText,
  );
  const ok = await vscode.workspace.applyEdit(wsEdit);
  if (!ok) {
    log(`[updateJob] applyEdit failed`);
    vscode.window.showErrorMessage(`Couldn't apply changes to job "${jobName}".`);
    return;
  }
  // Don't auto-save on every keystroke; let the user's normal save flow persist.
  log(`[updateJob] applied ${jobName} (${res.edit.newText.length} chars)`);
}

async function applyStageRename(uri: string, oldName: string, newName: string) {
  if (!client || !oldName || !newName || oldName === newName) return;
  const trimmed = newName.trim();
  if (!trimmed) { vscode.window.showWarningMessage('Stage name cannot be empty.'); return; }
  const res = (await client.sendRequest(RENAME_STAGE_REQUEST, { uri, oldName, newName: trimmed })) as RenameStageResult;
  if (!res || res.edits.length === 0) {
    vscode.window.showInformationMessage(`No occurrences of stage "${oldName}" found.`);
    return;
  }
  const wsEdit = new vscode.WorkspaceEdit();
  const targetUri = vscode.Uri.parse(uri);
  for (const e of res.edits) {
    wsEdit.replace(
      targetUri,
      new vscode.Range(e.range.start.line, e.range.start.character, e.range.end.line, e.range.end.character),
      e.newText,
    );
  }
  const applied = await vscode.workspace.applyEdit(wsEdit);
  if (!applied) { vscode.window.showErrorMessage('Failed to apply stage rename.'); return; }
  try {
    const doc = await vscode.workspace.openTextDocument(targetUri);
    await doc.save();
  } catch (e) {
    log(`[renameStage] save failed: ${(e as Error).message}`);
    vscode.window.showWarningMessage(`Stage renamed, but saving the file failed: ${(e as Error).message}`);
  }
  log(`[renameStage] applied ${res.edits.length} edit(s) in ${uri}`);
  if (res.externalRefs.length > 0) {
    const total = res.externalRefs.reduce((s, r) => s + r.count, 0);
    vscode.window.showWarningMessage(
      `Stage "${oldName}" is also referenced ${total} time(s) in included files. Edit those manually.`,
    );
  }
}

/** Convert every legacy `only:`/`except:` job in the document to `rules:` via the server. */
async function migrateOnlyExcept(uri: string) {
  if (!client) return;
  const res = (await client.sendRequest(MIGRATE_ONLY_EXCEPT_REQUEST, { uri })) as MigrateOnlyExceptResult;
  if (!res || res.edits.length === 0) {
    vscode.window.showInformationMessage('Nothing to convert — no jobs use legacy only/except.');
    return;
  }
  const wsEdit = new vscode.WorkspaceEdit();
  const targetUri = vscode.Uri.parse(uri);
  for (const e of res.edits) {
    wsEdit.replace(
      targetUri,
      new vscode.Range(e.range.start.line, e.range.start.character, e.range.end.line, e.range.end.character),
      e.newText,
    );
  }
  const applied = await vscode.workspace.applyEdit(wsEdit);
  if (!applied) { vscode.window.showErrorMessage('Failed to apply only/except conversion.'); return; }
  try {
    const doc = await vscode.workspace.openTextDocument(targetUri);
    await doc.save();
  } catch (e) {
    log(`[migrateOnlyExcept] save failed: ${(e as Error).message}`);
    vscode.window.showWarningMessage(`Converted, but saving the file failed: ${(e as Error).message}`);
  }
  vscode.window.showInformationMessage(`Converted only/except to rules in ${res.jobs.length} job(s): ${res.jobs.join(', ')}.`);
}

async function revealLocation(uri: string, range: { start: { line: number; character: number }; end: { line: number; character: number } }) {
  try {
    const targetUri = vscode.Uri.parse(uri);
    const doc = await vscode.workspace.openTextDocument(targetUri);
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One, false);
    const r = new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
    editor.selection = new vscode.Selection(r.start, r.start);
    editor.revealRange(r, vscode.TextEditorRevealType.InCenter);
  } catch (e) {
    log(`[revealLocation] failed: ${(e as Error).message}`);
  }
}

async function revealJob(uri: string, jobName: string) {
  if (!client) return;
  const model = (await client.sendRequest(RESOLVE_PIPELINE_REQUEST, { uri })) as PipelineModel | null;
  if (!model) return;
  const job = model.jobs.find((j) => j.name === jobName);
  if (!job) return;
  try {
    const targetUri = vscode.Uri.parse(job.source.uri);
    const doc = await vscode.workspace.openTextDocument(targetUri);
    const editor = await vscode.window.showTextDocument(doc);
    const range = new vscode.Range(
      job.source.range.start.line, job.source.range.start.character,
      job.source.range.end.line, job.source.range.end.character,
    );
    editor.selection = new vscode.Selection(range.start, range.start);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  } catch (e) {
    log(`[revealJob] failed: ${(e as Error).message}`);
    vscode.window.showErrorMessage(`Couldn't open the definition of "${jobName}": ${(e as Error).message}`);
  }
}

function renderHtml(ctx: vscode.ExtensionContext, webview: vscode.Webview): string {
  const distDir = bundleDir(ctx, 'webview');
  const jsPath = path.join(distDir, 'webview.js');
  const cssPath = path.join(distDir, 'webview.css');
  const jsUri = webview.asWebviewUri(vscode.Uri.file(jsPath));
  const cssUri = fs.existsSync(cssPath) ? webview.asWebviewUri(vscode.Uri.file(cssPath)) : null;
  const nonce = randomNonce();
  return /* html */ `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    img-src ${webview.cspSource} data:;
    font-src ${webview.cspSource} data:;
    style-src ${webview.cspSource} 'unsafe-inline';
    script-src 'nonce-${nonce}' 'unsafe-eval';
  ">
  ${cssUri ? `<link rel="stylesheet" href="${cssUri}">` : ''}
  <style>
    html, body, #root { height: 100%; margin: 0; padding: 0; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); }
    /* Hide React Flow's edge anchor handles — our layout is fixed. */
    .react-flow__handle {
      opacity: 0 !important;
      width: 1px !important;
      height: 1px !important;
      min-width: 1px !important;
      min-height: 1px !important;
      border: none !important;
      background: transparent !important;
      pointer-events: none !important;
    }
    /* Tighter selection ring on job cards. */
    .react-flow__node.selected, .react-flow__node:focus, .react-flow__node:focus-visible {
      outline: none !important;
      box-shadow: 0 0 0 2px var(--vscode-focusBorder, #007fd4) !important;
    }
    /* Theme the Controls panel (zoom +/−, fit-view) for dark editor. */
    .react-flow__controls {
      background: var(--vscode-sideBar-background, #1e1e1e) !important;
      border: 1px solid var(--vscode-panel-border, #444) !important;
      box-shadow: none !important;
    }
    .react-flow__controls-button {
      background: var(--vscode-button-secondaryBackground, #2d2d2d) !important;
      color: var(--vscode-button-secondaryForeground, #ccc) !important;
      border-bottom: 1px solid var(--vscode-panel-border, #444) !important;
      fill: currentColor !important;
    }
    .react-flow__controls-button:hover {
      background: var(--vscode-button-secondaryHoverBackground, #3d3d3d) !important;
    }
    .react-flow__controls-button svg { fill: currentColor !important; }
    .react-flow__minimap-mask { fill: rgba(0,0,0,0.55); }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module" nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}

// ---------- gitlab-workflow integration & token UX ----------

function getDefaultHost(): string {
  const explicit = vscode.workspace.getConfiguration('gitlabCi').get<string>('defaultHost');
  if (explicit) return explicit;
  const fromGit = hostFromGitRemote();
  if (fromGit) return fromGit;
  return 'gitlab.com';
}

/** Read the first git remote of the first open repository via the built-in vscode.git extension. */
function hostFromGitRemote(): string | null {
  try {
    const api = gitApi();
    if (!api) return null;
    for (const repo of api.repositories ?? []) {
      for (const remote of repo.state?.remotes ?? []) {
        const url = remote.fetchUrl ?? remote.pushUrl;
        if (!url) continue;
        const host = toHost(url);
        if (host && host !== 'github.com') return host;
      }
    }
  } catch (e) {
    log(`[auth] git remote detection failed (ignored): ${(e as Error).message}`);
  }
  return null;
}

type GitRef = { type: number; name?: string };
type GitRepo = {
  rootUri: vscode.Uri;
  state: {
    HEAD?: { name?: string };
    refs?: GitRef[];
    remotes: Array<{ fetchUrl?: string; pushUrl?: string }>;
  };
};
type GitApiV1 = { repositories: GitRepo[] };

// vscode.git RefType: 0 = local head, 1 = remote head, 2 = tag.
const REF_HEAD = 0, REF_REMOTE_HEAD = 1;

/** Branch names + current branch for the repo containing `fileUri`, via the built-in git extension. */
function gitRefsFor(fileUri: vscode.Uri): { branches: string[]; current: string | null } {
  try {
    const api = gitApi();
    if (!api) return { branches: [], current: null };
    const repos = [...(api.repositories ?? [])].sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length);
    const repo = repos.find((r) => fileUri.fsPath.startsWith(r.rootUri.fsPath)) ?? repos[0];
    if (!repo) return { branches: [], current: null };
    const branches = new Set<string>();
    for (const ref of repo.state?.refs ?? []) {
      if ((ref.type === REF_HEAD || ref.type === REF_REMOTE_HEAD) && ref.name) {
        const name = ref.type === REF_REMOTE_HEAD ? ref.name.replace(/^[^/]+\//, '') : ref.name;
        if (name && name !== 'HEAD') branches.add(name);
      }
    }
    const current = repo.state?.HEAD?.name ?? null;
    if (current) branches.add(current);
    return { branches: [...branches].sort(), current };
  } catch (e) {
    log(`[gitRefs] detection failed (ignored): ${(e as Error).message}`);
    return { branches: [], current: null };
  }
}

function gitApi(): GitApiV1 | null {
  try {
    const git = vscode.extensions.getExtension<{ getAPI(version: 1): GitApiV1 }>('vscode.git');
    if (!git?.isActive) return null;
    return git.exports.getAPI(1);
  } catch { return null; }
}

/**
 * Best-effort file lists for the rules simulation (`changes:` / `exists:`): ask the local
 * git repo for the changed + present paths on the simulated ref. When no data can be
 * computed (git extension missing, unknown ref, …) answer `available: false` and let the
 * webview keep the optimistic "file conditions match" assumption.
 */
async function handleSimFiles(uri: string, ref: string, pipelineSource: string, webview: vscode.Webview) {
  const reply = (files: SimFiles) => {
    webview.postMessage({
      type: 'simFilesResult',
      ref,
      pipelineSource,
      available: files.available,
      ...(files.changed ? { changedFiles: files.changed } : {}),
      ...(files.exists ? { existsFiles: files.exists } : {}),
    });
  };
  const fileUri = vscode.Uri.parse(uri);
  if (fileUri.scheme !== 'file') { reply({ available: false }); return; }
  const api = gitApi();
  const repos = api
    ? [...(api.repositories ?? [])].sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)
    : [];
  const repo = repos.find((r) => fileUri.fsPath.startsWith(r.rootUri.fsPath)) ?? repos[0];
  if (!repo) { reply({ available: false }); return; }
  try {
    const root = repo.rootUri.fsPath;
    const defaultBranch = await detectDefaultBranch(root);
    reply(await computeSimFiles(root, ref, pipelineSource, defaultBranch));
  } catch (e) {
    log(`[simFiles] computation failed (ignored): ${(e as Error).message}`);
    reply({ available: false });
  }
}

interface RepoContext { host: string; projectPath: string; branch: string; repoRoot: vscode.Uri }

/** Resolve host / project path / branch for the repository containing `fileUri`. */
function repoContextFor(fileUri: vscode.Uri): RepoContext | null {
  const api = gitApi();
  if (!api) return null;
  // Prefer the repo whose root is a prefix of the file path.
  const repos = [...(api.repositories ?? [])].sort(
    (a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length,
  );
  const repo = repos.find((r) => fileUri.fsPath.startsWith(r.rootUri.fsPath)) ?? repos[0];
  if (!repo) return null;
  for (const remote of repo.state?.remotes ?? []) {
    const url = remote.fetchUrl ?? remote.pushUrl;
    if (!url) continue;
    const host = toHost(url);
    const projectPath = toProjectPath(url);
    if (host && host !== 'github.com' && projectPath) {
      return { host, projectPath, branch: repo.state?.HEAD?.name || 'HEAD', repoRoot: repo.rootUri };
    }
  }
  return null;
}

/** Read instance URLs configured in the GitLab.gitlab-workflow extension and merge into our defaultHost. */
function importGitlabWorkflowHosts() {
  try {
    const glwf = vscode.workspace.getConfiguration('gitlab');
    const instanceUrl = glwf.get<string>('instanceUrl');
    const ours = vscode.workspace.getConfiguration('gitlabCi');
    const currentDefault = ours.get<string>('defaultHost');
    if (instanceUrl && (!currentDefault || currentDefault === 'gitlab.com')) {
      const host = toHost(instanceUrl);
      if (host) {
        log(`[auth] importing default host from gitlab-workflow: ${host}`);
        ours.update('defaultHost', host, vscode.ConfigurationTarget.Global).then(() => {}, () => {});
      }
    }
  } catch (e) {
    log(`[auth] gitlab-workflow import failed (ignored): ${(e as Error).message}`);
  }
}

const askedHosts = new Set<string>();

async function promptForToken(host: string) {
  if (askedHosts.has(host)) return;
  askedHosts.add(host);

  const hasGitlabWorkflow = !!vscode.extensions.getExtension('GitLab.gitlab-workflow');
  const SIGN_IN = 'Sign in via GitLab Workflow';
  const buttons: string[] = ['Paste Token'];
  if (hasGitlabWorkflow) buttons.push(SIGN_IN);
  buttons.push('Open Settings', 'Skip');

  const choice = await vscode.window.showInformationMessage(
    `GitLab CI Preview can't fetch private includes on ${host} without a personal access token.`,
    ...buttons,
  );

  if (choice === SIGN_IN) {
    try {
      await vscode.commands.executeCommand('gl.addAccount');
    } catch (e) {
      log(`[auth] gl.addAccount failed (falling back to PAT prompt): ${(e as Error).message}`);
    }
    await pasteTokenFlow(host, `GitLab Workflow doesn't share its token with other extensions — paste a PAT for ${host} (scopes: read_api, read_repository)`);
    return;
  }

  if (choice === 'Paste Token') {
    await pasteTokenFlow(host, `Personal access token for ${host} (scopes: read_api, read_repository)`);
  } else if (choice === 'Open Settings') {
    vscode.commands.executeCommand('workbench.action.openSettings', 'gitlabCi.tokens');
  }
}

async function pasteTokenFlow(host: string, prompt: string) {
  const token = await vscode.window.showInputBox({ prompt, password: true, ignoreFocusOut: true });
  if (!token) return;
  const cfg = vscode.workspace.getConfiguration('gitlabCi');
  const tokens = { ...(cfg.get<Record<string, string>>('tokens') ?? {}), [host]: token };
  await cfg.update('tokens', tokens, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`Token saved for ${host}.`);
  await client?.sendRequest(CLEAR_CACHE_REQUEST).then(undefined, (e: unknown) => {
    log(`[pasteTokenFlow] cache clear after token save failed (ignored): ${(e as Error).message}`);
  });
}
