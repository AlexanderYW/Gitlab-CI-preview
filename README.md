# GitLab CI Preview

A VS Code extension that visualizes `.gitlab-ci.yml` pipelines with full `include:` resolution — local, remote, template, project, and component.

## Features

- **Pipeline graph** — interactive stage/job graph rendered with React Flow + dagre layout. Click a job to inspect/edit it, double-click to jump to its definition. Badges flag manual (▶), allow-failure (⚠), trigger (↗), parallel (×N), matrix (⊞), services (⚙), and environment (🌐) jobs. Toggle **Edge labels** to annotate `needs` / `dependencies` / `extends` edges. A **Workflow** stat shows when `workflow:rules:` gate the pipeline.
- **`default:` inheritance** — top-level `default:` keys (image, services, `before_script`/`after_script`, tags, retry, …) are merged into every job that doesn't override them, matching GitLab's behaviour.
- **Keyboard & screen-reader support** — Tab or arrow keys move focus between jobs, **Enter** opens the focused job's details, **Esc** closes panels. The graph is exposed as a labelled region with per-job announcements.
- **Full include resolution** — recursively resolves every GitLab `include:` kind:
  - `local` — files in the current workspace
  - `remote` — arbitrary HTTPS URLs
  - `template` — GitLab-shipped templates
  - `project` — files from another GitLab project (ref-aware: branch, tag, or pinned SHA)
  - `component` — CI/CD components, including `spec.inputs` interpolation
- **Schema validation & diagnostics** — Ajv-backed validation against the GitLab CI JSON schema, surfaced as editor diagnostics.
- **Hover, go-to-definition, completion, code lens** — standard LSP features over the merged pipeline model (jobs, stages, `extends`, `needs`, `dependencies`).
- **Inline editing** — rename stages or edit job specs from the graph; edits are applied as `TextEdit`s back to the source YAML.
- **Auth-aware HTTP cache** — per-host personal access tokens for private GitLab instances; pinned refs cached longer than branch refs. Prompts on 401.

## Usage

1. Open a `.gitlab-ci.yml` file (or any YAML file whose name matches `gitlab-ci`).
2. Run **GitLab CI: Show Pipeline Graph** from the Command Palette, the editor title bar, the file's context menu, or with `Ctrl+Alt+G` / `Cmd+Alt+G`.

Use the **Filter jobs…** box in the graph header to dim everything except matching jobs — handy for large pipelines. Switch between the **Stages** (column-per-stage) and **Needs** (dependency/DAG) layouts with the toggle in the header.

### Commands

| Command | Description |
| --- | --- |
| `GitLab CI: Show Pipeline Graph` | Open the pipeline graph for the active file (`Ctrl+Alt+G` / `Cmd+Alt+G`). |
| `GitLab CI: Show Merged Pipeline (resolved YAML)` | Open the fully-resolved pipeline — includes/extends/`default:` merged — as one read-only YAML document. |
| `GitLab CI: Validate with GitLab CI Lint API` | Authoritative server-side validation via the project's `/ci/lint` endpoint (needs a token for the host). |
| `GitLab CI: Open File in GitLab` | Open the current file on its GitLab project/branch in the browser. |
| `GitLab CI: Clear Include Cache` | Drop the cached HTTP responses for remote/project/component includes. |
| `GitLab CI: Configure Token for Host…` | Set a personal access token for a given GitLab host. |

### Settings

| Setting | Default | Description |
| --- | --- | --- |
| `gitlabCi.tokens` | `{}` | Per-host GitLab personal access tokens, e.g. `{ "gitlab.com": "glpat-..." }`. |
| `gitlabCi.defaultHost` | `gitlab.com` | GitLab host used for project/component API lookups. |
| `gitlabCi.cacheTtlMinutes` | `15` | Cache TTL in minutes for branch refs. Pinned SHA/tag refs are cached longer. |
| `gitlabCi.fetchTimeoutSeconds` | `10` | Timeout for fetching remote/project/component includes before giving up. |

When the server hits a 401 fetching a private include, the extension prompts for a token and stores it in `gitlabCi.tokens` (global settings).

## Installation

Install from the packaged `.vsix`:

1. Build it: `bun install && bun run package` (produces `gitlab-ci-preview.vsix` at the repo root).
2. In VS Code: **Extensions: Install from VSIX…** → pick `gitlab-ci-preview.vsix`.

## Development

Requires [Bun](https://bun.sh/). The repo is a Bun workspaces monorepo with four packages: `shared`, `server`, `client`, `webview`.

```sh
bun install
bun run build      # build all packages
bun test           # run server tests
bun run package    # produce gitlab-ci-preview.vsix
```

Press `F5` in VS Code to launch an Extension Development Host against the live `dist/` bundles.
