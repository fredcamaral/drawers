# Workflow Authoring-Guidance Improvements — Implementation Plan

> **For implementers:** Use ring:executing-plans (rolling wave: implement the
> detailed phase → user checkpoint → detail the next phase → implement → repeat).
> This document is the living source of truth — task elaboration for later
> phases is written back into it during execution.

**Goal:** Raise the floor of LLM-authored workflow scripts so they reliably use this plugin's git-truth review primitives, structure gated stages, and route work to specialist agents — by fixing the authoring manual (the `workflow` tool description), adding submit-time anti-pattern nudges, and shipping a canonical multi-phase template.

**Architecture:** The `workflow` tool description (`packages/workflows/src/plugin/tools/workflow.ts:224-289`, `WORKFLOW_DESCRIPTION`) is deliberately the authoring manual — the orchestrating model reads it on every turn and writes scripts from it (the rationale is stated in the file comment at `:217-222`). Two real scripts (a Claude-Code-authored one and an opencode-session one) were compared; both omit the same things the manual under-teaches. This plan closes those gaps at three leverage points, cheapest first: (1) the manual's prose, (2) the submit-time `architectureEcho` that already runs static analysis on the script, (3) a canonical saved-workflow template + README example.

**Tech Stack:** TypeScript, Bun (`bun test`, `bun run typecheck`, `bun run lint` via biome), opencode plugin SDK.

## Phase Overview

| Phase | Milestone | Epics | Status |
|-------|-----------|-------|--------|
| 1 | The manual teaches the five under-taught practices (disk-truth review, schema-when-you-gate, agentType-by-role, on-failure policy, a multi-phase example) | 1.1 | Detailed |
| 2 | The tool's submit-time return flags the highest-value anti-patterns while the script is still in the model's context | 2.1 | Epic-level |
| 3 | A canonical multi-phase rolling-wave workflow ships as a named template + README worked example | 3.1 | Detailed |

**Evidence base (the comparison that motivated this plan):**
- Both compared scripts review by telling the agent to run `git diff` in Bash, instead of `contextDiff:true` — which the engine already offers and which *refuses* a review when the diff is empty (`workflow.ts:240`). This is the single biggest shared miss and it is this plugin's headline git-truth feature.
- The opencode script left `implement`/`fix` agents schema-less (free-text returns), so the orchestrator could not gate control flow on them.
- The opencode script routed each stage to a specialist `agentType` (domain engineer for impl, a parallel reviewer panel for review) — a strength the Claude-Code script missed entirely (it used the default generalist for everything). The manual mentions `agentType` only as a bare opt, never as a role-routing practice.
- Neither script acts on a failed verify/gate: both report failure and return anyway, with no stop/escalate decision — and the manual is silent on what to do.
- Both worked examples in the manual are single-phase; neither models the sequential decompose→implement→review→fix shape that real multi-phase work needs.

---

## Phase 1 — Fix the authoring manual (`WORKFLOW_DESCRIPTION`)

Pure text edits to one exported string. Highest leverage (every script-authoring turn reads it), lowest risk. The wording IS the deliverable, so the proposed text is given verbatim below (Code Snippet Policy: a model-facing manual is the exact artifact where approximation changes behavior).

### Epic 1.1: Teach the five under-taught practices

**Goal:** `WORKFLOW_DESCRIPTION` names disk-truth review as a first-class pattern, states the schema-when-you-gate rule, nudges role-based `agentType` routing, gives an on-failure policy, and includes a multi-phase example.
**Scope:** `packages/workflows/src/plugin/tools/workflow.ts` (the `WORKFLOW_DESCRIPTION` template literal only, `:224-289`).
**Dependencies:** none.
**Done when:** the description contains the five additions; `bun run typecheck`/`lint` pass; any test asserting on `WORKFLOW_DESCRIPTION` content (in `workflow.test.ts`) is updated to match.

#### Task 1.1.1: Add a `review-against-disk-truth` pattern and an agentType-by-role nudge to the Patterns section

- [ ] Done

**Context:** The Patterns section (`workflow.ts:262-270`) lists six named shapes. Authors read it (the opencode script names review/fix/verify stages), but `contextDiff`/`verifyDiff` live only in the dense `agent()` opts paragraph at `:240`, so they get skipped. `agentType` is likewise only a bare opt at `:240` — never framed as "route by role." The fix is to surface both as named guidance where authors actually look.

**Implementation vision:** Append a seventh bullet to the Patterns list, and a short routing note. Use this exact text (match the existing bullet style — `name — description.`):

```
- review-against-disk-truth — reviewers get contextDiff:true so they review the engine-computed REAL git diff (and the review is REFUSED when the diff is empty, so a reviewer can never pass on narrative-only claims); implement/fix agents get verifyDiff (verifyDiff:true asserts the unit wrote to disk; verifyDiff:{check:'<cmd>'} asserts a command exits 0). Never review by telling an agent to run `git diff` itself — contextDiff is the engine's tamper-proof channel. Code review, fix loops.
```

And, immediately after the Patterns list, add a routing note:

```
Route by role with agentType: prefer a specialist (a domain engineer for implementation, dedicated reviewer agents for review, a planning agent for decomposition) over the default generalist whenever one exists; a parallel panel of distinct reviewer agentTypes catches what one generalist misses, and a narrower panel on later rounds saves tokens.
```

**Files:**
- Modify: `packages/workflows/src/plugin/tools/workflow.ts:262-270`
- Test: `packages/workflows/src/plugin/tools/workflow.test.ts`

**Verification:** `bun test packages/workflows/src/plugin/tools/workflow.test.ts` — passes (update any content snapshot/substring assertion on `WORKFLOW_DESCRIPTION`). `bun run typecheck` and `bun run lint` clean.

**Done when:** the seventh pattern and the routing note are present in `WORKFLOW_DESCRIPTION` with the exact intent above; tests green.

#### Task 1.1.2: State the schema-when-you-gate rule and an on-failure policy

- [ ] Done

**Context:** The opencode script left `implement`/`fix` schema-less and acted on nothing when its `verify` stage reported `buildPasses:false`. The manual's `agent()` entry (`:240`) explains `schema` mechanically but never says *when* it is mandatory; nothing anywhere addresses what to do on a failed post-condition. Both are decision-shaped gaps an author fills wrongly by default.

**Implementation vision:** Add one sentence to the `agent()` bullet (`:240`), right after the schema clause, and a two-sentence block after the Caps-and-failure-semantics section (`:253-255`). Exact text:

For the `agent()` bullet, append:
```
If later control flow branches on a result (a count, a pass/fail, a list to fan out over), that agent MUST have a schema — free text cannot be gated.
```

After the failure-semantics section, add a short block titled to match the existing `##` headers:
```
## Acting on failures

agent() failures and failed verifyDiff/contextDiff post-conditions degrade to null — the script keeps running unless you decide otherwise. When a stage gates downstream work, DECIDE explicitly: stop the run (throw), escalate (spawn a fix/repair agent), or record-and-continue. For SEQUENTIAL phases where phase N+1 builds on phase N's code, the default is to STOP on a red gate rather than compound onto broken work; for independent fan-out, record-and-continue and report the failures in the result.
```

**Files:**
- Modify: `packages/workflows/src/plugin/tools/workflow.ts:240` (the `agent()` bullet) and after `:255`
- Test: `packages/workflows/src/plugin/tools/workflow.test.ts`

**Verification:** `bun test packages/workflows/src/plugin/tools/workflow.test.ts`; `bun run typecheck`; `bun run lint`.

**Done when:** the schema-when-you-gate sentence and the `## Acting on failures` block are present; tests green.

#### Task 1.1.3: Add a multi-phase (decompose → implement → review → fix) worked example

- [ ] Done

**Context:** Both worked examples (`:272-289`) are single-phase. The most common real ask — execute a phased plan end to end — has no model to copy, so authors reinvent the sequential-phase shape (and reinvent it without schemas or contextDiff, per the evidence base).

**Implementation vision:** Add a third worked example after the verifyDiff example (`:289`), short and self-contained, demonstrating: sequential phases, a per-phase helper, `agentType` routing, `contextDiff:true` on the reviewer, `verifyDiff` on the implementer, a schema on the gated stage, and a stop-on-red-gate decision. Keep it under ~15 lines — it is a shape, not a program. Exact example:

```
## Multi-phase example (sequential, disk-truth review, stop-on-red)

  export const meta = { name: 'run-plan', description: 'Execute phases: implement -> review -> fix', phases: [{ title: 'Implement' }, { title: 'Review' }] }
  const GATE = { type: 'object', properties: { gatesPass: { type: 'boolean' }, findings: { type: 'array', items: { type: 'string' } } }, required: ['gatesPass', 'findings'] }
  for (const p of args.phases) {
    phase('Implement')
    await agent('Implement phase ' + p + ' per the plan. Run the gates.', { agentType: 'domain-engineer', verifyDiff: { check: args.testCmd }, phase: 'Implement' })
    phase('Review')
    const r = await agent('Review phase ' + p + ' against the diff.', { agentType: 'code-reviewer', schema: GATE, contextDiff: true, phase: 'Review' })
    if (!r || !r.gatesPass) { log('Phase ' + p + ' red — stopping before the next phase.'); break }
  }
```

Note in one line that `agentType` names are environment-dependent (the example's `domain-engineer`/`code-reviewer` are illustrative — authors substitute the agentTypes their platform actually registers).

**Files:**
- Modify: `packages/workflows/src/plugin/tools/workflow.ts:289` (append after the last example)
- Test: `packages/workflows/src/plugin/tools/workflow.test.ts`

**Verification:** `bun test packages/workflows/src/plugin/tools/workflow.test.ts`; `bun run typecheck`; `bun run lint`. Eyeball that the example parses as valid JS (no TS annotations, no banned `Date.now`/`Math.random`).

**Done when:** the multi-phase example is present and self-consistent with the rules added in 1.1.1–1.1.2; tests green.

---

## Phase 2 — Submit-time anti-pattern nudges (`architectureEcho`)

**Milestone:** When a script is submitted, the tool's return message flags the two highest-value anti-patterns *while the model still holds the script in context* and could resubmit — turning documented guidance into enforced-at-the-door feedback.

### Epic 2.1: Heuristic nudges in the architecture echo

**Goal:** `architectureEcho` (`workflow.ts:137-170`) — which already does cheap regex static analysis and returns "detected call-sites" — also emits up-to-two short ADVISORY warnings: (a) gated-looking script (`parallel`/`pipeline` present) with no `schema` anywhere, (b) review/fix/verify-looking script with no `contextDiff`/`verifyDiff` token anywhere.
**Scope:** `packages/workflows/src/plugin/tools/workflow.ts` (`architectureEcho` only), `packages/workflows/src/plugin/tools/workflow.test.ts`.
**Dependencies:** Phase 1 (the warnings point at the now-documented patterns by name — Phase 1 is already in the tree).
**Done when:** a script using `parallel`/`pipeline` but no `schema` gets a one-line "consider…no schema detected — gated stages need schemas" nudge; a script with `review`/`fix`/`verify` tokens but no `contextDiff`/`verifyDiff` token gets a one-line "consider…no disk-truth review detected — see review-against-disk-truth" nudge; neither fires on scripts that already do the right thing; the existing detected-call-sites line is byte-unchanged; submission is never blocked; at most two nudge lines emitted.

**Elaboration decisions (resolved):**
- **Heuristic keying (labels vs prompt substrings):** `architectureEcho` only receives the raw `source` string — it has no parsed view of which substrings are labels vs prompts vs identifiers. The existing detected-call-site logic is already pure regex over `source` (`workflow.ts:156-162`). So the review heuristic keys on **word-boundary token matches anywhere in `source`** (`/\b(review|fix|verify)\b/i`). This is best-effort by construction: it will match `verifyDiff` itself, a variable named `fix`, or the word in a comment. That is acceptable for an advisory nudge and matches the honesty of the existing "static approximation, not a DAG" framing. Do NOT attempt label/prompt extraction — it is out of scope and the source is arbitrary JS.
- **Suppression on the disk-truth nudge:** the review nudge fires on review/fix/verify tokens UNLESS a disk-truth token is present. The disk-truth token set is `/\b(contextDiff|verifyDiff)\b/` — note `verifyDiff` and `contextDiff` are themselves substrings that contain `verify`/no, so detect disk-truth FIRST and short-circuit. (A script that writes `verifyDiff: true` contains the token `verify` via `\bverify\b`? No — `\bverify\b` requires a word boundary after `verify`, and `verifyDiff` has no boundary there, so `\bverify\b` does NOT match inside `verifyDiff`. Confirm this with a test; it is the load-bearing reason the good-script case stays silent.)
- **Advisory wording:** both nudges lead with `consider:` and never use imperative/blocking language. They are appended AFTER the detected-call-sites line, so the detected line stays byte-identical.

#### Task 2.1.1: Emit the schema and disk-truth advisory nudges from `architectureEcho`

- [ ] Done

**Context:** `architectureEcho` (`packages/workflows/src/plugin/tools/workflow.ts:137-170`) already computes `hasSchema = /\bschema\b/.test(source)` (`:162`) and the `parallel`/`pipeline` counts (`:159-160`), and pushes one detected-call-sites line (`:164-168`). The two nudges reuse this exact pass — no new parse, no behavior change to the existing line. The pattern name `review-against-disk-truth` referenced by the disk-truth nudge is the Phase-1 pattern already present in `WORKFLOW_DESCRIPTION` (`:275`).

**Implementation vision:** After the existing `lines.push(...)` detected-call-sites block (after `:168`, before `return lines`), add the two heuristics. Reuse the already-computed `pipelines`, `parallels`, `hasSchema`; compute two new booleans over `source`:

```
const gatedShape = pipelines > 0 || parallels > 0;
const hasDiskTruth = /\b(contextDiff|verifyDiff)\b/.test(source);
const reviewShape = /\b(review|fix|verify)\b/i.test(source);

if (gatedShape && !hasSchema) {
  lines.push(
    "consider: no schema detected — gated stages (parallel/pipeline) that branch on a result need schemas (free text cannot be gated).",
  );
}
if (reviewShape && !hasDiskTruth) {
  lines.push(
    "consider: no disk-truth review detected — review/fix/verify stages should use contextDiff/verifyDiff (see the review-against-disk-truth pattern), not a self-run `git diff`.",
  );
}
```

Cap is structural: the existing meta line + detected line are unaffected; only these two `push`es are added, so the function can add at most two new lines — no explicit counter needed, but the order (schema first, disk-truth second) is fixed. Never throw; never short-circuit the caller. Place both blocks inside `architectureEcho`, which only runs when `source !== undefined` (the resume-without-source path returns `[]` early at `:138-140`, so resumes emit no nudges — preserve that).

**Named edge cases (each must hold):**
1. **`verifyDiff`/`contextDiff` do NOT trip the review token.** `\bverify\b` does not match inside `verifyDiff` (no word boundary after `verify`). So a good script using `verifyDiff: { check: ... }` and NO bare review/fix/verify word stays silent on the disk-truth nudge. Verify with a dedicated test.
2. **Good gated script stays silent.** A `pipeline`/`parallel` script that sets `schema:` anywhere → `hasSchema` true → no schema nudge.
3. **`schema` substring honesty.** `hasSchema` is `/\bschema\b/` (existing) — a script with `schema:` on any agent suppresses the nudge for the WHOLE script, even if one gated stage lacks it. This is the existing approximation; do not tighten it (per-stage schema attribution needs an AST and is out of scope).
4. **The disk-truth nudge fires on the existing REVIEW test fixture** (`workflow.test.ts:226-233`): it has `Review`/`Verify` tokens and `schema: FINDINGS` but NO `contextDiff`/`verifyDiff`. So after this change the REVIEW fixture emits the disk-truth nudge (not the schema nudge). The three existing echo tests (`:235-262`) use `toContain` and an extra appended line is additive — they still pass. Do NOT alter those tests; just confirm green.
5. **Resume-without-source emits nothing** (early `return []` at `:138`). The existing test at `:279-311` asserts `not.toContain("detected")` — unaffected, and it must also not contain `consider:`.
6. **Neither nudge fires on a plain single-`agent` script with no gated shape and no review token** (e.g. the `wf_arch0003` fan-out fixture at `:265-269` uses `agent("one"/"two"/"three")` — no pipeline/parallel, no review/fix/verify word, no schema → both silent). Confirm `wf_arch0003`'s `toMatch(/3.*agent/)` still passes.

**Files:**
- Modify: `packages/workflows/src/plugin/tools/workflow.ts` (`architectureEcho`, insert after the detected-call-sites `lines.push` at `:168`, before `return lines` at `:169`)

**Verification:** `bun test packages/workflows/src/plugin/tools/workflow.test.ts` (all existing echo tests stay green). `bun run typecheck` clean. `bun run lint` clean — ZERO new biome findings introduced by this change (the file is not in the known pre-existing lint baseline).

**Done when:** both `push`es are present in `architectureEcho`, gated only by the booleans above; existing tests green.

#### Task 2.1.2: Cover the nudges with bad-fires / good-silent tests in `workflow.test.ts`

- [ ] Done

**Context:** The echo describe block (`workflow.test.ts:225-312`) is the home for these. It already has the `makeEngine`/`createWorkflowTool`/`run`/`ctx`/`fixedIds` helpers in scope and uses `out` substring assertions (`:249-262`). Add new tests in the SAME block, following the exact shape of `test("echoes detected primitive call-site counts…")` (`:249-262`): build a script string, run the tool, assert on `out`. Use a fresh `wf_arch####` id per test via `fixedIds(...)` to match the surrounding convention.

**Implementation vision:** Add four tests inside the `describe("createWorkflowTool — architecture echo at submit (Task 6.2.2)")` block (append after the resume test at `:311`, before the closing `});` at `:312`). Match indentation (tabs) and the `await engine.dispose();` teardown used by every sibling test.

1. **Schema nudge fires on a gated, schema-less script:**
   - Script: a `parallel(...)` or `pipeline(...)` over `args.files` whose stages call `agent(...)` with NO `schema` key anywhere, NO `review`/`fix`/`verify` word (use a neutral verb like `"Summarize " + f`) so ONLY the schema nudge fires.
   - Assert: `expect(out).toContain("no schema detected")` and `expect(out.toLowerCase()).toContain("consider")`.
   - Assert the disk-truth nudge did NOT fire: `expect(out).not.toContain("disk-truth")`.

2. **Schema nudge silent on a gated script that sets a schema:**
   - Script: same gated shape but with `schema: { type: 'object' }` on a stage and still a neutral verb.
   - Assert: `expect(out).not.toContain("no schema detected")`.

3. **Disk-truth nudge fires on a review-shaped script with no disk-truth token:**
   - Script: an `agent("Review " + f, { schema: { type: 'object' } })` (schema present so the schema nudge stays silent and isolates the disk-truth assertion) with NO `contextDiff`/`verifyDiff`.
   - Assert: `expect(out).toContain("disk-truth")` and `expect(out).toContain("review-against-disk-truth")`.

4. **Disk-truth nudge silent on a script that uses `verifyDiff`/`contextDiff`:**
   - Script: `agent("Review " + f, { contextDiff: true, schema: { type: 'object' } })` plus a `verifyDiff: { check: 'bun test' }` on a fix stage — i.e. the GOOD shape.
   - Assert: `expect(out).not.toContain("disk-truth")`. This is the load-bearing edge case (1) from 2.1.1: `verifyDiff` must not self-trigger the `\bverify\b` token. To make the test prove the word-boundary claim sharply, ensure the script contains NO bare `review`/`fix`/`verify` word — use `agent("Inspect " + f, { contextDiff: true, ... })` so the only `verify` substring is inside `verifyDiff`. Then `not.toContain("disk-truth")` proves both that disk-truth tokens suppress AND that `verifyDiff` does not falsely trip the token.

**Files:**
- Modify: `packages/workflows/src/plugin/tools/workflow.test.ts` (append four tests to the echo describe block, after `:311`)

**Verification:** `bun test packages/workflows/src/plugin/tools/workflow.test.ts` — all tests (old + four new) green. `bun run typecheck` clean. `bun run lint` clean (this test file is NOT in the known pre-existing lint baseline — `tui/paths.test.ts`, `builtin-deep-research.test.ts`, `control.test.ts`, `tools/workflow-save.test.ts` are the baseline files; `tools/workflow.test.ts` is not).

**Done when:** the four tests exist and pass, demonstrating: bad gated script → schema nudge; good gated script → silent; review-shaped script → disk-truth nudge; `verifyDiff`/`contextDiff` script → silent.

---

## Phase 3 — Canonical multi-phase template + README

**Milestone:** A named, runnable workflow demonstrating the full rolling-wave shape ships with the plugin, so authors can start from a correct skeleton instead of the manual's prose, and the README documents it.

### Epic 3.1: Ship a `rolling-wave` built-in/saved template and document it

**Goal:** A canonical multi-phase workflow (decompose → implement → review → fix → synthesize, with agentType routing, contextDiff reviewers, verifyDiff implementers, schemas on gated stages, and stop-on-red) exists as a template authors can copy or invoke by name, and the package README's reference section points to it.
**Scope:** the built-ins registry (`packages/workflows/src/plugin/builtins.ts` and any `builtin-*.ts` sibling, following the `builtin-deep-research.ts` precedent), the package README, and tests for the registry.
**Dependencies:** Phase 1 (the template embodies the documented patterns; they must be settled first to avoid drift between manual and template).
**Done when:** the template is registered and loads by name like `deep-research`; it parses and passes the engine's script validation; the README references it as the multi-phase starting point; registry tests cover its presence.
**Decision resolved (elaboration):** ship a **true built-in** (a `builtin-rolling-wave.ts` source constant registered in `BUILTIN_WORKFLOWS`), following the `builtin-deep-research.ts` precedent exactly. Confirmed against the customization concern: the template's only per-project knobs (`agentType` names, an optional `testCmd`) are isolated to named constants / `args` and degrade safely (an unknown `agentType` falls back to the generalist; an absent `testCmd` makes `verifyDiff` assert a non-empty diff instead of running a command). So it runs unedited out of the box — the "always needs editing argues for skeleton" exit does not apply. Built-in wins: discoverable, name-invocable, parses + validates under the same guard as `deep-research`, and the registry test catches a botched `\\n` escape that a README skeleton never would.

**Validation done during elaboration (the draft source was run against the real engine):** the proposed source parses via `parseScript` (`meta.name` = `rolling-wave`, phases `[Decompose, Implement, Review, Fix, Synthesize]`), and its body evaluates end-to-end via `evaluateScript` on the eight allowed globals only — decompose → implement(`verifyDiff`) → review(`contextDiff`) → fix-on-red → re-review → synthesize, plus the stop-on-red `break` and the empty-`goal` honest-error path. No banned globals, no `Date.now`/`Math.random`/argless `new Date`, `+`-concatenation only, `\\n` for embedded newlines.

#### Task 3.1.1: Add the `builtin-rolling-wave.ts` source constant

- [ ] Done

**Context:** Built-ins live as TS string constants in the bundle, not on disk — `scripts/build.ts` only bundles JS/TS entrypoints, so there is no asset-embedding path (`builtins.ts:4-12`). The single precedent is `builtin-deep-research.ts`, which exports `DEEP_RESEARCH_SOURCE` as a `` ` ``-delimited template literal holding a JS program (`builtin-deep-research.ts:23-127`). The program is plain JS evaluated by `evaluateScript` against the eight globals `agent`/`pipeline`/`parallel`/`phase`/`log`/`args`/`budget`/`workflow` (`evaluate.ts:31-40`); banned inside it are `Date.now()`, `Math.random()`, argless `new Date()`, `setTimeout`/`setInterval`/`queueMicrotask`, `process`/`require`/`fetch`/`Bun` (`evaluate.ts:93-121`, `128-170`). Because the program sits inside an outer template literal, the precedent writes string newlines as `\\n` and uses `+` concatenation only — no backticks, no `${}` (`builtin-deep-research.ts:17-21, 59`). The `meta` block must be a PURE literal: only object/array/string/number/boolean/null, non-computed identifier or string keys, no calls/spreads/identifiers/templates (`meta.ts:181-242`); `meta.name` + `meta.description` are required non-empty strings and `meta.phases[].title` required non-empty (`meta.ts:273-334`). The opts the template uses are all real `AgentOpts` members: `label`, `phase`, `schema`, `agentType`, `contextDiff`, `verifyDiff` (`types.ts:12-69`).

**Implementation vision:** Create `packages/workflows/src/plugin/builtin-rolling-wave.ts` exporting `ROLLING_WAVE_SOURCE`, mirroring `builtin-deep-research.ts`'s file shape: a doc-comment explaining the canonical rolling-wave shape and the `\\n`/`+`-only authoring constraint, then the `export const ROLLING_WAVE_SOURCE = \`...\`` constant. Use the source below — it is the artifact that was run through `parseScript` + `evaluateScript` during elaboration and is the exact intended text (Code Snippet Policy: a shipped, parser-validated built-in is the artifact where approximation breaks it). The shape it embodies: `meta` with five phases; an honest-error guard on a missing `goal`; an optional `testCmd` that selects `verifyDiff:{check}` vs `verifyDiff:true`; a `PLANNER`/`IMPLEMENTER`/`REVIEWER` agentType triad as named constants with the "environment-dependent, falls back to generalist" comment; a `decompose` agent with a `{tasks:[...]}` schema (gated → schema mandatory, per 1.1.2); a sequential `for` loop per task running implement(`verifyDiff`) → review(`contextDiff`+`GATE` schema) → on red, fix(`verifyDiff`) + re-review; a stop-on-red `break` with a `log()` line when a review is null or `gatesPass:false`; a `Synthesize` agent (no schema — terminal, free text is fine); a structured return `{goal, completed, remaining, report}`.

```ts
/**
 * Source for the built-in `rolling-wave` workflow (Epic 3.1).
 *
 * Shipped as a string constant (built-ins live in the bundle, not on disk — see
 * {@link ./builtins}). The canonical multi-phase shape this plugin teaches:
 * decompose a goal into ordered tasks, then per task implement (verifyDiff proves
 * the agent wrote to disk) → review against the engine-computed REAL git diff
 * (contextDiff, refused on an empty diff) → fix what the review flags and
 * re-review; STOP the wave on a red gate rather than compounding onto broken
 * work; finally synthesize a report over what landed. This is the runnable
 * embodiment of the review-against-disk-truth / agentType-by-role / schema-when-
 * you-gate / stop-on-red practices the WORKFLOW_DESCRIPTION manual documents.
 *
 * The agentType triad (planner / domain-engineer / code-reviewer) is environment-
 * dependent — whichever the deployment registers activates; an unknown agentType
 * falls back to the default generalist. The optional `args.testCmd` selects the
 * verifyDiff post-condition: a command check when given, else a non-empty-diff
 * assertion.
 *
 * Authoring note: this is a JS program embedded in a TS template literal, so
 * string newlines inside it MUST be written as `\\n` (an actual newline would
 * break the embedded double-quoted literal), and the program uses `+`
 * concatenation only — no backticks or `${}` — so nothing collides with the
 * outer template.
 */
export const ROLLING_WAVE_SOURCE = `export const meta = {
  name: "rolling-wave",
  description: "Execute a multi-phase plan in rolling waves: decompose into tasks, implement each, review against the real git diff, fix what the review flags, and synthesize a final report. Stops a phase on a red gate rather than compounding onto broken work.",
  whenToUse: "When the user asks to execute a multi-phase or multi-task plan end to end with implement -> review -> fix gating.",
  phases: [
    { title: "Decompose" },
    { title: "Implement" },
    { title: "Review" },
    { title: "Fix" },
    { title: "Synthesize" },
  ],
};

// agentType names are ENVIRONMENT-DEPENDENT: the platform/registry decides them.
// These are illustrative — substitute the agentTypes your deployment registers;
// an unknown agentType falls back to the default generalist.
const PLANNER = "planner";
const IMPLEMENTER = "domain-engineer";
const REVIEWER = "code-reviewer";
const MAX_TASKS = 20;

const goal =
  args && typeof args === "object" && args.goal
    ? args.goal
    : typeof args === "string"
      ? args
      : "";
if (!goal) {
  return { error: "rolling-wave needs a goal — pass args.goal (or a string)." };
}
// Optional verification command run as a verifyDiff post-condition on implement/fix.
const testCmd =
  args && typeof args === "object" && typeof args.testCmd === "string"
    ? args.testCmd
    : "";
const verify = testCmd ? { check: testCmd } : true;

// 1. Decompose the goal into ordered, independently-implementable tasks.
phase("Decompose");
const planSchema = {
  type: "object",
  properties: { tasks: { type: "array", items: { type: "string" } } },
  required: ["tasks"],
};
const plan = await agent(
  "Decompose this goal into an ordered list of small, independently-implementable tasks. Return JSON {tasks:[...]}.\\n\\nGoal: " + goal,
  { label: "decompose", phase: "Decompose", agentType: PLANNER, schema: planSchema },
);
const tasks = (plan && plan.tasks && plan.tasks.length > 0 ? plan.tasks : [goal]).slice(
  0,
  MAX_TASKS,
);

// 2-4. For each task in order: implement (verifyDiff), review (contextDiff), fix on red.
// Sequential: a red gate STOPS before the next task rather than compounding onto
// broken work.
const GATE = {
  type: "object",
  properties: {
    gatesPass: { type: "boolean" },
    findings: { type: "array", items: { type: "string" } },
  },
  required: ["gatesPass", "findings"],
};
const done = [];
for (let i = 0; i < tasks.length; i++) {
  const task = tasks[i];

  phase("Implement");
  await agent(
    "Implement this task and run the gates. Write the changes to disk.\\n\\nTask: " + task,
    { label: "implement:" + i, phase: "Implement", agentType: IMPLEMENTER, verifyDiff: verify },
  );

  phase("Review");
  let review = await agent(
    "Review the work for this task against the real git diff. Return JSON {gatesPass, findings:[...]}.\\n\\nTask: " + task,
    { label: "review:" + i, phase: "Review", agentType: REVIEWER, schema: GATE, contextDiff: true },
  );

  if (review && !review.gatesPass) {
    phase("Fix");
    await agent(
      "Address these review findings and write the fixes to disk.\\n\\nTask: " +
        task +
        "\\nFindings:\\n" +
        review.findings.join("\\n"),
      { label: "fix:" + i, phase: "Fix", agentType: IMPLEMENTER, verifyDiff: verify },
    );
    review = await agent(
      "Re-review the work for this task against the real git diff after the fix. Return JSON {gatesPass, findings:[...]}.\\n\\nTask: " + task,
      { label: "rereview:" + i, phase: "Review", agentType: REVIEWER, schema: GATE, contextDiff: true },
    );
  }

  // Stop-on-red: a null review (empty diff / agent failure) or a still-failing gate
  // halts before the next task. Sequential phases must not build on a red base.
  if (!review || !review.gatesPass) {
    log("Task " + i + " (" + task + ") did not pass review — stopping the wave.");
    break;
  }
  done.push(task);
}

// 5. Synthesize a report over what landed.
phase("Synthesize");
const report = await agent(
  "Summarize what was implemented and reviewed for this goal, and what remains. Be honest about any task that stopped the wave.\\n\\nGoal: " +
    goal +
    "\\nCompleted tasks:\\n" +
    done.map((t) => "- " + t).join("\\n"),
  { label: "synthesize", phase: "Synthesize" },
);

return {
  goal: goal,
  completed: done,
  remaining: tasks.slice(done.length),
  report: report,
};
`;
```

**Named edge cases (each must hold):**
1. **Pure-literal `meta`.** Every value in `meta` is a string/array/object literal — no `MAX_TASKS`-style identifier reaches it (the constants are declared in the BODY, below the meta export). If a later edit moves a constant INTO `meta`, `parseScript` throws `MetaError` (`meta.ts:181-242`). Keep all computed/named values below the meta block.
2. **`\\n` not real newlines.** Embedded prompt newlines are `\\n` (two chars in the source string) so they survive inside the outer template literal — same as `builtin-deep-research.ts:59`. A literal newline inside the `meta` string values is fine (they contain none here); inside the program's double-quoted strings it would break the literal.
3. **No banned globals.** The program uses no `Date`/`Math`/`fetch`/`process`/timer — only the eight injected globals and `JSON`-free plain operations. `tasks.slice`, `Array#map`, `Array#join`, `Array#push` are ordinary array methods, allowed.
4. **`agentType` fallback is safe.** `PLANNER`/`IMPLEMENTER`/`REVIEWER` are illustrative; an unregistered agentType degrades to the default agent at the platform layer (same posture as `deep-research`'s `tools` allowlist). The doc-comment and the inline comment both say so — do NOT hardcode a real project's agent names.
5. **Empty `goal` returns an honest error WITHOUT spawning agents.** The guard returns before the first `agent()` call (mirrors `deep-research`'s empty-question guard, `builtin-deep-research.ts:47-49`). The 3.1.3 control-flow test asserts no agent is called on this path.
6. **`verifyDiff` shape.** `verify` is `{ check: testCmd }` when `args.testCmd` is a non-empty string, else `true` — both are valid `AgentOpts.verifyDiff` values (`types.ts:49-68`); `true` means "assert a non-empty diff", `{check}` means "run the command, assert exit 0."

**Files:**
- Create: `packages/workflows/src/plugin/builtin-rolling-wave.ts`

**Verification:** `bun run typecheck` (the new file must type-clean; it exports one `string` constant, so this is cheap). `bun run lint` clean — ZERO new biome findings (this new file is not in the known pre-existing lint baseline). Real parse + run coverage lands in 3.1.2/3.1.3.

**Done when:** `packages/workflows/src/plugin/builtin-rolling-wave.ts` exists, exporting `ROLLING_WAVE_SOURCE` exactly as above; typecheck + lint clean.

#### Task 3.1.2: Register `rolling-wave` in `BUILTIN_WORKFLOWS` and extend the registry test

- [ ] Done

**Context:** `BUILTIN_WORKFLOWS` (`builtins.ts:21-23`) is the single registry both resolution paths consult via `lookupBuiltin` — the in-script `workflow()` global (`resolve-source.ts`) and the top-level `workflow` tool (`workflow.ts`); a built-in WINS over a same-named on-disk file (`builtins.ts:6-12`). Registration is therefore just an import + one map entry; no resolver change is needed (both call sites are generic over the map). The registry test (`builtins.test.ts`) already has two guards: a `deep-research`-specific phases assertion (`builtins.test.ts:13-24`) and a generic "every built-in parses and meta.name matches its key" loop (`builtins.test.ts:26-31`). The generic loop already covers `rolling-wave` the moment it is registered — but add an explicit named test so a regression points at `rolling-wave` directly, matching the `deep-research` precedent.

**Implementation vision:**
- In `builtins.ts`: add `import { ROLLING_WAVE_SOURCE } from "./builtin-rolling-wave";` next to the existing `DEEP_RESEARCH_SOURCE` import (`builtins.ts:18`), and add `"rolling-wave": ROLLING_WAVE_SOURCE,` to the `BUILTIN_WORKFLOWS` object (`builtins.ts:21-23`). Update the file's closing doc sentence (`builtins.ts:15-16`, "Phase 3 adds the `deep-research` source.") to also name `rolling-wave` — one-line doc accuracy, traces to this task.
- In `builtins.test.ts`: add a named test mirroring the `deep-research` one (`builtins.test.ts:13-24`): `lookupBuiltin("rolling-wave")` is defined, `parseScript` returns `meta.name === "rolling-wave"` and `meta.phases?.map(p => p.title)` equals `["Decompose","Implement","Review","Fix","Synthesize"]`. Place it inside the existing `describe("built-in workflows", ...)` block, after the `deep-research` test. The generic loop test needs no edit — it iterates `BUILTIN_WORKFLOWS` and now exercises `rolling-wave` automatically.

**Named edge cases:**
1. **Generic-loop coverage is automatic but the named test is the regression locator.** Do not delete or weaken the generic loop; it is the catch-all guard against a botched `\\n` escape (`builtins.test.ts:6-11` states this is the shipped-validity guard since built-ins are never type-checked as code).
2. **No precedence/resolver edit.** Resolution is map-driven; adding the entry is sufficient. Do NOT touch `resolve-source.ts` or `workflow.ts` resolution — out of scope and untraced to this task.
3. **Phases array must match the source byte-for-byte.** The named test's expected `["Decompose","Implement","Review","Fix","Synthesize"]` must equal `meta.phases` in 3.1.1; if they drift, this test (and the generic loop's name check) fails loudly.

**Files:**
- Modify: `packages/workflows/src/plugin/builtins.ts:15-16` (doc line), `:18` (import), `:21-23` (map entry)
- Modify: `packages/workflows/src/plugin/builtins.test.ts` (add a named `rolling-wave` test inside the existing describe block, after the `deep-research` test at `:13-24`)

**Verification:** `bun test packages/workflows/src/plugin/builtins.test.ts` — the new named test + the generic loop both green (the loop now parses `rolling-wave` too). `bun run typecheck` clean. `bun run lint` clean (`builtins.test.ts` is not in the known pre-existing lint baseline).

**Done when:** `rolling-wave` resolves through `lookupBuiltin`, parses with the five expected phases, and the registry test asserts it by name; tests green.

#### Task 3.1.3: Control-flow test for the `rolling-wave` source (`builtin-rolling-wave.test.ts`)

- [ ] Done

**Context:** `parseScript` (covered by 3.1.2) proves the source PARSES; it does not prove the LOGIC runs on allowed globals only and threads decompose → implement → review → fix → synthesize correctly. The precedent is `builtin-deep-research.test.ts`: it does `parseScript(SOURCE).bodySource`, builds a `RuntimeApi` with real `pipeline`/`parallel` and a label-dispatched stub `agent`, runs `evaluateScript(body, api)`, and asserts the plumbing — explicitly NOT research quality, since live behavior needs real tools and is not unit-testable (`builtin-deep-research.test.ts:7-13, 15-45`). Reuse that exact harness shape (`makeApi` with `agent`/`phase`/`log`/`args`/`budget`/`workflow`/`parallel`/`pipeline`); `rolling-wave` uses only `agent`/`phase`/`log`/`args` of those, but supply the rest to satisfy `RuntimeApi`.

**Implementation vision:** Create `packages/workflows/src/plugin/builtin-rolling-wave.test.ts`, importing `ROLLING_WAVE_SOURCE`, `parseScript`, `evaluateScript`, and the `AgentOpts`/`RuntimeApi` types — same import set as `builtin-deep-research.test.ts:1-5`. Build a `makeApi` helper (copy the deep-research one; `pipeline`/`parallel` can be the same real implementations even though `rolling-wave` does not call them — keeping the harness identical reduces drift). Dispatch the stub `agent` by `o.label` prefix: `decompose` → `{tasks:[...]}`; `implement:*`/`fix:*` → a non-null string; `review:*`/`rereview:*` → a `{gatesPass, findings}` object the test controls; `synthesize` → a report string. Tests (mirror the three deep-research tests in spirit):

1. **Happy path threads all tasks through to a report.** Stub: `decompose` → `{tasks:["t0","t1"]}`; every `review:*` → `{gatesPass:true, findings:[]}` (no fix loop); `synthesize` → `"REPORT"`. Assert: `result.completed` equals `["t0","t1"]`, `result.remaining` is `[]`, `result.report === "REPORT"`, and `result.goal` is the passed goal. Assert NO `fix:*` agent was called (track called labels).
2. **A red review triggers fix + re-review, then continues on green.** Stub: `review:0` → `{gatesPass:false, findings:["f1"]}`, `rereview:0` → `{gatesPass:true, findings:[]}`, `review:1` → `{gatesPass:true}`. Assert: a `fix:0` AND a `rereview:0` label were called (the fix loop fired), and `result.completed` is `["t0","t1"]` (both landed after the fix).
3. **Stop-on-red halts the wave before later tasks.** Stub `decompose` → `{tasks:["t0","t1","t2"]}`; `review:0` → `{gatesPass:false, findings:["f"]}`, `rereview:0` → `{gatesPass:false, findings:["still"]}` (fix didn't satisfy). Assert: `result.completed` is `[]` (t0 never passed), `result.remaining` includes `t1`/`t2`, and NO `implement:1` label was called (the `break` fired before task 1). This is the load-bearing stop-on-red assertion.
4. **Empty `goal` returns an honest error without spawning agents.** `args:{}`; assert `result.error` contains `"goal"` and that the stub `agent` was never called (a `called` flag, like `builtin-deep-research.test.ts:102-114`).
5. **`verifyDiff` shape is wired from `args.testCmd`.** With `args:{goal:"g", testCmd:"bun test"}`, capture the `opts` passed to the first `implement:0` call and assert `opts.verifyDiff` deep-equals `{check:"bun test"}`; with no `testCmd`, assert `opts.verifyDiff === true`. (This proves the `verify` selection in 3.1.1 edge case 6 actually reaches the agent opts.)

**Named edge cases:**
1. **Stub determinism — no clocks/random.** The harness must not introduce `Date.now()`/`Math.random()` (the body would not, but neither should the test fixtures) so the test stays deterministic, matching the deep-research test's design note (`builtin-deep-research.test.ts:7-13`).
2. **`review` dispatch must distinguish `review:*` from `rereview:*`.** Both start with `re`; key on the full prefix (`label.startsWith("rereview:")` BEFORE `label.startsWith("review:")`, or match exact prefixes) so test 2/3 control the two rounds independently.
3. **Track called labels for the negative assertions.** Tests 1 (no `fix`), 3 (no `implement:1`), and 4 (no agent at all) all assert on absence — accumulate `calledLabels` in the stub and assert with `.not.toContain` / membership.

**Files:**
- Create: `packages/workflows/src/plugin/builtin-rolling-wave.test.ts`

**Verification:** `bun test packages/workflows/src/plugin/builtin-rolling-wave.test.ts` — all five tests green. `bun run typecheck` clean. `bun run lint` clean (the new test file is not in the known pre-existing lint baseline — confirm it introduces ZERO biome findings). Eyeball that the dispatch stub covers every label the source emits (`decompose`, `implement:*`, `review:*`, `fix:*`, `rereview:*`, `synthesize`) so an unstubbed label can't silently return `null` and mask a logic bug.

**Done when:** the five control-flow tests exist and pass, proving the source's plumbing (happy path, fix loop, stop-on-red break, empty-goal guard, verifyDiff wiring) on allowed globals only.

#### Task 3.1.4: Reference `rolling-wave` in the package README's Built-in workflows section

- [ ] Done

**Context:** The README's "Built-in workflows" section (`README.md:369-379`) is a table with one row (`deep-research`, `:375`) plus two prose notes (`:377`, `:379`). The Epic's Done-when requires the README point at the template "as the multi-phase starting point." The section already exists and has the right shape — add a second table row and a one-line note; do not restructure.

**Implementation vision:**
- Add a `rolling-wave` row to the built-ins table after the `deep-research` row (`README.md:375`): name `` `rolling-wave` ``; description summarizing the shape (decompose → per-task implement with `verifyDiff` → review against the real git diff with `contextDiff` → fix-on-red + re-review → synthesize, stopping the wave on a red gate) and the invocation `{ "name": "rolling-wave", "args": "{\"goal\": \"…\"}" }` (optionally `"testCmd"`). Match the existing row's voice and the `deep-research` invocation-string escaping style exactly (`:375`).
- Add one prose note after the table (alongside the existing `deep-research` notes at `:377`/`:379`): state that `rolling-wave`'s `agentType` triad (`planner`/`domain-engineer`/`code-reviewer`) is environment-dependent and falls back to the generalist if unregistered, that `args.testCmd` (optional) becomes the implementer's `verifyDiff` command check, and that it is the canonical multi-phase starting point — copy it as the skeleton for a phased-plan execution workflow. Keep it terse, matching the `deep-research` note's register (`:377`).
- Do NOT add a slash-command wrapper for `rolling-wave` (the `deep-research` `.opencode/command/deep-research.md` precedent exists, but a command file is project-scoped and adds a maintained surface for a template whose whole point is to be copied/edited; the Epic's Done-when asks only for a README reference, not a command). If a wrapper is later wanted, it is a follow-up, not this task.

**Named edge cases:**
1. **Invocation-string escaping.** The README escapes the JSON args as `"{\"question\": \"…\"}"` (`:375`); match that escaping for `"{\"goal\": \"…\"}"` so the rendered table is consistent and copy-pasteable.
2. **Table-only change — no section restructure.** Two additions (one row, one note). Every changed line traces to "reference the built-in as the multi-phase starting point." Do not touch the `deep-research` row or its notes.
3. **`#built-in-workflows` anchor unchanged.** The TOC link (`README.md:24`) and the in-doc references to `#built-in-workflows` (`README.md:118`) must keep resolving — do not rename the heading.

**Files:**
- Modify: `packages/workflows/README.md:375` (add a table row after `deep-research`) and after `:379` (add one prose note)

**Verification:** Read-back the section renders as a two-row table with the new note. No build/test gate applies to the README, but run `bun run lint` to confirm no markdown lint rule is wired that would flag it (biome does not lint `.md` by default; confirm the file is untouched by lint). Eyeball the invocation JSON escaping matches the `deep-research` row.

**Done when:** the README's Built-in workflows section lists `rolling-wave` with its invocation and a note naming it the canonical multi-phase starting point; the `deep-research` row/notes are unchanged.

---

## Self-Review

- **Spec coverage:** the five evidence-base gaps map to Phase 1 (disk-truth pattern → 1.1.1; agentType routing → 1.1.1; schema-when-you-gate → 1.1.2; on-failure policy → 1.1.2; multi-phase example → 1.1.3), reinforced at the door by Phase 2 and given a copyable skeleton by Phase 3. No gap unaddressed.
- **Vagueness scan:** Phases 1 and 3 (detailed waves) give exact `file:line` targets and verbatim insertion/source text for every edit — no "appropriate"/"TBD"; Phase 3's deferred built-in-vs-skeleton decision is resolved (true built-in, parser-validated during elaboration). Phase 2 carries one explicit deferred decision (heuristic keying), which is legitimate rolling-wave deferral, not vagueness.
- **Contract consistency:** the pattern name `review-against-disk-truth` introduced in 1.1.1 is the same name Phase 2's nudge points to and the same shape Phase 3's template embodies — one vocabulary across all three phases.
- **Phase boundaries:** Phase 1 ships an improved manual (verifiable: tests + read). Phase 2 ships door-checks (verifiable: echo unit tests). Phase 3 ships a template (verifiable: registry test + load). Each stands alone.
- **Verification plausibility:** `bun test <path>`, `bun run typecheck`, `bun run lint` are the repo's real scripts; `workflow.test.ts`, `builtins.ts`, and `builtin-deep-research.ts` exist (confirmed in the tree). Implementer must check `workflow.test.ts` for existing assertions on `WORKFLOW_DESCRIPTION`/`architectureEcho` and update them in lockstep — flagged in each task's verification.
