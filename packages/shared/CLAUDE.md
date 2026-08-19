# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

`packages/shared` is the wire-format contract layer for the `gitlab-ci-preview` monorepo. It contains **only TypeScript types and constants** — no runtime logic, no build output, no compiled artifacts. All other packages (`client`, `server`, `webview`) import directly from `src/index.ts` via Bun's TypeScript path resolution.

## Commands

```bash
# Type-check (the only "build" step — produces no output files)
bun run build
# or directly:
bun run --cwd packages/shared build
```

There are no tests in this package — logic lives in `server`; run tests from the repo root or `packages/server`.

## Structure

Three source files:

- **`src/model.ts`** — Core domain types: `PipelineModel`, `Job`, `IncludeRef`, `Diagnostic`, `SourceLocation`, `Range`, `Position`. Also exports `DEFAULT_STAGES` and `RESERVED_TOP_LEVEL` constants.
- **`src/messages.ts`** — All cross-process message definitions in two groups:
  - LSP custom messages (client ↔ server over JSON-RPC): `RESOLVE_PIPELINE_REQUEST`, `PIPELINE_UPDATED_NOTIFICATION`, `READ_INCLUDED_FILE_REQUEST`, `UPDATE_JOB_REQUEST`, `RENAME_STAGE_REQUEST` — each exports a string constant + param/result interfaces.
  - Webview ↔ client messages: `WebviewMessage` discriminated union (`modelUpdated`, `revealJob`, `revealLocation`, `renameStage`, `updateJob`, `selectJob`, `ready`).
- **`src/index.ts`** — Re-exports everything from both files.

## Key Constraints

- **No runtime code.** This package must stay type-only. Any helper function belongs in the package that uses it.
- **No `dist/` or compiled output.** Consumers reference `src/index.ts` directly; the `package.json` `main`/`types`/`exports` all point at the TypeScript source. Never add a real build step here.
- **Wire-format authority.** Every method name string used in LSP custom requests and every webview message `type` field must be defined here as a constant or discriminant. Never inline these strings in `client` or `server`.
- **Adding a new LSP method:** add the string constant + param + result interfaces to `messages.ts`, implement in `server/src/features/` or handle in `server/src/server.ts`, and wire the client side in `client/src/extension.ts`.
- **Adding a new webview message:** add a member to the `WebviewMessage` union in `messages.ts`, handle it in `client/src/extension.ts` (client→webview or webview→client), and in the webview's message handler.
