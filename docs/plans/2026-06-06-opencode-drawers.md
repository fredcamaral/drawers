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
| 1 | Core engine launches, completes, cancels and persists background sessions against a real headless opencode; full unit + race coverage | 1.1, 1.2, 1.3, 1.4, 1.5 | Complete |
| 2 | `opencode-drawer-agents` plugin installable locally: `bg_task`/`bg_output`/`bg_cancel`/`bg_list` work e2e with passive notifications and restart survival | 2.1, 2.2, 2.3 | Complete |
| 3 | Workflow runtime executes spec-conformant scripts (`agent`/`pipeline`/`parallel`/`phase`/`log`/`args`) with caps, against the Phase 1 engine | 3.1, 3.2, 3.3 | Complete |
| 4 | `opencode-drawer-workflows` plugin: journal-backed deterministic resume, budget, sub-workflows, structured output; canonical review workflow runs e2e | 4.1, 4.2, 4.3 | Complete |
| 5 | Both plugins documented (READMEs + authoring guide) and published to npm, installable in a clean project via `"plugin": [...]` | 5.1, 5.2 | 5.1 Complete / 5.2 Epic-level |
| 6 | CC parity: structured results survive slow real-world turns (completion-gate watermark), absolute `script_path` works, live in-session workflow observability, active parent wake | 6.1, 6.2, 6.3 | Complete |
| 7 | Mid-turn completion eliminated (turn-liveness gate: session status + message `time.completed`); structured/empty failures carry diagnostics and full results are retrievable; resume replays journaled items per-item (key+occurrence) instead of prefix | 7.1, 7.2, 7.3 | Complete |
| 8 | Live observability + native viewer: real-time per-run feed with per-agent tokens/tool-calls/duration, external cancel channel, and a `./tui`-surface full-screen viewer (Phases \| Agents \| Detail) mirroring CC's `/workflows` overlay | 8.1, 8.2, 8.3 | 8.1 Detailed / 8.2–8.3 Epic-level |

## Design decisions (binding across phases)

1. ~~**No active parent-wake.**~~ **REVERSED 2026-06-07 (Phase 6, user decision: CC parity).** Active wake is now the goal — Epic 6.3. The original rationale stands as a CONSTRAINT, not a veto: OpenCode does not serialize concurrent session prompts (oh-my-opencode's wake costs ~24 files of crash-mitigation at `.references/oh-my-opencode/src/features/background-agent/parent-wake-*.ts`), so the wake fires ONLY on an idle parent; a busy parent falls back to the existing passive flush. Passive delivery (chat.message flush + toast) remains as the fallback layer.
2. **Event-primary completion, poll as safety net.** `session.idle` gated by min-idle grace + output validation; sparse (≥5s) re-entrancy-guarded poll only as fallback; `client.session.status()` treated as best-effort. **AMENDED 2026-06-07 (Phase 7):** quiet-time is NOT sufficient evidence of turn end — silent windows >5s are normal mid-turn (first-token latency on large prompts, API retry backoff). Completion additionally requires turn liveness to be negative: `session.status()` not `busy`/`retry` (veto, never trigger — best-effort stance preserved: a status read failure blocks completion conservatively) AND the newest post-watermark assistant message has `time.completed` stamped.
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

- [x] Done — `completion.ts` (`createCompletionGate`) owns tryComplete/idle-gating/poll/stale; runner wires it via injected collaborators. Key finding: `session.idle` must NOT count as last-activity (it perpetually resets the grace window — caught by tests). Deviation: teardown is DETACHED from the synchronous flip; callers needing post-teardown state must join via `awaitCompletion` (sharp edge for 1.3.4's cancel). Orphan-abort on cancel-before-create stays in the launch path (gate can't abort a session that didn't exist at flip time). 640× rerun race-clean.

**Context:** The race-correctness core. Verified design from OMO: `session.idle` handler requires status `running` + min-idle elapsed, defers-and-re-checks if too early (`.references/oh-my-opencode/src/features/background-agent/session-idle-event-handler.ts:35-52`); validates session has ≥1 non-empty assistant/tool message before completing (`manager.ts:2159-2217`); `tryCompleteTask` does a synchronous `status !== "running" → return false` check-and-flip **before any await** — JS single-threadedness is the mutex (`manager.ts:2443-2501`); slot released before async teardown to prevent leaks (`:2466-2469`).

**Implementation vision:** Three completion sources, all funneling into `tryComplete(task, terminal, reason)`: (a) `handleEvent` on `session.idle` for tracked sessions — gate: min-idle 5s grace (defer via injected timer if early), then output validation via `session.messages` (cache positive results per session); (b) safety poll every 5s (injected interval, `unref()`d, re-entrancy boolean): only checks tasks whose session stopped emitting events — uses `session.get`/`session.messages` (typed surfaces per the 1.1.2 audit), NOT `session.status` (best-effort/private in prior art); N consecutive misses + existence re-check → `error("session gone")`; (c) stale timeout — no progress for `staleTimeoutMs` (default 45min) → abort session, status `cancelled`, error text explicitly instructing the model NOT to launch a replacement task (OMO's retry-storm defense, `.references/oh-my-opencode/src/features/background-agent/task-poller.ts:156`). `tryComplete` synchronously flips status, then: release slot → abort session if needed (awaited — dangling teardown promises crash Bun per OMO's comments) → persist → emit completion to an injected `onTaskComplete` callback (the notification layer subscribes; the engine stays presentation-ignorant). `awaitCompletion()` is a promise registry resolved inside `tryComplete` — no polling. Race tests by name: idle-event and poll firing in the same tick (one winner); cancel racing idle (cancel wins if first, idle no-ops); double idle events (second no-ops); idle before min-grace then real completion after deferral; stale timeout racing completion.

**Files:**
- Create: `packages/core/src/completion.ts`
- Modify: `packages/core/src/session-runner.ts`
- Test: `packages/core/src/completion.test.ts`

**Verification:** `bun test packages/core/src/completion.test.ts` — all five named race tests pass; run with `--rerun-each 20` to shake out ordering flakes.

**Done when:** exactly-one-terminal-transition holds in every race test and `awaitCompletion` resolves for all terminal statuses without any poll loop.

#### Task 1.3.4: Cancel, resume, and output reading

- [x] Done — contract additions: `BgTask.model?` (resume re-acquires the right slot), `TaskOutput.messages` refined to `TaskOutputMessage[]`, gate gained `resetForResume(task)` (invalidates output-validation cache + restarts activity clock so a stale idle can't complete the new turn). `markCancelled` seam deleted; `cancel()` joins detached teardown via `awaitCompletion` so callers observe released slot + persisted state.

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

- [x] Done — recovery wired as `SessionRunnerDeps.recoveredTasks?: BgTask[]` (construction-time DI, not an interface method). Slot policy: recovered running tasks occupy NO concurrency slot (re-acquiring could deadlock startup if recovered > limit; original process's slots died with it). `save()` snapshots the task before enqueueing — the gate mutates BgTask in place, so a queued write must capture call-time state.

**Context:** better-async persists one whole-file JSON with read-modify-write, no locking, silent `{}` on corruption, and drops fields needed for resume (`.references/better-opencode-async-agents/src/storage.ts:77-121`, `src/manager/index.ts:325-339`) — all three defects to avoid. OMO persists nothing.

**Implementation vision:** One JSON file per task at `~/.local/share/opencode-drawers/tasks/<taskId>.json` (XDG-style; base dir injectable for tests). Writes: serialize the full `BgTask` to `<id>.json.tmp`, `rename` over the target (atomic on POSIX); a per-task in-process write queue serializes concurrent writes (last-write-wins, no interleaved torn writes). Persist EVERY `BgTask` field — parent IDs included (decision 4). Load at engine start: read dir, parse each file, skip-and-log corrupt entries individually (one bad file must not nuke the rest — fixes better-async's all-or-nothing). Recovered non-terminal tasks: verify session existence; alive → re-track as `running` (safety poll picks them up); gone → finalize `error("lost during restart")`. TTL sweep: terminal tasks older than 24h deleted at load. Edge cases by name: corrupt single file among valid ones; tmp-file leftover from a crashed write (ignored/cleaned); concurrent writes to the same task (queue order preserved); recovery with session alive vs gone.

**Files:**
- Create: `packages/core/src/persistence.ts`
- Modify: `packages/core/src/session-runner.ts`
- Test: `packages/core/src/persistence.test.ts`

**Verification:** `bun test packages/core/src/persistence.test.ts` — incl. a test that constructs a fresh runner over an existing dir and asserts full state recovery.

**Done when:** restart-recovery test passes for both alive- and gone-session cases and a corrupted file degrades to a logged skip, never an empty store.

#### Task 1.4.2: Notification queue with passive-flush contract

- [x] Done — dedup key is `taskId + ":" + completedAt`, not taskId alone (a resumed task legitimately re-completes with a fresh completedAt; taskId-only would swallow the second notice). `seed()` never fires onNotify (no toast storm on restart). `TaskNotice` lives in notify.ts, not types.ts — presentation shapes stay out of the engine contract.

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

- [x] Done — PASS against real opencode 1.16.2 (verified independently). EngineClient structural subset matched the live SDK exactly — zero core changes. Environmental gotchas recorded for Phase 2: (1) opencode resolves config from `PWD` env var, not spawn cwd — pin `PWD` when spawning; (2) `OPENCODE_PURE=1` disables ALL external plugins including ours; (3) `opencode run` is single-turn — parent turn end shuts the server down and aborts running children (the engine finalized the abort correctly); (4) global agent configs can silently override the configured model — force via `run --model`.

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

**Goal:** `packages/background-agents` plugin wires the core engine into OpenCode with tools `bg_task` (launch + resume via `task_id`), `bg_output` (incl. `block`), `bg_cancel` (single/all), `bg_list` (children of current session).
**Scope:** `packages/background-agents/`, small extraction into `packages/core/`
**Dependencies:** Phase 1
**Done when:** all four tools callable from a live session; recursion guard verified (child cannot see `bg_*` tools); single tool family, single resume path (no better-async/OMO dual-family drift).

#### Task 2.1.1: SDK client adapter in core + plugin package scaffold with engine wiring

- [x] Done — `onTaskComplete` seam already existed on `SessionRunnerDeps` (no core contract change). Additions: core package.json gained `exports` (`"."` → `./src/index.ts`) so the bare `@drawers/core` workspace import resolves; `createEngine` gained injectable `fs?` seam (test DI, forwards to store). Flag for later: engine's `markNotified` does an O(n) `list()` scan per flushed notice — add `runner.get(id)` if batches ever bite.

**Context:** The smoke plugin (`packages/core/test-harness/plugin/smoke-plugin.ts:60-77`) hand-rolls the real-SDK→`EngineClient` adapter; both Phase 2 and Phase 4 plugins need the identical adapter — it belongs in core, written once. The full wiring recipe (store→recover→runner→event hook) is proven at `smoke-plugin.ts:79-116`. Core's public surface is exported from `packages/core/src/index.ts`.

**Implementation vision:** (1) Create `packages/core/src/sdk-adapter.ts`: `adaptSdkClient(client): EngineClient` — lift the adapter verbatim-in-spirit from the smoke plugin; type the input structurally (the five `session.*` methods with their Options-shaped signatures) rather than importing `ReturnType<createOpencodeClient>` if that's cleaner under `verbatimModuleSyntax`; unit test with a scripted fake asserting call-shape forwarding and `{data}` narrowing. Re-export from index. Update the smoke plugin to consume it (deletes its local copy — the smoke run re-verifies the adapter live in 2.3.2). (2) Scaffold `packages/background-agents`: package.json named `opencode-drawer-agents` (decision 6), `"type": "module"`, workspace dep `@drawers/core`, exact-pinned `@opencode-ai/plugin` 1.16.2; tsconfig extending base; extend root `typecheck` script to cover it. (3) `src/engine.ts`: `createEngine({ client, dataDir? })` — one factory assembling store (`createTaskStore`, default base dir; `OPENCODE_DRAWERS_DATA_DIR` env override), `store.load()` → `recoveredTasks`, `ConcurrencyManager` (config-driven later, defaults now), `createIdGenerator()`, Date clock, `client.app.log`-backed logger, returns `{ runner, store, queue }` with `createNotificationQueue` wired to `runner`'s `onTaskComplete` (toast cb left injectable — Epic 2.2 fills it). Check how `onTaskComplete` is passed (gate dep via runner config — read `session-runner.ts` for the exact seam). (4) `src/index.ts`: the plugin entry — single async function export `BackgroundAgentsPlugin: Plugin` wiring `event` → `runner.handleEvent` and an empty `tool: {}` placeholder (2.1.2/2.1.3 fill it). No classes from the entry; `client.app.log` only, never console.

**Files:**
- Create: `packages/core/src/sdk-adapter.ts`
- Test: `packages/core/src/sdk-adapter.test.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/test-harness/plugin/smoke-plugin.ts`
- Create: `packages/background-agents/package.json`, `packages/background-agents/tsconfig.json`, `packages/background-agents/src/index.ts`, `packages/background-agents/src/engine.ts`
- Test: `packages/background-agents/src/engine.test.ts`
- Modify: `package.json` (typecheck script)

**Verification:** `bun install && bun test && bun run typecheck && bun run lint` — green; engine test proves recovery wiring (fake fs store seeded with a terminal + a running task).

**Done when:** adapter lives in core with tests, smoke plugin consumes it, plugin package builds with the engine factory under test.

#### Task 2.1.2: `bg_task` tool — launch and resume

- [x] Done — core's resume errors are plain `Error`s with stable message prefixes (`taskStillRunning:`/`sessionExpired:`); tool detects via `startsWith`. Worth typing as error classes if a third consumer appears.

**Context:** Tool registration shape: `.claude/skills/opencode-plugin-dev/references/custom-tools.md` (`tool()` helper, `tool.schema.*` = Zod, `ToolContext.sessionID`/`abort`/`metadata`). Core surface: `SessionRunner.launch(LaunchRequest)` (`packages/core/src/types.ts`) and `resume(taskId, prompt)` — resume only on terminal tasks, rejects `taskStillRunning`/`sessionExpired` (session-runner.ts, Task 1.3.4). Recursion guard is core-side (launch's tools override) — but depth must be INFERRED here: the runner's `list()` exposes tasks with `sessionID`; if the calling `context.sessionID` matches a tracked task's child session, this call is from a child.

**Implementation vision:** `src/tools/task.ts` exporting a factory `createBgTaskTool(runner)` (DI for tests). Args: `description` (string, short — UI title), `prompt` (string), `agent` (string, default "build"), `model` (optional, "provider/model"), `task_id` (optional — when present this is a RESUME: `prompt` required, all other args ignored). Launch path: depth = `(runner.list().find(t => t.sessionID === context.sessionID)?.depth ?? -1) + 1` — core's maxDepth guard does the rejecting; tool just reports the error string honestly. Returns (string result): task id + status + explicit guidance "running in background — you will be notified on completion; do NOT poll; use bg_output(task_id) when notified" (sets model expectations against poll-storms). Resume path: call `runner.resume`; map `taskStillRunning` and `sessionExpired` errors to honest error-string returns (expected outcomes the model reasons over — custom-tools.md error strategy 2), unexpected errors throw. Use `context.metadata({ title: description })`. Tests with a fake `SessionRunner` (typed interface — no SDK needed): launch arg mapping incl. depth inference (parent call → 0, call from child session → 1), resume mapping, both error translations.

**Files:**
- Create: `packages/background-agents/src/tools/task.ts`
- Modify: `packages/background-agents/src/index.ts` (register under key `bg_task`)
- Test: `packages/background-agents/src/tools/task.test.ts`

**Verification:** `bun test packages/background-agents` — green.

**Done when:** launch + resume work against the fake runner, depth inference is proven, and the result text contains the no-poll guidance.

#### Task 2.1.3: `bg_output`, `bg_cancel`, `bg_list` tools

- [x] Done — abort race with balanced add/remove listeners (leak-asserted in test); `bg_cancel` coerces `all === true` (Zod defaults don't fire on raw execute paths); `bg_list` uses the `Clock` seam. Registration wired in the entry by the orchestrator. Note: core's launch SPAWN_GUARD already hides all four tools from child sessions.

**Context:** Core surface: `readOutput(taskId, { full? })` → `{ status, summaryText, messages? }`; `awaitCompletion(taskId, timeoutMs)` resolves on terminal/rejects on timeout; `cancel(taskId)` resolves post-teardown, no-ops terminal tasks; `list(parentSessionID?)`. (`packages/core/src/types.ts`, tasks 1.3.3/1.3.4.)

**Implementation vision:** `src/tools/output.ts`, `cancel.ts`, `list.ts`, factories like 2.1.2. `bg_output` args: `task_id`, `full` (bool default false), `block` (bool default false), `timeout_ms` (number default 60000, max-clamped 300000) — `block: true` → `awaitCompletion` first (timeout → honest "still running after Xms" string, NOT a throw — the model should not retry-storm), then `readOutput`; format: status line + summary, `full` appends the filtered transcript as fenced text. Respect `context.abort`: bail from block awaiting when aborted (race `awaitCompletion` vs an abort promise; on abort return "wait cancelled"). `bg_cancel` args: `task_id` optional, `all` (bool default false) — exactly one required, both/neither → error string; `all` cancels every non-terminal task of `list(context.sessionID)`; reports per-task outcomes. `bg_list` args: `{}` — renders `list(context.sessionID)` as a compact table (id, status, description, age via injected clock-less Date; durations from task timestamps), empty → "no background tasks for this session". Unit tests per tool with the fake runner: block-timeout path, abort path, cancel all-vs-one matrix, list rendering incl. empty.

**Files:**
- Create: `packages/background-agents/src/tools/output.ts`, `packages/background-agents/src/tools/cancel.ts`, `packages/background-agents/src/tools/list.ts`
- Modify: `packages/background-agents/src/index.ts` (register `bg_output`/`bg_cancel`/`bg_list`)
- Test: `packages/background-agents/src/tools/output.test.ts`, `packages/background-agents/src/tools/cancel.test.ts`, `packages/background-agents/src/tools/list.test.ts`

**Verification:** `bun test packages/background-agents` — green incl. block/abort/all-cancel edges.

**Done when:** all four `bg_*` tools registered from the entry, every named edge tested, no tool ever throws on an expected outcome.

### Epic 2.2: Notification delivery wiring

**Goal:** Passive notice injection via `chat.message` (visible status line + `synthetic: true` retrieval-hint part) and TUI toasts, backed by core's `NotificationQueue`.
**Scope:** `packages/background-agents/src/hooks/`
**Dependencies:** Epic 2.1
**Done when:** completing task surfaces a toast immediately and a notice on the parent's next message; no notice duplication across restarts.

#### Task 2.2.1: `chat.message` flush hook + TUI toasts

- [x] Done — Part/TextPart types derived structurally from the `Hooks["chat.message"]` signature itself (no direct `@opencode-ai/sdk` dep added to the plugin package); `createToastNotifier` is a tested unit (sync throw AND rejected promise both swallowed+logged); engine.ts needed no change — 2.1.1's seams sufficed, only index.ts wires onNotify + hook.

**Context:** Hook signature (`.claude/skills/opencode-plugin-dev/references/hooks.md:66-75`): `"chat.message"(input: { sessionID, ... }, output: { message: UserMessage; parts: Part[] })` — mutation is by in-place reference: PUSH onto `output.parts`, never reassign. Core queue: `flushFor(parentSessionID)` drains oldest-first and fire-and-forgets `markNotified` (`packages/core/src/notify.ts`); `seed(tasks)` was already wired at engine construction if 2.1.1 did its job — verify, don't duplicate. Toast surface: `client.tui.showToast` typed per `docs/sdk-surface-audit.md` row h (check exact params there). Notice dedup across restarts is core's job (`notified` flag persisted) — the hook layer stays dumb.

**Implementation vision:** `src/hooks/notifications.ts`: factory `createChatMessageHook(queue)` returning the hook fn: `queue.flushFor(input.sessionID)`; empty → return without touching output; else push ONE visible text part summarizing all notices (compact: "✅ bg_abc12345 'description' completed in 32s" lines) plus ONE `synthetic: true` text part with the retrieval hints (model-only instruction; verify the `Part` type allows `synthetic` on text parts — sdk-surface audit/types.gen, it does per Task 1.3.4's GatePart work). Toast wiring: in `engine.ts`, fill the `onNotify` callback left injectable by 2.1.1: `client.tui.showToast({ body: { title, message, variant } })` per the audited shape — wrap in try/catch+log (toast failure must never break completion teardown); status→variant mapping: completed→success, error→error, cancelled→info. `markNotified` callback → `store.save`-backed (verify 2.1.1 wired it; the queue calls it per flushed notice). Tests: fake queue + scripted output object — parts pushed in order (visible first, synthetic second), empty-flush no-op, part shapes structurally valid (`type: "text"`, `text`, `synthetic`); toast callback mapping per terminal status; toast throw swallowed+logged.

**Files:**
- Create: `packages/background-agents/src/hooks/notifications.ts`
- Modify: `packages/background-agents/src/engine.ts` (toast + markNotified wiring), `packages/background-agents/src/index.ts` (register hook)
- Test: `packages/background-agents/src/hooks/notifications.test.ts`

**Verification:** `bun test packages/background-agents` — green.

**Done when:** flush hook pushes visible+synthetic parts only when notices exist; toasts fire on live completion with correct variant; a queue/toast failure can never crash the hook (chat.message is prompt-pipeline — a throw here kills the user's message per the gotchas doc).

### Epic 2.3: Context forking

**Goal:** `bg_task(fork: true)` injects truncated parent history into the child via a `noReply` prompt.
**Scope:** `packages/background-agents/src/fork/`
**Dependencies:** Epic 2.1
**Done when:** forked child demonstrably answers from parent context; truncation validated against the REAL current message part schema (better-async's pipeline silently no-ops on schema drift — `tool_result` vs `tool` part types, `.references/better-opencode-async-agents/src/fork/index.ts:168,264`); compaction-boundary slicing, recency-tiered truncation, head+tail error preservation, linear-time budget trimming.

#### Task 2.3.1: Fork transcript builder (pure)

- [x] Done — real compaction markers found and honored: `AssistantMessage.summary?: boolean` AND `CompactionPart` (`type: "compaction"`); slice after the LAST of either (marker dropped). Drift predicate: zero blocks + any part with unextracted payload (non-text kind carrying `.text`, or tool part with output/error under an unknown status) → throw; all-legitimately-skippable → `""`. SDK shapes restated as local line-referenced interfaces with compile-time `satisfies` grounding (SDK isn't a direct dep of the plugin package).

**Context:** Input is the REAL `session.messages` shape: `{ info: Message, parts: Part[] }[]` — verify part type names against the installed SDK's `types.gen.d.ts` (audit row c/j; known kinds: `text` w/ optional `synthetic`, `tool` w/ `state.{status,output,error}`, `step-start`/`step-finish`, `file`, etc.). better-async's fork silently produced empty transcripts when part names drifted (`.references/better-opencode-async-agents/src/fork/index.ts:168,264`) — our builder must THROW on a transcript that yields zero content from a non-empty input (loud, not silent). Core already has truncation precedent: `readOutput`'s head+tail error preservation (session-runner.ts, Task 1.3.4) — same patterns, but this builder belongs to the plugin (presentation), not core.

**Implementation vision:** `src/fork/transcript.ts`: pure function `buildForkTranscript(messages, opts: { budgetChars?: number }): string` (default budget ~24k chars). Pipeline, all linear-time: (1) compaction-boundary slice — if a compaction/summary marker message exists (check the real schema for how compaction surfaces: `system` role summary or a part flag; inspect types.gen + one real transcript from the smoke harness data if needed), keep only messages after the LAST one; (2) map messages to blocks: user/assistant text parts verbatim (skip `synthetic`), tool parts as `[tool: name] <output>` with per-block caps; (3) recency-tiered truncation: newest N messages get generous per-block caps, older get tight caps (e.g. last 5 → 4000 chars/block, rest → 600); (4) error-pattern tool outputs (reuse the regex family from readOutput) get head+tail preservation instead of flat truncation; (5) final budget pass: drop OLDEST whole blocks until under budget (never mid-block cuts beyond the per-block caps); (6) wrap with header "Context forked from the parent session — for reference only; follow the task prompt below." Tests: pure-function table tests with REAL-shaped fixtures (steal shapes from a captured smoke transcript or hand-build against types.gen); named cases: schema-drift guard (non-empty input + zero extractable content → throws), compaction slice, tier boundaries, error head+tail, budget drop order, empty-input → empty string (NOT a throw — genuinely empty parent is valid).

**Files:**
- Create: `packages/background-agents/src/fork/transcript.ts`
- Test: `packages/background-agents/src/fork/transcript.test.ts`

**Verification:** `bun test packages/background-agents/src/fork` — all named cases green.

**Done when:** builder is pure, linear-time, throws on schema drift, and every truncation tier is under test.

#### Task 2.3.2: Fork wiring in `bg_task` + live e2e smoke for the plugin

- [x] Done — `LaunchRequest.contextParts?: TextPartInput[]` added (TextPartInput moved to types.ts, re-exported from session-runner.ts + core index; gained `synthetic?`); prepended BEFORE the prompt part in launch's `dispatchPrompt`. Fork seam: `createEngine` now returns `fetchSessionMessages(sessionID): Promise<ForkMessage[]>` (built on the adapted client's `session.messages`, widened once through `unknown` since the adapter statically narrows away `info.summary`/`tool`/compaction parts that the builder reads at runtime); `createBgTaskTool(runner, { fetchMessages })`. fork:false → fetchMessages never called; empty transcript → no contextParts; builder throw (drift) → honest error string + no launch. **LIVE BUG FOUND + FIXED (loud):** `bg_output(block:true)` with omitted `timeout_ms` got `NaN` (opencode's raw execute path does NOT apply Zod `.default()` — same artifact as bg_cancel's `all`), `NaN` reached `setTimeout(cb, NaN)` → fired ~1ms → block returned "still running" instantly → model gave up → child session **Aborted**. Fixed by defensive `Number.isFinite` coercion in output.ts + 2 regression tests. e2e smoke (`bun run smoke:agents`) PASS on A/B/C, stable across reruns; fork injection independently verified in the opencode SQLite store (the child session carries the `"Context forked from the parent session…"` synthetic part with the parent's codename). Harness scenario B reframed from "secret word → state it back" (which haiku refused as a jailbreak) to a benign release-codename handoff — the fork mechanism is identical.

**Context:** Injection channel (plan decision + custom-tools.md recipe): `client.session.prompt` with `body: { noReply: true, parts: [{ type: "text", text, synthetic: true }] }` into the CHILD session before the task prompt runs — but core's `launch()` currently sends the task prompt itself in `promptAsync`. Sequencing matters: the context must arrive before (or with) the task prompt. Options: prepend the transcript as an extra part in the launch `promptAsync` parts array (single prompt, ordering guaranteed) vs a separate `noReply` prompt first (two round-trips, race possible). PICK the single-prompt prepend: extend `LaunchRequest` with `contextParts?: TextPartInput[]` in core (small, typed, additive) so launch passes them ahead of the task prompt part. The e2e harness from 1.5.1 (`packages/core/test-harness/`) is the model for the plugin's own smoke: PWD pinning, OPENCODE_BIN, single-turn lifecycle (run-smoke.ts).

**Implementation vision:** (1) Core: add `contextParts?` to `LaunchRequest`, prepend in launch's parts array; unit test the ordering. (2) Plugin: `bg_task` gains `fork` (bool default false): fetch parent messages via the adapter (`session.messages` — expose on the engine or pass client into the tool factory; smallest clean seam), build transcript (2.3.1), pass as `contextParts: [{ type: "text", text: transcript, synthetic: true }]`. Empty transcript → launch WITHOUT context parts (don't send an empty header). (3) e2e: `packages/background-agents/test-harness/` mirroring 1.5.1's (opencode.json registering the REAL plugin entry via file:// path, run-script): scenario A — bg_task launches, completes, bg_output reads result; scenario B — fork: parent told a fact ("the secret word is X") in turn 1, forked bg_task asked to state the secret word, assert child's output contains it; scenario C — restart: second process, bg_list/bg_output show the recovered terminal task. Root script `"smoke:agents"`. Excluded from `bun test` (no *.test.ts names).

**Files:**
- Modify: `packages/core/src/types.ts`, `packages/core/src/session-runner.ts` (contextParts prepend), `packages/core/src/session-runner.test.ts`
- Modify: `packages/background-agents/src/tools/task.ts` (+ its test)
- Create: `packages/background-agents/test-harness/opencode.json`, `packages/background-agents/test-harness/run-smoke.ts`, `packages/background-agents/test-harness/README.md`
- Modify: `package.json` (smoke:agents script)

**Verification:** `bun test` green; `bun run smoke:agents` PASS on scenarios A/B/C against a live opencode.

**Done when:** forked child demonstrably answers from parent context in the live run, and the whole `bg_*` family is proven e2e with restart survival. **Phase 2 exit.**

---

## Phase 3 — Workflow runtime (library)

**Milestone:** `packages/workflows/src/runtime/` executes `WORKFLOWS_HL_SPEC.md`-conformant scripts against the Phase 1 engine in-process; spec-conformance test suite green. No plugin surface yet.

### Epic 3.1: Script parsing and sandboxed evaluation

**Goal:** Parse the pure-literal `meta` export, reject computed metas, evaluate the body with an explicit global allowlist and throwing stubs for `Date.now`/`Math.random`/argless `new Date` (determinism guard, spec §3.1-3.2; threat model is resume-cache poisoning, not containment — the author already holds bash).
**Scope:** `packages/workflows/src/runtime/`
**Dependencies:** Phase 1 (engine contract only)
**Done when:** valid scripts run; TypeScript syntax, computed meta, and banned builtins each fail with the spec's prescribed behavior.

> **Elaboration deviations (recorded 2026-06-06, post-Phase-2):** (a) Phase 3 introduces the repo's first third-party runtime deps — `acorn` (AST parsing; pure-literal meta validation and TS rejection are not honestly doable with regex) and `ajv` (JSON Schema validation, Epic 3.3). Both are zero-dependency ecosystem standards, scoped to `packages/workflows` only. (b) The "workflow-scoped concurrency key" of Epic 3.2 is a **standalone** `ConcurrencyManager` instance (`{ defaultConcurrency: min(16, cores−2) }`, key = runId) layered ABOVE the runner; the runner injected into the runtime must be configured with `defaultConcurrency: 0` (unlimited) or the workflow gate is not authoritative — Phase 4 wiring requirement, documented in the runtime's deps contract. (c) Epic 3.3's "small hook in core" is `LaunchRequest.onSessionCreated?: (sessionID: string) => void`, invoked SYNCHRONOUSLY between `session.create` resolving and the prompt dispatch (session-runner.ts:420-450) — closes the race where the child calls `structured_output` before the schema registry knows its sessionID.

#### Task 3.1.1: Scaffold `packages/workflows` + pure-literal meta parser

- [x] Done — `ef9323b`; 18 tests. Deviations: root `typecheck` script extended to cover the new package (gate was a no-op otherwise); acorn pinned 8.16.0 exact (repo convention); `whenToUse` included in WorkflowMeta per spec §3.2 (task sketch omitted it).

**Context:** The package does not exist. Mirror `packages/background-agents`' shape: `package.json` (`name: "opencode-drawer-workflows"`, `type: module`, `private: true`, deps `@drawers/core@workspace:*` + `acorn`, devDep `bun-types@1.3.14`) and two-line `tsconfig.json` extending `../../tsconfig.base.json` (see `packages/background-agents/tsconfig.json`). Spec §3.2: every script begins `export const meta = {...}` as a PURE literal — no variables, calls, spreads, or interpolation; `name` + `description` required strings; `phases` optional `{title, detail?, model?}[]`. Spec §3.1: scripts are plain JavaScript — TypeScript syntax fails to parse.

**Implementation vision:** `src/runtime/meta.ts`: `parseScript(source: string): ParsedScript` where `ParsedScript = { meta: WorkflowMeta, bodySource: string }`. Pipeline: (1) `acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" })` — a parse failure (including any TS annotation) surfaces as `ScriptSyntaxError` carrying acorn's message + position; (2) walk top-level nodes: exactly one `ExportNamedDeclaration` declaring `const meta` is required (missing → `MetaError("script must begin with export const meta = {...}")`); any OTHER import/export declaration → error "workflow scripts are self-contained — no imports/exports beyond meta"; (3) pure-literal walk of the meta `ObjectExpression`: allowed nodes are ObjectExpression with non-computed Identifier/string keys, ArrayExpression, and Literal of type string/number/boolean/null; EVERYTHING else (Identifier reference, CallExpression, SpreadElement, TemplateLiteral — even without interpolation — UnaryExpression, etc.) → `MetaError` naming the offending construct and its position; (4) materialize the literal into a JS value (recursive AST→value, NOT eval), validate `name`/`description` are non-empty strings, `phases` entries have string `title`; (5) `bodySource` = source with the meta export statement's `[start, end)` range blanked (replaced by whitespace of equal length so error line numbers in the body still map to the original script). No default export, no `export default meta` variant — one shape only.

**Files:**
- Create: `packages/workflows/package.json`, `packages/workflows/tsconfig.json`
- Create: `packages/workflows/src/runtime/meta.ts`
- Create: `packages/workflows/src/index.ts` (re-exports, grows with the phase)
- Test: `packages/workflows/src/runtime/meta.test.ts`

**Verification:** `bun test packages/workflows` — named cases: valid meta (full + minimal), TS syntax → ScriptSyntaxError, computed meta (identifier ref, call, spread, template literal, computed key — one case each), missing/empty name or description, stray import, stray second export, body line numbers preserved after blanking.

**Done when:** parser accepts spec-valid scripts and rejects each §3.1/§3.2 violation with a positioned, named error; package typechecks inside the workspace.

#### Task 3.1.2: Sandboxed body evaluation with determinism guards

- [x] Done — 15 tests. Deviations: `WorkflowDate` ctor typed `unknown[]` + cast to `typeof Date` (the zero-arg branch the spec bans is a tsc type error against real Date overloads; documented inline); console shadow joins varargs into ONE narrator string (reconciled to types.ts's `log(message: string)` contract).

**Context:** Spec §3.1: body runs in async context (top-level `await`, and the script's `return` value is the workflow result); `Date.now()`, `Math.random()`, argless `new Date()` THROW; no filesystem/Node APIs. Threat model is resume-cache poisoning (nondeterministic values reaching `agent()` prompts void the §7 replay cache), NOT containment — the author already holds bash. So shadowing by parameter injection is the right weight: no `vm`, no realms. Consumes `bodySource` from 3.1.1.

**Implementation vision:** `src/runtime/evaluate.ts`: `evaluateScript(bodySource, api: RuntimeApi): Promise<unknown>` where `RuntimeApi = { agent, pipeline, parallel, phase, log, args, budget, workflow }` (shapes owned by Epic 3.2; this task takes them as opaque injected values). Build via `AsyncFunction` constructor: parameter list = the 8 API names + the shadow list; body = `"use strict";\n` + bodySource (strict mode makes accidental global writes throw). Shadow list and values: `Date` → wrapper class (extends real Date; constructor with zero args throws `DeterminismError("new Date() is banned in workflow scripts — pass timestamps via args")`, with args passes through; static `now` throws; `parse`/`UTC` pass through), `Math` → `new Proxy(Math, { get })` throwing only on `random`, `globalThis` → frozen empty object (closes the `globalThis.Date.now()` bypass — the cache-poisoning path that parameter shadowing alone would miss), `process`/`require`/`module`/`exports`/`Bun`/`fetch` → `undefined`, `setTimeout`/`setInterval`/`setImmediate`/`queueMicrotask` → throwing stubs ("workflow scripts orchestrate agents; they do not schedule"), `console` → object whose `log`/`warn`/`error`/`info` forward to the injected `log()` (scripts naturally write `console.log`; routing beats throwing). Errors: constructor-time SyntaxError → `ScriptSyntaxError`; runtime throw inside the body propagates as-is (the runner layer in 3.2.3 wraps it with run context). Return: whatever the body `return`s (undefined allowed).

**Files:**
- Create: `packages/workflows/src/runtime/evaluate.ts`
- Test: `packages/workflows/src/runtime/evaluate.test.ts`

**Verification:** `bun test packages/workflows` — named cases: body returns value / awaits injected agent stub; `Date.now()` throws DeterminismError; `Math.random()` throws; argless `new Date()` throws but `new Date(123)` and `Math.floor` work; `globalThis.Date` unreachable; `process`/`fetch` undefined; `setTimeout` throws; `console.log` reaches `log()`; strict-mode accidental global throws; thrown body error propagates with message intact.

**Done when:** every banned builtin fails exactly as spec §3.1 prescribes, allowed builtins (`JSON`, `Math.floor`, `Array`…) work untouched, and the body's return value round-trips.

### Epic 3.2: Orchestration primitives

**Goal:** `agent()` (via `SessionRunner.awaitCompletion` — never parent-wake), `pipeline()` (no barrier, per-item chains, throw→null), `parallel()` (barrier, never rejects), `phase()`/`log()` (progress journal), `args`, concurrency caps (`min(16, cores−2)` via a workflow-scoped concurrency key), 1,000-agent lifetime cap, 4,096-item call cap.
**Scope:** `packages/workflows/src/runtime/`
**Dependencies:** Epic 3.1
**Done when:** spec §3.3/§4/§5/§9 semantics each have a conformance test (incl. degrade-don't-detonate: null propagation vs thrown caps).

#### Task 3.2.1: `agent()` primitive over the core runner

- [x] Done — 17 tests incl. max-in-flight==limit proof against real ConcurrencyManager. Deviations: `AgentPrimitiveDeps` exported as named interface (referenceable by 3.2.3 wiring); `awaitCompletion` timeout maps to null+warn like any throw (degrade) — a timed-out agent is indistinguishable from a crashed one at script level, by design.

**Context:** Spec §3.3 row 1 + §9: `agent(prompt, opts?)` resolves to the subagent's final text, or `null` on terminal failure/cancellation — never rejects for agent-level failure; ONLY caps/budget throw. Core provides everything needed: `runner.launch` (session-runner.ts:359-467), `runner.awaitCompletion`, `runner.readOutput` whose `summaryText` is exactly "last assistant message text" (session-runner.ts:632-644). SPAWN_GUARD already disables `bg_*`/`workflow*` in children (session-runner.ts:130-138) — workflow children inherit that for free. Concurrency: standalone `ConcurrencyManager` (concurrency.ts:56) accepts an arbitrary string key with `defaultConcurrency` — per elaboration deviation (b), key = runId, limit `min(16, cores − 2)`.

**Implementation vision:** `src/runtime/agent-call.ts`: `createAgentPrimitive(deps)` → the `agent` function injected into scripts. Deps: `{ runner: SessionRunner, parentSessionID, runId, gate: ConcurrencyManager, counters: { agents: number }, budget: BudgetView, emit: ProgressEmitter, defaults: { agent: string, awaitTimeoutMs?: number } }`. Flow per call: (1) lifetime check — `counters.agents >= 1000` → throw `AgentCapError` (spec §5: these ARE meant to stop the run); increment BEFORE acquire so queued calls count; (2) budget check — `budget.total !== null && budget.remaining() <= 0` → throw `BudgetExhaustedError` (Phase 3 ships the null-budget default, see 3.2.3; the check exists NOW so 4.3 only swaps the provider); (3) `await gate.acquire(runId)`; (4) `emit({ type: "agent:start", label, phase })` where label = `opts.label ?? prompt.slice(0, 60)`, phase = `opts.phase ?? currentPhase`; (5) `runner.launch({ parentSessionID, description: label, prompt, agent: opts.agentType ?? defaults.agent, model: opts.model, depth: 0 })` — depth 0 is correct: workflow children are first-level children of the host session and SPAWN_GUARD blocks their spawning anyway; (6) `runner.awaitCompletion(task.id, defaults.awaitTimeoutMs ?? 1_800_000)` (30 min; the engine's stale timeout is the real hang-stopper); (7) in `finally`: `gate.release(runId)` — release on EVERY path or the slot leaks; (8) map result: `completed` → `(await runner.readOutput(task.id)).summaryText`; `error`/`cancelled` → `null`; launch() itself throwing (depth guard, client failure) → log via emit + resolve `null` (degrade, don't detonate); (9) `emit({ type: "agent:end", label, status })`. `opts.isolation: 'worktree'` is accepted but ignored with an emitted warning line (OpenCode has no worktree session primitive; honest no-op, documented). `schema` opt is wired in 3.3.2 — here it throws `NotYetSupportedError` so 3.3's RED test exists naturally.

**Files:**
- Create: `packages/workflows/src/runtime/agent-call.ts`
- Create: `packages/workflows/src/runtime/types.ts` (`RuntimeApi`, `ProgressEvent`, `BudgetView`, error classes — the phase's internal contract)
- Test: `packages/workflows/src/runtime/agent-call.test.ts` (FakeRunner implementing `SessionRunner`)

**Verification:** `bun test packages/workflows` — named cases: completed → summaryText; error → null; cancelled → null; launch throw → null; 1001st call throws AgentCapError; gate slot released after error path (acquire again succeeds); concurrent calls beyond limit queue (FakeRunner with deferred completions: max in-flight == limit); start/end events emitted with label+phase.

**Done when:** all §9 null-vs-throw semantics for `agent()` hold under test and the gate provably bounds in-flight launches.

#### Task 3.2.2: `pipeline()` and `parallel()` composition

- [x] Done — 18 tests incl. deferred-controlled no-barrier interleaving proof. Deviation (load-bearing): `parallel` uses `Promise.resolve().then(() => thunk())` not `.then(thunk)` — `.then(nonCallable)` is identity-passthrough per ES spec, so the literal vision one-liner would yield `undefined` (not `null`) for non-function thunks; explicit invocation routes both sync throws and non-callable TypeError into `.catch(() => null)`. ItemCapError's canonical home is compose.ts (carries count/cap); types.ts re-exports.

**Context:** Spec §3.3 rows 2-3, §4, §5, §9. These are PURE composition functions — they never touch the runner; they compose whatever async functions the script passes (usually closures over `agent()`). `pipeline(items, ...stages)`: per-item independent chains, NO barrier between stages, stage signature `(prevResult, originalItem, index)`, a throwing stage drops THAT item to `null` and skips its remaining stages. `parallel(thunks)`: barrier, failing thunk → `null` in the result array, the call itself NEVER rejects. Both: >4096 items/thunks → explicit throw at call time (never silent truncation).

**Implementation vision:** `src/runtime/compose.ts`: two standalone exports, no deps — they get injected into scripts as-is. `pipeline`: validate `items.length <= 4096` (else throw `ItemCapError` with the actual count); `Promise.all(items.map(async (item, i) => { let prev = item; for (const stage of stages) { try { prev = await stage(prev, item, i); } catch { return null; } } return prev; }))` — the per-item loop IS the no-barrier property: nothing synchronizes across items. `parallel`: same cap check; `Promise.all(thunks.map(t => Promise.resolve().then(t).catch(() => null)))` — `Promise.resolve().then(t)` also catches SYNCHRONOUSLY-throwing thunks (a bare `t()` would reject the whole call). Edge cases pinned by tests: empty items/thunks → `[]`; zero stages → items returned as-is; non-function thunk → that slot `null` (it throws inside `.then`, caught); stage throw on item A does not affect item B's chain.

**Files:**
- Create: `packages/workflows/src/runtime/compose.ts`
- Test: `packages/workflows/src/runtime/compose.test.ts`

**Verification:** `bun test packages/workflows` — named cases incl. the no-barrier proof: deferred-controlled stages where item B finishes stage 2 while item A is still held in stage 1, asserted via an event order log; stage args `(prev, originalItem, index)` asserted at stage 2+; throw→null isolation; sync-throwing thunk; 4097 items → ItemCapError; never-rejects property for parallel.

**Done when:** the interleaving test proves no barrier exists in `pipeline`, `parallel` provably never rejects, and both caps throw with named errors.

#### Task 3.2.3: Runtime assembly + spec-conformance suite

- [x] Done — 20 new tests (conformance a-j + unit), full suite green. Deviations: meta.ts gained `allowReturnOutsideFunction: true` (LOAD-BEARING — ES-module parse forbade the spec-mandated top-level `return`; latent seam surfaced at first parse→evaluate integration); gate floor `max(1, ...)` (cores=2 would yield 0 = UNLIMITED in ConcurrencyManager); no separate phase progress event — phase titles flow via agent:start only (Phase 4 renders from there).

**Context:** Glue 3.1 + 3.2 into the phase's public surface: `createWorkflowRun`. Spec §2.3/§3.3: `phase(title)` sets the progress group for subsequent `agent()` calls (per-call `opts.phase` wins inside concurrent stages); `log(message)` emits a narrator line; `args` passed verbatim; `budget` present from day one (§6 view; Phase 3 default provider = `{ total: null, spent: () => 0 }` so `remaining()` is `Infinity` — 4.3 swaps in the real token source); `workflow()` throws `NotYetSupportedError("sub-workflows arrive with the workflows plugin (Phase 4)")` — a complete API surface beats a ReferenceError. Cores: `os.availableParallelism()` via `node:os` (Bun implements it), injectable for tests. The conformance suite drives the REAL `createSessionRunner` with the fake-EngineClient pattern from `packages/core/src/session-runner.test.ts:54-100` (`makeClient()` deferreds) — fidelity over a FakeRunner where it matters.

**Implementation vision:** `src/runtime/index.ts`: `createWorkflowRun(deps: { runner, parentSessionID, runId, args?, clock?, cores?, budget?, onProgress?, defaults? })` → `{ run(source: string): Promise<WorkflowResult>, abort(): void }`. `run`: (1) `parseScript` (3.1.1); (2) assemble `RuntimeApi` — `agent` from 3.2.1 (gate = `new ConcurrencyManager({ defaultConcurrency: Math.min(16, (cores ?? availableParallelism()) - 2) })`), `pipeline`/`parallel` from 3.2.2, `phase` = sets a `currentPhase` box read by agent-call at CALL time (the spec's documented race with concurrent stages is why `opts.phase` wins), `log` → progress event `{ type: "log", message }`, `args` verbatim, `budget` view, `workflow` throwing stub; (3) `evaluateScript` (3.1.2); (4) return `WorkflowResult = { meta, returnValue, progress: ProgressEvent[], agentCount, status: "completed" | "error", error? }` — body throw → `status: "error"` with message, NOT a rejection (the Phase 4 tool layer decides presentation). `abort()`: flips an internal flag making subsequent `agent()` calls resolve `null` immediately + `gate.cancelWaiters(runId)` — in-flight children are cancelled via `runner.cancel` on their taskIds (track live taskIds in a Set). Conformance suite (`conformance.test.ts`): scripts as template strings run against the real runner + scripted fake client — (a) meta + `return` round-trip; (b) `agent()` text result from a scripted child transcript; (c) degrade case: child error → `null` → script `.filter(Boolean)` works; (d) `pipeline` over 3 items with one poisoned stage; (e) `phase()`/`log()` ordering in the progress journal; (f) `Date.now()` inside a script → run resolves `status: "error"` with DeterminismError message; (g) budget-stub: `budget.total === null`, `remaining() === Infinity`; (h) cap conformance: cores=4 → limit 2 enforced.

**Files:**
- Create: `packages/workflows/src/runtime/index.ts`
- Modify: `packages/workflows/src/index.ts` (public re-exports: `createWorkflowRun`, types, error classes)
- Test: `packages/workflows/src/runtime/runtime.test.ts`, `packages/workflows/src/runtime/conformance.test.ts`

**Verification:** `bun test packages/workflows` all green; `bun test` (whole repo) green; `bun run typecheck && bun run lint`.

**Done when:** a spec-conformant script executes end-to-end against the real runner in-process with every §3/§4/§5/§9 behavior pinned by a named conformance case. **Library milestone for Epics 3.1-3.2.**

### Epic 3.3: Structured output

**Goal:** `agent(prompt, { schema })` returns a validated object: a single global `structured_output` tool whose expected JSON Schema is looked up per-session from runner state; mismatch returns a tool error so the model retries (spec's "validation at the tool-call layer").
**Scope:** `packages/workflows/src/runtime/`, small hook in core for per-session tool state
**Dependencies:** Epic 3.2
**Done when:** schema-conformant results resolve as objects; a deliberately nonconforming model response triggers retry-then-error, never a script-level parse failure.

#### Task 3.3.1: Core `onSessionCreated` hook + schema registry + validator

- [x] Done — hook ordering proven via call log (create → hook → promptAsync); throwing hook teardown combines the cancel-across-create orphan-abort idiom + create-rejection gate.tryComplete (the gate's error path alone would leak the session — only `cancelled` aborts); ajv 8.20.0 pinned. registry resultFor carries `present` flag (stored-undefined ≠ never-stored).

**Context:** The race this kills: `agent({ schema })` must have the child's sessionID → schema mapping registered BEFORE the child can call `structured_output` — but the sessionID only exists after `session.create` resolves, and `launch()` dispatches `promptAsync` immediately after (session-runner.ts:455-463). A post-launch registration loses the race. Per elaboration deviation (c): the hook is a SYNCHRONOUS callback in core's launch, between create resolving and the prompt dispatch. Validation: `ajv` (new dep, workflows package only) compiles the JSON Schema once per `agent()` call.

**Implementation vision:** (1) Core: add `onSessionCreated?: (sessionID: string) => void` to `LaunchRequest` (types.ts); in `launch()`, invoke it synchronously right after the cancel-across-create check passes and before `task.sessionID` is assigned/prompt dispatched (session-runner.ts:~448-455); a throwing callback fails the launch loudly (it's a programming error in the caller, not a child failure) — unit test both. (2) Workflows: `src/runtime/structured/registry.ts` — `createSchemaRegistry()`: `register(sessionID, compiledSchema)` / `take(sessionID)` (used by the tool: look up + later store) / `resultFor(sessionID)` / `clear(sessionID)`; a plain Map, no TTL (entries are cleared by agent-call's finally in 3.3.2). (3) `src/runtime/structured/validate.ts` — thin ajv wrapper: `compileSchema(schema: object): CompiledSchema` where `CompiledSchema.validate(value)` returns `{ ok: true } | { ok: false, errors: string }` (ajv error text flattened to one human/model-readable string — this string IS the retry signal the model sees). Invalid schema itself (ajv compile throw) → throw at `agent()` call time: that's a SCRIPT bug and must detonate, not degrade.

**Files:**
- Modify: `packages/core/src/types.ts` (LaunchRequest), `packages/core/src/session-runner.ts` (sync invoke)
- Test: `packages/core/src/session-runner.test.ts` (hook timing: called-before-prompt asserted via call-order log; throwing hook fails launch)
- Create: `packages/workflows/src/runtime/structured/registry.ts`, `packages/workflows/src/runtime/structured/validate.ts`
- Test: `packages/workflows/src/runtime/structured/registry.test.ts`, `packages/workflows/src/runtime/structured/validate.test.ts`
- Modify: `packages/workflows/package.json` (ajv)

**Verification:** `bun test packages/core packages/workflows` — hook ordering proven (create → hook → promptAsync in the fake client's call log); valid/invalid value validation; malformed schema compile → throw.

**Done when:** the hook fires synchronously pre-prompt under test, and validation produces model-readable error strings.

#### Task 3.3.2: `structured_output` tool factory + `agent({ schema })` wiring

- [x] Done — 44 tests for the slice; whole repo 304. Deviations: agent captured RED retroactively (stash-based, genuine failures against untouched tests — process slip, disclosed); parse-failure tool string carries the same retry cue as the validation path; `WorkflowRun` now exposes `registry` (Phase 4's global tool must bind the per-run instance — contract documented on the type). Process note recorded: stricter TDD ordering enforcement in future dispatch prompts.

**Context:** Spec §3.3: with `schema`, `agent()` resolves to the VALIDATED object; mismatches surface as tool errors so the MODEL retries — never a script-level parse failure; epic Done-when adds "retry-then-error" for a child that never produces conforming output. The tool is built and tested here as a factory (`ToolDefinition` via the `tool()` helper, same pattern as `packages/background-agents/src/tools/*.ts`); actual registration with opencode is Phase 4's plugin shell. Lesson from Phase 2 (NaN bug, task.ts/output.ts): opencode's raw execute path does NOT apply Zod defaults — coerce every arg defensively.

**Implementation vision:** (1) `src/runtime/structured/tool.ts`: `createStructuredOutputTool(registry)` → `tool({ description, args: { result: tool.schema.string().describe("JSON-encoded value conforming to the required schema") }, execute })`. Execute: registry lookup by `context.sessionID` — miss → error string "no structured output expected for this session"; `JSON.parse(args.result)` failure → error string with the parse message (model retries); validate via 3.3.1 — `ok: false` → return the flattened errors string prefixed "schema validation failed — fix and call structured_output again:" (THE retry mechanism: the model reads the tool result and re-calls); `ok: true` → store in registry, return "accepted". (2) agent-call wiring (replaces 3.2.1's NotYetSupportedError): when `opts.schema` present — compile schema (throw on malformed: script bug); launch with `onSessionCreated: (sid) => registry.register(sid, compiled)`, `toolsOverride: { structured_output: true }` (merged over SPAWN_GUARD, session-runner.ts:319-322), and prompt suffix: "\n\nYou MUST return your result by calling the structured_output tool with a JSON value conforming to this schema:\n<schema JSON>\nYour final text is ignored; only the tool call counts."; on completion — `registry.resultFor(sessionID)` set → resolve the OBJECT; unset (model never called the tool / never passed validation) → ONE nudge: `runner.resume(taskId, "You have not returned a structured result. Call the structured_output tool now…")` + `awaitCompletion` again → result or `null`; `finally`: `registry.clear(sessionID)`. Resume-throws (e.g. session expired) → `null`, degrade. (3) Conformance additions: fake-client child "calls the tool" by the test invoking `execute` with the child's sessionID mid-run — cases: valid-first-try → object; invalid-then-valid (tool returns retry string, second call accepted) → object, and the script never saw a parse error; never-calls → nudge issued (assert resume happened) → null; two concurrent `agent({schema})` calls with different schemas don't cross-validate (registry isolation).

**Files:**
- Create: `packages/workflows/src/runtime/structured/tool.ts`
- Modify: `packages/workflows/src/runtime/agent-call.ts` (+ its test), `packages/workflows/src/runtime/index.ts` + `packages/workflows/src/index.ts` (export the tool factory for Phase 4)
- Test: `packages/workflows/src/runtime/structured/tool.test.ts`, conformance additions in `packages/workflows/src/runtime/conformance.test.ts`

**Verification:** `bun test` (whole repo) green; `bun run typecheck && bun run lint`.

**Done when:** schema-conformant results resolve as validated objects, the invalid→retry→valid loop is proven at the tool layer, never-conforming children degrade to `null` after exactly one nudge, and registry entries never leak. **Phase 3 exit.**

---

## Phase 4 — `opencode-drawer-workflows` plugin

**Milestone:** Installable plugin: `workflow` / `workflow_status` / `workflow_stop` tools; journal-backed deterministic resume (same script+args → 100% cache hit); budget; sub-workflows (one level); a canonical multi-stage review workflow runs e2e.

### Epic 4.1: Plugin shell, run lifecycle, and progress

**Goal:** `workflow({script|scriptPath|name, args, resumeFromRunId})` returns immediately with runId + persisted script path; completion delivered via the passive notification channel; `workflow_status` renders the progress tree; saved workflows from `.opencode/workflows/`.
**Scope:** `packages/workflows/src/`
**Dependencies:** Phase 3
**Done when:** fire → continue conversation → notification → read result loop works e2e.

> **Elaboration deviations (recorded 2026-06-06, post-Phase-3):** (a) The opencode loader calls EVERY export of the registered entry as a function — but `packages/workflows/src/index.ts` is the library surface. The plugin entry is therefore a separate module (`src/plugin/index.ts`, single export) and package.json gains `exports: { ".": "./src/plugin/index.ts", "./lib": "./src/index.ts" }`. (b) `createChatMessageHook`/`createToastNotifier` move from background-agents into `@drawers/core` (both plugins must be independently installable; core already depends on `@opencode-ai/plugin`); background-agents re-imports. (c) `WorkflowRunDeps` gains optional `registry?: SchemaRegistry` — one plugin-level registry serves the single global `structured_output` tool across concurrent runs (sessionIDs are globally unique). (d) **Budget deviates from spec §6's shared pool**: `spent()` counts output tokens of workflow-spawned children only — sweeping the parent session per call is API-heavy and the main loop belongs to opencode; the `budget_tokens` tool arg prices the WORKFLOW, not the turn. Labeled, not hidden. (e) The workflows engine's runner is constructed with `defaultConcurrency: 0` (unlimited) per the Phase 3 deviation note — the workflow gate is the authoritative limiter.

#### Task 4.1.1: Hoist notification presentation into core

- [x] Done — moved suite passed with zero assertion edits (bit-identical proof). Deviations: logger retyped to core's `NotificationQueueLogger` (EngineLogger structurally assignable, agents compiles unchanged); render parametrization is ONE knob (`toastTitle`) — the other "agents-specific strings" turned out data-driven or already overridable; no invented knobs.

**Context:** `createChatMessageHook` (background-agents `src/hooks/notifications.ts:121-124`) and `createToastNotifier` (`:181-184`) are generic over `NotificationQueue`/`TaskNotice` (both already in core `notify.ts`) — nothing BgTask-specific beyond wording. The workflows plugin needs identical passive delivery (notice → parent's next message + toast) and MUST NOT import from `opencode-drawer-agents`.

**Implementation vision:** Move both factories (and their `ShowToast`/logger types) into `packages/core/src/notify-hooks.ts` essentially verbatim; parametrize the two strings that are agents-specific (the visible-line prefix and the synthetic hint header) as optional `render` options with the current text as defaults, so both plugins read naturally. Re-export from core index. background-agents `src/hooks/notifications.ts` becomes a thin re-import (or its call sites switch to core imports and the file is deleted — prefer deletion; its tests move to core, adjusted import paths only). No behavior change: the moved tests must pass unmodified in assertion content.

**Files:**
- Create: `packages/core/src/notify-hooks.ts`
- Modify: `packages/core/src/index.ts`
- Delete: `packages/background-agents/src/hooks/notifications.ts` (+ its test) after moving
- Modify: `packages/background-agents/src/index.ts` (imports from `@drawers/core`)
- Test: `packages/core/src/notify-hooks.test.ts` (moved, import paths adjusted)

**Verification:** `bun test` whole repo green (no assertion changes in the moved suite); `bun run typecheck && bun run lint`.

**Done when:** both plugins can consume passive notification delivery from core; agents plugin behavior is bit-identical.

#### Task 4.1.2: Plugin shell, engine assembly, run store, global structured_output

- [x] Done — strict TDD. Deviations: engine constructor is SYNC + `ready(): Promise<void>` recovery seam (startRun/dispose await it internally — closes the statusOf-vs-unfinished-load race); `stopRun` landed early (trivial via the settle path); two documented RunRecord⇄BgTask widenings (store + queue read only the minimal validated shape); queue `renderHint` overridden to point at `workflow_status`; core ids.ts gained `prefix?` (default "bg_" — additive).

**Context:** Mirror the background-agents plugin shape (`packages/background-agents/src/index.ts` + `engine.ts:86-164`). Core pieces all exist: `adaptSdkClient`, `createSessionRunner`, `createTaskStore` (generic — validates only id/parentSessionID/status, persistence.ts:104-126), `createNotificationQueue`. Library: `createWorkflowRun` (runtime/index.ts:43-85). Deviation (a): plugin entry is `src/plugin/index.ts` with the SINGLE export `WorkflowsPlugin: Plugin`.

**Implementation vision:** (1) Library change: `WorkflowRunDeps.registry?: SchemaRegistry` (default: own instance, current behavior; test both). (2) `src/plugin/engine.ts`: `createWorkflowEngine({ client, directory, dataDir?, onNotify?, logger? })` → `{ runs, runStore, queue, registry, startRun, stopRun, statusOf }`. Internals: `adaptSdkClient`; runner via `createSessionRunner` with `new ConcurrencyManager({ defaultConcurrency: 0 })` (deviation e) and its own task store at `<dataDir>/workflow-tasks` (env `OPENCODE_DRAWERS_DATA_DIR` passthrough like engine.ts:78-84); ONE `createSchemaRegistry()` shared across runs (deviation c); run records in a second `createTaskStore` at `<dataDir>/workflow-runs` — `RunRecord = { id: runId ("wf_"+8char via core createIdGenerator prefix option — check ids.ts; if prefix is fixed "bg_", extend with a prefix option), parentSessionID, status: "running"|"completed"|"error"|"cancelled", description: meta name, createdAt, completedAt?, scriptPath, args, returnValue?, error?, agentCount? }` persisted through the store's minimal-shape validation; script source persisted to `<dataDir>/workflow-scripts/<runId>.js` before execution (the spec's "persisted script path", returned by the tool). `startRun({ source, args, parentSessionID })`: create record → `createWorkflowRun({ runner, parentSessionID, runId, args, registry, onProgress })` → fire `run.run(source)` detached; on settle: update record (status/returnValue/error/agentCount), push `TaskNotice` into the queue (taskId=runId, description=meta name or "workflow", hint names `workflow_status`), toast via onNotify. In-memory `runs: Map<runId, { run: WorkflowRun, record, progress: ProgressEvent[] }>` (progress accumulates from onProgress). Startup recovery: `runStore.load()` — records still "running" from a dead process flip to error "interrupted by restart" (children are NOT auto-relaunched; same philosophy as core's recovered tasks). (3) `src/plugin/index.ts`: single export wiring `event` → runner.handleEvent, `chat.message` → core's createChatMessageHook(queue), `tool:` `{ structured_output: createStructuredOutputTool(engine.registry) }` (tools `workflow*` arrive in 4.1.3 — register the structured tool now so children can call it), toast notifier from core. (4) package.json `exports` map per deviation (a); verify the test-harness-style file:// registration loads the plugin entry, not the lib (no live harness yet — assert via a unit test that imports the entry module and checks exactly one export).

**Files:**
- Modify: `packages/workflows/src/runtime/index.ts` (+ runtime.test.ts: registry injection), `packages/workflows/package.json` (exports map), `packages/core/src/ids.ts` ONLY IF the prefix is hardcoded (+ test)
- Create: `packages/workflows/src/plugin/engine.ts`, `packages/workflows/src/plugin/index.ts`
- Test: `packages/workflows/src/plugin/engine.test.ts`, `packages/workflows/src/plugin/index.test.ts`

**Verification:** `bun test` green; named cases: startRun persists record+script then resolves runId immediately (before run settles); settle updates record + queues notice; restart recovery flips running→error; shared registry routes two concurrent runs; single-export entry.

**Done when:** the engine fires a run detached, persists its lifecycle, and delivers completion passively — all under test with fake runner/client.

#### Task 4.1.3: `workflow` / `workflow_status` / `workflow_stop` tools + saved workflows

- [x] Done — strict TDD, 27 tool tests. Status renders flat chronological list with phase headers (faithful to event order, no re-sorted tree). Note: saved dir is `.opencode/workflows/` (the spec's `.claude/` describes CC; the port follows the host's convention — already fixed in the epic goal). **Epic 4.1 exit.**

**Context:** Tool patterns: `packages/background-agents/src/tools/*.ts` (defensive arg coercion per the Phase 2 NaN lesson — opencode does NOT apply Zod defaults). `PluginInput.directory` is the project root — saved workflows live at `<directory>/.opencode/workflows/<name>.js`. Spec §2.2/§2.3.

**Implementation vision:** `src/plugin/tools/workflow.ts`: args `{ script?, script_path?, name?, args?, resume_from_run_id?, budget_tokens? }` — exactly one of script/script_path/name (coerce: treat empty strings as absent); `name` → read `<directory>/.opencode/workflows/<name>.js` (missing → honest error listing available files); `script_path` → read file (relative paths resolve against `directory`); `args` accepted as object OR JSON string (coerce); returns `{ runId, scriptPath, meta.name }` text immediately + guidance "do not poll; you'll be notified — workflow_status <runId> for progress" (no-poll guidance mirroring bg_task). `resume_from_run_id` is accepted but returns "resume lands in Task 4.2.2" until then (honest placeholder). `workflow_status.ts`: args `{ run_id }` → record status + progress tree rendered as text: group agent:start/end by phase (phase title or "(no phase)"), one line per agent `[done|running] label`, narrator `log:` lines interleaved in order, tail with returnValue (JSON, head-truncated at ~2000 chars) when completed / error when failed. `workflow_stop.ts`: args `{ run_id }` → engine.stopRun: run.abort() + record→cancelled + notice. All three: unknown run_id → error string listing known runIds. Register in plugin entry.

**Files:**
- Create: `packages/workflows/src/plugin/tools/workflow.ts`, `workflow-status.ts`, `workflow-stop.ts`
- Modify: `packages/workflows/src/plugin/index.ts`, `packages/workflows/src/plugin/engine.ts` (stopRun/statusOf as needed)
- Test: one test file per tool under `src/plugin/tools/`

**Verification:** `bun test` green; named cases: source-selection xor (0 and 2 sources → error); saved-name resolution + missing-name listing; args-as-JSON-string coercion; immediate return while run in flight; status tree shows phases/agents/logs in order; stop cancels live run and notice fires.

**Done when:** the fire → continue → notified → `workflow_status` read-result loop works under test end-to-end against the fake client. **Epic 4.1 exit.**

### Epic 4.2: Journal and deterministic resume

**Goal:** Append-only JSONL journal of `(callIndex, hash(prompt+opts), result)`; resume replays the script with longest-unchanged-prefix cache hits; first divergence runs live (spec §7).
**Scope:** `packages/workflows/src/journal.ts`, runtime integration
**Dependencies:** Epic 4.1
**Done when:** same-script+args resume reproduces the result with zero new agent launches; an edited mid-script call re-runs only itself and successors.

#### Task 4.2.1: Journal module + replay seam in the runtime

- [x] Done — strict TDD honored (module-not-found RED). JournalEntry lives in runtime/types.ts (runtime stays plugin-import-free). Deviation (narrower, safer): `load()` tolerates only a truncated FINAL line; interior bad lines throw — mid-file corruption must not silently void replay correctness.

**Context:** Spec §7: every run journals its `agent()` calls; resume replays — longest unchanged prefix of `(prompt, opts)` pairs returns cached results instantly; first edited/new call and everything after runs live. Call INDEX is deterministic: `pipeline`/`parallel` invoke their callbacks synchronously in array order and the determinism sandbox bans the only sources of ordering drift, so invocation order is stable across replays of an unchanged script. The structured variant's result (a JSON object) journals identically.

**Implementation vision:** (1) `src/plugin/journal.ts`: `createJournal({ path, fs? })` → `{ record(entry: JournalEntry): Promise<void>, load(): Promise<JournalEntry[]> }`; `JournalEntry = { index: number, key: string, status: "ok", result: unknown }` — only SETTLED non-null results are journaled (a null/failed agent must re-run on resume, not replay its failure); append-only JSONL, one `JSON.stringify` line per entry, writes serialized through a queue (reuse the per-task write-queue idiom from core persistence.ts); `load` tolerates a truncated final line (crash mid-append → drop it, log). Key: `sha256(stableStringify({ prompt, label, phase, schema, model, agentType }))` via `node:crypto`; `stableStringify` = recursive key-sorted JSON (small local helper; no dep). (2) Runtime seam: `WorkflowRunDeps.replay?: { entries: JournalEntry[], onRecord: (e: JournalEntry) => void }`. agent-call integration: maintain a call counter (the journal index — distinct from the lifetime cap counter); per call compute key; if `replay.entries[index]` exists AND `prefixIntact` (a run-level box, starts true) AND `entries[index].key === key` → emit `agent:start`/`agent:end` with status "cached" and resolve the journaled result WITHOUT launching (no gate acquire, no counters.agents increment — cached calls don't count against the lifetime cap... DECISION: they DO count; the cap is a runaway-loop backstop and replay must hit it at the same point the original did; increment but skip gate/launch); on key mismatch or index beyond entries → flip `prefixIntact` false forever (spec: everything after the first divergence runs live, even if a later key coincidentally matches); every LIVE settled non-null result → `replay.onRecord({ index, key, status: "ok", result })`.

**Files:**
- Create: `packages/workflows/src/plugin/journal.ts`
- Test: `packages/workflows/src/plugin/journal.test.ts`
- Modify: `packages/workflows/src/runtime/index.ts`, `packages/workflows/src/runtime/agent-call.ts` (+ both test files)
- Modify: `packages/workflows/src/index.ts` (export journal types for the plugin layer)

**Verification:** `bun test` green; named cases: journal round-trip incl. truncated-final-line tolerance; stable key (object key order irrelevant; schema present/absent distinguishes); replay full-prefix → zero launches (fake runner asserts no launch calls) with identical returnValue; mid-script divergence → live from that index even when a LATER key matches; null results never journaled (re-run live on resume); cached calls still increment the lifetime counter.

**Done when:** the runtime can replay a journal with the spec's longest-unchanged-prefix semantics, fully under unit/conformance test.

#### Task 4.2.2: Resume wiring in the plugin

- [x] Done — strict TDD. Cached hits now re-record via onRecord (one-line library change — every run's journal is standalone); restart resume proven (second engine over same dataDir → all-cached, zero launches); `appendFile` synthesized over FsFacade read-modify-write (safe under the journal's serial write chain). **Epic 4.2 exit.**

**Context:** Spec §2.2/§7: `Workflow({ scriptPath, resumeFromRunId })`; same script + same args → 100% cache hit; prior run must be stopped first; resume is same-session... relaxed here: same plugin instance OR post-restart (journal + script + record are all on disk — restart resume is a strict improvement over the spec and falls out of the persistence design; take it). The 4.1.3 `workflow` tool already accepts `resume_from_run_id` as a placeholder.

**Implementation vision:** engine `startRun` gains `resumeFromRunId?`: (1) guard — referenced record must exist (error listing known runs) and must NOT be currently running in this instance (error "stop it first: workflow_stop <id>"); (2) script source: explicit `script`/`script_path`/`name` wins; absent → load the PRIOR run's persisted `scriptPath` (the edit-and-reinvoke loop: user edits the persisted file, passes resume id only); (3) args: explicit args win; absent → prior record's args (spec: same args → full hit); (4) load journal of the prior run → `replay.entries`; new run gets its OWN runId + journal file seeded by `onRecord` (cached entries are re-recorded as they replay so the new journal is complete standalone — decision: re-record cached hits; keeps every run's journal self-contained); (5) record carries `resumedFrom: priorRunId` for the status tree header. workflow tool: replace the 4.1.3 placeholder; `workflow_status` shows "resumed from wf_xxx, N/M calls cached" (count cached vs live from progress events' "cached" status).

**Files:**
- Modify: `packages/workflows/src/plugin/engine.ts`, `src/plugin/tools/workflow.ts`, `workflow-status.ts` (+ tests)

**Verification:** `bun test` green; named cases: same script+args resume → zero fake-runner launches, identical returnValue, status shows M/M cached; edited script (one prompt changed mid-way) → calls before the edit cached, the edited one and ALL after run live; resume of a still-running run → refused; resume after simulated restart (new engine instance over the same dataDir) works; explicit new args defeat the cache exactly when they reach a prompt.

**Done when:** the edit → re-invoke → prefix-cached loop works against persisted state, incl. across an engine restart. **Epic 4.2 exit.**

### Epic 4.3: Budget and sub-workflows

**Goal:** `budget.total/spent()/remaining()` from SDK token usage (spike first: verify usage metadata on assistant messages per the 1.1.2 audit; fallback = labeled char-based estimation); hard-ceiling throw on exhaustion; `workflow()` sub-workflow sharing caps/budget/abort, nesting depth 1 (spec §6/§8).
**Scope:** `packages/workflows/src/`
**Dependencies:** Epic 4.2
**Done when:** loop-until-budget conformance test halts at the ceiling; nested sub-workflow inside a child throws.

#### Task 4.3.1: Token budget provider

- [x] Done — strict TDD, 12 budget tests + integration. Sequential accuracy proven (call 2's pre-check sees call 1's spend); the §6 loop idiom halts via its own guard with the direct-call throw asserted separately (truer conformance than forcing mid-loop). recordTask on the live path only — cached replays charge nothing. One honest widening at the engine fetchMessages closure (GateMessage narrows tokens away).

**Context:** Audit row m confirms `AssistantMessage.tokens = { input, output, reasoning, cache: { read, write } }` + `cost`, carried by `session.messages()` (the adapter does not strip them at runtime — engine.ts widening precedent from fork). The spike the epic asked for is therefore already answered: token metadata is typed and reachable; no char-based fallback needed. Per elaboration deviation (d): `spent()` counts workflow children only.

**Implementation vision:** `src/plugin/budget.ts`: `createTokenBudget({ total, fetchMessages })` → `BudgetView & { recordTask(sessionID): Promise<void> }`: an accumulator; `recordTask` fetches the child session's messages once, sums assistant `tokens.output + tokens.reasoning` (reasoning is output-priced; document), adds to the counter — fenced: a fetch failure logs and adds 0 (budget must never crash a run). agent-call integration: after `awaitCompletion` settles (any terminal status), if deps.budget exposes `recordTask` AND the task has a sessionID, await it BEFORE resolving — so the budget check of the NEXT agent() call sees this call's spend (sequential loops, the spec's §6 idiom, stay accurate; concurrent calls are best-effort by nature — document). Type it as an optional structural extension: `BudgetView & Partial<{ recordTask }>` checked at runtime (the library keeps no plugin dependency). Engine wiring: `budget_tokens` arg (4.1.3 already accepts it) → `createTokenBudget({ total: budget_tokens, fetchMessages: adapted client })`; absent → null-budget default as today. `workflow_status` shows `spent/total` when a total exists. Cached replay calls record nothing (no session) — resumed runs re-spend only live calls, which is exactly right.

**Files:**
- Create: `packages/workflows/src/plugin/budget.ts` (+ test)
- Modify: `packages/workflows/src/runtime/agent-call.ts` (+ test), `src/plugin/engine.ts`, `src/plugin/tools/workflow-status.ts` (+ tests)

**Verification:** `bun test` green; named cases: loop-until-budget conformance script (`while (budget.total && budget.remaining() > N) { await agent(...) }` with scripted per-child token counts) halts at the ceiling via BudgetExhaustedError → run status error mentioning budget; sequential accuracy (call 2's check sees call 1's spend); fetch-failure adds 0 and warns; no budget → Infinity semantics unchanged.

**Done when:** the §6 dynamic-scaling idiom works against scripted token counts, hard ceiling included.

#### Task 4.3.2: Sub-workflows + live e2e smoke — Phase 4 exit

- [x] Done — smoke A/B/C PASS (verified independently). **Three production bugs caught live, each with regression test:** (1) engine never persisted scripts/journals in production — all fs paths were `if (fs)`-gated and the entry injects none; fix: node-fs default; (2) journal appends fire-and-forget — single-turn exit dropped unflushed writes; fix: drain before `settled`; (3) **replay indexed the journal positionally but concurrent agents record in COMPLETION order** — resume was silently broken for every pipeline/parallel workflow (all prior tests were sequential); fix: byIndex Map lookup (agent-call.test.ts:611). Deviations: scenario C probes the plugin's own task store, not opencode's 21GB global SQLite; `wait_ms` on workflow_status (cap 120s) as the honest single-turn port of CC's task-notification re-invocation. **Phase 4 exit.**

**Context:** Spec §8: `workflow(nameOrRef, args?)` runs a child workflow inline, returns its return value; child shares the parent's concurrency cap, agent counter, abort signal, budget (and here: schema registry); nesting depth 1 — `workflow()` inside a child throws; unknown name / unreadable path / child syntax error throw synchronously (catchable in the script). The runtime's `workflow` global is currently the NotYetSupported stub (runtime/index.ts). Live-harness model: `packages/background-agents/test-harness/` (PWD pinning, OPENCODE_BIN, file:// plugin registration, OPENCODE_DRAWERS_DATA_DIR).

**Implementation vision:** (1) Library: `WorkflowRunDeps.resolveSubWorkflow?: (nameOrRef: string | { scriptPath: string }) => Promise<string>` (returns script SOURCE; plugin provides fs/saved-name resolution — library stays fs-free). Runtime builds the child run internally: same gate, same counters object, same budget, same registry, same liveTasks/abort latch; child's OWN progress events forwarded to the parent's journal wrapped under a `workflow:<name>` phase prefix (decision: prefix the child's agent labels with `<meta.name>/` rather than a new event type — Phase 4 status tree gets nesting for free); child deps get `resolveSubWorkflow: undefined` → child's `workflow` global throws NestingError (depth 1 enforced structurally, not by flag-counting). Child meta/script errors → synchronous throw out of `workflow()` (catchable); child run executing with `status: "error"` → `workflow()` THROWS that error too (spec: errors throw, unlike agent's null — §8 lists them as throwing). Replay: the child's agent calls flow through the SAME journal/replay seam as the parent's (shared call counter) — a resumed parent replays straight through child calls; document that editing the child's saved file voids the prefix from the first child call (key includes prompt, and child prompts derive from the child source… they don't — keys are per agent() call. DECISION: include a synthetic journal entry for the workflow() call itself: key = hash of (resolved child SOURCE + args), so a child-script edit breaks the prefix exactly at the workflow() boundary; entry result = child returnValue; on replay-hit, the child is not re-run at all). (2) Plugin: engine provides the resolver (saved names from `.opencode/workflows/`, `{scriptPath}` against `directory`). (3) e2e: `packages/workflows/test-harness/` mirroring the agents harness — opencode.json registers the plugin entry file://; scenario A: inline canonical two-stage review workflow (pipeline of 2 items → agent per item → parallel verify) over trivial prompts, assert completed + returnValue shape + notification part in a follow-up parent turn; scenario B: `workflow_stop` mid-run → cancelled; scenario C: resume — run A's runId resumed with same script → status shows all-cached, zero new child sessions in the opencode store. Root script `smoke:workflows`. (4) README documenting the harness env knobs (copy the agents README structure).

**Files:**
- Modify: `packages/workflows/src/runtime/index.ts`, `agent-call.ts` or a new `src/runtime/sub-workflow.ts` (+ tests), `src/plugin/engine.ts` (+ test)
- Create: `packages/workflows/test-harness/opencode.json`, `run-smoke.ts`, `README.md`
- Modify: root `package.json` (`smoke:workflows`)

**Verification:** `bun test` green (sub-workflow conformance: shared caps/budget/registry, nesting throw, error-throw semantics, child-edit breaks prefix at the boundary); `bun run smoke:workflows` PASS A/B/C against live opencode.

**Done when:** the canonical review workflow runs e2e on a real opencode with passive completion, stop, and all-cached resume proven live. **Phase 4 exit.**

---

## Phase 5 — Ship

> Elaboration note (2026-06-06): the original Epic 5.1 mixed documentation and npm
> publish. Split: Epic 5.1 (documentation) executes now; Epic 5.2 (npm publish)
> stays epic-level and runs in a separate session (publish requires interactive
> npm auth at the keyboard). Docs are written npm-first: each package README is
> the package's npm landing page.

### Epic 5.1: Documentation

**Goal:** Each plugin has a self-contained README that serves as its npm page (install, config, tool reference, and — for workflows — the complete script-authoring manual); the repo has a root README presenting the drawer and the development workflow. Every example is verified against the real code.
**Scope:** `README.md` (new, root), `packages/background-agents/README.md` (new), `packages/workflows/README.md` (new)
**Dependencies:** Phases 2, 4
**Done when:** docs-reviewer pass is clean; every tool name, option, env var, path, and script example in the docs matches the source; workflow script examples parse through the real `parseScript`.

#### Task 5.1.1: README for `opencode-drawer-agents`

- [x] Done

**Context:** The plugin exposes `bg_task`/`bg_output`/`bg_cancel`/`bg_list` (`packages/background-agents/src/index.ts:80-87`). No user-facing docs exist anywhere. Data persists under `$OPENCODE_DRAWERS_DATA_DIR` → `$XDG_DATA_HOME` fallback. Completion notices are passive: TUI toast + flushed into the parent's next message via the `chat.message` hook (design decision 1). Tasks survive opencode restarts (Phase 2 exit criterion).

**Implementation vision:** One README, npm-first structure: what it is (one paragraph — fire-and-forget background agents for OpenCode), install (`opencode.json` `"plugin": ["opencode-drawer-agents"]` once published; `file://` form for local dev, marked as such), tool reference table with every parameter read from the actual tool definitions in `packages/background-agents/src/tools/*.ts` (schema names, defaults, coercions — read the code, not memory), notifications model (passive-only; why there is no active wake), persistence/restart behavior, env vars. No marketing prose. Examples are realistic single-turn agent interactions.

**Files:**
- Create: `packages/background-agents/README.md`

**Verification:** Every tool name/parameter cross-checked against `src/tools/*.ts` schemas; docs-reviewer pass in Task 5.1.4.

**Done when:** a reader with zero context can install, fire a background task, read its output, and explain where state lives.

#### Task 5.1.2: README + authoring manual for `opencode-drawer-workflows`

- [x] Done

**Context:** The plugin exposes `workflow`/`workflow_status`/`workflow_stop`/`structured_output` (`packages/workflows/src/plugin/index.ts:88-93`). The script runtime API is `agent`/`pipeline`/`parallel`/`phase`/`log`/`args`/`budget`/`workflow` (`packages/workflows/src/runtime/types.ts:83-93`). Determinism bans live in `packages/workflows/src/runtime/evaluate.ts` (Date.now, Math.random, argless `new Date`, scheduling primitives; `console.*` → narrator log). Meta must be a pure literal (`runtime/meta.ts`). Caps: 1000 agent calls lifetime, 4096 items per composition, concurrency gate `min(16, cores−2)`. Resume: journal-backed longest-unchanged-prefix replay, only settled non-null results journaled, works across restarts (`plugin/journal.ts`, `runtime/keys.ts`). Budget: hard ceiling over child sessions' output+reasoning tokens (`plugin/budget.ts`) — note the declared deviation from CC's shared-pool semantics. Sub-workflows: depth-1, saved names resolve from `.opencode/workflows/<name>.js|.mjs`, child error THROWS (unlike `agent()`'s null). `workflow_status` has `wait_ms` (cap 120000) as the single-turn substitute for CC's task notifications.

**Implementation vision:** One self-contained README — it is simultaneously the npm page and the authoring manual (no split into a separate guide; npm relative links are brittle and the surface fits one well-structured doc). Sections: what it is, install, the three tools (+ `structured_output` explained as an internal child-session tool, not user-invoked), then "Writing workflows": meta block format, the eight globals with signatures, `pipeline` vs `parallel` (no-barrier default, when a barrier is right), determinism rules with the *why* (replay-cache poisoning), caps, structured output via `schema`, budget, resume semantics (what re-runs, what replays, what breaks the prefix), saved workflows, sub-workflows. Close with 2–3 complete worked examples, including the canonical review workflow already proven live in `test-harness/run-smoke.ts`. Every example script must parse via the real `parseScript`.

**Files:**
- Create: `packages/workflows/README.md`

**Verification:** Extract every fenced workflow script from the README and run each through `parseScript` from `packages/workflows/src/runtime/meta.ts` (a throwaway bun script is fine); all parse. Tool parameters cross-checked against `src/plugin/tools/*.ts` schemas.

**Done when:** a model (or human) can author a correct workflow script from the README alone — meta, API, determinism, resume — without reading the source.

#### Task 5.1.3: Root README

- [x] Done

**Context:** The repo is a Bun-workspace monorepo: `packages/core` (shared engine, npm-private), `packages/background-agents` (`opencode-drawer-agents`), `packages/workflows` (`opencode-drawer-workflows`). Root `package.json` carries `test`, `typecheck`, `lint`, `smoke:agents`, `smoke:workflows` scripts. The "drawer" concept: independently installable OpenCode plugins sharing one engine.

**Implementation vision:** Short root README: the drawer concept (two paragraphs max), a plugin matrix table linking to each package README, quickstart install, development section (bun install / test / typecheck / lint / smoke harnesses — note smoke requires a real opencode binary and hits a live model), repo layout, license. The root README routes; the package READMEs teach. No duplication of tool reference content.

**Files:**
- Create: `README.md`

**Verification:** Every script name matches root `package.json`; links resolve to real paths; docs-reviewer pass in Task 5.1.4.

**Done when:** a visitor understands what the repo ships and how to develop in it within one screen of reading.

#### Task 5.1.4: Documentation review pass

- [x] Done — docs-reviewer found 2 HIGH factual errors (bg_output `timeout_ms` clamp range misstated; `OPENCODE_DRAWERS_DATA_DIR` appends no `tasks` suffix in the agents store — README implied symmetry with XDG tiers) + 1 gap (30-min per-agent timeout undocumented); all fixed and spot-checked against source. All other dimensions clean. ~~⚠️ Pre-publish flag for Epic 5.2: the same env var behaves differently across plugins~~ — RESOLVED same day (user-ordered): one canonical `resolveDataBaseDir` in core (explicit → env → `$XDG/opencode-drawers`); agents tasks at `<base>/tasks`, workflows at `<base>/workflow-*`. The alignment also fixed a latent production gap: with the env var unset (default install), the workflows engine's `scriptsDir`/`journalsDir` were `undefined` → no script/journal persistence → no restart resume; regression test added (engine.test.ts default-install resume).

**Context:** Tasks 5.1.1–5.1.3 are written in parallel by separate agents; cross-document consistency (terminology, install instructions, the passive-notification story told the same way twice) is nobody's job until this task.

**Implementation vision:** Dispatch docs-reviewer over the three new READMEs with the source tree available. Review for: factual accuracy against code (tool names, parameters, paths, env vars, caps, defaults), internal consistency across the three docs, voice (technical, terse, no marketing), and completeness against each task's done-when. Findings fixed in place; re-review only the changed sections.

**Files:**
- Modify: `README.md`, `packages/background-agents/README.md`, `packages/workflows/README.md` (fixes only)

**Verification:** docs-reviewer reports no blocking findings; orchestrator spot-checks one fact per doc independently.

**Done when:** review clean; Epic 5.1 done-when satisfied.

### Epic 5.2: npm publish

**Goal:** Both plugins on npm (`opencode-drawer-agents`, `opencode-drawer-workflows`), each self-contained (core bundled or published as `@drawers/core` dependency — decide at publish against OpenCode's npm-install behavior); publishing per `.claude/skills/opencode-plugin-dev/references/publishing.md`; MIT license.
**Scope:** `packages/*/package.json`, build/bundle config, `LICENSE`
**Dependencies:** Epic 5.1 (READMEs ship inside the packages)
**Done when:** a clean project with only `"plugin": ["opencode-drawer-agents", "opencode-drawer-workflows"]` in `opencode.json` gets working tools on startup.

*(Tasks elaborated when execution reaches this epic — requires interactive npm auth; scheduled for a separate session.)*

---

## Phase 6 — CC parity: correctness, observability, wake

**Milestone:** Workflows and background agents behave like Claude Code's: structured results survive slow real-world turns, the main session sees live workflow progress, and completion actively wakes an idle parent session.

> **Origin (2026-06-07):** Fred's first real workflow (`wf_801501pc`, 4 ring reviewers vs the helm branch) returned `null` from all four agents despite every reviewer producing a valid schema-conforming verdict. Root cause traced live (registry instrumentation + exact-script replay + opencode SQLite transcript forensics): the completion gate's missed-idle poll fallback (`packages/core/src/completion.ts`, `DEFAULT_MIN_IDLE_MS`/`DEFAULT_POLL_MS` = 5000) validates ANY assistant output in the transcript — including the PREVIOUS turn's — so a ≥2-poll silent gap (e.g. ~28s first-token latency on an opus reviewer's nudge turn) completes the task mid-turn. `resolveStructured` then reads an empty registry slot, degrades to null, and its `finally` clears the schema; the child's later `structured_output` call gets "no structured output expected". Evidence: task-record spans of exactly 10.002s/15.011s/14.995s/25.01s (poll multiples), replay diag showing `clear` with no prior `lookup`. A second bug found during replay: absolute `script_path` is broken (`resolve-source.ts` `joinPath` strips the leading `/` and roots it at the project dir).

### Epic 6.1: Correctness — turn watermark + absolute script_path

**Goal:** A resumed (nudged) child that thinks for >10s before its first token is no longer falsely completed; structured output survives real reviewer workloads; `workflow` accepts the absolute `script_path` it itself hands out; the smoke harness exercises the schema path e2e.
**Scope:** `packages/core/src/completion.ts` (+ session-runner reset seam), `packages/workflows/src/plugin/resolve-source.ts`, `packages/workflows/test-harness/run-smoke.ts`
**Dependencies:** none
**Done when:** unit tests prove stale-output polls cannot complete a freshly-dispatched turn; absolute script_path resolves; smoke includes a schema scenario whose returnValue carries the validated object.

#### Task 6.1.1: Completion-gate turn watermark

- [x] Done — `39f5cc7`. Watermark = timestamp (`AssistantMessage.time.created` is typed in SDK 1.16.2); stamped at the single `dispatchPrompt` site; `validatedSessions` evicted on stamp; RED captured (poll AND idle paths flipped `completed` off stale output). `GateMessage.info` gained required `time.created` — test fixtures in 3 downstream files updated (type-sync only).

**Context:** `packages/core/src/completion.ts` — the gate completes a task via (a) `session.idle` + min-idle grace and (b) a 5s safety poll whose quiet-session branch calls `outputIsValid(sessionID)` (`completion.ts:334-353`). `outputIsValid` fetches messages and accepts ANY assistant output (`hasValidOutput`), and caches positives in `validatedSessions`. After `resume()` (`session-runner.ts:530-575`, used by the structured-output nudge at `agent-call.ts:320-332`), the previous turn's output instantly validates → premature completion during any silent gap. The gate already exposes a resume-reset seam (`completion.ts:132` — "restarts the idle/stale activity clock"); `session-runner.resume` calls it after flipping the task to running.

**Implementation vision:** Per-task **turn watermark**: record when the current turn was dispatched — set on launch's `dispatchPrompt` and again on resume's. Output validation only accepts assistant messages created AFTER the watermark (verify the fetched message shape carries a creation timestamp via the typed SDK — see `docs/sdk-surface-audit.md`; if timestamps are unavailable, fall back to a message-count/last-id watermark captured at dispatch). The resume reset MUST also evict the session from `validatedSessions` (a turn-N validation must not carry into turn N+1). `session.idle`-driven completion keeps its existing grace logic (the stale-idle guard at `completion.ts:581` already covers it) — the watermark applies wherever `outputIsValid`/`hasValidOutput` decide completion; map every caller and apply uniformly. No new config knobs; `DEFAULT_MIN_IDLE_MS`/`DEFAULT_POLL_MS` unchanged. TDD non-negotiable: RED test first reproducing the false completion (launch → turn 1 completes → resume → silent gap → poll with only-stale output MUST NOT complete → post-watermark output arrives → completes).

**Files:**
- Modify: `packages/core/src/completion.ts`
- Modify: `packages/core/src/session-runner.ts` (watermark stamping at both dispatch sites)
- Test: `packages/core/src/completion.test.ts`, `packages/core/src/session-runner.test.ts`

**Verification:** `cd packages/core && bun test` — new watermark describe RED first (captured), then GREEN; full suite + `bun run typecheck` + `bun run lint` clean.

**Done when:** the stale-output false-completion is reproduced by a failing test, fixed, and the whole-repo suite passes.

#### Task 6.1.2: Absolute script_path resolution

- [x] Done — `d08cbc7`. Leading-`/` passthrough; relative join unchanged; RED captured.

**Context:** `packages/workflows/src/plugin/resolve-source.ts:80` — `joinPath(directory, nameOrRef.scriptPath)` strips a leading `/`, so an absolute path is silently rooted at the project dir and fails to read. The `workflow` tool's own output hands the model the persisted ABSOLUTE script path for iteration, so this breaks our documented resume/iterate loop.

**Implementation vision:** In the resolver, a `scriptPath` starting with `/` is used verbatim; relative paths keep the existing project-dir join. No tilde expansion, no normalization beyond that — smallest correct change. RED test: resolver with an absolute path outside the project dir reads the file (in-memory fs fixture keyed by the absolute path).

**Files:**
- Modify: `packages/workflows/src/plugin/resolve-source.ts`
- Test: `packages/workflows/src/plugin/resolve-source.test.ts`

**Verification:** `cd packages/workflows && bun test resolve-source` RED → GREEN; full suite clean.

**Done when:** absolute and relative `script_path` both resolve; tests prove each.

#### Task 6.1.3: Smoke scenario D — structured output e2e

- [x] Done — `254805d`. D asserts the persisted returnValue is the validated object. Scope addition (approved in-flight): Scenario C's stdout regex was a pre-existing deterministic blocker (model paraphrases tool output — three distinct false-failure modes observed); C now asserts persisted state only (task-file count + returnValue deep-equal). Full A→D green in a single run.

**Context:** `packages/workflows/test-harness/run-smoke.ts` covers pipeline/parallel/phase/sub-workflow/stop/resume but NEVER passes `schema` — the gap that let the registry/gate bug ship. The schema happy path is cheap to verify live (haiku answers the structured suffix within the grace window; see the 2026-06-07 repro).

**Implementation vision:** Add Scenario D after C: a one-agent workflow with `schema: { type:'object', properties:{ verdict:{type:'string'} }, required:['verdict'] }`, asserting the persisted run record's `returnValue` carries the validated OBJECT (not a string, not null). Follow the existing scenario structure (`runUntilRunAppears` + `waitForTerminal`). The slow-gap/nudge case is NOT live-testable deterministically (model-behavior dependent) — it is covered by 6.1.1's unit tests; note that honestly in the scenario comment.

**Files:**
- Modify: `packages/workflows/test-harness/run-smoke.ts`

**Verification:** `bun packages/workflows/test-harness/run-smoke.ts` — all scenarios PASS including D.

**Done when:** smoke fails if structured output regresses to null/string on the happy path.

### Epic 6.2: In-session workflow observability

**Goal:** The main session can see what a running workflow is doing — CC-style: architecture echo at submit, per-agent elapsed, live progress while blocked.
**Scope:** `packages/workflows/src/plugin/engine.ts` (event stamping), `plugin/tools/workflow.ts`, `plugin/tools/workflow-status.ts`, `plugin/index.ts`
**Dependencies:** Epic 6.1 (status must report trustworthy results)
**Done when:** during a live run, `workflow_status` shows per-agent elapsed and the TUI tool line updates while `wait_ms` blocks; the `workflow` return echoes the flow architecture; sending any message mid-run surfaces a one-line digest.

#### Task 6.2.1: Timestamped progress + elapsed rendering

- [x] Done — `f3d119a`

**Context:** `ProgressEvent` (`packages/workflows/src/runtime/types.ts:53-57`) carries no timestamps, so `workflow_status` can render elapsed only for terminal runs (`completedAt - createdAt`). The runtime is deliberately clock-free; the engine has the injected `Clock` and pushes events at `engine.ts:588-591` (`onProgress`).

**Implementation vision:** Stamp at the ENGINE boundary, not in the runtime: engine wraps each event as `StampedProgressEvent = ProgressEvent & { at: number }` (`clock.now()`) before pushing to `handle.progress` — runtime types stay clock-free, fake clocks keep tests deterministic. `workflow-status` render gains: header `running <elapsed>` for LIVE runs (`clock.now() - createdAt` — the engine exposes its clock or the handle carries a `now()` view); per-agent elapsed on done/failed/cached markers (`end.at - start.at`, pairing first-unmatched-start per label — labels may repeat, chronological pairing is the documented approximation); a counts line `N running / N done / N failed / N cached` while live. Recovered runs (no in-memory progress) render as today.

**Files:**
- Modify: `packages/workflows/src/plugin/engine.ts`
- Modify: `packages/workflows/src/plugin/tools/workflow-status.ts`
- Test: `packages/workflows/src/plugin/tools/workflow-status.test.ts`, `packages/workflows/src/plugin/engine.test.ts`

**Verification:** `cd packages/workflows && bun test` — RED first on the new render expectations.

**Done when:** a live status render shows total elapsed + per-agent elapsed + counts, all driven by fake-clock-stamped events.

#### Task 6.2.2: Architecture echo at submit

- [x] Done — `f3d119a`

**Context:** The `workflow` tool's immediate return (`plugin/tools/workflow.ts`, execute path) hands back only run id + script path + "running in background" prose. The parsed meta (name/description/phases) is already in hand at submit; the script source is too.

**Implementation vision:** Extend the immediate return with a compact architecture block: meta name + phases (from the validated meta), plus a "detected primitives" line from cheap regex counts over the source (`agent(`, `pipeline(`, `parallel(`, `workflow(`, `schema` presence) labeled as detected-call-sites — an honest approximation, NOT a DAG (static analysis of arbitrary JS cannot promise more; the journal records the real shape after execution). Keep the existing run-id-first line intact (the model parses it for workflow_status).

**Files:**
- Modify: `packages/workflows/src/plugin/tools/workflow.ts`
- Test: `packages/workflows/src/plugin/tools/workflow.test.ts`

**Verification:** `bun test workflow.test` — RED on the new return-shape expectations.

**Done when:** submitting the canonical review script echoes name, phases, and detected primitive counts alongside the run id.

#### Task 6.2.3: Live TUI progress during wait_ms

- [x] Done — `f3d119a`

**Context:** `workflow_status` `wait_ms` blocks silently (`workflow-status.ts:247-254` races `handle.settled` vs timeout). opencode's `ToolContext.metadata({ title })` updates the in-progress tool line live (`.claude/skills/opencode-plugin-dev/references/custom-tools.md:91-120`) — the ONLY live-display channel a plugin gets.

**Implementation vision:** While blocked, re-render a compact title on a ~1s interval driven by the handle's stamped progress: `<name> · <current phase> · <done>/<seen> agents · <elapsed>` — counts from the same tally logic as 6.2.1. Wrap every `context.metadata` call in try/catch (defensive: hosts may not implement it); always clear the interval on settle/timeout (finally). No interval when `wait_ms` is 0/absent. Final render unchanged.

**Files:**
- Modify: `packages/workflows/src/plugin/tools/workflow-status.ts`
- Test: `packages/workflows/src/plugin/tools/workflow-status.test.ts` (fake context capturing metadata calls; fake timers per existing patterns)

**Verification:** `bun test workflow-status` — RED first: a blocked wait with progress events must emit metadata title updates.

**Done when:** a blocked `workflow_status` call streams title updates reflecting live progress, and never leaks a timer.

#### Task 6.2.4: Live-run digest on the next user turn

- [x] Done — `f3d119a`

**Context:** `plugin/index.ts:87` wires `createChatMessageHook(engine.queue, logger)` — it drains TERMINAL notices into the parent's next message. While a run is LIVE there is no passive surface at all.

**Implementation vision:** Extend the hook wiring so that, per user message, live runs owned by that parent session prepend one line each: `[workflow wf_x '<name>' running <elapsed> — <done>/<seen> agents done]`, formatted consistently with the existing notice style. The engine exposes a small read surface (live runs + tallies — reuse 6.2.1's tally). No persistence, no dedup needed (a digest is repeatable by design; only terminal notices are once-only).

**Files:**
- Modify: `packages/workflows/src/plugin/index.ts` (and the hook factory it delegates to)
- Test: `packages/workflows/src/plugin/index.test.ts`

**Verification:** `bun test index.test` — RED: a chat.message during a live run must carry the digest line; after settle it must not.

**Done when:** any user message sent mid-run surfaces the digest; terminal notices keep their exactly-once behavior.

### Epic 6.3: Active parent wake

**Goal:** Workflow/bg-task completion wakes an IDLE parent session with a demarcated automated notice (CC task-notification parity); busy parents keep passive flush. Coalescing: N completions while busy → one wake carrying all pending notices, deduped against the chat.message flush.
**Scope:** `packages/core` (wake notifier seam on the notification queue + idle detection via typed SDK surface), both plugins' `index.ts` wiring
**Dependencies:** Epic 6.1; constraint from reversed design decision 1 — wake ONLY on idle parent, passive fallback otherwise, no oh-my-opencode-style crash-mitigation sprawl
**Done when:** with the TUI parent idle, a completing workflow triggers a parent turn that reads the result without user input; with the parent busy, notices arrive via the existing flush exactly once.

#### Task 6.3.1: Core wake notifier

- [x] Done

**Context:** Terminal notices flow through core's notification queue (toast via `onNotify`; passive drain via `createChatMessageHook` — now wrapped by the workflows digest hook). Typed SDK surface for wake: `client.session.status()` is the GLOBAL `/session/status` map `{ [sessionID]: SessionStatus }`, `SessionStatus = idle | retry | busy` (`docs/sdk-surface-audit.md` row f — no per-session path); `client.session.promptAsync` is already used for child dispatch (`session-runner.ts:343`).

**Implementation vision:** New core module `createWakeNotifier({ client, queue, logger, clock })` exposing a `notify(notice)`-shaped hook the plugins call on terminal transitions. Behavior: (1) check the parent's status — wake when the entry is `idle` OR ABSENT (absent ≠ busy; the missed-wake failure mode is the silence we're fixing, and promptAsync failures are fenced anyway — document this call); `busy`/`retry` → leave queued for the passive flush. (2) Coalesce: drain ALL pending notices for that parent into ONE wake prompt; consume-on-success only — `promptAsync` resolving marks them consumed; any throw leaves them queued (passive fallback intact, exactly-once preserved against the flush). (3) Per-parent in-flight guard: never two concurrent wakes for the same parent. (4) Wake text demarcated CC-style: `[task-notification] <notice lines> — automated notice, not the user; read results with the matching status tool.` (5) No retry timers, no polling loops — a wake attempt happens only when a notice arrives; lean by constraint. Verify `promptAsync` body's `agent` field is optional and omit it (the parent keeps its own agent); if the typed surface requires it, STOP and report.

**Files:**
- Create: `packages/core/src/wake-notifier.ts` (+ export via `packages/core/src/index.ts`)
- Test: `packages/core/src/wake-notifier.test.ts`

**Verification:** `cd packages/core && bun test wake-notifier` — RED first: idle parent → one coalesced promptAsync carrying all pending notices, consumed; busy parent → no prompt, notices remain; promptAsync throw → notices remain; concurrent notices → single in-flight wake.

**Done when:** the four behaviors above are test-pinned and the full core suite passes.

#### Task 6.3.2: Wire wake into both plugins

- [x] Done

**Context:** Workflows: terminal transitions invoke the engine's `onNotify` seam (`packages/workflows/src/plugin/engine.ts` — currently toast-only via `plugin/index.ts:68-70`). Background-agents: `packages/background-agents/src/index.ts` wires its queue + toast similarly. Both already share core's queue semantics.

**Implementation vision:** Each plugin constructs the wake notifier with its engine's queue and calls it alongside the toast on terminal transitions — toast stays (visual), wake added (CC parity), passive flush remains as fallback for busy/failed wakes. The status tool named in the wake text differs per plugin (`workflow_status` vs `bg_output`). No behavior change for headless single-turn contexts beyond a fenced failed prompt. Keep wiring thin — composition in `index.ts`, no engine surgery beyond exposing what the notifier needs.

**Files:**
- Modify: `packages/workflows/src/plugin/index.ts`
- Modify: `packages/background-agents/src/index.ts`
- Test: `packages/workflows/src/plugin/index.test.ts`, `packages/background-agents/src/index.test.ts`

**Verification:** plugin index tests — RED: terminal notice with idle parent triggers a parent promptAsync carrying the demarcated notice; busy parent leaves the flush path intact.

**Done when:** both plugins wake an idle parent on completion in unit tests; full repo gates green.

#### Task 6.3.3: Documentation truth update

- [x] Done

**Context:** `packages/background-agents/README.md` documents the passive model ("why no active wake") — now false. `packages/workflows/README.md` describes completion notification passively.

**Implementation vision:** Update both notification sections: active wake on idle parent (CC task-notification parity), passive flush + toast as fallback layers, the busy-parent rule, and the headless caveat (`opencode run` dies with its turn — `wait_ms` remains the answer there). Keep the established README voice; no marketing.

**Files:**
- Modify: `packages/background-agents/README.md`
- Modify: `packages/workflows/README.md`

**Verification:** reread sections against the shipped behavior; no stale "no active wake" claims remain (`grep -ri "active wake" packages/*/README.md`).

**Done when:** READMEs match the implementation.

---

## Phase 7 — Completion correctness: turn liveness, output diagnostics, per-item replay

**Origin (2026-06-07, post-Phase-6 field failure).** A real 5-reviewer helm review (runs `wf_0ybs7l96` → `wf_566l0gvc` → `wf_jpxdrxl8`, after-action report at `~/repos/lerianstudio/helm/docs/workflow-reliability-report.md`) failed three times WITH the Phase 6 watermark fix live (plugin loaded 08:37 -03, merge `96fc916` at 08:25). Forensics (SQLite message timelines vs `workflow-tasks/*.json` `completedAt`): the gate completed tasks MID-TURN. Proof: `bg_ta1rn5kd` was nudged 31s into a turn whose in-flight assistant message ran 08:40:32→08:45:02 (no `time.completed` yet — ECONNRESET retry backoff, error in opencode log `2026-06-07T113740.log`); `bg_7uz0uzne` completed 08:44:52 while its session produced output until 08:45:13. Root cause: the poll's quiet heuristic (5s without SDK events) is satisfied by normal mid-turn silent windows — first-token latency on 384KB-diff prompts, retry backoff — and `hasValidOutput` accepts ANY post-watermark tool part, so the gate completes as soon as both coincide. The watermark (Epic 6.1) only killed the *previous-turn* variant. Downstream symptoms, all one mechanism: schema `null`s (completed before `structured_output` was called → nudge → nudge turn also tripwired), consistently empty `""` outputs on the two heaviest reviewers (longest prompt → first silent window precedes first text), and mid-thought truncated captures (`lastAssistantText` snapshots whatever exists at the false completion moment). Report findings R1/R2/R3 share this root cause; R4/R5 (resume economics) are independent and addressed in Epic 7.3.

### Epic 7.1: Turn-liveness completion gate

**Goal:** the gate can no longer complete a task whose turn is still running: completion requires quiet + grace (existing) AND `session.status()` not `busy`/`retry` AND the newest post-watermark assistant message has `time.completed`.
**Scope:** `packages/core/src/completion.ts`, `packages/core/src/sdk-adapter.ts`, engine wiring in both plugins' composition roots.
**Dependencies:** none (root cause; lands first).
**Done when:** unit suite pins all liveness-veto branches; the 4-parallel heavy-turn repro (silent gap > poll window mid-turn) no longer completes early; existing 498 tests still pass.

#### Task 7.1.1: Add turn-liveness veto to the completion gate

- [x] Done

**Context:** `packages/core/src/completion.ts` — `maybeCompleteOnOutput` (completion.ts:466) and the poll's quiet branch (completion.ts:573) decide completion on `graceElapsed` + `outputIsValid` alone. `hasValidOutput` (completion.ts:193) returns true for any post-watermark tool part. The SDK already exposes the two liveness signals: the global status map (adapted at `packages/core/src/sdk-adapter.ts:111-120` for the wake notifier, audit row f) and `AssistantMessage.time.completed` (typed in `types.gen.d.ts`; `GateMessage.info.time` currently narrows only `created`, completion.ts:65-68).

**Implementation vision:** Add an injected `fetchStatus(sessionID): Promise<"busy" | "retry" | "idle" | undefined>` dep to `CompletionGateDeps` (undefined = absent from map = idle-equivalent, same semantics the wake notifier uses). Widen `GateMessage.info.time` to `{ created: number; completed?: number }`. Create one choke point — a `turnIsLive(task, sessionID, messages)` check used by BOTH completion paths (deferred-idle fire and poll quiet branch), evaluated AFTER grace but BEFORE `tryComplete`: (a) `fetchStatus` returns `busy`/`retry` → live, do not complete; a status read THROW also blocks (conservative: better to wait for the next poll tick than complete mid-turn); (b) the newest post-watermark assistant message lacks `time.completed` → live. Reuse the messages already fetched by `outputIsValid` rather than fetching twice — restructure `outputIsValid` to return the fetched messages (or fold validity + liveness into one `assessTurn` that fetches once). The `validatedSessions` positive-cache must NOT bypass the liveness check: cache only the validity half (messages exist), never the liveness half (liveness is a point-in-time property). `session.error` path unchanged. Stale-timeout force-cancel unchanged (it must still kill a hung turn). Wire `fetchStatus` through `sdk-adapter.ts` reusing the existing status-map narrowing, and through both plugins' composition roots.

**Files:**
- Modify: `packages/core/src/completion.ts`
- Modify: `packages/core/src/sdk-adapter.ts`
- Modify: `packages/core/src/session-runner.ts` (deps plumbing)
- Modify: `packages/background-agents/src/index.ts`, `packages/workflows/src/plugin/index.ts` (composition)
- Test: `packages/core/src/completion.test.ts`

**Verification:** new tests RED first: (1) quiet + valid output + status `busy` → no completion, then status flips idle → next poll completes; (2) status `retry` → no completion; (3) status read throws → no completion (and a later successful read completes); (4) newest post-watermark assistant message without `time.completed` → no completion, stamped → completes; (5) absent status (undefined) + completed message → completes (no regression for fast turns); (6) stale timeout still force-cancels a permanently-busy session. Then `bun test` full suite.

**Done when:** all six branches pinned green; full suite passes; no `as any` (decision 3).

#### Task 7.1.2: Live repro proves the fix end-to-end

- [x] Done

**Context:** the Phase 6 smoke (`packages/workflows/test-harness/run-smoke.ts`) asserts persisted state, but its scenarios use fast haiku turns that rarely open a >5s silent mid-turn window — they cannot catch this class. The field failure needed opus + a 384KB-diff prompt to reproduce. A deterministic repro needs an artificially slow turn, not a heavy model.

**Implementation vision:** Add smoke Scenario E: one `agent()` whose prompt instructs the child to run a single bash sleep ~15s (tool execution = a silent window longer than `DEFAULT_POLL_MS`+grace while status stays `busy`) and THEN emit a distinctive final marker text. Assert the persisted run record's `returnValue` contains the final marker — pre-fix, the gate completes during the sleep and captures `""`/pre-sleep text; post-fix, the full turn survives. Keep the model-rendered-stdout rule: assert ONLY persisted state (Phase 6 lesson). If the harness agent cannot reliably sleep via bash, fall back to a prompt that forces a long tool chain; the assertion (final marker present in persisted returnValue) stays the same.

**Files:**
- Modify: `packages/workflows/test-harness/run-smoke.ts`

**Verification:** `bun run-smoke.ts` scenario E passes post-fix; capture a RED run by stashing the 7.1.1 fix once (or running against the pre-fix commit) to prove the scenario actually detects the bug.

**Done when:** scenario E green on main with RED evidence captured in the commit message.

### Epic 7.2: Output reliability and diagnostics

**Goal:** no silent total losses: structured-output failures persist a typed reason + the raw final text on the child task record and surface in `workflow_status`; empty (`""`) agent results render a warning; full untruncated results retrievable through the tool (no shell access to the drawers dir required).
**Scope:** `packages/workflows/src/runtime/structured/`, `packages/workflows/src/plugin/tools/workflow-status.ts`, `packages/workflows/src/plugin/engine.ts`, core task-record fields.
**Dependencies:** Epic 7.1 (most nulls/empties die with the root cause; this epic handles the residue honestly).
**Done when:** a forced schema-mismatch run shows `null (schema: <reason>; raw N chars preserved)` in status and the raw text is retrievable; `workflow_status full:true` returns the complete `returnValue` untruncated. Report findings R1, R2; usability #1, #2, #3.

#### Task 7.2.1: Agent-call diagnostics — typed null reasons, raw-text capture, empty warning

- [x] Done

**Context:** `agent()` degrades every failure to bare `null` (`packages/workflows/src/runtime/agent-call.ts:261-284` — structured resolution, non-completed status, runner throw all collapse identically), and an empty `""` final text journals as a normal ok result. The field report (R1, usability #2) shows the cost: 4 nulls forced a 6-minute hypothesis-and-rerun cycle because nothing said WHY. Progress events (`ProgressEvent` in `packages/workflows/src/runtime/types.ts`) carry `agent:end {label, status}` and are rendered by `workflow-status.ts`; run records persist via the engine (`packages/workflows/src/plugin/engine.ts` settle path).

**Implementation vision:** Three layers, one source of truth. (a) In `agent-call.ts`, when a call resolves `null` or `""`, build a typed diagnostic: `{ label, index, reason, rawText?, childSessionID? }` where `reason` is one of `schema_no_call` (completed but no `structured_output` stored after nudge), `schema_invalid` (tool called, validation failed — registry already distinguishes via `resultFor.present`), `status_error` / `status_cancelled` (non-completed terminal), `await_failed` (runner throw), `empty_output` (completed, final text empty). For the schema reasons, capture the child's raw final text via `runner.readOutput(taskId)` `summaryText`, capped at 20_000 chars with a `…[capped]` marker; never let the capture failure mask the original flow (fence it). (b) Extend `agent:end` progress events with optional `note?: string` (short human line, e.g. `null — schema_invalid: missing required 'verdict'; raw 6.3k chars preserved`); `workflow-status.ts` renders it after the duration, and renders `⚠ empty output` for `empty_output`. (c) Persist: add `diagnostics?: AgentDiagnostic[]` to the run record (`RunRecord`), collected by the engine from a new optional `onDiagnostic` hook threaded next to `onProgress`/`onRecord`, written at settle — so a finished run is post-mortem-debuggable without SQLite. Keep CC parity untouched: `agent()` still RETURNS bare null/"" to the script; nulls stay un-journaled (that is the failure-targeted retry path).

**Files:**
- Modify: `packages/workflows/src/runtime/agent-call.ts`, `packages/workflows/src/runtime/types.ts`
- Modify: `packages/workflows/src/plugin/engine.ts` (hook + RunRecord field + persist)
- Modify: `packages/workflows/src/plugin/tools/workflow-status.ts` (note + warning render)
- Test: `packages/workflows/src/runtime/agent-call.test.ts`, `packages/workflows/src/plugin/engine.test.ts`, `packages/workflows/src/plugin/tools/workflow-status.test.ts`

**Verification:** RED-first unit tests: each `reason` variant produces the right diagnostic; raw capture caps at 20k; diagnostics persist in the run record; status render shows the note line and the empty warning; `agent()` return values unchanged (null/""). Full suite + typecheck + lint.

**Done when:** every null/empty result is explainable from the persisted run record alone; script-visible semantics byte-identical.

#### Task 7.2.2: Untruncated result retrieval through `workflow_status`

- [x] Done

**Context:** `workflow-status.ts:22-23` caps the rendered result at `RESULT_MAX = 2000` head-truncation (`workflow-status.ts:99`), including with `full: true` — the field report's worst usability finding (#1): the security report was unreadable through the tool and required `jq` against `workflow-runs/<id>.json`.

**Implementation vision:** `full: true` renders the COMPLETE `returnValue` JSON (and per-agent diagnostics from 7.2.1) for both live-settled and terminal-persisted runs; keep the 2000-char head preview for the default (no-`full`) view. Add a safety ceiling only against pathological sizes: 200_000 chars, with an explicit `… (result exceeds 200k chars; full JSON at <runs-path>/<id>.json)` trailer naming the on-disk path — never a silent cut. The tool description gains one line stating `full: true` returns the untruncated result.

**Files:**
- Modify: `packages/workflows/src/plugin/tools/workflow-status.ts`
- Test: `packages/workflows/src/plugin/tools/workflow-status.test.ts`

**Verification:** RED-first: a >2000-char returnValue renders complete under `full: true` (live and terminal paths) and previews at 2000 without it; the 200k trailer names the path. Full suite.

**Done when:** a user can read their entire workflow result through the tool; no shell required.

### Epic 7.3: Per-item journal replay (key + occurrence)

**Goal:** resume replays every journaled item whose call key matches, independent of position — editing item 0's prompt no longer re-runs an unchanged expensive item 1 (report finding R4: identical key `1d2e8321…` re-executed for 4m17s and produced a different answer).
**Scope:** `packages/workflows/src/plugin/engine.ts` (replay matching), `packages/workflows/src/runtime/keys.ts` (occurrence counting), journal docs.
**Dependencies:** none (independent of 7.1/7.2).
**Done when:** resume with an edited early `parallel()` item replays unchanged siblings from journal (zero re-execution) while re-running edited items and previously-null items (nulls stay unjournaled — that is the failure-targeted retry path); duplicate identical calls keep correct semantics via nth-occurrence matching (the CC adversarial-verify pattern spawns N byte-identical refuters — key alone would wrongly dedupe them); agent non-determinism on cache MISS documented in the tool description (finding R5). **Declared deviation from CC:** CC documents longest-unchanged-prefix replay; key+occurrence matching strictly dominates for `parallel()` sets and is what the field report requests — flagged, not silent.

#### Task 7.3.1: Key+occurrence journal replay

- [x] Done

**Context:** replay matching lives in `packages/workflows/src/runtime/agent-call.ts:128-181`: a `byIndex` map plus a run-level `prefixIntact` latch — the first key mismatch at any index voids ALL later replays (`prefixIntact.value = false` is forever). Field finding R4: editing item 0's prompt re-executed an unchanged, expensive item 1 (`security-reviewer`, identical key `1d2e8321…`, 4m17s re-run, different answer). `sub-workflow.ts` consumes the same replay seam with `workflow:`-prefixed boundary keys (`packages/workflows/src/runtime/keys.ts`); the latch type is threaded from `compose.ts`/`evaluate.ts` (find `prefixIntact` construction).

**Implementation vision:** Replace positional-prefix matching with per-key occurrence queues: build `byKey: Map<string, JournalEntry[]>` from the prior journal (entries pushed in journal-file order; entries are recorded in COMPLETION order, which is fine — occurrence order only needs to be deterministic per key, and for byte-identical duplicate calls the cached results are interchangeable by definition). At each call: `shift()` the queue for this call's key — hit → replay (emit `cached`, re-record into the new journal with the CURRENT call index, count the lifetime cap exactly as today); miss/empty → run live. Delete the `prefixIntact` latch and its threading entirely (dead with per-item matching); keep the deterministic `callIndex` ordinal (still the journal `index` field and the progress ordering anchor). Apply the same mechanism to the `workflow()` boundary in `sub-workflow.ts` — its `workflow:`-prefixed keys land in the same `byKey` map, no special-casing. Docs: update the spec-§7 comment trail (`agent-call.ts`, `engine.ts:149`, `journal.ts` if it narrates prefix), the `workflow` tool description's resume sentence (`packages/workflows/src/plugin/tools/workflow.ts` — replace "longest unchanged prefix" wording with per-item key matching), add the R5 non-determinism contract line (replay returns the frozen journaled result; a re-run may legitimately differ — agents are non-deterministic), and fix both READMEs' resume sections.

**Files:**
- Modify: `packages/workflows/src/runtime/agent-call.ts`, `packages/workflows/src/runtime/sub-workflow.ts`, threading sites (`compose.ts`/`evaluate.ts`)
- Modify: `packages/workflows/src/plugin/tools/workflow.ts` (description), `packages/workflows/src/plugin/engine.ts` (comment), `packages/*/README.md`
- Test: `packages/workflows/src/runtime/agent-call.test.ts`, `packages/workflows/src/runtime/sub-workflow.test.ts`, `packages/workflows/src/plugin/engine.test.ts` (resume e2e)

**Verification:** RED-first: (1) edited item 0 + unchanged items 1..3 → item 0 live, 1..3 cached (the R4 scenario, asserted via `agent:end` statuses); (2) N byte-identical calls journaled → N replays, N+1th runs live (occurrence semantics); (3) previously-null item absent from journal → runs live; (4) reordered identical-key calls still replay (position independence); (5) sub-workflow boundary replays by key. Existing prefix tests rewritten to the new semantics — deleting a now-false test is correct, silently weakening one is not. Full suite + typecheck + lint.

**Done when:** the R4 scenario replays the unchanged sibling for free; no `prefixIntact` remains; docs/tool descriptions tell the new truth.

---

## Phase 8 — Live observability: progress feed, control channel, native TUI viewer

**Origin (field validation, 2026-06-07).** Phase 7 passed live validation — the helm 5-reviewer review ran end-to-end with structured verdicts intact. The next gap is UX parity with CC's `/workflows` overlay: live phases tree, per-agent `model · tokens · tool calls · duration`, drill-down with prompt/activity/outcome, and stop controls. Today our observability is the textual `workflow_status` tool only, and per-agent stats (tokens, tool-call counts) are not captured anywhere — core's completion gate deliberately narrows messages to `GateMessage` (`packages/core/src/completion.ts:50-74`), which strips `AssistantMessage.tokens` and tool-part inputs.

**Architecture facts (verified against `.references/opencode`, 2026-06-07):**
- opencode now has a second plugin surface — the `"./tui"` package export — loaded by the TUI process via plain `await import()` (`.references/opencode/packages/opencode/src/plugin/loader.ts:139`): **no sandbox, full Bun fs access**. TUI plugins register full-screen routes (`api.route.register`), host slots (12 slots incl. `sidebar_content`), keybind layers, and subscribe to the SDK event bus (`.references/opencode/packages/plugin/src/tui.ts:455-486,589-622`).
- The workflows server plugin already routes ALL SDK events into the engine (`packages/workflows/src/plugin/index.ts:107-108` → `engine.handleEvent`, `engine.ts:225,760`); `message.updated` carries `AssistantMessage.tokens` (`.references/opencode/packages/sdk/js/src/gen/types.gen.ts:112-141`, tokens at 131-139) and `message.part.updated` carries `ToolPart` with name + input (`types.gen.ts:294-305`) — per-agent stats are available WITHOUT widening core's gate types.
- The engine already has a single progress choke point that stamps every runtime event (`engine.ts:632-637`); the runtime itself is clock-free by design — durations are an engine-side derivation from stamped `at` deltas, never a runtime concern.

**Binding decisions for this phase:**
- **Feed file is the bus.** The engine appends every enriched event to `<dataDir>/workflow-feed/<runId>.jsonl`; the TUI viewer only tails files. One source of truth; the viewer holds no protocol with the server plugin. Headless runs still produce the feed (the viewer is a lens, not a dependency).
- **Enrichment happens at the engine choke point** (`engine.ts:632-637`), so `handle.progress` (consumed by `workflow_status`) and the feed file see the same enriched stream.
- **Feed writes are fenced** — an fs failure must never break a run (same stance as `onProgress` fencing).
- **TUI surface risk accepted:** the `./tui` API is new; published types lag the runtime (`PluginModule.tui?: never` vs runtime accepting `tui()`). Pin and document the opencode version tested against; treat breakage on host bumps as expected maintenance.

### Epic 8.1: Live progress feed + per-agent stats (data layer)

**Goal:** every run produces a real-time JSONL feed carrying phases, per-agent lifecycle with `sessionID/model/agentType`, live token + tool-call stats, and durations; `workflow_status` renders the CC-style tree from the same enriched stream; per-agent summaries persist on the RunRecord for post-hoc inspection.
**Scope:** `packages/workflows/src/runtime/` (event vocabulary, emission sites), `packages/workflows/src/plugin/` (feed writer, stats collector, engine wiring, status tool).
**Dependencies:** none (Phase 7 complete).
**Done when:** a live smoke run produces a `workflow-feed/<runId>.jsonl` whose `agent:end` lines carry tokens/toolCalls/durationMs; `workflow_status` shows per-agent `model · tokens · tools · duration` rows grouped by phase, live and post-hoc.

#### Task 8.1.1: Extend the progress vocabulary — `agent:launched` + `sessionID` on `agent:end`

- [x] Done

**Context:** `ProgressEvent` (`packages/workflows/src/runtime/types.ts:52-72`) has four members: `agent:start {label, phase?}`, `agent:end {label, status, note?}`, `log`, `warn`. `agent:start` is emitted before launch (`agent-call.ts:315`), so it cannot carry the child sessionID; the sessionID exists at `agent-call.ts:336` (`sessionId = task.sessionID`) and is in scope in the `finally` that emits `agent:end` (`agent-call.ts:426-433`). The cached path (`agent-call.ts:262-263`) never launches a session. Downstream consumers (engine choke, `workflow_status`, feed) need a session↔label binding to attach stats and compute durations.

**Implementation vision:** Add `agent:launched { type, label, phase?, sessionID, model?, agentType? }` to the `ProgressEvent` union, emitted immediately after `runner.launch` returns (after `agent-call.ts:336`), with `model` resolved as `task.model ?? opts.model` (BgTask carries `model?: string`, `packages/core/src/types.ts:40`) and `agentType` as `opts.agentType ?? defaults.agent`. Add optional `sessionID?: string` to `agent:end`, set in the `finally` when `sessionId !== undefined` (cached and pre-launch-throw paths legitimately omit it). The runtime stays clock-free — NO timestamps or durations here; those are engine-side. Cached emissions are untouched (no session, no `agent:launched`).

**Files:**
- Modify: `packages/workflows/src/runtime/types.ts`, `packages/workflows/src/runtime/agent-call.ts`
- Test: `packages/workflows/src/runtime/agent-call.test.ts`

**Verification:** RED-first: live call emits `agent:start` → `agent:launched` (sessionID matches the fake runner's task, model/agentType resolved) → `agent:end` with the same sessionID; cached call emits only `start`/`end` with no sessionID; launch-throw path emits `agent:end` without sessionID. Full runtime suite + typecheck.

**Done when:** the enriched sequence is observable in runtime tests and no existing consumer breaks (additive fields only).

#### Task 8.1.2: Feed writer — `workflow-feed/<runId>.jsonl`

- [x] Done

**Context:** the engine stamps every runtime event at one choke point (`packages/workflows/src/plugin/engine.ts:632-637`, pushes `StampedProgressEvent` to `handle.progress`); run records are created at `engine.ts:616` and settled at `engine.ts:673,690,707`. Data subdirs are declared as constants (`engine.ts:246-248`: `workflow-runs`, `workflow-scripts`, `workflow-journals`) under the base dir resolved by `resolveDataBaseDir` (`engine.ts:349-351`; XDG default per `packages/core/src/persistence.ts:91`). There is no on-disk live event stream today — `handle.progress` dies with the process.

**Implementation vision:** New module `packages/workflows/src/plugin/feed.ts`: `createFeedWriter({ dir, runId })` → `{ append(event: FeedEvent): void, settled(): Promise<void> }`. `FeedEvent` = stamped/enriched progress events plus two lifecycle lines: `run:start { runId, parentSessionID, scriptPath?, at }` and `run:end { status, agentCount?, budgetSpent?, at }`. Writes are serialized through an internal promise chain (append order = emission order), each line `JSON.stringify + "\n"` via `fs.appendFile`, and **fenced**: any fs error flips the writer into a dead state (log once via the engine logger, drop subsequent appends) — a broken disk must never break a run. `settled()` awaits the chain drain (called before run settlement, same pattern as `journalWrites`). Engine wiring: add `SUBDIR_FEED = "workflow-feed"` beside `engine.ts:246-248`; write `run:start` where the initial record is created (`engine.ts:616`), append every stamped event inside the existing choke (`engine.ts:632-637`), write `run:end` at each settle site (`engine.ts:673,690,707`) and drain before returning. Feed files are append-only and never garbage-collected by this task (retention is out of scope; note it in the module doc).

**Files:**
- Create: `packages/workflows/src/plugin/feed.ts`
- Modify: `packages/workflows/src/plugin/engine.ts`
- Test: `packages/workflows/src/plugin/feed.test.ts`, `packages/workflows/src/plugin/engine.test.ts` (feed lines asserted in an e2e fake run)

**Verification:** RED-first: temp-dir writer test asserts line ordering under interleaved appends, `run:start`/`run:end` framing, and the fenced-failure path (writer with a throwing fs records nothing yet the run completes); engine e2e asserts a completed fake run leaves a parseable JSONL whose first line is `run:start` and last is `run:end`. Full suite + typecheck + lint.

**Done when:** every engine run (success, error, cancel) leaves a complete, parseable feed file, and a feed-write failure provably cannot fail a run.

#### Task 8.1.3: Session stats collector — tokens + tool calls from the SDK event bus

- [ ] Done

**Context:** the plugin's `event` hook forwards every SDK event to `engine.handleEvent` (`packages/workflows/src/plugin/index.ts:107-108`), which today only forwards to the runner's completion gate (`engine.ts:225-226,760`). `message.updated` events carry the full v1 `AssistantMessage` including `tokens { input, output, reasoning, cache { read, write } }` (`.references/opencode/packages/sdk/js/src/gen/types.gen.ts:112-141`); `message.part.updated` carries `ToolPart { tool, callID, state }` with `state.input` (`types.gen.ts:294-305`). Events fire for ALL sessions including workflow children — the data for live per-agent stats already flows through the engine and is discarded.

**Implementation vision:** New module `packages/workflows/src/plugin/session-stats.ts`: a collector with `register(sessionID, { runId, label })`, `unregister(sessionID)`, `snapshot(sessionID)` → `{ tokens: { input, output, reasoning, cacheRead, cacheWrite }, toolCalls, lastTools: string[], updatedAt }`, and `handleEvent(event)`. Token accounting: per-`messageID` map of the latest `tokens` (message.updated fires repeatedly per message — replace per message, sum across messages for the snapshot); tool accounting: count each tool part once on first sight of `state.status === "completed" | "error"` keyed by part id, and keep a 3-deep ring of `"toolName(inputPreview≤60chars)"` labels. Only registered sessions are tracked (everything else is dropped at the first key check — the hook is hot). Wiring: engine constructs one collector per engine instance, calls `collector.handleEvent` inside `handleEvent` (before the runner forward), registers on the choke-point sighting of `agent:launched`, unregisters after the final enrichment on `agent:end` (Task 8.1.4 consumes the snapshot). Throttled live emission: on stats change with ≥2000ms since the session's last emission, the engine appends `agent:stats { label, sessionID, tokens, toolCalls, lastTools, at }` to the feed (feed-only; NOT pushed to `handle.progress` — the status tool reads snapshots directly).

**Files:**
- Create: `packages/workflows/src/plugin/session-stats.ts`
- Modify: `packages/workflows/src/plugin/engine.ts`
- Test: `packages/workflows/src/plugin/session-stats.test.ts`, `packages/workflows/src/plugin/engine.test.ts`

**Verification:** RED-first: synthetic v1 event sequences — repeated `message.updated` for one message does not double-count; multi-message sums are correct; tool parts count once across repeated part updates; unregistered sessions ignored; ring buffer holds the last 3 labels with truncated inputs; throttle emits at most one `agent:stats` per session per 2s window (fake clock). Full suite + typecheck.

**Done when:** a fake run with synthetic child events yields correct token/tool snapshots and throttled `agent:stats` feed lines, with zero allocation cost for non-workflow sessions beyond one map lookup.

#### Task 8.1.4: Enriched `agent:end` + per-agent rollup on the RunRecord

- [ ] Done

**Context:** the choke point (`engine.ts:632-637`) sees the full event stream in order: `agent:launched` (with `at`) precedes its `agent:end` (same sessionID, Task 8.1.1). The collector (Task 8.1.3) holds final token/tool stats at `agent:end` time. `RunRecord` (`engine.ts:80-105`) carries `diagnostics` since Phase 7 but nothing per-agent — post-hoc `workflow_status` cannot show what CC shows (per-agent model/tokens/tools/duration) without re-parsing the feed.

**Implementation vision:** At the choke point, keep a per-run `Map<sessionID, { label, phase?, model?, agentType?, launchedAt }>` populated from `agent:launched`. On `agent:end` with a sessionID: compute `durationMs = at - launchedAt`, take the collector's final snapshot, enrich the stamped event (added fields: `durationMs`, `tokens`, `toolCalls`, `model`, `agentType`) **before** it is pushed to `handle.progress` and appended to the feed — both consumers see identical truth — then unregister the session from the collector. Cached `agent:end` events (no sessionID) pass through untouched. Accumulate each enriched end into `agents: AgentSummary[]` (`{ label, phase?, sessionID?, model?, agentType?, status, tokens?, toolCalls?, durationMs?, note? }` — cached entries carry only label/phase/status) and persist the array on the RunRecord at every settle site (`engine.ts:673,690,707`) alongside `diagnostics`. The map and accumulator live on the run handle (per-run, dropped at settle).

**Files:**
- Modify: `packages/workflows/src/plugin/engine.ts` (choke-point enrichment, `RunRecord.agents`, settle sites)
- Modify: `packages/workflows/src/runtime/types.ts` only if the enriched-event type is shared (prefer a plugin-local `EnrichedProgressEvent` type — the runtime never sees enrichment)
- Test: `packages/workflows/src/plugin/engine.test.ts`

**Verification:** RED-first: engine e2e fake run asserts (1) `agent:end` lines in the feed carry `durationMs` equal to the fake-clock delta and the collector's final tokens/toolCalls; (2) `handle.progress` carries the same enriched values; (3) the settled RunRecord's `agents` array matches, cached entries included with `status: "cached"` and no stats; (4) error/cancel settles still persist partial `agents`. Full suite + typecheck + lint.

**Done when:** post-hoc, the RunRecord alone reconstructs CC's per-agent table; live, `handle.progress` carries the same data.

#### Task 8.1.5: `workflow_status` CC-style rendering

- [ ] Done

**Context:** `workflow-status.ts` reconstructs agent state by pairing `agent:start`/`agent:end` (`packages/workflows/src/plugin/tools/workflow-status.ts:14,94`) and renders a flat list; it has no phases tree, no per-agent stats. After 8.1.4, `handle.progress` (live) and `RunRecord.agents` (settled) both carry model/tokens/toolCalls/durationMs; the collector exposes `snapshot()` for in-flight agents. CC's reference layout (the parity target): phases sidebar with `✓ Impl 5/5`-style counters, agent rows `✓ impl:kadm-leaf  opus-4.8  112.7k tok · 51 tools · 7m 8s`.

**Implementation vision:** Rework the render: group agents by `phase` (events without phase go under a single unnamed group), each phase header `✓|✗|… <phase> <done>/<total>`; one row per agent occurrence: status marker, label, model (short form — strip the provider prefix), `<tokens> tok · <tools> tools · <duration>` where tokens formats as `112.7k`/`1.2M` (output+input+reasoning total? — NO: show **total of input+output+reasoning+cache.read+cache.write the way CC does, a single human number**; document the formula in a comment), duration as `7m 8s`. Running agents (start without end) pull live numbers from the collector snapshot via the engine; cached rows render `cached` in place of stats. Settled runs render from `RunRecord.agents` so the same view works after restart. Keep the existing sections (result preview, diagnostics, `full:true`) untouched below the tree. Formatting helpers (`formatTokens`, `formatDuration`) live in the tool module and are unit-tested.

**Files:**
- Modify: `packages/workflows/src/plugin/tools/workflow-status.ts`
- Modify: `packages/workflows/src/plugin/engine.ts` (expose collector snapshot access on the engine surface for the tool)
- Test: `packages/workflows/src/plugin/tools/workflow-status.test.ts`

**Verification:** RED-first: fragment tests for a live run (phase grouping, running row with live snapshot stats, cached row), a settled run rendered purely from `RunRecord.agents`, and the formatting helpers (`999 → "999"`, `112_700 → "112.7k"`, `1_234_567 → "1.2M"`, `428_000ms → "7m 8s"`). Full suite + typecheck + lint.

**Done when:** `workflow_status` output is a recognizable sibling of CC's `/workflows` tree for live and settled runs.

### Epic 8.2: External control channel

**Goal:** a process other than the opencode server (the TUI viewer, a shell `touch`) can cancel a live run through a file-based sentinel — no RPC between plugin surfaces.
**Scope:** `packages/workflows/src/plugin/` (engine watch loop, `workflow-control/` subdir convention); feed gains a `run:cancel-requested` line for viewer feedback.
**Dependencies:** Epic 8.1 (feed conventions, subdir layout).
**Done when:** `touch <dataDir>/workflow-control/<runId>.cancel` cancels a live run end-to-end (settles as `cancelled`, children stopped, sentinel consumed), verified in the smoke harness.

### Epic 8.3: Native TUI viewer (`./tui` surface)

**Goal:** a full-screen workflow viewer inside the opencode TUI mirroring CC's `/workflows`: Phases | Agents | Detail panes, `j/k` navigation, enter to drill in, `x` to stop (via 8.2 sentinel), esc back; plus a `sidebar_content` slot summarizing active runs (`34/35 agents · 1h34m`) and a keybind to open the route.
**Scope:** new `"./tui"` entrypoint on `packages/workflows` (dual export per `.references/opencode/packages/plugin/package.json:11-14`), Solid-JSX over opentui (`@opentui/core`/`keymap`/`solid` as peer deps), feed-tailing data layer (fs watch + poll fallback — TUI plugins load via plain `import()`, full fs access confirmed at `.references/opencode/packages/opencode/src/plugin/loader.ts:139`).
**Dependencies:** Epics 8.1 (feed is the only data source) and 8.2 (stop control).
**Done when:** with both surfaces installed, a live workflow renders phases/agents/detail updating in real time from the feed, `x` cancels through the sentinel, and the viewer renders settled runs from feed files after a TUI restart. Risk note: `./tui` API is new and types lag the runtime — pin the opencode version tested against and document the type-lag workaround.

---

## Risks (carried from analysis)

| Risk | Mitigation |
|---|---|
| Host doesn't serialize concurrent session prompts (root cause of OMO's worst code) | Workflows await in-process; notifications passive-only (decision 1) |
| `session.idle` reliability varies across opencode versions | Narrow version pin (decision 5) + sparse safety poll + stale timeout |
| SDK churn on `tui`/`session.status` surfaces | Typed-only rule (decision 3) + audit gate re-run at each phase start |
| Budget token accounting may not be exposed in SDK | Spike in Epic 4.3; honest labeled estimation fallback |
| Model-authored workflow scripts run in-process | Accepted: same trust level as the bash tool; shadowed globals are for determinism, not containment |
