# Workflow Tool Hardening Implementation Plan

> **For implementers:** Use ring:executing-plans (rolling wave: implement the
> detailed phase → user checkpoint → detail the next phase → implement → repeat),
> or ring:running-dev-cycle for the full subagent-orchestrated workflow.
> This document is the living source of truth — task elaboration for later
> phases is written back into it during execution.

**Goal:** Close the eight failure modes in `ISSUES.md` for the `workflows` plugin's
agent-orchestration surface — chiefly the **catastrophic #5** (file-editing,
git-capable agents on one shared working tree silently destroying each other's
uncommitted work via `git restore`/`checkout`/`stash`, unrecoverable) — plus the
phantom-isolation flag (#6), phantom reviews (#7), resume/recovery correctness
(#1–#4), and honest token reporting (#8).

**Architecture:** Defense-in-depth — **no single wall**, because the adversarial
design pass proved none exists (a verb-scoped git deny is bypassable by regex
evasion and, fatally, by native `write`/`edit` tool calls that touch no git at all).
The durable fix is a *combination*, sequenced by severity:
1. **Stop the bleeding** — deny the five destructive git verbs to *worker* sessions
   via a `tool.execute.before` hook, and convert the silently-ignored
   `isolation:'worktree'` flag from a false-safety no-op into a loud failure.
2. **Cheap correctness** — four isolated, independent fixes (resume `args`, absolute
   `script_path`, token split, restart-recovery warning string).
3. **Engine-owned VCS** — the engine commits each pipeline/loop unit so surviving
   drift becomes *recoverable* instead of destroyed; prerequisite for #7.
4. **Recovery integrity** — write-ahead intent journal + feed-rehydration of
   recovered counts (the coupled #3/#4 structural fix).
5. **Review integrity** — inject the *real* git diff into reviewers and verify agent
   success against disk, not self-report.

This rests on a **feasibility spike** (recorded below): the data-loss exposure is a
**wiring gap, not a host limitation**. The plugin destructures only
`{ client, directory }` at `index.ts:56` and routes everything through a 5-call
minimal `EngineClient`, declining host primitives it is already handed
(`$: BunShell`, `tool.execute.before`, `permission.ask`, `worktree`,
`experimental_workspace`). Consequently **Phases 0–4 are plugin-only**; only *true*
per-agent worktree isolation needs opencode-host verification and runs as a parallel
**HOST track**.

**Feasibility ground truth (spike, 2026-06-08):**
| Capability | Verdict | Evidence |
|---|---|---|
| Deny worker tools (`git`/`bash`) | **FEASIBLE-IN-PLUGIN** | `tool.execute.before` supported by host (SDK `index.d.ts:235-241`), NOT registered in plugin `index.ts` (which already registers `dispose`/`event`/`chat.message`/`tool`); worker-session lineage derivable from `agent:launched`/`agent:end` |
| Engine runs git via `$` | **FEASIBLE-IN-PLUGIN** | host hands `$: BunShell` (`.cwd()`, exit codes); plugin discards it at `index.ts:56`; engine runs **no** git today (this independently confirms #5's forensic claim that reverts came from workers) |
| Inject diff / post-condition | **FEASIBLE-IN-PLUGIN** | `contextParts` prompt-injection exists (`core` `types.ts`/`session-runner.ts`); script→launch forwarding missing in `agent-call.ts` |
| Per-agent worktree cwd (#6 real) | **NEEDS-HOST-SUPPORT** | `session.create`/`promptAsync` have no cwd slot; SDK `query.directory` exists but it is **unverified** whether it re-roots the worker's Bash/tool cwd vs only scoping project lookup |

**Tech Stack:** TypeScript, Bun (test runner + build), opencode plugin SDK. All work
under `packages/workflows/src/`.

**Delivery constraint (per user):** No commits during implementation. Build on the
working tree, verify with tests, land all phases on a **single branch → `main`** at
the end. Per-task "Verification" runs tests; it does not gate on a commit.

> **Line numbers are anchors, not contracts.** Every `file:line` below is a
> match-by-symbol hint; versions drift. The implementer re-locates the symbol and
> re-verifies before editing. (Self-verified during planning: `workflow.ts:360`,
> `workflow.ts:372-378`, `resolve-source.ts:83-85`, `engine.ts:213-216,729`. Engine
> hook-lifecycle lines came from a design agent and must be re-confirmed.)

## ⚠️ Two decisions for sign-off before P0 executes

1. **Worker git-deny is default-ON, no opt-out** (recommended). This is a behavior
   change for any existing script that *deliberately* delegated VCS to a worker —
   per #5's framing none should, and an escape hatch re-invites the catastrophe. A
   product-meaning call; baked in as the recommendation, flagged for your veto.
2. **`isolation:'worktree'` failure mode: degrade-to-null vs hard-throw.** A hard
   throw placed before `gate.acquire` detonates a whole `parallel()` batch over one
   item. **Recommendation: catchable degrade-to-null + loud diagnostic** (the
   requesting agent does not run; the batch survives), preserving the existing
   "degrade, don't detonate" contract at `agent-call.ts:124-131`. Override lane:
   hard-stop if you want a worktree request to be fatal.

## Phase Overview

| Phase | Milestone (working software at the end) | Epics | Status |
|-------|------------------------------------------|-------|--------|
| **0** | Worker sessions cannot run destructive git; `isolation:'worktree'` fails loud instead of lying | 0.1, 0.2, 0.3, 0.4 | **Complete** |
| **1** | Resume inherits `args`; absolute `script_path` loads; token split shown; restart-recovery warns honestly | 1.1, 1.2, 1.3, 1.4 | **Complete** |
| **2** | The engine commits each unit; surviving drift is recoverable, not destroyed | 2.1 | **Complete** |
| **3** | An interrupted run is detectable (write-ahead intent journal) and reports real recovered counts (feed rehydration) | 3.1, 3.2 | **Complete** |
| **4** | Reviewers diff real code; agent success is verified against disk, not self-report | 4.1, 4.2 | **Complete** (verifyDiff git-grounded, not session-diff) |
| **HOST** | Real per-agent worktree isolation (parallel track; does not block 0–4) | H.1 | PARTIAL — probe green, inert seam landed, lifecycle deferred |

---

## Phase 0 — Stop the bleeding (data loss) — ✅ COMPLETE (2026-06-08)

> #5 is the only catastrophic, *unrecoverable* failure. Its prevention goes first
> even though P1 is cheaper: cheap-but-non-urgent does not outrank data destruction.
> Defense-in-depth — this phase is the necessary-but-not-sufficient first layer.

**Outcome:** typecheck PASS, `bun test packages/workflows` 494 pass / 0 fail, biome
clean. Adversarial review (3 lenses over the real diff) found and fixed a **critical
matcher bypass** (`\n`/`&`-separated commands weren't segmented and only the first
`git` per segment was inspected — `git status\ngit reset --hard` slipped through),
plus a glued-subshell evasion `(git restore .)` and a slashed-branch false-positive
(`git checkout feature/foo` was wrongly blocked).

**Deviations from plan (recorded):**
- 0.3: the hook factory lives in a new sibling module `plugin/git-deny-hook.ts`
  (`createGitDenyHook(engine)`), NOT inlined in `index.ts` — `index.test.ts` asserts
  `index.ts` has exactly one export, so an inline named export was impossible; this
  mirrors the existing `digest-hook.ts` precedent. Flavor-level; invariant preserved.
- 0.4: beyond the plan's "loud diagnostic", the degrade path also emits a visible
  `agent:start`/`agent:end(status=error, note=isolation_unsupported)` pair + a typed
  `isolation_unsupported` `DiagnosticReason`, so the failed agent appears in the
  progress tree rather than vanishing — parity with the file's other degrade paths.
- `IsolationUnsupportedError` is added as a class (canonical message + future
  hard-stop override lane) though the code degrades-to-null rather than throwing it.

**Residual (non-blocking, deferred — defense-in-depth, not the wall):** `git checkout
package.json` (bare top-level file revert, no slash) still slips — string-only
matching cannot distinguish a file from a branch without I/O; mitigated by P2 commits.
`git rm`/`git worktree remove` are outside the named five verbs (scope). `git stash
list`/`git clean -n` are over-blocked (safe direction). The hook keys on tool id
`bash` only. All logged for a future tightening pass.

### Epic 0.1: Worker-session identity in the engine

**Goal:** The engine can answer `isWorkerSession(sessionID)` — true for a session
spawned by a workflow agent while it is live, false for the parent and unrelated
sessions. This is the lineage key the deny hook needs (the host hook payload carries
only `{ tool, sessionID, callID }`, no parent).
**Scope:** `packages/workflows/src/plugin/engine.ts`.
**Dependencies:** none.
**Done when:** `isWorkerSession` returns true between a session's `agent:launched`
and its `agent:end`, false before/after and for parent/unrelated sessions.

#### Task 0.1.1: Track live worker sessions and expose `isWorkerSession`

- [x] Done

**Context:** The engine already observes child-session lifecycle: it emits
`agent:launched` with the child `sessionID` and `agent:end` when the child settles
(design agent cited `engine.ts` ~907-912 and ~966; re-confirm by symbol). It maintains
similar per-launch bookkeeping (`statsBindings`/launchMeta). There is no notion of
"is this session a workflow worker" exposed anywhere, so a host hook cannot tell a
worker's Bash call apart from the parent's.

**Implementation vision:** Add a `Set<string>` of live worker session IDs to the
engine closure. Add the id at the `agent:launched` branch; delete it at `agent:end`
(both the ok and error paths — reuse the existing binding lifecycle so the Set never
leaks). Expose `isWorkerSession(sessionID: string): boolean` on the `WorkflowEngine`
interface next to `statsSnapshot`/`statusOf`. Keep it pure membership — no I/O. Edge:
a session that never emits `agent:end` (crash) leaves a stale entry; bounded by
process lifetime and harmless (a dead session makes no tool calls), so no reaping
needed.

**Files:**
- Modify: `packages/workflows/src/plugin/engine.ts` (Set + add/delete at the launched/end branches; interface method)
- Test: `packages/workflows/src/plugin/engine.test.ts`

**Verification:** `bun test packages/workflows/src/plugin/engine.test.ts` — drive
`agent:launched`/`agent:end` and assert `isWorkerSession` true while live, false
before/after, false for an unrelated id.

**Done when:** the predicate tracks the live window exactly and the suite is green.

---

### Epic 0.2: Destructive-git matcher (pure, isolated)

**Goal:** A pure `isDestructiveGit(command): boolean` that recognizes the five
destruction verbs (and their compound/`-C` forms) without false-positiving on
read-only or constructive git.
**Scope:** new `packages/workflows/src/plugin/git-deny.ts`.
**Dependencies:** none.
**Done when:** the table test below passes; the limits (regex-evasion, native
file-write) are documented in the file as explicitly out of scope.

#### Task 0.2.1: Implement and table-test `isDestructiveGit`

- [x] Done

**Context:** #5's forensics name the exact mechanism: `git restore`,
`git checkout -- <path>`, `git reset`, `git stash`, `git clean`, run by agents
chasing a green gate. The adversarial pass flagged that the reset family must not be
narrowed to `--hard`, and that compound commands (`cd ui && git restore .`) must be
caught.

**Implementation vision:** A string matcher (not a full shell parser — documented as
a mitigation, not a wall). Match `git` invocations (including `git -C <dir>`) whose
subcommand is `restore`, `checkout` with a pathspec (`--`, `.`, or a bare dir/path —
NOT a bare branch name like `git checkout main`), `reset` (any mode: `--hard`,
`--mixed`, `--soft`, bare, `HEAD~`), `stash`, or `clean`. Split compound commands on
`&&`/`;`/`|` and test each segment. **Explicitly out of scope, documented in a header
comment:** variable-indirection evasion (`g=git; $g restore`) and native
`write`/`edit` clobbering — these are why this is one layer of defense-in-depth, not
the wall.

**Files:**
- Create: `packages/workflows/src/plugin/git-deny.ts`
- Test: `packages/workflows/src/plugin/git-deny.test.ts`

**Verification:** `bun test packages/workflows/src/plugin/git-deny.test.ts` — table.
TRUE: `git restore <path>`, `git restore .`, `git checkout -- f`, `git checkout .`,
`git checkout src/`, `git reset --hard`, `git reset`, `git reset HEAD~`, `git stash`,
`git clean -fd`, `cd ui && git restore .`, `git status && git restore .`,
`git -C ui restore .`. FALSE: `git status`, `git diff`, `git add -A`, `git commit`,
`git checkout main`, `git log`, `rm -rf`.

**Done when:** the table passes and the out-of-scope limits are documented.

---

### Epic 0.3: Deny destructive git on worker sessions

**Goal:** A workflow worker that attempts a destructive git verb is blocked with an
explicit error; the parent session and read-only/constructive git are unaffected.
**Scope:** `packages/workflows/src/plugin/index.ts` (register `tool.execute.before`).
**Dependencies:** 0.1 (`isWorkerSession`), 0.2 (`isDestructiveGit`).
**Done when:** the hook throws for worker + destructive git, resolves for everything
else. **Default-on, no opt-out** (pending the §sign-off decision).

#### Task 0.3.1: Register `tool.execute.before` deny hook

- [x] Done

**Context:** The plugin's returned `Hooks` already registers
`dispose`/`event`/`chat.message`/`tool` (the spike's "zero hooks" was wrong — only
`tool.execute.before` is missing). The host supports `tool.execute.before(input, output)`
where `input` is `{ tool, sessionID, callID }` and `output` is `{ args }`. Denial is
**by throw** — there is no `deny` field; a throw surfaces to the worker as a tool
error, which is the desired signal ("you may not do this").

**Implementation vision:** Register the hook. When `input.tool` is the Bash/shell
tool, `engine.isWorkerSession(input.sessionID)` is true, and
`isDestructiveGit(output.args.command)` is true → throw with a clear message
("workflow worker may not run destructive git (`restore`/`checkout --`/`reset`/
`stash`/`clean`) — the engine owns version control; use `git commit` or let the
engine roll back"). Otherwise return. Read-only git, `git add`, `git commit`, and all
parent-session calls pass. Keep the matcher and predicate injected (testable in
isolation).

**Files:**
- Modify: `packages/workflows/src/plugin/index.ts`
- Test: `packages/workflows/src/plugin/index.test.ts`

**Verification:** `bun test packages/workflows/src/plugin/index.test.ts` — (a) worker
+ `git restore .` → throws; (b) worker + `git checkout -- src/x.tsx` → throws; (c)
worker + `git commit -m x` → resolves; (d) worker + `git checkout feature` → resolves;
(e) **parent** + `git restore .` → resolves; (f) worker + `tool='read'` → resolves.

**Done when:** all six cases pass and the suite is green.

---

### Epic 0.4: Fail loud on `isolation:'worktree'`

**Goal:** Requesting worktree isolation no longer silently runs unisolated. The
requesting agent fails with a clear diagnostic instead of giving false safety.
**Scope:** `packages/workflows/src/runtime/{types,agent-call}.ts`, doc string in
`tools/workflow.ts`.
**Dependencies:** none.
**Done when:** a worktree request degrades-to-null with a loud diagnostic (default)
without detonating its `parallel()` batch; the doc string no longer claims silent
fallback.

#### Task 0.4.1: Replace the warn-and-proceed no-op with a loud failure

- [x] Done

**Context:** `agent-call.ts` (~300-307) currently only `emit`s a warn and proceeds
unisolated. The agent-call contract degrades errors to `null` rather than detonating
a batch (`agent-call.ts:124-131`). Placing a hard throw *before* `gate.acquire`
(alongside `SchemaCompileError` ~298-299) would detonate the whole `parallel()`.

**Implementation vision:** Add `IsolationUnsupportedError` (next to `AgentCapError`
in `types.ts`). In `agent-call.ts`, when `opts.isolation === 'worktree'`, **emit a
loud diagnostic and degrade this agent to `null`** (the recommended default — see
§sign-off decision 2), so the requesting agent does not run unisolated and the rest
of the batch survives. (Override lane: throw to hard-stop, if Fred chooses.) Update
the tool doc string (`tools/workflow.ts:230`) from "recognized but NOT yet supported
(runs without isolation)" to "not supported; passing it fails the agent".

**Files:**
- Modify: `packages/workflows/src/runtime/types.ts` (new error class)
- Modify: `packages/workflows/src/runtime/agent-call.ts` (~301-307)
- Modify: `packages/workflows/src/plugin/tools/workflow.ts:230` (doc string)
- Test: `packages/workflows/src/runtime/agent-call.test.ts`

**Verification:** `bun test packages/workflows/src/runtime/agent-call.test.ts` — a
worktree-isolation request yields `null` + the diagnostic emit; a sibling agent in
the same batch still completes.

**Done when:** worktree requests fail loudly without batch detonation; doc string
corrected; suite green.

---

## Phase 1 — Cheap correctness (parallel, independent) — ✅ COMPLETE (2026-06-08)

**Outcome:** typecheck PASS, `bun test packages/workflows` 500 pass / 0 fail, biome
clean. The autonomous executor's gate brake correctly halted on a biome import-sort
nit (`formatTokens`/`formatTokenSplit` order in `workflow-status.ts`) — a safe
auto-fix applied post-hoc; the implementation itself was green (500 tests).

**Deviation (recorded):** Task 1.3 reducer.ts/TUI parity was SKIPPED (plan marked it
optional) — the TUI feed-reducer renders its own flattened `AgentView.tokens`
independently, and that path is the pre-existing uncommitted run-name work; skipping
introduces no inconsistency. The required files (`format.ts`, `workflow-status.ts`)
are done. Token split semantics: reasoning folded into the OUTPUT side (output-priced,
matching the budget line); cache read/write excluded.

> Four isolated, uncoupled fixes. Zero coupling to each other or to P0/P2. They can
> be implemented fully in parallel. They restore documented contracts and honest
> reporting. (P1.1 and P1.2 touch the same file `workflow.ts` but are line-disjoint —
> sequence on one branch or expect a trivial merge.)

### Epic 1.1: Resume inherits the prior run's `args`

**Goal:** Resume with `args` omitted inherits the prior run's persisted `args`
(documented at `workflow.ts:304`, `engine.ts:213-216`) instead of passing `undefined`.
**Scope:** `packages/workflows/src/plugin/tools/workflow.ts`.
**Dependencies:** none.
**Done when:** resume-without-args inherits; resume-with-args overrides; fresh run
unchanged.

#### Task 1.1.1: Conditionally spread `args` at the `startRun` call site

- [x] Done

**Context:** The engine's resume path is correct — `engine.ts:729` reads
`const runArgs = "args" in args ? args.args : prior.record.args` and
`StartRunArgs.args` is optional and documented to inherit on resume. The bug is the
tool: `workflow.ts:372-378` sets `args: argsResult.value` **unconditionally** (unlike
`resumeFromRunId`/`budgetTokens`, which are conditionally spread on the same object).
`resolveArgs(undefined)` returns `value: undefined` (`workflow.ts:95-96`), so the key
is always present → `"args" in args` is always true → `prior.record.args` is never
reached.

**Implementation vision:** Replace `args: argsResult.value,` with
`...(argsResult.value !== undefined ? { args: argsResult.value } : {})`. No type
change (`StartRunArgs.args` is already optional). **Documented flag:** an explicit
JSON `args: null` on resume collapses to `undefined` (`workflow.ts:95`) and thus
inherits the prior — acceptable, since JSON callers cannot distinguish "omit" from
"reset to null" and the contract is inherit-on-absent.

**Files:**
- Modify: `packages/workflows/src/plugin/tools/workflow.ts:372-378`
- Test: `packages/workflows/src/plugin/tools/workflow.test.ts` (resume block ~494)

**Verification:** `bun test packages/workflows/src/plugin/tools/workflow.test.ts` —
seed a prior WITH args, resume omitting args, assert
`engine.statusOf(newRun).record.args` deep-equals the prior; assert explicit args
still overrides; existing resume tests stay green.

**Done when:** inherit + override both pass; suite green.

---

### Epic 1.2: `script_path` accepts absolute paths

**Goal:** An absolute `script_path` (the exact path the launch message returns) loads
verbatim; relative paths still resolve under the project dir.
**Scope:** `packages/workflows/src/plugin/tools/workflow.ts`.
**Dependencies:** none.
**Done when:** absolute and relative `script_path` both resolve correctly.

#### Task 1.2.1: Guard absolute `script_path` before joining

- [x] Done

**Context:** `workflow.ts:359-360` does `joinPath(directory, scriptPath)`, and
`joinPath` (`workflow.ts:67-71`) strips a leading `/` (`rel.startsWith("/") ? rel.slice(1) : rel`),
so `/Users/me/x.js` → `<projectdir>/Users/me/x.js` → ENOENT. `resolve-source.ts:83-85`
already handles this correctly for sub-workflows; the tool call site is the only
place missing the guard.

**Implementation vision:** Replace line 360 with
`const abs = scriptPath.startsWith("/") ? scriptPath : joinPath(directory, scriptPath)`
— a direct port of `resolve-source.ts:83-85`. Use the `startsWith("/")` idiom (not
`path.isAbsolute`) to match the existing codebase. **Documented flag:** POSIX-only;
do not market as round-trippable on Windows (this project is Unix-first).

**Files:**
- Modify: `packages/workflows/src/plugin/tools/workflow.ts:360`
- Test: `packages/workflows/src/plugin/tools/workflow.test.ts`

**Verification:** `bun test packages/workflows/src/plugin/tools/workflow.test.ts` —
absolute temp path loads as-is; relative path still resolves under `directory`.

**Done when:** both cases pass; suite green.

---

### Epic 1.3: Show input vs output tokens separately

**Goal:** `workflow_status` reports per-agent INPUT vs OUTPUT(+reasoning) tokens
instead of one flattened `tok` that reads as "millions of output" when it is mostly
repeated context-loading (#8).
**Scope:** `packages/workflows/src/tui/format.ts`,
`packages/workflows/src/plugin/tools/workflow-status.ts`, optional
`packages/workflows/src/tui/reducer.ts`.
**Dependencies:** none.
**Done when:** the status row shows the split; `budget` (output+reasoning) semantics
unchanged.

#### Task 1.3.1: Render the token split (data already exists)

- [x] Done

**Context:** `AgentSummary.tokens` already carries the five-field split
(`session-stats.ts:51`); `format.ts:100` flattens it to a single `totalTokens`. The
data exists — only the renderer collapses it.

**Implementation vision:** Add `formatTokenSplit(t)` to `format.ts` rendering
`<input>→<output+reasoning> tok` (keep `totalTokens` available). Carry the raw
`SessionTokenSnapshot` through `statsSegment` and the AgentRow build in
`workflow-status.ts` and render the split. Optional parity in `reducer.ts` for the
TUI. Render-only — no accounting change, lowest risk in the set.

**Files:**
- Modify: `packages/workflows/src/tui/format.ts`
- Modify: `packages/workflows/src/plugin/tools/workflow-status.ts` (statsSegment + AgentRow)
- Modify (optional): `packages/workflows/src/tui/reducer.ts`
- Test: `packages/workflows/src/tui/format.test.ts`

**Verification:** `bun test packages/workflows/src/tui/format.test.ts packages/workflows/src/plugin/tools/workflow-status.test.ts && bun run typecheck`.

**Done when:** the split renders; typecheck clean; suites green.

---

### Epic 1.4: Honest restart-recovery warning

**Goal:** A run marked "interrupted by restart" tells the operator the working tree
may carry agent edits the journal does not record, and to inspect `git status` before
resuming. **No agent count** — it would lie.
**Scope:** `packages/workflows/src/plugin/engine.ts` (recovery block).
**Dependencies:** none.
**Done when:** the recovery error string carries the warning; no fabricated count.

#### Task 1.4.1: Add the dirty-tree warning string to the recovery path

- [x] Done

**Context:** The recovery block (`engine.ts:1185-1190`) marks a `running` record as
`error`/"interrupted by restart". The adversarial pass **killed** the
"(N agents settled)" enrichment: `record.agents` is empty on a real crash (persisted
only at settle, never in `onProgress`), so any count would be a lie. The *real*
pre-crash per-agent data lives only in the feed file — surfacing it is Phase 3
(feed-rehydration), not here.

**Implementation vision:** Set `record.error` to "interrupted by restart — agents may
have mutated the working tree before the interrupt; inspect `git status` before
resume or relaunch". Do **not** append any count. String + recovery-path change only.

**Files:**
- Modify: `packages/workflows/src/plugin/engine.ts` (~1185-1190)
- Test: `packages/workflows/src/plugin/engine.test.ts`

**Verification:** `bun test packages/workflows/src/plugin/engine.test.ts` — a
recovered run carries the warning string; no count substring present.

**Done when:** the warning lands; suite green.

---

## Phase 2 — Engine-owned VCS foundation (epic-level)

*Detailed by ring:executing-plans after P0/P1 land, against the real code.*

### Epic 2.1: Per-unit commit checkpoint owned by the engine

**Goal:** The engine commits (or tags) the working tree after each pipeline/loop
**unit**, so a later agent's surviving git/file mutation cannot silently erase prior
units — drift becomes a *recoverable commit*, not destroyed work.
**Scope:** thread the host `$: BunShell` into the engine (discarded at `index.ts:56`;
add to `CreateWorkflowEngineOptions`), engine commit logic, drift detection.
**Dependencies:** P0 (contains the bleed first). **Gated on the async-emit-seam
race:** the adversarial pass found the synchronous void `emit` seam means a commit
can race behind the next unit's start — without commit-before-next-unit
serialization, the checkpoint is theater. Resolve the seam as a prerequisite.
**Done when:** after each unit the engine has a commit/tag of that unit's changes;
a later destructive op leaves prior units recoverable from the commit; the engine
never clobbers the operator's own pre-existing uncommitted changes (must detect and
refuse, not stomp).
**Open question (resolve at elaboration):** commit granularity for *dependent* units
(a later unit needs to SEE prior edits — commit-and-continue on the same tree) vs
*independent* units. Prerequisite for Epic 4.1's real-diff injection.

---

## Phase 3 — Recovery integrity (coupled cluster, epic-level)

### Epic 3.1: Write-ahead intent journal

**Goal:** Each agent writes (and flushes) an intent record **before** dispatch and a
completion record after, so a crash mid-agent is detectable.
**Scope:** `agent-call.ts` (dispatch ~337), journal format, engine drain/recovery.
**Dependencies:** P2. **High blast radius:** the intent record MUST be filtered out
of the resume replay cache — otherwise an unmatched intent poisons replay (re-runs or
returns a nonexistent cached result). This coupling is why it is not a P1 quick fix.
**Done when:** a run killed mid-agent leaves a durable intent-without-completion;
resume reconciles it (re-runs live, does not replay a missing result) and warns;
`journal.test.ts` covers the format; completed-call replay-by-key is preserved.

### Epic 3.2: Rehydrate recovered run counts from the feed

**Goal:** `workflow_status` for a recovered run reports the real agent-call counts
from the persisted feed instead of `0 / 0`.
**Scope:** engine recovery path (`progress: []` at ~1191), feed reader,
`agentCallTally` (`workflow-status.ts:557-574`).
**Dependencies:** coupled with 3.1 (both read the durable per-agent record across a
crash). The "fall back to `record.agents`" shortcut is **inert** (empty post-crash) —
the fix MUST read the feed file. **Done when:** a simulated recovery shows
`workflow_status` counting the feed's `agent:end` events; the correct `budgetLine`
snapshot path is unaffected.

---

## Phase 4 — Review integrity (probe-gated, epic-level)

> **PROBE RESOLVED (2026-06-08, static + host-confirmed) — both epics shipped.**
> The Epic 4.2 load-bearing assumption is resolved **conclusively against vendored
> opencode source**: `.references/opencode/packages/core/src/git.ts` (`Git.patch`)
> runs `git diff --binary HEAD -- <scope>` plus an `ls-files --others` untracked pass,
> **captured at message time** and stored as a `type:"snapshot"` message part
> (`v1/session.ts`); the SDK `SessionRevertData` reverts *to a messageID* (a snapshot),
> and `FileDiff` is a per-file `{file,before,after,additions,deletions}` snapshot, **not**
> a live unified git diff. Consequence: an out-of-band `git restore` / `git checkout --
> <file>` does **not** mutate opencode's stored snapshot, so the session diff stays
> NON-EMPTY after a revert — a `verifyDiff` against the **opencode session diff** would
> PASS ON PHANTOM/REVERTED work (#5's catastrophe). **Resolution:** Epic 4.2 verifies
> against **GIT** — this run's own checkpointer working-tree diff (`runCheckpointer.diff()`,
> the engine's privileged `$`), or a caller-provided `{check}` command run via `$` —
> **never** the opencode session diff. The static vendored-source read is more conclusive
> and deterministic than a flaky live run, so the **live host probe** (session edit →
> external `git checkout -- file` → fetch session diff → assert empty) is filed as an
> **OPTIONAL** confirmation, not a blocker. The `{check}` mode's `$` interpolation
> (`${{ raw: cmd }}` + `.cwd().nothrow()`) was additionally **live-probed** in Bun 1.3.10
> (multi-token command, real exit code) and confirmed.
>
> The plan brief's demand for **`label→sessionID` resolution plumbing** (below) is
> **refuted by the real design**: the diff is computed at the agent-call dispatch seam
> from the per-run checkpointer baseline **before** the reviewer session exists, so no
> sessionID lookup is needed and the `agent:end` binding deletion is irrelevant. The
> cache-key hazard is also handled: the diff rides a **synthetic `contextPart`**, not the
> prompt, so `computeCallKey` is unchanged and a reviewer replays its verdict on resume;
> `contextDiff`/`verifyDiff` are deliberately **absent from `CallKeyInput`**.

### Epic 4.1: Inject the real git diff into reviewers

**Goal:** Reviewer agents receive the engine-computed **real** `git diff` for the
unit under review (via the existing `contextParts` mechanism) and refuse to review on
an empty diff — killing phantom reviews of narrative-only "implemented" claims (#7).
**Scope:** `contextParts` forwarding from `AgentOpts` (missing at `agent-call.ts:337-351`),
`runner.diff()` via `$`, ~~label→sessionID resolution~~ (refuted — see probe note: the
diff is computed at the dispatch seam from the per-run checkpointer baseline before the
reviewer session exists, so no sessionID lookup is needed). **Dependencies:** P2 (per-unit
commits give the diff base). **Done when:** a reviewer's prompt contains the unit's real
diff; an empty diff blocks the review with a diagnostic. **SHIPPED.**

### Epic 4.2: Verify agent success against disk (`verifyDiff` post-condition)

**Goal:** An agent's "implemented: true" is treated as a hypothesis the engine checks
with a cheap ground-truth (diff non-empty for the unit, or a caller-provided check
command exits 0 via `$` + `awaitCompletion`); a failed check downgrades the result to
`null`.
**Scope:** post-condition API on `agent()` opts (parity-shaped with CC), engine
verification via `$`. **Dependencies:** P2. **PROBE RESOLVED (see Phase 4 note above):**
opencode's per-session diff IS a *snapshot* diff (vendored-source confirmed), so it would
pass on reverted/phantom work — therefore `verifyDiff` verifies against **GIT**
(`runCheckpointer.diff()` working-tree delta vs baseline, or a `{check}` command via `$`),
**never** the opencode session diff. The original live probe (session edit → external
`git checkout -- file` → fetch session diff → assert empty) is filed **OPTIONAL** — the
static read is conclusive. `verifyDiff` is **best-effort** (it proves "something on disk
vs HEAD" or a command exits 0, not that the agent's claim is correct) and **inert** on a
no-shell / non-git checkout (pass-through, never a fabricated failure). **Done when:** an
empty git diff (or a non-zero `{check}`) downgrades a settled agent to `null` with a
`verify_failed` diagnostic; a non-empty diff / exit-0 check preserves the result.
**SHIPPED.**

---

## HOST track — Real worktree isolation (parallel, host-gated, epic-level)

### Epic H.1: Per-agent git worktree isolation

> **PROBE RESOLVED (2026-06-08, host-confirmed GREEN) — inert seam landed, lifecycle deferred.**
> **Method (live, conclusive):** ran against the REAL runtime binary `opencode v1.16.2`
> (the exact version the plugin links against — NOT the divergent v1.2.25 Effect-rewrite
> vendored at `.references/opencode`, which is an unreliable oracle for runtime behavior).
> Launched `opencode serve` headless; created a session via `POST /session?directory=<git-worktree>`;
> the session returned `directory=<worktree>` and a DISTINCT projectID (not `global`).
> Prompted that session to run `pwd && git rev-parse --show-toplevel` in one bash tool
> call (claude-haiku-4-5). **Result:** BOTH lines = the worktree path; the assistant
> message `path` was `{cwd:<worktree>, root:<worktree>}`. **Control:** an identical
> session created with NO `directory` query ran `pwd` → the server launch cwd (`/tmp`),
> NOT the worktree. **Conclusion:** the SDK `directory` query param on `session.create`
> RE-ROOTS the worker's Bash/tool cwd (and git resolves against the worktree) — it is not
> merely project-lookup scoping. The brief's open feasibility question is answered GREEN,
> so **H.1 is NO LONGER host-gated; it is UNBLOCKED.** Probe artifacts torn down.
>
> **Plan-vs-reality symbol drifts corrected** (the Scope line below previously read
> `LaunchRequest.directory → EngineClient.query → adaptSdkClient → session-runner`, which
> names symbols that do not exist):
> 1. There is **no `query()` call**. The engine calls `client.session.create({ body })`;
>    `directory` is a SESSION-CREATE QUERY PARAM (`SessionCreateData.query.directory`,
>    SDK `gen/types.gen.d.ts:1817-1819`) which `adaptSdkClient` and `EngineClient.session.create`
>    both DROP today (they forward only `{ body }`).
> 2. "core" = `@drawers/core` at `packages/core/src/` — `LaunchRequest`/`SessionRunner`/
>    `EngineClient`/`adaptSdkClient` all live there, NOT in `packages/workflows`.
> 3. The destructuring site the brief calls `index.ts:56` is `plugin/index.ts:61`
>    (`WorkflowsPlugin = async ({ client, directory, $ }) =>`), which already passes a
>    SINGLE project-wide `directory` to `createWorkflowEngine`; there is no per-agent
>    directory anywhere on the launch path.
>
> **Shipped this phase:** the INERT directory-plumbing seam only — an optional
> `directory?: string` threaded straight down the ladder (`LaunchRequest` → `SessionRunner`
> launch `session.create` query → `EngineClient`/`SdkSessionClient`/`adaptSdkClient` →
> `AgentPrimitiveDeps` → `WorkflowRunDeps`), type-verified and forwarded spread-when-present
> so an absent directory yields byte-identical SDK/runner calls as today. The seam is
> UNFED at the engine top (`engine.ts` createWorkflowRun supplies no per-agent value), so
> nothing actually re-roots a worker yet. `directory` is deliberately kept OUT of
> `computeCallKey`/`CallKeyInput` (a worktree path would re-key every cached agent and
> re-run settled work — the same exclusion precedent as `contextDiff`/`verifyDiff`).
>
> **Residual dependency FILED (genuinely deferred, epic-level — NOT delivered by the seam):**
> the full worktree LIFECYCLE — worktree create, scratch branch, merge/cherry-pick back,
> conflict surfacing, auto-cleanup-if-unchanged — plus the code that MINTS a per-agent
> directory and feeds the now-plumbed seam. The seam UNBLOCKS this but does not deliver the
> epic's done-when ("isolated agents edit only their worktree and the engine merges back").
> **Shared-stash/refs flag:** even with a per-worktree cwd, `git stash`/refs/index are
> SHARED across worktrees of one repo — so this is not total isolation. NOTE: worker-
> *initiated* `git stash`/`restore`/`checkout --`/`reset`/`clean` is ALREADY denied today
> by the Epic 0.3 git-deny-hook (`plugin/index.ts:130-134`), so the residual is narrower
> than "git stash is shared" — it is real only for the FUTURE lifecycle (engine-side stash
> and refs/index sharing beyond stash). Until that lifecycle lands, **P0.4 fail-loud**
> (`isolation:'worktree'` degrades-to-`null` via `IsolationUnsupportedError`) remains the
> shipped behavior. The status-table row (md:84) is marked PARTIAL to match this epic body.
> **Prompt-time directory unverified:** the probe re-rooted cwd via `session.create` ALONE;
> whether `promptAsync`'s own `directory` query re-roots on RESUME is NOT verified, so the
> seam keeps `directory` off `resume()`/`dispatchPrompt`. A future per-resume worktree epic
> must re-probe.

**Goal:** Each isolated agent runs in its own `git worktree` on a scratch branch; the
engine merges/cherry-picks results back and surfaces conflicts; auto-cleanup if
unchanged (CC parity). Makes parallel AND serial multi-agent mutation safe by
construction — the only fix that closes the intra-unit parallel-writer collision that
commits alone cannot.
**Scope:** ~~host-capability probe~~ (RESOLVED GREEN, see note) + the
`LaunchRequest.directory` → `session.create` query param → `adaptSdkClient`/`EngineClient`
→ `AgentPrimitiveDeps`/`WorkflowRunDeps` plumbing seam (LANDED, inert), then worktree
lifecycle via `$` (DEFERRED — epic-level future work).
**Dependencies:** none on P0–P4; runs as an independent track. ~~**HOST-GATED — probe
required first:**~~ **PROBE RESOLVED GREEN (see note above)** — `session.create`'s
`query.directory` re-roots the worker's Bash/tool cwd (live-confirmed on opencode
v1.16.2; control with no directory landed at the server cwd). **Flag:** even with
worktrees, `git stash`/refs are shared across worktrees of one repo — not total
isolation (worker-initiated destructive git is already denied by Epic 0.3; the residual
is the future lifecycle's engine-side stash + refs/index sharing).
**Done when:** ~~the probe is conclusive~~ (DONE, green); the inert directory seam is
landed and type-verified; the full worktree lifecycle (isolated agents edit only their
worktree and the engine merges back with conflict surfacing) remains DEFERRED epic-level
work, with P0.4 fail-loud as the shipped behavior until it lands.

---

## Self-Review

- **Spec coverage:** #1→1.1, #2→1.2, #3→1.4 (warning) + 3.1 (journal), #4→3.2,
  #5→0.1/0.2/0.3 (deny) + 2.1 (recoverable commits) + H.1 (isolation), #6→0.4
  (fail-loud) + H.1 (real), #7→4.1 (diff inject) + 4.2 (verify), #8→1.3. All eight
  covered; the catastrophic #5 is addressed in three layers.
- **Adversarial corrections honored:** "prevention by construction" downgraded to
  mitigation (0.2 documents the limits); #4 `record.agents` fallback dropped as inert
  (3.2 reads the feed); #3 write-ahead journal deferred to P3 with the replay-cache
  poisoning hazard named; #7 `verifyDiff` probe-gated on snapshot-diff semantics;
  #1 null-inherit and #2 POSIX-only flagged.
- **Vagueness scan:** P0/P1 tasks name exact files, exact edits, enumerated test
  cases. No "appropriate"/"TBD". The two genuine decisions are surfaced for sign-off,
  not buried.
- **Contract consistency:** `isWorkerSession` (0.1) is consumed by 0.3;
  `isDestructiveGit` (0.2) by 0.3; the engine `$` handle threaded in 2.1 is reused by
  4.1/4.2/H.1. P1 introduces no new cross-epic contract.
- **Phase boundaries:** every phase ends in working, testable software. P0 ends with
  workers unable to destroy + honest isolation failure. P1 ends with four restored
  contracts. P2/P3/P4/H each end at a verifiable milestone.
- **Verification plausibility:** P0/P1 commands target real, existing test files
  (`engine.test.ts`, `git-deny.test.ts` [new], `index.test.ts`, `workflow.test.ts`,
  `format.test.ts`); assertion styles match the existing tests.
