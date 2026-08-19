# Changelog

All notable changes to the **GitLab CI Preview** extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-08-19

### Added
- Top-level `default:` keys (image, services, before/after_script, tags, retry, etc.) are now merged into jobs that don't override them, matching GitLab's behaviour.
- Job detail panel surfaces `before_script`, `after_script`, `services`, `artifacts`, and `cache`.
- Service (⚙) and environment (🌐) badges on graph nodes; a **Workflow** stat when `workflow:rules:` are present.
- Spatial keyboard navigation (arrow keys move between jobs by position), Enter to open details, and screen-reader landmarks/announcements.
- Optional **Edge labels** toggle for `needs` / `dependencies` / `extends` edges.
- `gitlabCi.fetchTimeoutSeconds` setting to tune the remote-include fetch timeout.
- **Show Merged Pipeline** command — opens the fully-resolved pipeline (includes/extends/`default:` merged) as one read-only YAML document.
- **Filter jobs** box in the graph header to dim non-matching jobs in large pipelines.
- **Needs (DAG) layout** toggle — lay the graph out by `needs`/`dependencies` via dagre, alongside the stage-column view.
- **Validate with GitLab CI Lint API** command — authoritative server-side validation via the project's `/ci/lint`.
- **Open File in GitLab** command — open the current file on its project/branch in the browser.
- Pipeline-graph diagnostics: undeclared-stage errors, `needs:` cycles, and `needs:` pointing at a later stage.
- GitLab CI Lint results now appear as inline diagnostics in the Problems panel (not just the Output channel).
- **Open child pipeline** action in the job detail panel for `trigger:` jobs with a local `include:`.
- **Export PNG** — save the whole pipeline graph as an image.
- A **Get Started** walkthrough for first-run onboarding.
- Default keybinding `Ctrl+Alt+G` / `Cmd+Alt+G` for *Show Pipeline Graph*.
- Extension icon, license, and keywords for the Marketplace listing.
- Unit tests for the webview layout/sections/reference utilities, the merged-pipeline builder, and the client helpers.

### Changed (UX)
- Clicking a job opens its detail panel instantly (removed the 220 ms double-click debounce).
- The detail panel now says edits are *applied to the buffer* and shows the save shortcut, instead of a misleading green "Saved".

### Changed
- Remote includes now time out (default 10s) instead of hanging indefinitely.
- Failures in reveal/rename/update actions are now surfaced to the user instead of failing silently.
- Development (F5) now prefers live `dist/` bundles, so a leftover `bundled/` can't shadow them.
- Upgraded to React 19 and LSP SDK 10, raised the VS Code engine floor to 1.125, and refreshed dependencies (clearing all outstanding security advisories). The Output channel is now a log channel with levels.

## [0.1.1]

### Added
- Visualize `.gitlab-ci.yml` pipelines as an interactive graph.
- Full `include:` resolution: local, remote, template, project, and component.
- `extends`, `!reference`, matrix/parallel expansion, and `spec.inputs` interpolation.
- LSP features: diagnostics, hover, go-to-definition, completion, code lens, stage rename, and inline job editing.
- Per-host personal access token auth for private includes.
