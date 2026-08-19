# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See the [root CLAUDE.md](../../CLAUDE.md) for monorepo-wide commands, architecture, and conventions. This file covers client-package specifics.

## Package role

VS Code extension host (`packages/client`). Single source file: `src/extension.ts`. Compiled to `dist/extension.js` — the `"main"` entry in `package.json`.

## Build & typecheck

Run from this directory or the repo root:

```sh
bun run build         # bun build src/extension.ts --target=node --format=cjs --outfile=dist/extension.js --external vscode
bun run dev           # same with --watch
bun run --cwd packages/client typecheck   # tsc --noEmit
```

No tests live in this package — server tests are in `packages/server/test/`.

## Key architecture points

**Bundle resolution** (`bundleCandidates` / `resolveBundle`): the extension probes two layouts at runtime — `bundled/{server,webview}/` (packaged `.vsix`) then `../{server,webview}/dist/` (F5 dev). `scripts/package.sh` deletes `bundled/` after packaging so dev always falls back to the live `dist/` paths.

**Webview panels**: one panel per pipeline URI, tracked in the `panels: Map<string, vscode.WebviewPanel>`. `showGraph` reuses an existing panel if one is open for the same URI.

**Three message directions**:
1. VS Code → extension: commands (`showGraph`, `clearIncludeCache`, `setTokenForHost`)
2. Extension ↔ LSP server: `RESOLVE_PIPELINE_REQUEST`, `READ_INCLUDED_FILE_REQUEST`, `RENAME_STAGE_REQUEST`, `UPDATE_JOB_REQUEST`, `CLEAR_CACHE_REQUEST` custom requests; `PIPELINE_UPDATED_NOTIFICATION` and `NEEDS_AUTH_NOTIFICATION` notifications
3. Extension ↔ webview: `modelUpdated` (ext→webview), `ready` / `revealJob` / `revealLocation` / `renameStage` / `updateJob` (webview→ext)

All message constants come from `@gitlab-ci-preview/shared` — never inline string method names.

**Edit flow**: `applyJobUpdate` and `applyStageRename` send a custom LSP request, receive a `TextEdit` back from the server, and apply it via `vscode.workspace.applyEdit`. Stage rename auto-saves; job update does not (intentional — see comment in code).

**Auth UX**: the server emits `NEEDS_AUTH_NOTIFICATION` (`gitlabCi/needsAuth`) on a 401. The client de-dupes per host (`askedHosts` set), prompts for a PAT, and writes it to `gitlabCi.tokens` in global settings. On save it sends `CLEAR_CACHE_REQUEST` (`gitlabCi/clearCache`) so the server retries with the new token.
