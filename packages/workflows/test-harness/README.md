# `opencode-drawer-workflows` plugin smoke harness

A headless, end-to-end smoke test that proves the **real** workflow tool family
(`workflow`, `workflow_status`, `workflow_stop`, `structured_output`) against a
**real** opencode process — not a mock. It loads the actual plugin entry
(`packages/workflows/src/plugin/index.ts`, registered by absolute `file://` path in
`opencode.json`), exercises the canonical review-workflow shape (pipeline + parallel
+ phase + sub-workflow), stop, and deterministic resume across two independent
opencode processes.

## What it proves

1. **Review workflow (Scenario A).** The model calls `workflow` with an inline
   script that runs `pipeline(['fs.ts','net.ts'], …)` under a `Review` phase, then a
   `parallel` verify stage under a `Verify` phase, then `await workflow('helper', { x: 1 })`
   — a **saved sub-workflow** resolved from `.opencode/workflows/helper.js`. It then
   calls `workflow_status` with `wait_ms=90000` to **block** until the run settles.
   The harness asserts the persisted run record is `completed` and the result carries
   `reviewed fs.ts` / `reviewed net.ts` (pipeline + parallel) and `helper-marker`
   (the sub-workflow's agent output). One scenario covers pipeline, parallel, phase,
   sub-workflow, saved-name resolution, and the `wait_ms` block.
2. **Stop (Scenario B).** The model launches a workflow whose script runs one long
   agent, then calls `workflow_stop` in the **same turn**. The harness asserts the
   run record settles `cancelled`.
3. **Resume (Scenario C).** A **second** `opencode run` boots a fresh engine that
   recovers the prior run from the same `$OPENCODE_DRAWERS_DATA_DIR`, then resumes
   Scenario A's run via `resume_from_run_id`. The harness asserts the resumed run is
   `completed`, `workflow_status` reports **`0 live agent calls`** (fully cached), and
   the plugin's child-task store gained **no new files** — the authoritative
   cross-process "nothing relaunched" signal.

## Single-turn lifecycle and the `wait_ms` affordance

`opencode run` is a single-turn headless process: when the parent turn ends,
opencode shuts the server down and **aborts any still-running child session**. The
`workflow` tool returns immediately by design (the run is detached), and unlike
Claude Code, `opencode run` has **no task-notification** to re-invoke the model when
the run completes. So Scenario A instructs the model to call
`workflow_status { wait_ms: 90000 }`: when the run is live, the status tool awaits
the engine's per-run `settled` promise (raced against the capped timeout), holding
the turn open until the run settles. This is the port's honest equivalent of CC's
re-invocation — the same philosophy as the agents harness's `bg_output(block:true)`.

## Why the child-task store, not opencode's session DB, is the resume probe

The faithful "a cached resume relaunches nothing" probe is the **plugin's own**
child-task store (`$OPENCODE_DRAWERS_DATA_DIR/workflow-tasks/*.json`): every child
agent the workflow launches persists exactly one task file there, isolated to the
harness's temp data dir. A fully-cached resume launches zero children → zero new
files. opencode's global session store (`~/.local/share/opencode/opencode.db`, a
multi-gigabyte SQLite shared across the user's entire history) is neither isolated
nor cheap to diff, so counting it would be noisy and slow. The per-run task store is
the same authoritative cross-process pattern the agents harness uses for its own
tasks. (Deviation from the task brief's "opencode SQLite store" — documented here
because the per-run store is the correct, deterministic signal.)

## Prerequisites

- **opencode** installed. The harness invokes the resolved binary at
  `/Users/fredamaral/.opencode/bin/opencode` by default — **not** the
  `opencode` / `ai-opencode` zsh functions (interactive-shell wrappers that fail in
  scripts). Override with `OPENCODE_BIN=/path/to/opencode`.
- **An authenticated provider.** The harness forces `opencode/claude-haiku-4-5`
  (cheap + reliable at tool-calling) via `run --model`. The local install must have
  a working provider for it (`opencode auth list`). Override with `SMOKE_MODEL`.
- **Bun** (the runner script is Bun).

### Environment gotchas the harness handles for you

1. **`PWD`, not the spawn cwd, drives config discovery.** opencode resolves its
   project/config directory from the `PWD` env var. `spawn({ cwd })` changes the real
   working dir but leaves `PWD` inherited — so the harness pins `PWD = <harness dir>`.
   This also roots **saved-workflow resolution** at the harness dir, so
   `workflow('helper')` finds `.opencode/workflows/helper.js`.
2. **A global agent can override the configured model.** The harness forces the model
   with `run --model` (overrides everything).
3. **`OPENCODE_PURE=1` is deliberately NOT set** — it skips ALL external plugins,
   including this one.
4. **Data dir via `OPENCODE_DRAWERS_DATA_DIR`.** The engine reads this env var for its
   run-record + task store base dir (`engine.ts`). The harness points it at a fresh
   temp dir and observes the persisted JSON files directly.

## Run

```bash
bun run smoke:workflows          # from the repo root
# or:
OPENCODE_BIN=/custom/opencode bun run smoke:workflows
SMOKE_MODEL=opencode/some-model bun run smoke:workflows
```

## Expected output

A passing run prints progress for the three scenarios and ends with:

```
[smoke:workflows] ================ PASS ================
[smoke:workflows] A: review workflow (pipeline+parallel+phase+sub-workflow) ✓
[smoke:workflows] B: workflow_stop → cancelled                              ✓
[smoke:workflows] C: resume all-cached, no child relaunch (new process)     ✓
[smoke:workflows] ======================================
```

Exit code `0` on PASS, nonzero with a `FAIL` block + diagnostics otherwise.

## Files

| File | Role |
|------|------|
| `opencode.json` | Minimal config: pins the model + registers the REAL plugin entry by absolute `file://` path. |
| `run-smoke.ts` | Bun orchestrator: temp data dir, `opencode run` invocations per scenario, run-record/task-file poll + stdout assertions. |
| `.opencode/workflows/helper.js` | A one-agent saved sub-workflow returning `helper-marker`, resolved by name in Scenario A. |

These are **not** unit tests (no `*.test.ts`), so `bun test` ignores them.
