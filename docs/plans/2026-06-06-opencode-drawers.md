# opencode-drawers Implementation Plan

> **For implementers:** Use ring:executing-plans (rolling wave: implement the
> detailed phase → user checkpoint → detail the next phase → implement → repeat),
> or ring:dev-cycle for the full subagent-orchestrated workflow.
> This document is the living source of truth — task elaboration for later
> phases is written back into it during execution.

**Goal:** A monorepo of focused OpenCode plugins delivering Claude Code-style background agents (Layer 1) and a deterministic, resumable workflow orchestration engine per `WORKFLOWS_HL_SPEC.md` (Layer 2).

**Architecture:** Bun-workspaces monorepo. `@drawers/core` is a shared library owning the background-session engine (launch via `session.create` + `promptAsync`, event-primary completion behind a synchronous mutex, key-based concurrency, atomic metadata persistence). Two thin, independently publishable plugins sit on top: `opencode-drawer-agents` (bg_* tool surface) and `opencode-drawer-workflows` (sandboxed script runtime that awaits agents in-process — eliminating the parent-wake prompt-injection machinery that sinks prior art). Factory dependency injection throughout for testability.

**Tech Stack:** TypeScript, Bun (runtime/test/build), `@opencode-ai/plugin` + `@opencode-ai/sdk` (typed surface only), Zod (tool args via `tool.schema.*`), Biome.

**Prior art (analysis record: `docs/plans/001-implementation-plan.md`):** clean-room from `.references/better-opencode-async-agents` (architectural spine) and `.references/oh-my-opencode` (ConcurrencyManager design, factory-DI, completion mutex — SUL-1.0 licensed, no verbatim copying). `.references/opencode` is API ground truth.

## Phase Overview

| Phase | Milestone | Epics | Status |
|-------|-----------|-------|--------|
| 1 | Core engine launches, completes, cancels and persists background sessions against a real headless opencode; full unit + race coverage | 1.1, 1.2, 1.3, 1.4, 1.5 | Detailed |
| 2 | `opencode-drawer-agents` plugin installable locally: `bg_task`/`bg_output`/`bg_cancel`/`bg_list` work e2e with passive notifications and restart survival | 2.1, 2.2, 2.3 | Epic-level |
| 3 | Workflow runtime executes spec-conformant scripts (`agent`/`pipeline`/`parallel`/`phase`/`log`/`args`) with caps, against the Phase 1 engine | 3.1, 3.2, 3.3 | Epic-level |
| 4 | `opencode-drawer-workflows` plugin: journal-backed deterministic resume, budget, sub-workflows, structured output; canonical review workflow runs e2e | 4.1, 4.2, 4.3 | Epic-level |
| 5 | Both plugins published to npm and installable in a clean project via `"plugin": [...]` | 5.1 | Epic-level |

## Design decisions (binding across phases)

1. **No active parent-wake.** Completion notices are delivered passively (flushed into the parent's next user message via the `chat.message` hook) plus a TUI toast. The workflow runner never needs a wake: it awaits its own in-process promises. Rationale: OpenCode does not serialize concurrent session prompts; oh-my-opencode's active wake costs ~24 files of crash-mitigation (`.references/oh-my-opencode/src/features/background-agent/parent-wake-*.ts`).
2. **Event-primary completion, poll as safety net.** `session.idle` gated by min-idle grace + output validation; sparse (≥5s) re-entrancy-guarded poll only as fallback; `client.session.status()` treated as best-effort.
3. **Typed SDK surface only.** No `as any` calls (better-async relies on untyped `tui.showToast` / `session.fork` — brittle). Anything untyped is treated as unavailable.
4. **The child session IS the durable task.** Persist metadata only — but ALL fields needed for notify/resume after restart (better-async drops parent context and breaks resume: `.references/better-opencode-async-agents/src/manager/index.ts:325-339`).
5. **Narrow version pin.** Support the `@opencode-ai/plugin` version captured at scaffold time; refuse cross-version event-normalization complexity.
6. **Naming defaults** (zero cost to change before first publish): npm `opencode-drawer-agents` / `opencode-drawer-workflows`; tool prefix `bg_` / `workflow`. License MIT.

---

## Phase 1 — Core Engine

**Milestone:** `@drawers/core` library with full unit + race tests; a smoke plugin wired to the engine launches a background session in headless opencode, detects completion, persists, and recovers after restart.

### Epic 1.1: Workspace scaffold and API ground truth

**Goal:** Monorepo builds, tests, lints; the plugin API references are regenerated from the installed SDK and the typed surface we depend on is verified and recorded.
**Scope:** repo root, `packages/core/` skeleton, `.claude/skills/opencode-plugin-dev/` refs
**Dependencies:** none
**Done when:** `bun test` and `bun run typecheck` pass at the root; `references/hooks.md`/`events.md` regenerated; SDK pin and typed-surface audit committed.

#### Task 1.1.1: Scaffold the Bun workspaces monorepo

- [x] Done

**Context:** Repo is empty except `docs/`, `.claude/`, `WORKFLOWS_HL_SPEC.md`, `.gitignore` (already ignores `.references/`, `node_modules/`, `dist/`). Layout decided in the architecture: `packages/core`, later `packages/background-agents`, `packages/workflows`.

**Implementation vision:** Root `package.json` with `"workspaces": ["packages/*"]`, `private: true`, scripts `test` (`bun test`), `typecheck` (`tsc -b` or `bunx tsc --noEmit` per package), `lint` (`biome check`). `tsconfig.base.json`: `strict: true`, `module: "Preserve"`, `moduleResolution: "bundler"`, `types: ["bun-types"]`. `packages/core/package.json` named `@drawers/core`, `"type": "module"`, dependencies `@opencode-ai/plugin` and `@opencode-ai/sdk` at the current latest, exact-pinned (decision 5). Biome config at root: recommended rules, no custom ceremony. A placeholder `packages/core/src/index.ts` exporting nothing plus one trivial test file so the toolchain is provable. No CI in this task — local commands only.

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `biome.json`
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/index.ts`
- Test: `packages/core/src/index.test.ts`

**Verification:** `bun install && bun test && bun run typecheck && bun run lint` — all green.

**Done when:** all four commands pass from the repo root on a clean checkout.

#### Task 1.1.2: Regenerate API refs and audit the typed SDK surface

- [x] Done — all 13 surfaces typed ✅ (see `docs/sdk-surface-audit.md`). Notables: `session.status` IS typed but only reports `idle|retry|busy` (not a completion oracle — pair with output validation per decision 2); `AssistantMessage.tokens` exposes input/output/reasoning/cache + cost (Epic 4.3 budget spike unblocked); per-prompt `tools: {[name]: boolean}` recursion guard fully typed.

**Context:** The local skill mandates a gate: regenerate `references/hooks.md` and `references/events.md` from the installed SDK before any hook code (`.claude/skills/opencode-plugin-dev/SKILL.md:61-72`, script at `.claude/skills/opencode-plugin-dev/scripts/extract-plugin-api.ts`). The engine design assumes specific SDK capabilities; each must be confirmed typed or the design adjusts NOW, not in Phase 2.

**Implementation vision:** Run the extract script against `packages/core`'s installed `@opencode-ai/plugin`. Then audit and record, in a short doc, the typed status of every surface the engine needs: `client.session.create` (with `parentID`), `client.session.promptAsync` (incl. `noReply` and per-prompt `tools` overrides), `client.session.messages`, `client.session.abort`, `client.session.get`, `client.event.subscribe`, `client.tui.showToast` (or typed equivalent), `client.app.log`, the `session.idle` / `session.created` / `session.error` event payloads (note: `parentID` lives at `session.created` → `event.properties.info.parentID`; `isSubagent` on idle is undefined — `SKILL.md:292`). For each: typed ✅ / untyped ❌ / absent. Any ❌ on a load-bearing call triggers a design note in this plan (decision 3 forbids using it). Record the resolved SDK version pin.

**Files:**
- Modify: `.claude/skills/opencode-plugin-dev/references/hooks.md` (regenerated)
- Modify: `.claude/skills/opencode-plugin-dev/references/events.md` (regenerated)
- Create: `docs/sdk-surface-audit.md`

**Verification:** `bun run .claude/skills/opencode-plugin-dev/scripts/extract-plugin-api.ts` exits 0; audit doc lists every surface above with a verdict and the pinned version.

**Done when:** refs are regenerated from the pinned SDK and no load-bearing engine call sits on an untyped surface without a recorded fallback decision.

### Epic 1.2: Concurrency manager

**Goal:** A self-contained, fully tested concurrency primitive with model > provider > default limit resolution.
**Scope:** `packages/core/src/concurrency.ts`
**Dependencies:** Epic 1.1
**Done when:** unit tests cover limit resolution, queueing, slot handoff, waiter cancellation, and double-resolution races.

#### Task 1.2.1: Implement ConcurrencyManager (clean-room)

- [x] Done — deviation: `acquire()` returns `AcquireResult` (= `Promise<{id}>` with a synchronous readonly `id` property) so callers can cancel a still-queued waiter; superset of the planned contract. `limitFor()` surfaces `0` as the unlimited sentinel.

**Context:** Design source: `.references/oh-my-opencode/src/features/background-agent/concurrency.ts` (175 lines; SUL-1.0 — reimplement the design, do not copy text). Key behaviors verified in analysis: limit resolution `modelConcurrency[model]` > `providerConcurrency[provider]` > `defaultConcurrency` > 5, with `0` meaning unlimited (`:25-40`); concurrency *key* follows where the config knob lives — full model string if a model limit is set, else provider, else model (`:42-53`); provider = `model.split('/')[0]`.

**Implementation vision:** Public API: `acquire(model): Promise<void>`, `release(model): void`, `cancelWaiter(model, id)`, `cancelWaiters(model)`, `clear()`, constructed with `{ defaultConcurrency?, providerConcurrency?, modelConcurrency? }`. Two decisions carried over because they prevent real races: (a) **slot handoff on release** — hand the freed slot directly to the next non-settled FIFO waiter without decrementing the count, avoiding thundering-herd reacquire; (b) **settled flag per queue entry** — a `release` resolving a waiter and a `cancelWaiters` rejecting it must not both fire; first settle wins. Acquire fast-path is synchronous when under limit. In-memory only — no persistence (tasks die with the process; restart recovery is the persistence layer's job, Epic 1.4). Edge cases to test by name: zero-limit (unlimited) never queues; cancel of an already-resolved waiter is a no-op; release with empty queue decrements; release with only-settled waiters decrements (no handoff to a corpse); interleaved acquire/cancel/release sequence preserves FIFO order among survivors.

**Files:**
- Create: `packages/core/src/concurrency.ts`
- Test: `packages/core/src/concurrency.test.ts`

**Verification:** `bun test packages/core/src/concurrency.test.ts` — all named edge cases green.

**Done when:** API above is implemented with every named edge case under test and no `setTimeout`-based sleeps in tests (use explicit promise sequencing).

### Epic 1.3: Session runner and completion engine

**Goal:** Launch, track, complete, cancel, and resume background child sessions with race-safe completion.
**Scope:** `packages/core/src/` (runner, completion, types, ids)
**Dependencies:** Epics 1.1, 1.2
**Done when:** unit tests (mocked client) prove single-winner completion across event/poll/cancel/timeout interleavings.

#### Task 1.3.1: Core types, IDs, and the engine's public contract

- [x] Done — `handleEvent` typed against the SDK's `Event` discriminated union (32 members) instead of `unknown`; `notified?: boolean` added to `BgTask` for Epic 1.4; `TERMINAL_STATUSES`/`isTerminal` helpers exported.

**Context:** Greenfield. The contract below is load-bearing: Epics 1.4/1.5 and both Phase 2/3 consumers program against it (snippet justified as a cross-epic contract).

**Implementation vision:** Define in `types.ts` / `ids.ts`:

```ts
type TaskStatus = "pending" | "running" | "completed" | "error" | "cancelled"

interface BgTask {
  id: string            // "bg_" + 8-char suffix, collision-checked
  sessionID?: string    // set once the child session exists
  parentSessionID: string
  description: string
  agent: string
  status: TaskStatus
  createdAt: number; startedAt?: number; completedAt?: number
  error?: string
  depth: number         // recursion guard
  concurrencyKey: string
}

interface SessionRunner {
  launch(req: LaunchRequest): Promise<BgTask>          // returns at "pending"/"running", never awaits completion
  awaitCompletion(taskId: string, timeoutMs?: number): Promise<BgTask>  // in-process await (workflow runtime path)
  cancel(taskId: string): Promise<BgTask>
  resume(taskId: string, prompt: string): Promise<BgTask>
  readOutput(taskId: string, opts?: ReadOpts): Promise<TaskOutput>
  list(parentSessionID?: string): BgTask[]
  handleEvent(event: OpencodeEvent): Promise<void>     // wired by the host plugin
  dispose(): Promise<void>
}
```

`LaunchRequest`: `{ parentSessionID, description, prompt, agent, model?, depth, toolsOverride?, noSpawnTools? (default true) }`. Timestamps are injected via a `Clock` dep (factory-DI — tests control time, and workflow determinism later forbids ambient `Date.now()` anyway). Short-ID generator: random suffix, regenerate on collision against live set.

**Files:**
- Create: `packages/core/src/types.ts`
- Create: `packages/core/src/ids.ts`
- Test: `packages/core/src/ids.test.ts`

**Verification:** `bun test packages/core/src/ids.test.ts`; `bun run typecheck`.

**Done when:** contract compiles, IDs are collision-safe under a forced-collision test, and all time access flows through the injected `Clock`.

#### Task 1.3.2: Launch path

- [x] Done — decisions recorded: concurrency-key fallback when `model` absent is the literal `"default"` (never the agent name — keyspace collision risk); depth/`session.create` failures REJECT launch, cancellations RESOLVE with the `cancelled` task; `LaunchRequest.model` string is split into the SDK's `{providerID, modelID}`; temporary `markCancelled` seam to be absorbed by 1.3.3's `tryComplete`. ⚠️ for 1.3.3: happy-path slot release is owned by the completion gate (doesn't exist yet).

**Context:** Spine validated in prior art: `client.session.create({ body: { parentID, title } })` then `client.session.promptAsync({ path: { id }, body: { agent, tools, parts } })` fire-and-forget (`.references/better-opencode-async-agents/src/manager/task-lifecycle.ts:72-180`). OMO re-checks cancellation around the session-create await because the user can cancel mid-window (`.references/oh-my-opencode/src/features/background-agent/manager.ts:773,785,797`).

**Implementation vision:** `launch()` flow: (1) depth guard — reject if `depth >= maxDepth` (default 2) with a clear error; (2) create `BgTask` at `pending`, register in the in-memory Map, persist; (3) `concurrency.acquire(key)`; (4) re-check not-cancelled; (5) `session.create` with `parentID` + title from description; re-check cancelled after the await — if cancelled, abort the orphaned session and finalize; (6) record `sessionID`, status → `running`, persist; (7) `promptAsync` with parts `[{type:"text", text: prompt}]` and a `tools` override mapping every `bg_*`/`workflow*` tool to `false` when `noSpawnTools` (recursion guard — better-async's pattern, `task-lifecycle.ts:164-170`); launch errors from the promise `.catch` finalize the task as `error` and release the slot. The client is injected (factory-DI) so tests use a scripted fake. Edge cases by name: cancel-during-acquire (waiter cancelled → task `cancelled`, no session ever created); cancel-between-create-and-prompt (session aborted, task `cancelled`); `session.create` rejection (slot released, task `error`); depth exceeded (no slot acquired at all).

**Files:**
- Create: `packages/core/src/session-runner.ts`
- Test: `packages/core/src/session-runner.test.ts`

**Verification:** `bun test packages/core/src/session-runner.test.ts` — launch happy path + all four named edge cases.

**Done when:** every named edge case passes and no code path can leak a concurrency slot (assert slot count in tests after each scenario).

#### Task 1.3.3: Completion gate, mutex, and safety net

- [ ] Done

**Context:** The race-correctness core. Verified design from OMO: `session.idle` handler requires status `running` + min-idle elapsed, defers-and-re-checks if too early (`.references/oh-my-opencode/src/features/background-agent/session-idle-event-handler.ts:35-52`); validates session has ≥1 non-empty assistant/tool message before completing (`manager.ts:2159-2217`); `tryCompleteTask` does a synchronous `status !== "running" → return false` check-and-flip **before any await** — JS single-threadedness is the mutex (`manager.ts:2443-2501`); slot released before async teardown to prevent leaks (`:2466-2469`).

**Implementation vision:** Three completion sources, all funneling into `tryComplete(task, terminal, reason)`: (a) `handleEvent` on `session.idle` for tracked sessions — gate: min-idle 5s grace (defer via injected timer if early), then output validation via `session.messages` (cache positive results per session); (b) safety poll every 5s (injected interval, `unref()`d, re-entrancy boolean): only checks tasks whose session stopped emitting events — uses `session.get`/`session.messages` (typed surfaces per the 1.1.2 audit), NOT `session.status` (best-effort/private in prior art); N consecutive misses + existence re-check → `error("session gone")`; (c) stale timeout — no progress for `staleTimeoutMs` (default 45min) → abort session, status `cancelled`, error text explicitly instructing the model NOT to launch a replacement task (OMO's retry-storm defense, `.references/oh-my-opencode/src/features/background-agent/task-poller.ts:156`). `tryComplete` synchronously flips status, then: release slot → abort session if needed (awaited — dangling teardown promises crash Bun per OMO's comments) → persist → emit completion to an injected `onTaskComplete` callback (the notification layer subscribes; the engine stays presentation-ignorant). `awaitCompletion()` is a promise registry resolved inside `tryComplete` — no polling. Race tests by name: idle-event and poll firing in the same tick (one winner); cancel racing idle (cancel wins if first, idle no-ops); double idle events (second no-ops); idle before min-grace then real completion after deferral; stale timeout racing completion.

**Files:**
- Create: `packages/core/src/completion.ts`
- Modify: `packages/core/src/session-runner.ts`
- Test: `packages/core/src/completion.test.ts`

**Verification:** `bun test packages/core/src/completion.test.ts` — all five named race tests pass; run with `--rerun-each 20` to shake out ordering flakes.

**Done when:** exactly-one-terminal-transition holds in every race test and `awaitCompletion` resolves for all terminal statuses without any poll loop.

#### Task 1.3.4: Cancel, resume, and output reading

- [ ] Done

**Context:** Cancel = `client.session.abort` + terminal flip (better-async `task-lifecycle.ts:216-224` — but it bypasses its own status helper; we route everything through `tryComplete`). Resume re-prompts the existing session and re-acquires concurrency (OMO `manager.ts:1240+`). Output reading walks `session.messages` with filtering (better-async `src/tools/output.ts`).

**Implementation vision:** `cancel()`: route through `tryComplete(task, "cancelled")`; if a waiter is queued, `cancelWaiter` instead of abort (no session exists yet). `resume()`: only on terminal tasks whose session still exists (`session.get` succeeds — else `sessionExpired` error); re-acquire slot on the persisted `concurrencyKey`, reset `startedAt`, status → `running`, `promptAsync` the new prompt, same completion machinery; no pending-resume queue in v1 — a resume on a `running` task is an error (`taskStillRunning`), simpler than better-async's depth-1 stash. `readOutput()`: fetch messages, return `{ status, summaryText, messages? }` — `summaryText` is the last assistant text; `full: true` returns the filtered transcript (drop synthetic parts, cap tool-result text at a fixed char limit with head+tail preservation for results matching error patterns). Edge cases by name: cancel of pending task (no session — waiter cancelled); cancel of already-terminal task (no-op, returns current state); resume of expired session; readOutput on a running task (returns partial with `status: "running"`).

**Files:**
- Modify: `packages/core/src/session-runner.ts`
- Test: `packages/core/src/session-runner.test.ts`

**Verification:** `bun test packages/core/src/session-runner.test.ts` — named edge cases green.

**Done when:** cancel/resume/readOutput behave per the named edge cases and every status mutation in the codebase flows through `tryComplete` (grep proves no direct `task.status =` outside it).

### Epic 1.4: Persistence and notification queue

**Goal:** Task metadata survives process restart without corruption; completion notices queue for passive delivery.
**Scope:** `packages/core/src/persistence.ts`, `packages/core/src/notify.ts`
**Dependencies:** Epic 1.3
**Done when:** kill-and-reload tests recover full task state; notification queue dedupes and survives the flush contract.

#### Task 1.4.1: Atomic per-task persistence with restart recovery

- [ ] Done

**Context:** better-async persists one whole-file JSON with read-modify-write, no locking, silent `{}` on corruption, and drops fields needed for resume (`.references/better-opencode-async-agents/src/storage.ts:77-121`, `src/manager/index.ts:325-339`) — all three defects to avoid. OMO persists nothing.

**Implementation vision:** One JSON file per task at `~/.local/share/opencode-drawers/tasks/<taskId>.json` (XDG-style; base dir injectable for tests). Writes: serialize the full `BgTask` to `<id>.json.tmp`, `rename` over the target (atomic on POSIX); a per-task in-process write queue serializes concurrent writes (last-write-wins, no interleaved torn writes). Persist EVERY `BgTask` field — parent IDs included (decision 4). Load at engine start: read dir, parse each file, skip-and-log corrupt entries individually (one bad file must not nuke the rest — fixes better-async's all-or-nothing). Recovered non-terminal tasks: verify session existence; alive → re-track as `running` (safety poll picks them up); gone → finalize `error("lost during restart")`. TTL sweep: terminal tasks older than 24h deleted at load. Edge cases by name: corrupt single file among valid ones; tmp-file leftover from a crashed write (ignored/cleaned); concurrent writes to the same task (queue order preserved); recovery with session alive vs gone.

**Files:**
- Create: `packages/core/src/persistence.ts`
- Modify: `packages/core/src/session-runner.ts`
- Test: `packages/core/src/persistence.test.ts`

**Verification:** `bun test packages/core/src/persistence.test.ts` — incl. a test that constructs a fresh runner over an existing dir and asserts full state recovery.

**Done when:** restart-recovery test passes for both alive- and gone-session cases and a corrupted file degrades to a logged skip, never an empty store.

#### Task 1.4.2: Notification queue with passive-flush contract

- [ ] Done

**Context:** Decision 1: no active parent-wake. The passive channel is OMO's "Channel B": pending notices injected when the parent's next user message flows through the `chat.message` hook (`.references/oh-my-opencode/src/features/background-agent/manager.ts:2144-2153`). Toasts via the typed TUI surface confirmed in Task 1.1.2. better-async's dedup-with-priority exists because it has three competing notifiers (`.references/better-opencode-async-agents/src/manager/notifications.ts:15-230`) — our single-winner `tryComplete` means at most one notice per task, so dedup is a simple seen-set.

**Implementation vision:** `NotificationQueue`: `push(notice)` called from the engine's `onTaskComplete`; `flushFor(parentSessionID): Notice[]` drains notices for that parent. The notice carries task id/short-id, description, terminal status, duration, and the retrieval hint text ("call `bg_output(task_id=...)`"). The hook wiring itself (calling `flushFor` inside `chat.message` and appending a hint part) belongs to the Phase 2 plugin — core only exposes the queue and the rendered hint strings, keeping the engine presentation-ignorant. Toast emission: an injected `onNotify` callback (the plugin passes `client.tui`-backed impl; tests pass a spy). Queue is in-memory + persisted alongside the task (a `notified: boolean` on the task record), so a restart doesn't re-announce already-flushed notices and doesn't lose un-flushed ones. Edge cases by name: completion while parent has no pending turn (notice waits indefinitely); restart with un-flushed notice (re-queued); restart with flushed notice (not re-queued); two tasks completing for the same parent (both flushed in one batch, oldest first).

**Files:**
- Create: `packages/core/src/notify.ts`
- Modify: `packages/core/src/types.ts`
- Test: `packages/core/src/notify.test.ts`

**Verification:** `bun test packages/core/src/notify.test.ts` — named edge cases green.

**Done when:** flush contract and restart semantics hold under test; core has zero imports from plugin/TUI modules.

### Epic 1.5: Headless smoke harness

**Goal:** Prove the engine against a real opencode, not just mocks.
**Scope:** `packages/core/test-harness/`
**Dependencies:** Epics 1.3, 1.4
**Done when:** a scripted headless run launches a trivial background task, observes idle-driven completion, and recovers state after a simulated restart.

#### Task 1.5.1: Smoke harness plugin + scripted headless run

- [ ] Done

**Context:** Plugin loading rules: auto-scan glob is `{plugin,plugins}/*.{ts,js}`, one level deep, or explicit `opencode.json` `plugin` array with local paths (`.claude/skills/opencode-plugin-dev/SKILL.md:157-180`). The plugin loader calls all exports as functions — never export classes from the entry (better-async hit this: `.references/better-opencode-async-agents/src/index.ts:16-17`). Hooks fire inside headless `opencode run` (`SKILL.md:85-86`). Testing guidance: `.claude/skills/opencode-plugin-dev/references/testing.md`.

**Implementation vision:** A throwaway harness directory (not a published package): minimal `opencode.json` registering a local `smoke-plugin.ts` that instantiates the core engine with real deps, exposes one `smoke_launch` tool, and wires `event` → `runner.handleEvent`. A Bun test script shells out to headless opencode (model: whatever is configured locally; the harness asserts engine behavior, not model output): launch a "respond with the word done" task → assert task reaches `completed` with non-empty output within timeout → kill the process → rerun pointing at the same data dir → assert the task is recovered as terminal with its result readable. Marked as a separate test target (`bun run smoke`) excluded from `bun test` (needs a live opencode + credentials). Document the manual prerequisite (an authenticated local opencode) in the harness README.

**Files:**
- Create: `packages/core/test-harness/opencode.json`
- Create: `packages/core/test-harness/plugins/smoke-plugin.ts`
- Create: `packages/core/test-harness/run-smoke.ts`
- Create: `packages/core/test-harness/README.md`

**Verification:** `bun run smoke` against a locally authenticated opencode — launch→complete→restart-recover sequence passes.

**Done when:** the smoke run passes locally and the README documents prerequisites and expected output. **Phase 1 exit.**

---

## Phase 2 — `opencode-drawer-agents` plugin

**Milestone:** Installable plugin (local path) exposing the `bg_*` tool family; e2e: launch → idle completion → toast + passive notification on next user message → output retrieval → resume → cancel; tasks survive plugin restart.

### Epic 2.1: Plugin shell and tool surface

**Goal:** `packages/background-agents` plugin wires the core engine into OpenCode with tools `bg_task` (launch + resume via `task_id`), `bg_output` (incl. `block`, incremental fetch), `bg_cancel` (single/all), `bg_list` (children of current session).
**Scope:** `packages/background-agents/`
**Dependencies:** Phase 1
**Done when:** all four tools callable from a live session; recursion guard verified (child cannot see `bg_*` tools); single tool family, single resume path (no better-async/OMO dual-family drift).

### Epic 2.2: Notification delivery wiring

**Goal:** Passive notice injection via `chat.message` (visible status line + `synthetic: true` retrieval-hint part) and TUI toasts, backed by core's `NotificationQueue`.
**Scope:** `packages/background-agents/src/hooks/`
**Dependencies:** Epic 2.1
**Done when:** completing task surfaces a toast immediately and a notice on the parent's next message; no notice duplication across restarts.

### Epic 2.3: Context forking

**Goal:** `bg_task(fork: true)` injects truncated parent history into the child via a `noReply` prompt.
**Scope:** `packages/background-agents/src/fork/`
**Dependencies:** Epic 2.1
**Done when:** forked child demonstrably answers from parent context; truncation validated against the REAL current message part schema (better-async's pipeline silently no-ops on schema drift — `tool_result` vs `tool` part types, `.references/better-opencode-async-agents/src/fork/index.ts:168,264`); compaction-boundary slicing, recency-tiered truncation, head+tail error preservation, linear-time budget trimming.

---

## Phase 3 — Workflow runtime (library)

**Milestone:** `packages/workflows/src/runtime/` executes `WORKFLOWS_HL_SPEC.md`-conformant scripts against the Phase 1 engine in-process; spec-conformance test suite green. No plugin surface yet.

### Epic 3.1: Script parsing and sandboxed evaluation

**Goal:** Parse the pure-literal `meta` export, reject computed metas, evaluate the body with an explicit global allowlist and throwing stubs for `Date.now`/`Math.random`/argless `new Date` (determinism guard, spec §3.1-3.2; threat model is resume-cache poisoning, not containment — the author already holds bash).
**Scope:** `packages/workflows/src/runtime/`
**Dependencies:** Phase 1 (engine contract only)
**Done when:** valid scripts run; TypeScript syntax, computed meta, and banned builtins each fail with the spec's prescribed behavior.

### Epic 3.2: Orchestration primitives

**Goal:** `agent()` (via `SessionRunner.awaitCompletion` — never parent-wake), `pipeline()` (no barrier, per-item chains, throw→null), `parallel()` (barrier, never rejects), `phase()`/`log()` (progress journal), `args`, concurrency caps (`min(16, cores−2)` via a workflow-scoped concurrency key), 1,000-agent lifetime cap, 4,096-item call cap.
**Scope:** `packages/workflows/src/runtime/`
**Dependencies:** Epic 3.1
**Done when:** spec §3.3/§4/§5/§9 semantics each have a conformance test (incl. degrade-don't-detonate: null propagation vs thrown caps).

### Epic 3.3: Structured output

**Goal:** `agent(prompt, { schema })` returns a validated object: a single global `structured_output` tool whose expected JSON Schema is looked up per-session from runner state; mismatch returns a tool error so the model retries (spec's "validation at the tool-call layer").
**Scope:** `packages/workflows/src/runtime/`, small hook in core for per-session tool state
**Dependencies:** Epic 3.2
**Done when:** schema-conformant results resolve as objects; a deliberately nonconforming model response triggers retry-then-error, never a script-level parse failure.

---

## Phase 4 — `opencode-drawer-workflows` plugin

**Milestone:** Installable plugin: `workflow` / `workflow_status` / `workflow_stop` tools; journal-backed deterministic resume (same script+args → 100% cache hit); budget; sub-workflows (one level); a canonical multi-stage review workflow runs e2e.

### Epic 4.1: Plugin shell, run lifecycle, and progress

**Goal:** `workflow({script|scriptPath|name, args, resumeFromRunId})` returns immediately with runId + persisted script path; completion delivered via the passive notification channel; `workflow_status` renders the progress tree; saved workflows from `.opencode/workflows/`.
**Scope:** `packages/workflows/src/`
**Dependencies:** Phase 3
**Done when:** fire → continue conversation → notification → read result loop works e2e.

### Epic 4.2: Journal and deterministic resume

**Goal:** Append-only JSONL journal of `(callIndex, hash(prompt+opts), result)`; resume replays the script with longest-unchanged-prefix cache hits; first divergence runs live (spec §7).
**Scope:** `packages/workflows/src/journal.ts`, runtime integration
**Dependencies:** Epic 4.1
**Done when:** same-script+args resume reproduces the result with zero new agent launches; an edited mid-script call re-runs only itself and successors.

### Epic 4.3: Budget and sub-workflows

**Goal:** `budget.total/spent()/remaining()` from SDK token usage (spike first: verify usage metadata on assistant messages per the 1.1.2 audit; fallback = labeled char-based estimation); hard-ceiling throw on exhaustion; `workflow()` sub-workflow sharing caps/budget/abort, nesting depth 1 (spec §6/§8).
**Scope:** `packages/workflows/src/`
**Dependencies:** Epic 4.2
**Done when:** loop-until-budget conformance test halts at the ceiling; nested sub-workflow inside a child throws.

---

## Phase 5 — Ship

### Epic 5.1: Publish and documentation

**Goal:** Both plugins on npm (`opencode-drawer-agents`, `opencode-drawer-workflows`), each self-contained (core bundled or published as `@drawers/core` dependency — decide at publish against OpenCode's npm-install behavior); READMEs with install/config/tool reference; publishing per `.claude/skills/opencode-plugin-dev/references/publishing.md`.
**Scope:** repo-wide
**Dependencies:** Phases 2, 4
**Done when:** a clean project with only `"plugin": ["opencode-drawer-agents", "opencode-drawer-workflows"]` in `opencode.json` gets working tools on startup.

---

## Risks (carried from analysis)

| Risk | Mitigation |
|---|---|
| Host doesn't serialize concurrent session prompts (root cause of OMO's worst code) | Workflows await in-process; notifications passive-only (decision 1) |
| `session.idle` reliability varies across opencode versions | Narrow version pin (decision 5) + sparse safety poll + stale timeout |
| SDK churn on `tui`/`session.status` surfaces | Typed-only rule (decision 3) + audit gate re-run at each phase start |
| Budget token accounting may not be exposed in SDK | Spike in Epic 4.3; honest labeled estimation fallback |
| Model-authored workflow scripts run in-process | Accepted: same trust level as the bash tool; shadowed globals are for determinism, not containment |
