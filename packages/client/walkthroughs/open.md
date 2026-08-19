## Open a pipeline file

GitLab CI Preview activates on any YAML file whose name matches `gitlab-ci`, including:

- `.gitlab-ci.yml`
- `*.gitlab-ci.yml`
- files under `.gitlab/ci/`

Once open, you get inline schema diagnostics, hover, go-to-definition, and completion over the
fully-resolved pipeline — with all `include:` (local / remote / template / project / component),
`extends`, and top-level `default:` merged in.
