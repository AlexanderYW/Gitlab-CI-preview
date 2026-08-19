## Validate your pipeline

Two layers of validation:

1. **Local (automatic):** schema validation plus pipeline-graph checks — undeclared stages,
   `needs:` cycles, and `needs:` pointing at a later stage — appear as you type.
2. **Authoritative (on demand):** __GitLab CI: Validate with GitLab CI Lint API__ sends the file
   to your project's `/ci/lint` endpoint and reports the result in the Problems panel.

The CI Lint API needs a token for the host — see the next step.
