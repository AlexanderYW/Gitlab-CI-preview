# Backlog — bigger features for later

Deferred ideas with enough context to pick up cold. These are larger than the incremental
polish already shipped; capture here so they aren't lost.

## 1. Pipeline simulation per branch / MR — ✅ shipped (Phase 3a)

**Status:** Implemented in `packages/webview/src/rules.ts` (evaluator + `simulatePipeline`,
unit-tested in `packages/webview/test/rules.test.ts`) with a toolbar in `App.tsx` and graph
dimming in `layout.ts`. It evaluates `if:` and `when:` for a chosen ref + pipeline source.
**Still deferred:** `rules:changes:`/`exists:` (need a file list) and legacy `only/except` —
rules carrying only those conditions are currently treated as matching.

**Goal:** Let the user pick a ref (branch / tag / MR context) and show which jobs would
*actually* run, by evaluating `workflow:rules` (pipeline-level) and each job's `rules:`
(job-level), plus the legacy `only/except`.

**Why it's valuable:** This is the one thing GitLab's own pipeline editor can't do locally.
Today rules are parsed into `job.rules` (raw, see `packages/server/src/parser.ts`) but never
evaluated — the graph shows every job regardless of conditions.

**Sketch:**
- New rules-evaluator module in `packages/server/src/features/` that, given a context
  (`CI_COMMIT_BRANCH`, `CI_PIPELINE_SOURCE`, changed files, variables), walks `workflow.rules`
  then per-job `rules` and resolves each job to run / manual / never.
- Context input: a webview control (branch dropdown sourced from the git extension, pipeline
  source picker, optional changed-files glob).
- Surface result on the graph: dim/hide jobs that wouldn't run; badge manual ones.
- Hard parts: `rules:changes:` needs a file list; `if:` needs a real CI-variable expression
  parser (`$VAR`, `=~`, `&&`, `||`, `null` checks). Start with `if:`/`when:`, defer `changes:`.

## 2. Effective variables view — ✅ shipped

**Status:** Implemented in `packages/webview/src/vars.ts` (`composeJobVariables`, unit-tested
in `packages/webview/test/vars.test.ts`) and surfaced as the "Effective variables" section in
`JobDetailPanel.tsx`. Composes global → default → job → matrix and flags unresolved `$VARS`.

**Goal:** For a selected job, show the merged variable set actually in effect, in precedence
order: global `variables:` → `default:` → job `variables:` → matrix axis values, with `$VAR`
expansion where statically resolvable.

**Why:** `PipelineModel.globalVariables` + `Job.variables` + `Job.matrix` already hold the
pieces (see `packages/shared/src/model.ts`); nothing composes them for display. Hover already
does `$VAR` expansion in script previews (`packages/server/src/features/hover.ts`) — reuse that
expansion logic.

**Sketch:** a "Variables" section in `JobDetailPanel.tsx` (or a dedicated tab) listing each
variable, its resolved value, and its source layer; flag unresolved `$VARS`.
