# Drawers — Monorepo Overview

## What is this

**Drawers** is a Bun-workspace monorepo of independently installable plugins for two AI coding-agent harnesses: [opencode](https://opencode.ai) and [pi](https://pi.dev). The ten packages are organized under `packages/opencode/` and `packages/pi/`, each published and installed on its own. Every plugin family is mirrored across both harnesses — the same four capabilities (background agents, orchestration workflows, session cadence, TUI status line) exist for opencode and for pi, built on a per-harness private core engine package. Users install only the plugins they want; the monorepo is the development container, not the distribution unit.

---

## Plugin Families

### 1 · Background Agents (`*-drawer-agents`)

Fire-and-forget child sessions. The parent calls `bg_task` and gets a task ID back immediately; a child agent runs independently in its own session. The parent retrieves output later with `bg_output`, or gets an automatic notification (idle-wake, TUI toast, or next-message flush) when the task finishes. State is persisted atomically to disk and survives restarts.

| Tool | What it does |
|---|---|
| `bg_task` | Launch a new task, or resume a terminal one by id |
| `bg_output` | Read a finished task's result/transcript; supports blocking wait |
| `bg_cancel` | Cancel one task or all tasks owned by this session |
| `bg_list` | List tasks scoped to the current session with status and runtime |

### 2 · Workflows (`*-drawer-workflows`)

Deterministic multi-agent orchestration. Authors write plain-JS scripts using `agent()`, `pipeline()`, `parallel()`, `shell()`, and `workflow()` globals. The runtime fans out child sessions concurrently, journals every settled call (SHA-256 keyed for position-independent replay), and resumes crash-safe from the last journal entry. Supports schema-validated structured output (AJV), per-agent git worktree isolation for parallel writers, contextDiff/verifyDiff post-conditions, and named saved workflows. Runs detached — the parent session is never blocked. The opencode variant includes a native TUI viewer (`ctrl+o` / `/workflows`); the pi variant exposes a `workflow_skills` tool for listing installable skill bindings.

| Tool | What it does |
|---|---|
| `workflow` | Launch a run from inline script, file path, or saved name; returns run_id |
| `workflow_status` | Inspect live progress or final result; `wait_ms` for headless blocking |
| `workflow_stop` | Abort a live run and all its in-flight child agents |
| `workflow_save_run` | Persist a run's script as a reusable named workflow |
| `structured_output` | Child-facing: echo a schema-validated JSON value back to the parent |

### 3 · Cadence (`*-drawer-cadence`)

Session-level re-prompt orchestration. Two independent mechanisms share one engine: `loop` fires on a repeating interval (minimum 1 s), and `goal` fires on every session-idle/`agent_end` event. Both halt when the model emits `GOAL_COMPLETE` on its own line, or when a `max_iterations` cap is hit. Directives are persisted atomically (tmp→rename) so active loops survive plugin reloads. The engine uses an `inFlight` Set to prevent re-entrant ticks and a `disposed` flag to block any mutation after teardown.

| Tool | What it does |
|---|---|
| `loop` | Arm an interval-driven re-prompt with optional `until` predicate |
| `goal` | Arm an idle-driven completion gate |
| `cadence_stop` | Halt one directive by id, or all active directives for this session |
| `cadence_list` | List active directives with iteration progress |

### 4 · Statusline (`*-drawer-statusline`)

Zero-configuration TUI footer widget. Renders a pipe-delimited, muted status line showing: current directory, git worktree root (when different from the directory), VCS branch, session state (idle/working), and harness version. Refreshes on lifecycle events (session start, agent start/end). No local state beyond cached git facts between turns.

---

## Opencode vs Pi Mirroring

The same four plugin families exist for both harnesses, but the host integration surfaces are different enough that each harness gets its own implementation.

```
packages/
  opencode/
    core/               → @drawers/core        (private, opencode SDK adapter)
    background-agents/  → opencode-drawer-agents
    workflows/          → opencode-drawer-workflows
    cadence/            → opencode-drawer-cadence
    statusline/         → opencode-drawer-statusline
  pi/
    core/               → @drawers/pi-core     (private, pi RPC adapter)
    background-agents/  → pi-drawer-agents
    workflows/          → pi-drawer-workflows
    cadence/            → pi-drawer-cadence
    statusline/         → pi-drawer-statusline
```

**`@drawers/core`** (opencode) wraps the opencode SDK's resolve-on-error envelope style with a single `adaptSdkClient` choke point that restores throw semantics, then builds the session runner, concurrency manager, task store, and notification queue on top. All opencode plugins import from this package rather than touching the SDK directly.

**`@drawers/pi-core`** (pi) does the equivalent for pi's `--mode rpc` child processes: it wraps the `RpcClient` from `@earendil-works/pi-coding-agent` behind a `createRpcClientFactory` DI seam and implements a `CompletionFuser` — a synchronous-flip exactly-once terminal-state machine that fuses `agent_end` events, process exit, and a prompt watchdog (pi can silently swallow a `success:false` preflight). The higher-level pi plugins program against the same `SessionRunner` interface as their opencode counterparts.

**Why two cores instead of one?** The harnesses have structurally different client contracts — opencode uses an async SDK with resolve-on-error envelopes; pi uses RPC child processes with event streams and an explicit process-death signal. The shared _shape_ (SessionRunner, ConcurrencyManager, TaskStore, NotificationQueue) is consistent across both cores; the harness-specific adapter is the only divergence.

---

## Tech Stack & Dev Workflow

| Concern | Tool |
|---|---|
| Runtime & package manager | Bun (workspaces: `packages/*/*`) |
| Language | TypeScript 6 |
| Lint / format | Biome (`bun run lint`) |
| Type checking | `tsc --noEmit` per package (`bun run typecheck`) |
| Unit tests | Bun test runner (`bun test`) |
| End-to-end smoke | Per-package harnesses (`bun run smoke`, `smoke:agents`, `smoke:pi-*`) |
| Build | `bun run scripts/build.ts` |
| Releases | semantic-release with changelog + git tags (`release:prepare` → `release:publish`) |
| TUI components (opencode) | Solid.js + `@opentui/solid` — **must be `.tsx` files** to hit the host's Solid transform and avoid a second Solid instance |
| Schema validation (workflows) | AJV |
| Script AST parsing (workflows) | acorn (reads `export const meta` without eval) |

All packages use strict factory-DI: every subsystem is a factory function receiving injected collaborators (client, clock, fs, logger, timers). There are no singletons — all state lives in closure. This makes unit tests straightforward: inject fakes for the RPC/SDK client, file system, and clock.

---

## Where to Start Reading

| Goal | File |
|---|---|
| Understand the opencode engine contract | `packages/opencode/core/src/types.ts` — `BgTask`, `SessionRunner`, `LaunchRequest`, `TaskStatus` |
| Understand the pi engine contract | `packages/pi/core/src/types.ts` — same shape, pi-adapted |
| How a background task is launched | `packages/opencode/core/src/session-runner.ts` (8-step launch protocol, ~600 LOC) |
| How pi child processes complete | `packages/pi/core/src/completion.ts` — `CompletionFuser` exactly-once state machine (487 LOC) |
| Workflow orchestration engine (opencode) | `packages/opencode/workflows/src/plugin/engine.ts` (~2065 LOC) |
| Workflow orchestration engine (pi) | `packages/pi/workflows/src/plugin/engine.ts` (~1867 LOC) |
| How agent() works inside a workflow script | `packages/pi/workflows/src/runtime/agent-call.ts` — concurrency, journal replay, worktree, verifyDiff (1391 LOC) |
| How resume/replay works | `packages/opencode/workflows/src/plugin/journal.ts` — append-only JSONL, sha256 cache key (138 LOC) |
| Cadence loop/goal engine | `packages/opencode/cadence/src/engine.ts` (510 LOC) or its pi mirror at `packages/pi/cadence/src/engine.ts` (~370 LOC) |
| Statusline (full implementation) | `packages/pi/statusline/src/index.ts` (~82 LOC) — smallest package, good onboarding read |
| Opencode TUI dual-export pattern | `packages/opencode/statusline/src/tui/index.tsx` — explains the `.tsx`-is-load-bearing rule |
