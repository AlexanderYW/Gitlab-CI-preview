# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A VS Code extension that visualizes `.gitlab-ci.yml` pipelines with full include resolution (local / remote / template / project / component). Built as a Bun workspaces monorepo and shipped as a single `.vsix`.

## Commands

Package manager is **Bun** (see `bun.lock`). Workspaces live under `packages/*`.

- `bun install` — install all workspaces
- `bun run build` — build every package (`build:server`, `build:client`, `build:webview`, `build:shared`)
- `bun test` — run all tests (Bun's test runner). Server tests live in `packages/server/test/*.test.ts`. Run one with `bun test packages/server/test/resolve.test.ts` (or filter: `bun test -t "pattern"`).
- `bun run --cwd packages/<pkg> typecheck` — `tsc --noEmit` for `client`/`server` (no root-wide typecheck script)
- `bun run --cwd packages/<pkg> dev` — watch-build that package
- `bun run package` — runs `scripts/package.sh`: builds all bundles, stages `server.js` and `webview.js`/`webview.css` into `packages/client/bundled/`, runs `vsce package` to produce `gitlab-ci-preview.vsix` at repo root, then **deletes `bundled/`** so F5 dev mode falls back to live `dist/` paths.

To install the built extension in VS Code/Kiro: Command Palette → "Extensions: Install from VSIX…" → pick `gitlab-ci-preview.vsix`.

## Architecture

Four packages with a strict dependency direction: `client`, `server`, and `webview` all depend on `shared`; nothing else cross-depends.

- **`packages/shared`** — pure TypeScript types only (no build output, consumed via `src/index.ts`). Defines `PipelineModel`, `Job`, `IncludeRef`, `Diagnostic`, and all LSP message constants/param/result types (`RESOLVE_PIPELINE_REQUEST`, `PIPELINE_UPDATED_NOTIFICATION`, `READ_INCLUDED_FILE_REQUEST`, `RENAME_STAGE_REQUEST`, `UPDATE_JOB_REQUEST`) plus the webview ↔ extension message union. Any change to wire-format types belongs here.

- **`packages/server`** — Language Server (Node, runs as a separate process over stdio JSON-RPC). Entry `src/server.ts`. Anything written to stdout other than LSP frames corrupts the stream, so `console.log/error` are redirected to `connection.console` at startup. Responsibilities:
  - `parser.ts` / `resolve.ts` — parse YAML and recursively walk `include:` (with cycle detection, depth cap, root-takes-precedence merging for jobs/variables).
  - `includes/` — fetchers for the five include kinds; `http.ts` handles auth (per-host tokens) and caches by ref (pinned SHA/tag longer than branch). Emits a `gitlabCi/needsAuth` notification when a host needs a token.
  - `includes/inputs.ts` — implements GitLab's `spec.inputs` interpolation for includes.
  - `features/` — LSP features built on the resolved model: `diagnostics`, `hover`, `definition`, `completion`, `codeLens`, `schemaValidate` (Ajv against `schema/gitlab-ci.schema.json`), `renameStage`, `updateJob`.
  - Custom requests beyond standard LSP: `resolvePipeline`, `readIncludedFile`, `renameStage`, `updateJob`; pushes `pipelineUpdated` notifications when the cached model changes (debounced per-doc).

- **`packages/client`** — VS Code extension host code. Entry `src/extension.ts`. Spawns the language server, owns webview panels (one per pipeline doc, tracked in `panels` map), and bridges three directions: VS Code ⇄ LSP ⇄ webview. Registers commands `gitlabCi.showGraph`, `gitlabCi.clearIncludeCache`, `gitlabCi.setTokenForHost`. Settings: `gitlabCi.tokens` (per-host PAT map), `gitlabCi.defaultHost`, `gitlabCi.cacheTtlMinutes`.
  - **Bundle resolution is dual-mode** (`bundleCandidates` in `extension.ts`): in a packaged `.vsix` it loads from `bundled/{server,webview}/`; during F5 dev it falls back to `../{server,webview}/dist/`. This is why `scripts/package.sh` deletes `bundled/` after packaging — otherwise dev mode would load stale files.

- **`packages/webview`** — React app (bundled with Bun for browser target) rendered inside the webview panel. Uses `@xyflow/react` + `dagre` for graph layout (`layout.ts`). Receives `PipelineModel` via the `modelUpdated` message and posts back `revealJob` / `revealLocation` / `renameStage` / `updateJob` / `selectJob` messages defined in `shared/messages.ts`. `SchemaForm.tsx` is driven by an embedded `gitlab-ci.schema.json` for editing job specs.

## Conventions

- Bun is required (TypeScript is run directly; `shared` has no compile step). Don't introduce `tsc` build outputs for `shared`.
- All cross-process messages must use the constants from `shared/messages.ts` — never inline a string method name.
- The server is built as CJS (`--format=cjs --external vscode`) because VS Code's language client spawns it as a Node script; the webview is built as ESM browser bundle. Keep these targets distinct.
- Stages `build`, `test`, `deploy` are GitLab's implicit defaults — see `DEFAULT_STAGES` in `shared/model.ts`.
- Test fixtures (`fixtures/*.gitlab-ci.yml`) are reused by both server tests and manual testing.
