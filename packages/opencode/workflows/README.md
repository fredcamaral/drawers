# opencode-drawer-workflows

Deterministic multi-agent orchestration scripts for [OpenCode](https://opencode.ai). You write a plain-JavaScript script that fans out to many sub-agents — in pipelines, in parallel, in phases — and the plugin runs it in the background. The launch returns immediately with a run id; the parent session is never blocked. When the run settles, an idle parent session is woken to read the result automatically; a busy parent gets a toast and a notice folded into its next message. Runs are journaled, so a crashed or edited run resumes by replaying each unchanged agent call from the journal — matched per-item by key, independent of position — instead of re-spending tokens on work that already settled.

This README is both the package landing page and the complete authoring manual. Everything needed to write a correct workflow script is here; you do not need to read the source.

---

## Table of contents

1. [Install](#install)
2. [The tools](#the-tools)
3. [Writing workflows — the manual](#writing-workflows--the-manual)
   - [The `meta` block](#the-meta-block)
   - [The eight globals](#the-eight-globals)
   - [`pipeline` vs `parallel`](#pipeline-vs-parallel)
   - [Agent failure is `null`; what throws instead](#agent-failure-is-null-what-throws-instead)
   - [Structured output via schema](#structured-output-via-schema)
   - [Determinism rules](#determinism-rules)
   - [Caps](#caps)
   - [Budget](#budget)
   - [Resume](#resume)
   - [Saved workflows](#saved-workflows)
   - [Built-in workflows](#built-in-workflows)
   - [Sub-workflows](#sub-workflows)
4. [Patterns](#patterns)
5. [Worked examples](#worked-examples)
6. [Environment variables](#environment-variables)
7. [The native TUI viewer](#the-native-tui-viewer)
8. [Honest limitations](#honest-limitations)

---

## Install

Add the plugin to your OpenCode config (`opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-drawer-workflows"]
}
```

### Dev variant (local checkout only)

To run the plugin straight from a local checkout — for development of the plugin itself — register it by absolute `file://` path instead. **This form is for development only**; published installs use the npm form above.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///abs/path/to/packages/workflows/src/plugin/index.ts"]
}
```

Once loaded, the plugin contributes five tools to every session — `workflow`, `workflow_status`, `workflow_stop`, `workflow_save_run`, and `structured_output` — and a **native TUI viewer** you open with **`ctrl+o`** (see [The native TUI viewer](#the-native-tui-viewer)). The same package ships both the server tools and the viewer; there is no separate install.

---

## The tools

### `workflow` — launch a run

Selects a script source, loads it, and fires the run **detached**. It returns immediately with a `run_id` and the persisted script path — it does not block and you should not poll. When the run settles you are notified on three layers: an **active wake** of the parent session when it is idle (one prompt carrying a demarcated `[task-notification]` notice that points at `workflow_status`, so the assistant reads the result without you typing), a **TUI toast**, and a **next-message flush** that folds the notice into your next message. When the parent is busy mid-turn the wake is skipped — the host does not serialize concurrent session prompts — and the flush is the fallback. Wake and flush share one queue, so a completion is delivered exactly once; the toast is always additive.

The tool is **opt-in** by design: a workflow can spawn dozens of agents and consume large token volumes, so the tool's own description instructs the model to use it only when the user has explicitly asked for multi-agent orchestration (e.g. an `ultracode` keyword, a standing toggle, a skill that invokes it, or a request to run a named workflow). Otherwise the model should use single agent calls or describe the cost and ask first.

**Source selection.** Provide **exactly one** of `script`, `script_path`, or `name`. Empty/whitespace strings count as absent. Zero or two-or-more sources is an error — *except on resume*, where zero sources inherits the prior run's script and at most one override is allowed.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `script` | string | one-of | Inline self-contained workflow script (JavaScript). |
| `script_path` | string | one-of | Path to a script file, resolved relative to the project directory. |
| `name` | string | one-of | Name of a saved workflow at `.opencode/workflows/<name>.js` (or `.mjs`). |
| `args` | string | no | JSON-encoded value exposed to the script as `args`. A raw object is also accepted. Empty/whitespace → absent. Unparseable JSON string → error. |
| `resume_from_run_id` | string | no | Resume a prior run by its `run_id`. Each `agent()` call matching a journaled call key replays from cache (per-item, position-independent); changed/new/failed calls run live. A replay returns the frozen result — a re-run may differ. Source/args default to the prior run's when omitted. |
| `budget_tokens` | number | no | Output-token ceiling for the whole workflow (sum of child agents' output + reasoning tokens). When exhausted, further `agent()` calls are refused. Omit for no ceiling. A non-positive or non-finite value is treated as absent (no ceiling). |

**Coercion note.** OpenCode's raw execute path does not apply schema coercion, so `args` and `budget_tokens` are coerced defensively: `args` accepts a real object, a JSON string, or absent; `budget_tokens` accepts a number, a numeric string, or absent, and any garbage (`NaN`, `""`, `<= 0`) becomes "no budget" rather than silently disabling caps or crashing.

**Returns** (a string): the new `run_id`, the run name, the persisted script path, and a reminder to use `workflow_status` rather than poll. On resume it also names the run it resumed from.

### `workflow_status` — inspect a run

Reads a run's state: a flat chronological progress list (phase headers on change, one marker line per agent) while running, or the result/error once terminal. You do not need to poll — you are notified on completion — but you can read progress or the final result on demand.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `run_id` | string | yes | The `wf_…` run id returned by `workflow`. |
| `wait_ms` | number | no | Block up to this many ms (**capped at 120000**) for a *live* run to settle before rendering. Omit or `0` to read the current snapshot immediately. Non-positive/garbage collapses to `0`. |

`wait_ms` is the single-turn affordance: a headless `opencode run` has no completion notification to re-invoke the model, so `wait_ms` lets the caller block in-process until the run settles (or the cap elapses — a timeout simply renders the still-running snapshot, it never throws). A terminal run short-circuits (nothing to wait for).

The rendered output includes: a header (`id — description — status`, plus elapsed ms and `resumed from` when applicable), the progress lines, a budget line when a budget was set (`budget: <spent>/<total> output tokens`), the result JSON (head-truncated at 2000 chars) on completion or `error: …` on failure, and on any terminal run a cache tally (`<cached> cached / <live> live agent calls`).

Unknown `run_id` returns an error string listing the known run ids.

### `workflow_stop` — cancel a live run

Aborts a running workflow and all its in-flight agents.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `run_id` | string | yes | The `wf_…` run id. |

Three honest outcomes: unknown id → error listing known runs; already-terminal run → reports its status, no-op; running run → cancels and confirms.

### `workflow_save_run` — persist a run as a reusable workflow

Takes a run you have already launched and saves **its script** to `.opencode/workflows/<name>.js`, so the same workflow can be re-invoked by `name` later. The run may be finished or still running — it is the persisted *source* that is saved, not the result. This is the programmatic path behind the TUI's `s` keybinding.

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `run_id` | string | yes | The `wf_…` run id whose script to save. |
| `name` | string | yes | Name to save under. Charset is `[A-Za-z0-9._-]` (no `/`, `\`, or `.`/`..` traversal). |
| `overwrite` | boolean | no | Replace an existing saved workflow of the same name. Defaults to `false`. |

It **validates the script** (the same parse the launcher uses) before writing, and writes nothing on any refusal. Refusals: a bad name; a name that collides with a [built-in](#built-in-workflows) (built-ins win at resolve time, so a saved file by that name would never load); an unknown `run_id`; an unreadable or invalid source; or an existing file without `overwrite: true`.

### `structured_output` — internal, child-facing

`structured_output` is exposed as a tool but it is **not user-invoked**. It is granted to a child session only when its parent `agent()` call declared a `schema`. The child calls it to return a JSON value conforming to that schema; the value is ajv-validated, and a validation or parse failure is returned to the child as an error string so the model fixes it and calls again. The script never sees an unvalidated value — `agent({ schema })` resolves to the validated object, or `null` if the child never produced one. You do not call this tool from a workflow script.

---

## Writing workflows — the manual

A workflow script is **plain JavaScript** — TypeScript syntax fails to parse. It runs inside an async function, so top-level `await` works and the body's `return` value becomes the workflow result. The script is self-contained: no `import`, no `export` other than `meta`.

### The `meta` block

Every script must begin with a single `export const meta = {…}`. Its initializer must be a **pure literal**: only object literals, array literals, and `string`/`number`/`boolean`/`null` values. No variable references, function calls, spreads, template literals, computed keys, unary operators, or array holes. This is validated statically (an AST walk, never `eval`) so the body never runs unless the metadata is trustworthy.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `name` | non-empty string | yes | Workflow name; surfaces in status and notifications. |
| `description` | non-empty string | yes | What the workflow does. |
| `whenToUse` | string | no | Guidance on when to invoke it. |
| `phases` | array of phase objects | no | Declared phases (see below). |

Each entry in `phases` is an object with a required non-empty `title` and optional `detail` (string) and `model` (string). The `phases` you declare here are documentation/grouping metadata; the *active* progress phase at runtime is set by the `phase()` global or a per-call `opts.phase` (see below). Keep phase titles consistent between `meta.phases` and your `phase()` calls so the declared phases match what the progress tree renders.

```js
export const meta = {
  name: "review",
  description: "Review changed files, then adversarially verify the findings.",
  whenToUse: "When the user asks for a multi-file review pass.",
  phases: [
    { title: "Review", detail: "One reviewer per file." },
    { title: "Verify", detail: "Adversarial check of each review." },
  ],
};

return "ok";
```

### The eight globals

The body programs against exactly eight injected globals.

| Global | Signature | Purpose |
|---|---|---|
| `agent` | `(prompt: string, opts?) => Promise<unknown>` | Spawn a sub-agent. Resolves to its final text, a validated object (with `schema`), or `null` on failure. |
| `pipeline` | `(items, ...stages) => Promise<unknown[]>` | Per-item independent chains, **no barrier** between stages. |
| `parallel` | `(thunks) => Promise<unknown[]>` | Run thunks concurrently **with a barrier**; never rejects. |
| `phase` | `(title: string) => void` | Set the active progress phase for subsequent agent calls. |
| `log` | `(message: string) => void` | Emit a narrator line into the run's progress. |
| `args` | value | The verbatim JSON value passed via the `args` tool parameter. |
| `budget` | `BudgetView` | The token budget view: `total`, `spent()`, `remaining()`. |
| `workflow` | `(nameOrRef, args?) => Promise<unknown>` | Run another workflow inline as a sub-step (depth-1). |

#### `agent(prompt, opts?)`

Spawns one sub-agent and resolves to its final text (a completed non-structured agent), a validated object (with `schema`), or `null` on any failure.

```js
const summary = await agent("Summarize the architecture of this repo in 3 bullets.", {
  label: "summarize",
  phase: "Survey",
});
```

`opts` (`AgentOpts`):

| Option | Type | Status | Meaning |
|---|---|---|---|
| `label` | string | supported | Display label in the progress tree. Defaults to the prompt's first 60 chars. |
| `phase` | string | supported | Progress group for this call; overrides the global `phase()` state. |
| `schema` | object (JSON Schema) | supported | Request a validated structured result (see [Structured output](#structured-output-via-schema)). |
| `model` | string | supported | Model override; default inherits the session model. |
| `agentType` | string | supported | Custom subagent type from the same registry as the `Agent` tool. |
| `tools` | string[] | supported | Tool names to **enable** for this agent (e.g. web search/fetch). Names are environment-dependent (the platform/MCP servers define them); composes with `schema`. This is the seam the built-in `deep-research` workflow uses. Omit to inherit the session's tools. |
| `isolation` | `"worktree"` | supported (git-backed) | Runs the agent in its **own git worktree** — a scratch branch checked out in a sibling dir — so parallel mutating agents never clobber one shared tree; the agent's edits are committed and merged back when it settles. Active only on a git-backed run with shell access; on a non-git / no-shell checkout it degrades to `null` with a loud diagnostic rather than silently running unisolated. |

**`isolation: "worktree"` in depth.** On a git-backed run (a real work tree with shell access) an `isolation: "worktree"` agent is minted its own worktree — `git worktree add` on a scratch branch `wf/<runId>/<label>`, checked out in a sibling directory — and runs there in isolation. When it settles, its uncommitted edits are committed onto the scratch branch and merged back into the main tree: a clean merge reclaims the worktree and branch; a **merge conflict** preserves the worktree and resolves the agent to a `{ status: "conflict" }` result for manual resolution; any other merge failure preserves the worktree and degrades the agent to `null` for re-attempt on resume. On a **non-git or no-shell** checkout there is no worktree primitive, so the call degrades to `null` with a loud diagnostic — it never silently runs unisolated. Use it for agents that mutate files in parallel.

#### `phase(title)` and `log(message)`

```js
phase("Survey");
log("Found 12 changed files; reviewing the 4 with logic changes.");
```

`phase()` sets the active progress group; subsequent `agent()` calls without an explicit `opts.phase` render under it. `log()` emits a narrator line. Note: a reflexive `console.log`/`warn`/`error`/`info` inside a script is rerouted to `log()` rather than the host stdout.

#### `args`

`args` is the verbatim JSON value the caller passed. Read timestamps, file lists, or configuration from here — never from the clock or randomness (see [Determinism](#determinism-rules)).

```js
const files = (args && args.files) || [];
```

### `pipeline` vs `parallel`

These are the two composition primitives. They never touch the runner — they compose whatever async functions you pass — and both **degrade rather than detonate**: a failure becomes a `null` slot, not a rejection.

#### `pipeline(items, ...stages)` — the default, no barrier

Runs each item through all stages **independently, with no barrier between stages**. Item A can be in stage 3 while item B is still in stage 1. Each stage receives `(prevResult, originalItem, index)` and its return value (awaited) feeds the next stage. A throwing stage (sync or async) drops **that item** to `null` and skips its remaining stages; other items are unaffected. Zero stages returns the items unchanged.

```js
const results = await pipeline(
  args.files,
  (file) => agent("Review " + file, { label: "review:" + file, phase: "Review" }),
  (review, file) => agent("Summarize the review of " + file + ":\n" + review, { label: "sum:" + file }),
);
```

This is the default because most fan-out work is per-item and independent: there is no reason to make item B's stage 2 wait on item A's stage 1.

#### `parallel(thunks)` — the barrier

Runs an array of zero-argument thunks concurrently and **awaits all of them before returning** (the barrier). A failing thunk — rejects, throws sync or async, or is not callable — resolves to `null` at its original index. The call itself **never rejects**.

```js
const verified = await parallel(
  reviews.map((r) => () => agent("Adversarially verify: " + r, { label: "verify", phase: "Verify" })),
);
```

Note the shape: `parallel` takes **thunks** (`() => agent(...)`), not promises. Wrapping each call in a thunk is what lets a synchronous throw route into the same null-slot path as an async rejection.

**When is a barrier genuinely right?** Use `parallel` when a later stage must see *all* results together — an aggregation, a cross-item comparison, a synthesis step that reads every prior output. If each item's downstream work is independent, prefer `pipeline`; the barrier only adds latency (everyone waits for the slowest) when you do not need it.

### Agent failure is `null`; what throws instead

`agent()` follows "degrade, don't detonate." An agent that dies on a terminal status, or a runner call that throws, resolves to `null` — never a rejection. There is **no per-agent wall-clock timeout**: workflows are long-running by nature, so an agent waits for as long as it needs to reach a terminal status (the completion gate still resolves it on normal idle completion, a vanished session, or a stale backstop of 45 minutes of *total* silence — which an actively-working agent never reaches). Filter the nulls out:

```js
const reviews = (await pipeline(files, reviewStage)).filter(Boolean);
```

Three things **do** throw out of `agent()` (and propagate out of the workflow as an error unless you catch them) — they are meant to stop the run:

| Throws | When |
|---|---|
| `AgentCapError` | The lifetime cap of 1000 agent calls was hit. |
| `BudgetExhaustedError` | A budget was set and is exhausted; the call is refused. |
| `SchemaCompileError` | The `schema` you passed is malformed (a script bug). Compiled before any slot is acquired. |

`pipeline` and `parallel` also throw `ItemCapError` at call time if you pass more than 4096 items/thunks — an explicit error, never a silent truncation.

### Structured output via schema

Pass a JSON Schema as `opts.schema` and `agent()` resolves to a **validated object** instead of free text. Under the hood: the child's prompt is suffixed with instructions to call `structured_output`, the child is granted that tool, the schema is compiled and registered against the child session, and the returned value is ajv-validated. A non-conforming value is bounced back to the child to fix and retry. A completion that never produces a structured result earns exactly one re-prompt, then resolves to `null`. Non-completed statuses resolve to `null`.

```js
const finding = await agent("Inspect auth.ts for injection risks.", {
  label: "scan:auth.ts",
  schema: {
    type: "object",
    properties: {
      file: { type: "string" },
      severity: { type: "string", enum: ["low", "medium", "high"] },
      issues: { type: "array", items: { type: "string" } },
    },
    required: ["file", "severity", "issues"],
  },
});
// finding is the validated object, or null if the child never produced one.
```

A malformed *schema* (not a malformed result) throws `SchemaCompileError` at call time, before any agent is launched — treat it as a script bug.

### Determinism rules

The script body runs in a deterministic sandbox. The following are **banned** and throw `DeterminismError` from inside the body:

| Banned | Why |
|---|---|
| `Date.now()` | Nondeterministic timestamp. |
| `new Date()` (zero-arg) | Nondeterministic timestamp. `new Date(ms)`, `Date.parse`, `Date.UTC`, and instance methods are fine. |
| `Math.random()` | Nondeterministic. Other `Math` members work. |
| `setTimeout`, `setInterval`, `setImmediate`, `queueMicrotask` | Scheduling has no place in agent orchestration. |

In addition: the body runs in strict mode (an accidental global write like `x = 1` throws), `globalThis` is frozen and empty (so `globalThis.Date.now()` cannot bypass the shadow), and `process`/`require`/`module`/`exports`/`Bun`/`fetch` are `undefined`. `console.*` is rerouted to `log()`.

**Why this exists — and what it is not.** This is *not* a security sandbox. The script author already holds `bash`; containing them is pointless. The threat model is **resume-cache poisoning**: if a nondeterministic value (a wall-clock timestamp, a random number) leaks into an `agent()` prompt, the replay key for that call changes between runs, and resume can no longer match the cached result. The ban keeps the values reaching `agent()` reproducible so the journal stays valid. If you need a timestamp or a seed, pass it through `args`.

### Caps

| Cap | Value | Behavior on hit |
|---|---|---|
| Agent lifetime cap | 1000 calls per workflow | Next `agent()` (or sub-workflow boundary) throws `AgentCapError`. Counts every invocation, cached or live; shared with sub-workflows. |
| Items per `pipeline`/`parallel` call | 4096 | Throws `ItemCapError` at call time. Never truncates silently. |
| Concurrency gate | `min(16, cores − 2)` | Effective ceiling on simultaneously-launched agents per run. Excess calls queue until a slot frees. |

The concurrency gate is the authoritative limiter for in-flight agents; it is not something you configure from the script.

### Budget

`budget` is a view over the run's token ceiling:

| Member | Returns | Meaning |
|---|---|---|
| `budget.total` | `number \| null` | The ceiling set via `budget_tokens`, or `null` when none was set. |
| `budget.spent()` | `number` | Output + reasoning tokens consumed so far by the workflow's child agents. |
| `budget.remaining()` | `number` | `max(0, total − spent())`, or `Infinity` when there is no ceiling. |

When a budget is set, each `agent()` call charges the child's output + reasoning tokens against the accumulator at settle (reasoning is output-priced, hence folded into output). Because the charge is awaited before the call resolves, the *next sequential* `agent()` call's pre-check sees it; if `total !== null` and `remaining() <= 0`, the call throws `BudgetExhaustedError`. A failed agent still consumed tokens, so it is charged like a completed one. Concurrent calls are best-effort: two settling in overlapping windows both record, but a pre-check between them may not have seen the other yet.

**Loop-until-budget pattern:**

```js
const findings = [];
let i = 0;
while (budget.remaining() > 0 && i < args.files.length) {
  const f = await agent("Review " + args.files[i], { label: "review:" + args.files[i] });
  if (f) findings.push(f);
  i++;
}
return findings;
```

**Declared deviation from Claude Code.** Claude Code's Workflows spec describes a *turn-wide shared pool* — the budget prices the whole turn, including the parent. **This port counts only the workflow's child agents.** `budget_tokens` prices the *workflow*, not the surrounding turn; the parent session's own tokens are not charged. This is an intentional deviation, documented so you size budgets accordingly.

### Resume

Resume replays each unchanged `agent()` call from a journal and runs the rest live, matched **per-item by key and occurrence** — independent of position. Pass `resume_from_run_id` to the `workflow` tool. The resumed run gets its **own new run id and its own journal**, seeded from the prior run's journal.

What replays vs. re-runs:

- **Replays (from cache, no relaunch):** every `agent()` call whose `(prompt, opts)` key matches a journaled call, regardless of where it sits in the script. Matching is position-independent: editing one item (or reordering items) does **not** void unchanged items — an edited `parallel()` item 0 still replays an unchanged, expensive item 1 for free. A replayed call is rendered as `cached` in the progress tree and still counts against the lifetime cap (a resume hits the cap where the original did).
- **Occurrence semantics:** N byte-identical journaled calls replay their N journaled results, then the N+1th identical call runs live. (This is what keeps CC's adversarial-verify pattern — N byte-identical refuters — correct; key-only matching would wrongly collapse them to one.)
- **Re-runs live:** any call whose key has no remaining journaled match — an edited prompt/opts, a new call, or an extra occurrence beyond what was journaled.
- **Always re-runs:** a failed/`null` agent. Only **settled, non-null** results are journaled, so a failure was never journaled and re-runs on resume (failure-targeted retry, by construction).
- **Non-determinism contract:** a replay returns the **frozen** journaled result. A call that re-runs live may legitimately return a *different* answer — agents are non-deterministic. Resume buys you "don't pay twice for unchanged work", not "identical output forever".

The replay key is a sha256 of `(prompt, label, phase, schema, model, agentType)`. Field order and schema key order do not matter (canonicalized); changing the prompt, model, or *presence* of a schema changes the key, so that call re-runs live (other calls are unaffected).

`resume_from_run_id` defaults source and args to the prior run's persisted values when you omit them; you may pass an edited source as a single override. Resume **survives OpenCode restarts** because the journal is on disk (one JSONL file per run); a journal append is drained before the run settles, so a single-turn `opencode run` that exits the instant the turn ends still leaves a durable journal for a later resume.

A run left `running` by a dead process is recovered on startup as `error("interrupted by restart")` — its children are not relaunched; resume it explicitly to continue.

### Saved workflows

Place a script at `.opencode/workflows/<name>.js` (or `.mjs`) in your project directory and invoke it by `name`:

```jsonc
// workflow tool call
{ "name": "review", "args": "{\"files\": [\"a.ts\", \"b.ts\"]}" }
```

Name resolution tries `<name>.js` first, then `<name>.mjs`, rooted at `<project>/.opencode/workflows/`. An unknown name returns an error listing what is available in that directory.

You do not have to hand-author the file: a run you launched inline (via `script` or `script_path`) can be promoted into a saved workflow with the [`workflow_save_run`](#workflow_save_run--persist-a-run-as-a-reusable-workflow) tool or the TUI viewer's `s` keybinding — both persist the run's script under a name you choose so it becomes invocable by `name` thereafter.

### Built-in workflows

Some workflows ship **inside the plugin** and resolve by name with no file on disk. A built-in **wins** over a same-named user file in `.opencode/workflows/` — a shipped capability stays predictably available and cannot be silently shadowed.

| Name | What it does |
|---|---|
| `deep-research` | Fans out web searches across independent angles, extracts checkable claims with source URLs, adversarially verifies each claim against its own source (dropping the unsupported ones), and synthesizes a cited report. Invoke with `{ "name": "deep-research", "args": "{\"question\": \"…\"}" }`. |
| `rolling-wave` | Executes a multi-phase plan in rolling waves: decomposes a goal into ordered tasks, then per task implements (with `verifyDiff` proving disk truth) → reviews against the real git diff (`contextDiff`) → fixes what the review flags and re-reviews, stopping the wave on a red gate rather than compounding onto broken work, then synthesizes a report. Invoke with `{ "name": "rolling-wave", "args": "{\"goal\": \"…\"}" }` (optionally add `"testCmd"`). |

`deep-research`'s research agents request the `tools` allowlist `["websearch", "webfetch", "exa", "firecrawl"]` — names are environment-dependent, so whichever your OpenCode/MCP setup provides activates and the rest are no-ops. If your deployment names web tools differently, the built-in source is the place to adjust.

`rolling-wave` is the canonical multi-phase starting point — copy its source as the skeleton for a phased-plan execution workflow. Its `agentType` triad (`planner`/`domain-engineer`/`code-reviewer`) is environment-dependent and falls back to the generalist if your deployment does not register those names; the optional `args.testCmd` becomes the implementer's `verifyDiff` command check (absent → `verifyDiff` asserts a non-empty diff instead).

A `/deep-research <question>` slash-command wrapper ships at `.opencode/command/deep-research.md` in this package; copy it into your project's `.opencode/command/` to get the ergonomic invocation (OpenCode has no plugin-level command registration, so command files are project-scoped).

### Sub-workflows

The `workflow(nameOrRef, args?)` global runs another workflow inline as a sub-step. `nameOrRef` is either a saved-name string or a `{ scriptPath }` ref (read relative to the project directory). `args` becomes the child's verbatim `args`.

```js
const helperResult = await workflow("helper", { x: 1 });
const inlineResult = await workflow({ scriptPath: "scripts/extra.js" }, args);
```

Semantics:

- **Depth-1 only.** A child workflow has no `workflow()` available — calling it inside a child throws `NestingError`. Nesting is exactly one level deep.
- **Error semantics differ from `agent()`.** A child that errors **throws** `Error(child.error)` out of `workflow()` — catchable, unlike `agent()`'s silent `null`. A child that completes returns its `return` value.
- **Shared caps and budget.** The child shares the parent's lifetime agent counter and budget; the boundary itself consumes one of the 1000 lifetime slots, and the child's own agents count too.
- **Resume.** The sub-workflow boundary is journaled as a single key over the *resolved child source* + args. Editing the child source (even a change the parent never sees) changes that key and re-runs the child; otherwise a matching boundary replays the cached child result without running the child at all. The child's internal agent calls get no individual journal entries — the one boundary key covers them.

---

## Patterns

Six composable shapes the Claude Code workflow guidance names; ours mirrors them. Each is the same move — "spawn isolated agents, then combine" — arranged differently. Naming the pattern when you ask for a workflow sharpens what Claude builds. Mix them freely; a research workflow is fan-out → adversarial-verification → generate-and-filter in one pipeline.

- **classify-and-act** — one agent classifies the input, then you branch to a specialist agent per class (or classify the *output* at the end to shape it). Example 2 below is this shape: each file is classified into a severity bucket before anything acts on it. Mixed backlogs, triage.
- **fan-out-and-synthesize** — one agent per independent step, each in its own clean context so the steps never cross-contaminate, then a **barrier** that merges their structured outputs into one result. Example 1 below fans out with no synthesis barrier; add a `parallel`-gated merge step to turn it into full fan-out-and-synthesize. Per-file audits, multi-angle research.
- **adversarial-verification** — for each finding, spawn a *separate* agent whose only job is to refute it against a rubric. Producer and skeptic never share a context, which is what kills self-preference: a finding survives only if the skeptic cannot knock it down. Example 3 below is the flagship. Security findings, factual claims.
- **generate-and-filter** — overgenerate a wide set of candidates, then a judge agent keeps only the rubric-passers. The generator and the judge **must be different agents** — a generator grading its own output is self-preference wearing a different hat. Naming, design exploration:

```js
// generate-and-filter: overgenerate in parallel, then a DIFFERENT agent judges.
const candidates = await parallel(
  Array.from({ length: 12 }, (_, i) =>
    () => agent("Propose CLI tool name #" + i + " for: " + args.brief, { label: "gen:" + i }),
  ),
);
const top3 = {
  type: "object",
  properties: { names: { type: "array", items: { type: "string" } } },
  required: ["names"],
};
return await agent(
  "Keep the 3 best names against the rubric (short, memorable, no clash):\n" +
    candidates.filter(Boolean).join("\n"),
  { label: "judge", schema: top3 },
);
```

- **tournament** — N agents attempt the *same* task with different approaches; a judge compares them **pairwise** ("is A better than B?") until one wins. Comparative judgment is more reliable than absolute 1–10 scoring, which drifts. The deterministic JS loop holds the bracket; only the running order stays in context. There is **no `tournament()` primitive** — use `agent()` plus a plain loop, because keeping the bracket in JS is exactly what preserves resume. Taste-based ranking, sorting 1000+ items:

```js
// tournament: the bracket lives in the JS loop, not in an agent.
const pick = {
  type: "object",
  properties: { winner: { type: "string", enum: ["A", "B"] } },
  required: ["winner"],
};
let bracket = (
  await parallel(
    args.approaches.map((a, i) =>
      () => agent("Draft a solution using approach: " + a, { label: "attempt:" + i }),
    ),
  )
).filter(Boolean);
while (bracket.length > 1) {
  const next = [];
  for (let i = 0; i < bracket.length; i += 2) {
    if (i + 1 >= bracket.length) {
      next.push(bracket[i]);
      continue;
    }
    const v = await agent(
      "Which is better, A or B? Reply 'A' or 'B'.\n\nA:\n" + bracket[i] + "\n\nB:\n" + bracket[i + 1],
      { label: "judge:" + i, schema: pick },
    );
    next.push(v && v.winner === "B" ? bracket[i + 1] : bracket[i]);
  }
  bracket = next;
}
return { winner: bracket[0] };
```

- **loop-until-done** — for unknown-size work, loop spawning agents until a stop condition is met (no new findings for K rounds, no errors left in the logs) instead of a fixed pass count; pair the budget guard as a ceiling so an open-ended hunt cannot run away. Bug hunts, log-driven root-cause. Example 2 below shows the budget-guarded variant.

## Worked examples

### Example 1 — fan-out summarize, no barrier

A pipeline over a file list, one summarizing agent per file, nulls filtered out.

```js
export const meta = {
  name: "summarize-files",
  description: "Summarize each file independently.",
  phases: [{ title: "Summarize" }],
};

phase("Summarize");
const files = (args && args.files) || ["README.md"];

const summaries = await pipeline(files, (file) =>
  agent("Summarize " + file + " in two sentences.", {
    label: "summarize:" + file,
    phase: "Summarize",
  }),
);

return { summaries: summaries.filter(Boolean) };
```

### Example 2 — structured triage with a budget loop

Each file is triaged into a validated object; the loop stops when the budget runs out.

```js
export const meta = {
  name: "triage",
  description: "Triage files into structured severity findings until the budget is spent.",
  phases: [{ title: "Triage" }],
};

phase("Triage");
const files = (args && args.files) || [];
const schema = {
  type: "object",
  properties: {
    file: { type: "string" },
    severity: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: ["file", "severity"],
};

const findings = [];
let i = 0;
while (budget.remaining() > 0 && i < files.length) {
  const f = await agent("Triage " + files[i] + " and return its severity.", {
    label: "triage:" + files[i],
    phase: "Triage",
    schema: schema,
  });
  if (f) findings.push(f);
  i++;
}

log("Triaged " + findings.length + " of " + files.length + " files.");
return { findings: findings, spent: budget.spent() };
```

### Example 3 — the canonical review workflow (pipeline → adversarial verify, with a sub-workflow)

This is the flagship pattern, adapted from the plugin's live smoke harness: a `pipeline` of review agents (one per file, under the `Review` phase), a `parallel` barrier of adversarial verifiers over the reviews (under the `Verify` phase), and a saved sub-workflow call. It exercises `phase`, `pipeline`, `parallel`, `workflow`, and saved-name resolution in one script.

```js
export const meta = {
  name: "review",
  description: "Review changed files, then adversarially verify each review.",
  whenToUse: "When the user asks for a multi-file review pass.",
  phases: [{ title: "Review" }, { title: "Verify" }],
};

const files = (args && args.files) || ["fs.ts", "net.ts"];

// Stage 1: one reviewer per file, independent (no barrier), under "Review".
const reviewed = await pipeline(files, (item) =>
  agent("Review the file " + item + " and list any issues.", {
    label: "review:" + item,
    phase: "Review",
  }),
);

// Stage 2: barrier — adversarially verify every review together, under "Verify".
const verified = await parallel(
  reviewed.map((r) => () =>
    agent("Adversarially verify this review, flag anything missed:\n" + r, {
      label: "verify",
      phase: "Verify",
    }),
  ),
);

// A saved sub-workflow (resolved from .opencode/workflows/helper.js).
const helper = await workflow("helper", { x: 1 });

return {
  reviewed: reviewed.filter(Boolean),
  verified: verified.filter(Boolean),
  helper: helper,
};
```

The matching saved sub-workflow, at `.opencode/workflows/helper.js`:

```js
export const meta = {
  name: "helper",
  description: "A one-agent saved sub-workflow returning a marker.",
};

const reply = await agent("Reply with exactly: helper-marker", {
  label: "helper-agent",
  phase: "Helper",
});

return { marker: reply, x: args && args.x };
```

---

## Environment variables

| Variable | Effect |
|---|---|
| `OPENCODE_DRAWERS_DATA_DIR` | Base directory for the plugin's persistence (run records, child-task records, persisted scripts, journals). When unset, the XDG default base `$XDG_DATA_HOME/opencode-drawers` (or `~/.local/share/opencode-drawers`) is used — so persistence and restart-resume work out of the box on a default install. |

Under the base dir the plugin maintains its `workflow-*` subdirectories: `workflow-runs/` (run records), `workflow-tasks/` (child-task records, one per launched agent), `workflow-scripts/` (the persisted source per run id), and `workflow-journals/` (one `<runId>.jsonl` per run, powering resume).

---

## The native TUI viewer

Beyond the textual `workflow_status` tool, the package ships a second plugin surface — a **native TUI viewer** loaded through OpenCode's `"./tui"` package export. It gives you CC's `/workflows`-style live observability: a phases tree, per-agent `model · tokens · tool calls · duration` rows, drill-down detail, and an in-TUI cancel — all driven from the run's feed file. The viewer is a **lens, not a dependency**: it only ever *reads* `<dataDir>/workflow-feed/<runId>.jsonl`, so headless runs still produce the feed and the viewer adds zero coupling to the server plugin (Phase 8 binding decision: the feed file is the bus).

It contributes two things to the TUI:

- A **`sidebar_content` slot** — a passive one-line glance per active run (`… <run-id>  <done>/<total> agents · <elapsed>`, the CC-style `done/total` where the leading number is how many agents finished), invisible when no run is live. Click a run (or open the viewer from the palette) to jump into the full-screen route for that run.
- A **full-screen `workflows` route** — a tree on the left (every phase, with its agents indented beneath it) and a Detail pane on the right. Open it with **`ctrl+o`**, or `/workflows` from the command palette, or by clicking the sidebar line. The declared `meta.phases` paint as pending `·` headers from the first frame — the whole pipeline is visible up front; agents fill in live as execution reaches each phase. In-route keys:
  - `↑/↓` (or `k/j`) — move the agent selection (the tree scrolls to follow it).
  - `←/→` (or `h/l`) — switch between runs (every run in the feed dir, freshest first; the header shows `run i/N`). One viewer flips between workflows launched from different sessions in the same repo.
  - `x` — cancel the open run. It asks for confirmation first (cancel is destructive and `x` is a bare letter), then writes the cancel sentinel the engine's control watcher consumes — the run settles `cancelled`.
  - `s` — save the open run as a named workflow under its display name. It writes a save sentinel the engine consumes, which validates the run's script and persists it to `.opencode/workflows/<name>.js` (the same path as the [`workflow_save_run`](#workflow_save_run--persist-a-run-as-a-reusable-workflow) tool). The toast is optimistic — it reports the request, not the validated outcome; use the tool when you need the full result.
  - `q` (or `esc`) — quit the viewer.

### Installing the viewer surface

The viewer rides the **same package** as the server plugin — no separate install. The published `opencode-drawer-workflows` entry in your `opencode.json` `plugin` array exposes both `"."` (the server plugin) and `"./tui"` (the viewer); OpenCode loads the TUI surface automatically in its TUI process. For a local checkout, register the dev `file://` form (see [Install](#install)); the `"./tui"` export resolves from the same package.

### Pinned-version note (TUI surface risk)

The `"./tui"` plugin API is newer and less settled than the server plugin API, and its published types lag the runtime (`PluginModule.tui?: never` pins `tui` *out* on the server module even though the runtime accepts it). This surface is built and tested against:

- **opencode `1.16.2`** (`@opencode-ai/plugin@1.16.2`, which provides the `/tui` type entry).
- **opentui `0.3.2`** for all three peers — `@opentui/core`, `@opentui/keymap`, `@opentui/solid` — the version opencode `1.16.2` bundles (so the typecheck types match the runtime).

> ⚠️ **The single-instance rule: solid/opentui usage lives ONLY in `.tsx` files, never `.ts`.** Solid JSX is *compiled*, and the host rewrites a plugin's `solid-js`/`@opentui/*` imports to its OWN already-loaded runtime instance — but its Solid transform only runs on files matching `/\.(js|ts)x$/` (`.tsx`/`.jsx`). A `.ts` file that imports solid/opentui at runtime is NOT rewritten, so it resolves to this package's *nested* copy = a **second** solid/opentui instance. Mounting host JSX built from a second instance fails the host renderer's `node instanceof TextRenderable` checks and throws `Orphan text error: "" must have a <text> as a parent` at navigate time. This is exactly what crashed the viewer when the entry was a `.ts` that called `createComponent`/`lazy` from the nested `solid-js`. The fix (mirroring opencode's own external `cwd-status.tsx`): the entry is `index.tsx` and registers with inline JSX render callbacks (`<WorkflowsRoute … />`) so the host transform owns component creation; the JSX-free path/sentinel helpers live in `paths.ts`. A `bun test` guard (`paths.test.ts`) asserts no `.ts` under `src/tui` imports solid/opentui. (A *published* install has no nested copy — the peer resolves to the host's opentui — so this is the same single-instance guarantee by a different route.)

The viewer module types its default export as `TuiPluginModule` (from `@opencode-ai/plugin/tui`), which sidesteps the type lag. Treat breakage on an opencode/opentui bump as expected maintenance: re-pin opentui to the new host version, re-run `bun run typecheck` (it includes `tsconfig.tui.json`), and re-walk the manual steps below.

### Live walkthrough (manual validation)

The pure reduction/summary logic is unit-tested under `bun test`, but live rendering against a real opentui runtime is out of automated CI scope. Validate it manually:

1. **Install both surfaces.** Point your `opencode.json` at `opencode-drawer-workflows` (or the dev `file://` form) and launch OpenCode's TUI against opencode `1.16.2` (the `./tui` entry is `index.tsx` so the host transform owns component creation — see the single-instance rule above).
2. **Launch a multi-phase workflow.** Run a script with at least two phases and a handful of agents (the canonical review workflow in [Example 3](#example-3--the-canonical-review-workflow-pipeline--adversarial-verify-with-a-sub-workflow) works well). The `workflow` tool returns a `run_id` immediately.
3. **Watch the sidebar summarize it.** Within ~1s the `sidebar_content` slot shows a line like `… <run-id>  3/5 agents · 1m 12s` (3 of 5 agents finished), the count climbing as agents settle.
4. **Open the route.** Press **`ctrl+o`** (or run `/workflows`, or click the sidebar line). The full-screen tree + Detail view opens on that run, the whole `meta.phases` pipeline visible as pending `·` headers from the first frame.
5. **See it update live.** As the engine appends to the feed, the phase markers, the per-agent CC-style rows (`✓ impl  opus-4-8  112.7k tok · 51 tools · 7m 8s`), and the Detail pane (last tools, note, token breakdown, sessionID) update in real time. Move the selection with `↑/↓`, switch runs with `←/→`; the tree scrolls to follow the selection.
6. **Save the run as a workflow.** Press `s`. A toast confirms the save request; the engine consumes the save sentinel, validates the open run's script, and writes it to `.opencode/workflows/<run-name>.js`. Confirm the file appears and is invocable by `name` on a later `workflow` call.
7. **Cancel through the sentinel.** Press `x`. The view flips to `cancelling` (the feed's `run:cancel-requested` line), the engine's control watcher consumes the sentinel, the children stop, and the run settles `cancelled`.
8. **Restart and re-render.** Quit and relaunch the TUI, then open `/workflows` again. The now-settled run re-renders from its feed file alone — the viewer holds no state of its own.

---

## Honest limitations

- **No active wake in a single-turn host.** In an interactive session a settling run actively wakes an idle parent (and falls back to the toast + next-message flush when busy). But a headless `opencode run` exits — and the server shuts down — when the turn ends, so there is no live session to wake. The blocking option there is `workflow_status` with `wait_ms` (capped at 120000ms), which holds the turn open in-process until the run settles.
- **`isolation: "worktree"` needs a git-backed run.** Worktree isolation is active on a git work tree with shell access; on a non-git or no-shell checkout there is no worktree primitive, so the call degrades to `null` with a loud diagnostic rather than running unisolated. A merge-back conflict resolves the agent to a `{ status: "conflict" }` result with the worktree preserved for manual resolution (see [`isolation: "worktree"` in depth](#agentprompt-opts)).
- **Budget counts workflow-children only**, not the whole turn — a declared deviation from Claude Code's turn-wide pool (see [Budget](#budget)).
```
