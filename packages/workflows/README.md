# opencode-drawer-workflows

Deterministic multi-agent orchestration scripts for [OpenCode](https://opencode.ai). You write a plain-JavaScript script that fans out to many sub-agents — in pipelines, in parallel, in phases — and the plugin runs it in the background. The launch returns immediately with a run id; the parent session is never blocked. When the run settles, an idle parent session is woken to read the result automatically; a busy parent gets a toast and a notice folded into its next message. Runs are journaled, so a crashed or edited run resumes by replaying the longest unchanged prefix of agent calls instead of re-spending tokens on work that already settled.

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
   - [Sub-workflows](#sub-workflows)
4. [Worked examples](#worked-examples)
5. [Environment variables](#environment-variables)
6. [Honest limitations](#honest-limitations)

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

Once loaded, the plugin contributes four tools to every session: `workflow`, `workflow_status`, `workflow_stop`, and `structured_output`.

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
| `resume_from_run_id` | string | no | Resume a prior run by its `run_id`. The longest unchanged prefix of `agent()` calls replays from cache; the rest runs live. Source/args default to the prior run's when omitted. |
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
| `isolation` | `"worktree"` | **recognized but unsupported** | There is no worktree session primitive; the call emits a warn and runs **without** isolation. |

The `isolation: "worktree"` option is honestly a no-op in this port: it is recognized, warns, and proceeds without isolation. Do not rely on it for parallel file mutation.

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

`agent()` follows "degrade, don't detonate." An agent that dies on a terminal status, or a runner call that throws, resolves to `null` — never a rejection. This includes the per-agent completion timeout: an agent still running after **30 minutes** degrades to `null` like any other failure. Filter the nulls out:

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

Resume replays the longest unchanged prefix of `agent()` calls from a journal, then runs the rest live. Pass `resume_from_run_id` to the `workflow` tool. The resumed run gets its **own new run id and its own journal**, seeded from the prior run's journal.

What replays vs. re-runs:

- **Replays (from cache, no relaunch):** every `agent()` call whose `(prompt, opts)` key matches the journaled key at the same call index, **while the prefix is still intact**. A replayed call is rendered as `cached` in the progress tree and still counts against the lifetime cap (a resume hits the cap where the original did).
- **Re-runs live:** the first call whose key diverges (an edited prompt/opts, a new call, or a position past the end of the journal) — and **everything after it**. Once the prefix diverges, it is broken *forever* for that run; a later coincidentally-matching key still runs live.
- **Always re-runs:** a failed/`null` agent. Only **settled, non-null** results are journaled, so a failure never replays its failure — it gets a fresh attempt on resume.

The replay key is a sha256 of `(prompt, label, phase, schema, model, agentType)`. Field order and schema key order do not matter (canonicalized); changing the prompt, model, or *presence* of a schema changes the key and breaks the prefix from that call onward.

`resume_from_run_id` defaults source and args to the prior run's persisted values when you omit them; you may pass an edited source as a single override. Resume **survives OpenCode restarts** because the journal is on disk (one JSONL file per run); a journal append is drained before the run settles, so a single-turn `opencode run` that exits the instant the turn ends still leaves a durable journal for a later resume.

A run left `running` by a dead process is recovered on startup as `error("interrupted by restart")` — its children are not relaunched; resume it explicitly to continue.

### Saved workflows

Place a script at `.opencode/workflows/<name>.js` (or `.mjs`) in your project directory and invoke it by `name`:

```jsonc
// workflow tool call
{ "name": "review", "args": "{\"files\": [\"a.ts\", \"b.ts\"]}" }
```

Name resolution tries `<name>.js` first, then `<name>.mjs`, rooted at `<project>/.opencode/workflows/`. An unknown name returns an error listing what is available in that directory.

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

## Honest limitations

- **No active wake in a single-turn host.** In an interactive session a settling run actively wakes an idle parent (and falls back to the toast + next-message flush when busy). But a headless `opencode run` exits — and the server shuts down — when the turn ends, so there is no live session to wake. The blocking option there is `workflow_status` with `wait_ms` (capped at 120000ms), which holds the turn open in-process until the run settles.
- **`isolation: "worktree"` is recognized but unsupported.** There is no worktree session primitive, so the option warns and runs without isolation. Do not use it for safe parallel file mutation.
- **Budget counts workflow-children only**, not the whole turn — a declared deviation from Claude Code's turn-wide pool (see [Budget](#budget)).
```
