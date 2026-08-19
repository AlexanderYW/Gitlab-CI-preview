# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Run from this directory (`packages/server`) or the repo root.

```sh
# Build (CJS, Node target)
bun run build

# Watch-build during development
bun run dev

# Type-check only
bun run typecheck

# Run all server tests
bun test packages/server/test

# Run a single test file
bun test packages/server/test/resolve.test.ts

# Run tests matching a name pattern
bun test -t "cycle"
```

## stdout is sacred

`server.ts` redirects `console.log` and `console.error` to `connection.console` at startup. Any bare `console.*` call or stray write to stdout **corrupts the JSON-RPC stream**. Use `connection.console.log/error` for diagnostics in code that has access to `connection`, or throw and let the uncaught-exception handler surface it.

## Data flow

```
TextDocument change
  → scheduleResolve (250 ms debounce per URI)
    → resolvePipeline (resolve.ts)
        → parseYaml / buildBaseModel (parser.ts)   [per file]
        → resolveInclude (includes/index.ts)        [per include, recursive]
            local  → fs.readFile (or open doc)
            remote / template → httpGet (includes/http.ts)
            project  → workspace-first, then GitLab API
            component → GitLab API (templates/<name>/template.yml)
        → applyInputs (includes/inputs.ts)           [if spec.inputs present]
        → applyExtends                               [post-walk, in resolve.ts]
        → needs-validation
      → PipelineModel stored in modelCache
      → publishDiagnostics (features/diagnostics.ts)
      → PIPELINE_UPDATED_NOTIFICATION sent to client
```

## Key invariants

- **Root-wins merge**: `walk()` in `resolve.ts` processes the root file first. Jobs and global variables set by the root are never overwritten by included files (`!jobsByName.has(name)` / `!(k in globalVariables)`). This mirrors real GitLab behaviour.
- **Cycle detection**: `visited` (Set) prevents re-walking the same URI across the whole tree; `chain` (array) carries the current path for error messages.
- **`extends` is post-walk**: all files are parsed first, then `applyExtends` in `resolve.ts` runs a single memoised DFS. It only shallow-merges `raw` maps and re-derives the typed `Job` fields listed in `extractJob` (stage, image, script, when, allow_failure, rules, tags).
- **HTTP cache**: `includes/http.ts` keeps an in-memory LRU (max 200 entries). Pinned refs (SHA / semver tags) get 24-hour TTL; branch refs use `cacheTtlMinutes` from settings. `clearHttpCache()` is called on the `gitlabCi/clearCache` request.
- **Auth flow**: on 401/403, `httpGet` retries with `PRIVATE-TOKEN` if a token is configured for the host, otherwise fires `notifyNeedsAuth` (once per host per session) which sends the `NEEDS_AUTH_NOTIFICATION` (`gitlabCi/needsAuth`) to the client. The cache-clear request uses `CLEAR_CACHE_REQUEST` (`gitlabCi/clearCache`). Both constants live in `shared/messages.ts` — never inline the raw strings.

## Adding a new LSP feature

1. Create `src/features/<name>.ts` exporting a function that takes `(model: PipelineModel, ...)`.
2. Register it in `server.ts` on the appropriate `connection.on*` hook.
3. Use `modelCache.get(p.textDocument.uri)` to retrieve the cached model — features are read-only; they never trigger re-resolution.

## Adding a new include kind

1. Add a case to the `IncludeRef['kind']` union in `shared/src/model.ts`.
2. Add a resolver function in `includes/index.ts` and wire it into `resolveInclude`'s switch.
3. Update `extractIncludes` in `parser.ts` to recognise the new YAML shape.

## Test conventions

Tests in `test/` use `bun:test`. `resolve.test.ts` writes temp files via `fs.mkdtemp` / `fs.writeFile` and converts paths to `file://` URIs with `vscode-uri`. There is no global test setup — each test is self-contained. Network calls are not mocked; tests that would require network hits are skipped or use local fixtures only.
