# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See the [root CLAUDE.md](../../CLAUDE.md) for monorepo-wide commands, architecture, and conventions. This file covers webview-package specifics.

## Package role

The React app rendered inside the VS Code webview panel (`packages/webview`). It receives a resolved `PipelineModel` from the extension and draws the pipeline as an interactive graph; it never talks to the language server directly — all communication goes through the extension host via `postMessage`.

## Build & typecheck

Run from this directory or the repo root:

```sh
bun run build   # bun build src/main.tsx --target=browser --format=esm --minify --outfile=dist/webview.js  (also copies @xyflow/react style.css → dist/webview.css)
bun run dev     # same, unminified, --watch
bun run --cwd packages/webview typecheck   # tsc -p tsconfig.json --noEmit
```

The bundle is an **ESM browser** target — distinct from the server's CJS Node target. `scripts/package.sh` stages `dist/webview.js` + `dist/webview.css` into `packages/client/bundled/webview/` for the `.vsix`.

## Entry & structure

- **`src/main.tsx`** — mounts `<App/>` inside `<ErrorBoundary/>` on `#root`.
- **`src/App.tsx`** — the top-level component: holds the `PipelineModel`, the selected job, the simulation/branch state, keyboard navigation, and PNG export. Owns the `window` message listener (ext→webview) and posts messages back (webview→ext).
- **`src/vscode.ts`** — thin singleton wrapper around `acquireVsCodeApi()`; the only place that handle is acquired. Use `vscode().postMessage(...)`.
- **Components** — `JobDetailPanel.tsx` (right-hand inspector + `SchemaForm`-driven editing), `PipelineHeader.tsx` (title, pipeline-state badge, simulation bar), `SchemaForm.tsx` (job-spec editor driven by the embedded schema — the largest module), `ReferenceField.tsx`, `Legend.tsx`, `DiagnosticsBadge.tsx`, `ErrorBoundary.tsx`.
- **Logic helpers** (pure, unit-tested) — `layout.ts` (dagre layout → React Flow nodes/edges, plus keyboard nav helpers), `cycles.ts` (graph cycle detection), `rules.ts` (per-branch pipeline simulation of `rules:`/`workflow:`), `vars.ts` (variable composition: global/default/job/matrix), `referenceUtil.ts` (`!reference` parsing/formatting), `sections.ts` (job-detail section grouping), `schemaUtil.ts`, `ciVariables.ts` (predefined `CI_*` variables).
- **`src/gitlab-ci.schema.json`** — schema embedded for `SchemaForm` editing (separate copy from the server's `schema/`).

## Message flow

All message `type` strings come from the `WebviewMessage` union in `@gitlab-ci-preview/shared` — **never inline a string**. See [client/CLAUDE.md](../client/CLAUDE.md) for the extension side.

- **ext → webview**: `modelUpdated` (the resolved `PipelineModel`), `gitRefs` (branch list for the simulation picker).
- **webview → ext**: `ready` (sent once on mount to request the initial model), `revealJob`, `revealLocation`, `renameStage`, `updateJob`, `selectJob`, `openChildPipeline`, `exportPng`.

The webview is stateless across reloads except via `vscode().setState/getState` and a couple of `localStorage` keys (e.g. `gitlabCi.detailPanelWidth` in `JobDetailPanel.tsx` — these are webview-local, **not** VS Code settings, so they are not declared in `client/package.json`).

## Conventions

- **Keep logic out of components.** Graph/layout/simulation/variable logic lives in the pure `*.ts` helpers so it can be unit-tested without a DOM. Tests live in `test/` (`bun:test`) and import those helpers directly — components themselves are not tested.
- **CSP-safe.** The panel HTML (in `client/src/extension.ts`) sets a strict CSP with a per-load nonce. Don't introduce inline event handlers or remote script/style URLs; keep everything in the bundled JS/CSS.
- **React Flow theming** is done via global CSS in the panel HTML (`client/src/extension.ts` `renderHtml`), not here — node handles are hidden and controls are themed to the editor there.
