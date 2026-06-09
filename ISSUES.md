# ISSUES

Observations from running the workflow engine on a real, heavy multi-agent job
(`wf_8q6kkzy1` — 15 agents, 4 phases, 15m51s, Matcher frontend red/yellow fixes).
The per-agent checkpoint-commit feature is new and worked: an earlier run of the
same script (`wf_7dpt49ht`) lost all work to a mid-run restart because nothing was
committed; this run would have survived one. These are the rough edges found while
verifying the result against git/disk truth. Raw notes — to be distilled.

---

## Issue 1 — Cross-run checkpoint residue pollutes `git log`

**Severity:** medium (history hygiene / operator confusion)

**What happened:**
The failed run `wf_7dpt49ht` left 3 checkpoint commits in the working branch's
history that I had previously believed were gone (the working *tree* was clean
after the restart, so `git status` showed nothing — but `git log` did not):

```
197a97fc workflow checkpoint: run=wf_7dpt49ht agent=kill dayjs ...
df536fb6 workflow checkpoint: run=wf_7dpt49ht agent=lodash -> native ...
f45b98f7 workflow checkpoint: run=wf_7dpt49ht agent=config: coverage+a11y+csp ...
```

These sit interleaved with the successful `wf_8q6kkzy1` checkpoints in the same
branch. A failed/aborted run's checkpoints are now permanent history noise.

**Why it matters:**
- `git log` becomes a diary of every attempt, including the dead ones.
- An operator inspecting history can't tell at a glance which checkpoints belong
  to the run that actually completed vs. an abandoned one.
- The "clean working tree" after the failed restart was misleading — it implied
  nothing happened, when in fact 3 commits had landed on the branch.

**Possible directions (not prescriptive):**
- Isolate checkpoints on a per-run ref/branch (e.g. `refs/opencode/wf_<id>`)
  instead of the working branch, and only fast-forward/squash onto the working
  branch on successful completion.
- On run failure/abort, offer to roll back (or clearly tag) that run's
  checkpoints rather than leaving them inline.
- At minimum, make the failure message surface *which commits* were left behind
  so the operator can decide, instead of only saying "inspect git status"
  (git status was empty; the evidence was in git log).

---

## Issue 2 — `verifyDiff` produces false negatives under intra-phase parallelism

**Severity:** high (correctness of reported result vs. reality)

**What happened:**
Three Phase-1 agents were reported `ok:false` / `verify_failed`
(git/command post-condition failed):

```
result.phase1: lodash ok:false, dayjs ok:false, i18n ok:false
diagnostics: [verify_failed] i18n ... / lodash ... / kill dayjs ...
```

But all three had actually landed correctly and were independently verified after
the run:
- `dayjs`, `lodash`, `@types/lodash` removed from `package.json` ✓
- `scripts/check-i18n-parity.mjs` present and exits 0 (2116 keys parity) ✓
- full suite green: `tsc` clean, lint 0 errors, 278 tests pass ✓

**Root cause (hypothesis):**
Each of these agents ran its `verifyDiff` check (`pnpm typecheck` / `pnpm lint`)
while *other agents in the same `parallel()` phase were still mutating the working
tree*. The check observed a transient, mid-flight state of the repo — not the
agent's own isolated result — and failed on someone else's half-written change.

`verifyDiff` downgrades the result to `null` on failure but does NOT revert the
agent's disk writes, so the work survived; the only damage was a **lying result
object** (`ok:false` for work that succeeded). A consumer trusting `result` would
wrongly conclude these fixes failed.

**Why it matters:**
- The whole point of `verifyDiff` is to assert disk/command truth. A false
  negative here is worse than no check — it actively misreports success as
  failure.
- It undermines trust in the `result` payload; I had to go verify everything by
  hand against git + disk, which defeats the purpose of the post-condition.

**Possible directions:**
- Run a parallel agent's `verifyDiff` against an **isolated view** of *that
  agent's* changes (e.g. against its own checkpoint commit / worktree), not
  against the shared mutating tree.
- Or: defer `verifyDiff` for `parallel()`-grouped agents until the phase barrier,
  and run each against the post-phase state — accepting that this checks
  "phase is consistent" rather than "this one agent is consistent".
- Or: scope the check command to the agent's touched paths where the tool allows
  (e.g. `pnpm test <agent's files>` already does this; whole-tree `typecheck`
  does not and is the main offender — a single typecheck sees the whole repo).
- Document clearly that whole-repo checks (`typecheck`) are unsafe as per-agent
  `verifyDiff` inside `parallel()`, and steer toward scoped checks.

---

## Issue 3 — Checkpoint commits miss file deletions

**Severity:** medium (incomplete checkpoint → manual cleanup required)

**What happened:**
The `domain/ cleanup (Option A)` agent deleted 21 files
(`src/domain/*-entity.ts`, `pagination-entity.ts`, moved `state-machine.ts`).
Its checkpoint commit (`4fceb103`) captured the *additions/modifications* (the
moved `state-machine.ts` in `lib/`, updated importers) but left the 21 deletions
**staged-but-uncommitted** in the index. After the run completed, `git status`
showed 21 pending `D` entries that I had to commit manually to get a clean tree.

```
D  ui/src/domain/matcher-actor-mapping-entity.ts
D  ui/src/domain/matcher-adjustment-entity.ts
... (21 total)
```

**Root cause (hypothesis):**
The checkpoint staging step appears to stage new/modified files but not removals
— likely a `git add <paths>` / `git add .` that doesn't capture deletions, rather
than `git add -A` (or `git add -u`).

**Why it matters:**
- The checkpoint is not a faithful snapshot of the agent's result — a restart
  immediately after this checkpoint would have *resurrected* the 21 deleted files
  (they'd be back on disk, un-deleted), partially undoing the cleanup.
- It silently requires manual finalization after a "successful" run, which is
  exactly the kind of hidden state the checkpoint feature is meant to eliminate.

**Possible directions:**
- Use `git add -A` (stage adds, modifies, AND deletes) for checkpoint staging.
- Add a post-checkpoint assertion that `git status --short` is empty for the
  agent's declared touched paths — if not, the checkpoint is incomplete.

---

## Meta note

The tool *surface* (the `workflow` / `workflow_status` / `workflow_stop` schemas)
is unchanged from before the plugin update — all three issues live in the engine
(checkpointing + verifyDiff timing), and were only discoverable by inspecting
`git log` / `git status` / re-running the gate by hand. Consider surfacing more of
this engine state in `workflow_status --full` so an operator doesn't have to drop
to git to reconcile the reported result with reality:
- which commits a run created (and which are residue from prior failed runs),
- whether the working tree is clean or has pending changes after completion,
- whether any `verify_failed` was a true failure vs. a stale-tree false negative.
