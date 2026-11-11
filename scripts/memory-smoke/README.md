# Live Memory smoke test

This opt-in DSH plugin exercises the production Capture, analyzer, Publisher, search and Wiki projection against a real configured model. It uses a fresh private `/tmp/dsh-memory-live-*` directory, a synthetic source Session and an actual deterministic Node assertion. Capture and Dreaming create no Agent and receive no tools. A separate ordinary fixture Agent uses the `workspace-write` preset to invoke exactly one Host-selected `node --test schema.test.cjs` through native Bash, without prompting a model. This tests the live execution attestor; it grants no `danger-full-access`, sends no channel messages and never opens the operator's Runtime database. The hard per-run limit is four application model calls; normal success uses two. Failures consume budget too.

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

Run from this checkout using Node 24 and DSH 0.2.2-rc.1 (the live fixture uses its verified batch tool API; production attestation also has offline tests against 0.2.1-alpha.2) (the script imports the production TypeScript sources):

```bash
NODE_OPTIONS=--experimental-transform-types \
DSH_MEMORY_SMOKE_PROVIDER=opencode-go \
DSH_MEMORY_SMOKE_MODEL=deepseek-v4.1-flash \
dsh --profile memory-validation --no-open
```

The plugin prints the private `report.json` path and success flag. Inspect the report and stop that test profile with Ctrl-C after it finishes. It records source-retention checks, candidate/checkpoint replay, disabled/enabled retrieval, original source evidence availability, actual consolidation publication, Wiki/topic secret checks, one controlled fixture Agent, zero analyzer-created Agents, a zero-model verified execution receipt, FTS5, model call counts and provider-reported token usage. It stores only controlled synthetic proposals for diagnostics; provider failure text and credentials are excluded. The test explicitly selects low reasoning, temperature 0 and a 45-second per-call deadline. It does not benchmark real Coding Worker completion, command savings or dollar cost. The 20-case zero-model retrieval comparison is independently reproducible:

```bash
pnpm exec vitest run tests/memory-evaluation.spec.ts
```

Topic proposals are optional model output; the report records their actual count rather than claiming article generation when none was proposed. Publisher/article reconstruction and cross-round duplicate/conflict behavior have deterministic integration tests. A provider can exceed the 45-second deadline, legitimately decline a proposal or propose an invalid merge. The Host rejects unsupported publication; such a smoke run fails and leaves its isolated retryable effect for diagnosis. Never relax evidence, exact-merge or CAS checks to force a successful model result.

The fixture also submits a deliberately unsafe retraction against actual available source checks. The Publisher must keep the verified claim and create a pending review without another model call. Four simultaneous public Memory searches must all find that claim with its review flag, without a busy result. These assertions exercise the current Host gate and FIFO using the real DSH/SQLite environment.

For a model-independent check on the installed DSH, set `DSH_MEMORY_SMOKE_HOST_ONLY=1` alongside the variables above. This uses a zero-call budget, explicitly skips Capture/Dreaming analysis, and runs source replay, native execution attestation, Publisher protection, concurrent retrieval and projection checks. Its report is labeled `host-only`; success must not be reported as real model extraction/consolidation success.
