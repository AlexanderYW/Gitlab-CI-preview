## Connect a private GitLab instance

Private `project:` / `component:` includes and the CI Lint API require a personal access token
(scopes: `read_api`, `read_repository`).

- Run __GitLab CI: Configure Token for Host…__ and paste a PAT, or
- The extension prompts automatically the first time a private include returns `401`.

Tokens are stored per-host in the `gitlabCi.tokens` setting. The host is auto-detected from your
git remote (and from the GitLab Workflow extension if installed).
