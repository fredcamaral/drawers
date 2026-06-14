# Core engine smoke harness

A headless, end-to-end smoke test that proves `@drawers/core`'s `SessionRunner`
against a **real** opencode process — not a mock. It launches a background task
through a plugin tool, watches the engine drive it to completion off the live
event stream, persists it, and then proves restart recovery by reading it back
from a second, independent opencode process.

## What it proves

1. **Launch path** — `runner.launch()` calls real `session.create` +
   `promptAsync`, returning a `running` task with a child `sessionID`.
2. **Completion gate off the live event stream** — the `event` hook forwards
   `session.idle` / `session.error` to `runner.handleEvent`; the gate validates
   output and flips the task to `completed`.
3. **Atomic persistence** — the task is written to `$SMOKE_DATA_DIR/<id>.json`
   by `createTaskStore`, observed cross-process by reading the file directly.
4. **Restart recovery + store load** — a second `opencode run` boots a fresh
   engine, loads `recoveredTasks` from the same store, and reads the terminal
   task via `smoke_status`. The persisted task is still terminal and readable.
5. **`EngineClient` ↔ real SDK** — the plugin adapts the live
   `createOpencodeClient()` result to the engine's structural `EngineClient`;
   if the SDK's `{ data }` shape diverged from the audit, the adapter breaks.

## Prerequisites

- **opencode 1.16.2** installed. The harness invokes the resolved binary at
  `/Users/fredamaral/.opencode/bin/opencode` by default — **not** the
  `opencode` / `ai-opencode` zsh functions, which only work in an interactive
  shell. Override with `OPENCODE_BIN=/path/to/opencode`.
- **An authenticated provider.** The harness pins `opencode/gemini-3-flash`
  (cheap + fast) in `opencode.json`; the local install must have a working
  provider for that model (`opencode auth list`). Override the model by editing
  `opencode.json`, or the agent via `SMOKE_AGENT` (default `build`).
- **Bun** (the runner script is Bun).

### Two environment gotchas the harness handles for you

Both were found the hard way while bringing this up against a real install:

1. **`PWD`, not the spawn cwd, drives config discovery.** opencode resolves its
   project/config directory from the `PWD` env var. `spawn({ cwd })` changes the
   real working directory but leaves `PWD` inherited from the parent — so if you
   launch the harness from the repo root, opencode looks for config there, never
   finds this `opencode.json`, and the plugin's tools are never registered (the
   model then says "smoke_launch is not available"). The harness pins
   `PWD = <harness dir>` in the spawn env.
2. **A global agent can override the configured model.** The harness pins a
   model in `opencode.json`, but a user's global `build`-agent config can pin its
   own model that silently wins — and that model+agent combo refused to call the
   custom tool. The harness forces the model with `run --model` (overrides
   everything). Change it via `SMOKE_MODEL`.

`OPENCODE_PURE=1` is deliberately **not** set: it skips ALL external plugins,
including this one. The user's global observer plugins load alongside the smoke
plugin but are harmless.

## Run

```bash
bun run smoke          # from the repo root
# or:
OPENCODE_BIN=/custom/opencode bun run smoke
```

## Expected output

A passing run prints progress for three phases and ends with:

```
[smoke] ================ PASS ================
[smoke] launched + completed task : bg_xxxxxxxx
[smoke] child sessionID           : ses_...
[smoke] survived simulated restart: status='completed'
[smoke] status read in new process: id echoed by recovered engine ✓
[smoke] ======================================
```

Exit code `0` on PASS, nonzero with a `FAIL` block + diagnostics otherwise.

## Files

| File | Role |
|------|------|
| `opencode.json` | Minimal config: pins the model + registers the plugin by absolute `file://` path. |
| `plugin/smoke-plugin.ts` | The plugin: wires the real engine, the `event` hook, and the `smoke_launch` / `smoke_status` tools. |
| `run-smoke.ts` | Bun orchestrator: temp data dir, two `opencode run` invocations, file-poll assertions. |

These are **not** unit tests (no `*.test.ts`), so `bun test` ignores them.
