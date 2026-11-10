# Live Memory smoke test

This opt-in DSH plugin exercises the production Capture, analyzer, Publisher, search and Wiki projection against a real configured model. It uses a fresh private `/tmp/dsh-memory-live-*` directory, a synthetic source Session and an actual deterministic Node assertion. It creates no Agent, grants no tools, sends no channel messages and never opens the operator's Runtime database. The hard per-run limit is four application model calls; normal success uses two. Failures consume budget too.

Install dependencies first, then create a **separate web profile** with the same supported provider configuration as your normal DSH profile. Keep credentials in the DSH credentials service. Do not copy API keys into this repository.

```bash
pnpm install --frozen-lockfile
dsh plugin --profile memory-validation add "link:$PWD/scripts/memory-smoke"
```

The profile's `package.json` must list `@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-web-app` in `dsh.profile.bundles`. Add the following entries to that profile's `cordis.patch.yml`, alongside the chosen provider configuration:

```yaml
- id: webserver
  config:
    host: 127.0.0.1
    port: 0
- insert:
    - id: memory-smoke
      name: dsh-superagent-memory-smoke
```

Run from this checkout using Node 24 (the script imports the production TypeScript sources):

```bash
NODE_OPTIONS=--experimental-transform-types \
DSH_MEMORY_SMOKE_PROVIDER=opencode-go \
DSH_MEMORY_SMOKE_MODEL=deepseek-v4.1-flash \
dsh --profile memory-validation --no-open
```

The plugin prints the private `report.json` path and success flag. Inspect the report and stop that test profile with Ctrl-C after it finishes. It records source-retention checks, candidate/checkpoint replay, disabled/enabled retrieval, actual consolidation publication, Wiki secret checks, zero new Agents, FTS5, model call counts and provider-reported token usage. It stores only controlled synthetic proposals for diagnostics; provider failure text and credentials are excluded. The test explicitly selects low reasoning, temperature 0 and a 15-second per-call deadline. It does not benchmark real Coding Worker completion, command savings or dollar cost. The 20-case zero-model retrieval comparison is independently reproducible:

```bash
pnpm exec vitest run tests/memory-evaluation.spec.ts
```

A provider can legitimately decline a proposal or propose an invalid merge. The Host rejects unsupported publication; such a smoke run fails and leaves its isolated retryable effect for diagnosis. Never relax evidence, exact-merge or CAS checks to force a successful model result.
