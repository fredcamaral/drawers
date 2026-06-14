# `opencode-drawer-agents` plugin smoke harness

A headless, end-to-end smoke test that proves the **real** `bg_*` tool family
against a **real** opencode process — not a mock. It loads the actual plugin
entry (`packages/background-agents/src/index.ts`, registered by absolute
`file://` path in `opencode.json`), exercises launch / blocking output / context
forking, and proves restart recovery across two independent opencode processes.

## What it proves

1. **Launch + blocking output (Scenario A).** The model calls `bg_task`, then
   `bg_output(block:true)` in the same turn. The blocking output holds the parent
   turn open (the engine's `awaitCompletion`) so the single-turn `opencode run`
   process doesn't shut down and abort the child before it completes. The child
   reaches `completed` and its output contains the expected token (`alpha`).
2. **Context forking (Scenario B).** One run: the parent prompt states a fact (a
   release codename "zanzibar"), then calls `bg_task(fork:true)` asking the child
   to write a release note that must include it, then `bg_output(block:true)`. At
   fork time the parent transcript already contains the user message with the
   codename — that's what the fork injects as synthetic context. The child output
   contains the codename, proving the fork wiring (`fetchSessionMessages` →
   `buildForkTranscript` → `LaunchRequest.contextParts` → prepended before the
   task prompt) works live. (Benign engineering framing on purpose: a "secret
   word → state it back" framing reads as a jailbreak to the model and gets
   refused; the fork mechanism under test is identical either way.)
3. **Restart recovery (Scenario C).** A second `opencode run` boots a fresh
   engine that loads `recoveredTasks` from the same `$OPENCODE_DRAWERS_DATA_DIR`
   store, then `bg_list` + `bg_output` on a recovered task. The persisted task is
   still terminal and readable in the new process.

## Single-turn lifecycle

`opencode run` is a single-turn headless process: when the parent turn ends,
opencode shuts the server down and **aborts any still-running child session**.
Scenarios A and B work around this by instructing the model to call
`bg_output(block:true)` in the same turn — the blocking output awaits child
completion in-process, holding the turn open. (This replaces the core harness's
`smoke_launch`-internal `awaitCompletion` trick, since the plugin's launch tool
returns immediately and the blocking happens at the `bg_output` layer.)

## Prerequisites

- **opencode 1.16.2** installed. The harness invokes the resolved binary at
  `/Users/fredamaral/.opencode/bin/opencode` by default — **not** the
  `opencode` / `ai-opencode` zsh functions (interactive-shell wrappers that fail
  in scripts). Override with `OPENCODE_BIN=/path/to/opencode`.
- **An authenticated provider.** The harness forces `opencode/claude-haiku-4-5`
  (cheap + reliable at tool-calling) via `run --model`. The local install must
  have a working provider for it (`opencode auth list`). Override with
  `SMOKE_MODEL`.
- **Bun** (the runner script is Bun).

### Environment gotchas the harness handles for you

1. **`PWD`, not the spawn cwd, drives config discovery.** opencode resolves its
   project/config directory from the `PWD` env var. `spawn({ cwd })` changes the
   real working dir but leaves `PWD` inherited — so if launched from the repo
   root, opencode looks for config there, never finds this `opencode.json`, and
   the plugin's tools are never registered. The harness pins
   `PWD = <harness dir>`.
2. **A global agent can override the configured model.** The harness pins a model
   in `opencode.json`, but a global `build`-agent config can silently win. The
   harness forces the model with `run --model` (overrides everything).
3. **`OPENCODE_PURE=1` is deliberately NOT set** — it skips ALL external plugins,
   including this one. The user's global observer plugins load alongside but are
   harmless.
4. **Data dir via `OPENCODE_DRAWERS_DATA_DIR`.** The engine reads this env var
   for its `TaskStore` base dir (`engine.ts`). The harness points it at a fresh
   temp dir and observes the persisted task JSON files directly — the
   authoritative cross-process signal.

## Run

```bash
bun run smoke:agents          # from the repo root
# or:
OPENCODE_BIN=/custom/opencode bun run smoke:agents
SMOKE_MODEL=opencode/some-model bun run smoke:agents
```

## Expected output

A passing run prints progress for the three scenarios and ends with:

```
[smoke:agents] ================ PASS ================
[smoke:agents] A: launch + bg_output(block) → 'alpha'        ✓
[smoke:agents] B: fork injects parent secret → 'zanzibar'    ✓
[smoke:agents] C: restart recovery readable in new process   ✓
[smoke:agents] ======================================
```

Exit code `0` on PASS, nonzero with a `FAIL` block + diagnostics otherwise.

## Files

| File | Role |
|------|------|
| `opencode.json` | Minimal config: pins the model + registers the REAL plugin entry by absolute `file://` path. |
| `run-smoke.ts` | Bun orchestrator: temp data dir, `opencode run` invocations per scenario, file-poll + stdout assertions. |

These are **not** unit tests (no `*.test.ts`), so `bun test` ignores them.
