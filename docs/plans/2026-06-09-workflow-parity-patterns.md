# Workflow Parity & Patterns Implementation Plan

> **For implementers:** Use ring:executing-plans (rolling wave: implement the
> detailed phase → user checkpoint → detail the next phase → implement → repeat),
> or ring:running-dev-cycle for the full subagent-orchestrated workflow.
> This document is the living source of truth — task elaboration for later
> phases is written back into it during execution.

**Goal:** Close the gap between our `workflows` plugin and Claude Code's dynamic-workflows feature by (1) naming the six canonical orchestration patterns in our guidance, (2) shipping a built-in `/deep-research` workflow with real web access, (3) letting users save a run as a reusable named command, and (4) adding a new plugin that provides general-purpose `loop` and `goal` orchestration.

**Architecture:** Four largely-independent deliverables across the monorepo. Items 1, 3, and the deep-research infra live inside `packages/workflows`; the web-tool provisioning seam also touches `packages/core` (`SessionRunner.launch`); item 2 is a brand-new third plugin package. OpenCode plugins expose **model-callable tools** (there is no plugin-level slash-command registration API) — user-facing `/loop`, `/goal`, `/deep-research` ergonomics are delivered as thin `.opencode/command/*.md` wrappers that invoke the underlying tools. Phases are ordered so the single design-invalidating risk (web-tool provisioning to spawned agents) is proven before the work that depends on it; the highest-uncertainty-but-isolated work (the new plugin) lands last because its risk cannot invalidate any other phase.

**Tech Stack:** Bun workspace monorepo; TypeScript; `@opencode-ai/plugin@1.16.2` + `@opencode-ai/sdk@1.16.2`; Zod v4 for tool args; acorn for script meta parsing; SolidJS + opentui for the `/workflows` TUI; `bun test` for tests; `scripts/build.ts` (Bun.build, per-package TARGETS) for bundling.

## Phase Overview

| Phase | Milestone | Epics | Status |
|-------|-----------|-------|--------|
| 1 | The six patterns are named in both the model-facing guidance and the user README; a test locks the names | 1.1 | Complete |
| 2 | A workflow-spawned agent can be granted web tools, and a workflow bundled with the plugin resolves by name (precedence over user dir) | 2.1, 2.2 | Complete |
| 3 | `deep-research` runs end-to-end: fan-out search → fetch → adversarial claim verification → cited synthesis | 3.1 | Complete |
| 4 | A completed run's script is persistable to `.opencode/workflows/<name>.js` and re-invokable by name, from both a tool and the `/workflows` TUI | 4.1, 4.2 | Complete |
| 5 | A new plugin provides general `loop` (interval re-prompt, persisted + recoverable) and `goal` (hard completion gate) tools, with `.opencode/command` wrappers | 5.1, 5.2, 5.3 | Complete |

---

## Phase 1 — Name the six patterns

### Epic 1.1: The six canonical patterns are named in guidance and docs

**Goal:** Both the model-facing `WORKFLOW_DESCRIPTION` and the user-facing `README.md` explicitly name and describe all six canonical patterns (classify-and-act, fan-out-and-synthesize, adversarial-verification, generate-and-filter, tournament, loop-until-done), and a regression test asserts the names are present in the shipped description.
**Scope:** `packages/workflows/src/plugin/tools/workflow.ts` (the `WORKFLOW_DESCRIPTION` constant), `packages/workflows/README.md`, and a test file under `packages/workflows/src/plugin/tools/`.
**Dependencies:** none
**Done when:** the description string contains all six pattern names with a one-line shape + when-to-use each; the README has a patterns section cross-referencing the existing worked examples; `bun test` covers a name-presence assertion; build + smoke stay green.

#### Task 1.1.1: Add a named-pattern section to the model-facing guidance

- [x] Done

**Context:** `WORKFLOW_DESCRIPTION` lives at `packages/workflows/src/plugin/tools/workflow.ts:214-268` (~6.8 KB). It currently teaches the primitives (`agent`/`pipeline`/`parallel`/`phase`/`log`/`budget`/`workflow`) and shows two worked examples (review+adversarial-verify, fix-and-verify), but does **not** enumerate the six patterns by name. The canonical source is Anthropic's "A harness for every task" (claude.com/blog, 2026-06-02): the names themselves are load-bearing — *"prompting Claude with the right pattern by name gives the sharpest results."* Of the six, **adversarial-verification** is already the flagship example, **fan-out-and-synthesize** is implied by `parallel`-as-barrier, **classify-and-act** appears as an unnamed triage example, **loop-until-done** is only present as "loop-until-budget"; **generate-and-filter** and **tournament** are entirely absent.

**Implementation vision:** Insert a compact `## Patterns` section into `WORKFLOW_DESCRIPTION` listing all six, each as one line of *shape* + one line of *when to use*. Decisions already made, to bake into the wording:
- **Tournament:** state explicitly that the pairwise bracket must live in the deterministic JS loop, not in an agent — *"the deterministic loop holds the bracket; only the running order stays in context."* This protects determinism/resume. Do NOT introduce a `tournament()` primitive — it is expressible with `agent()` + plain JS, and a primitive would duplicate that and risk leaking the bracket into agent context (YAGNI).
- **Generate-and-filter:** state that the generator and the judge MUST be different agents (kills self-preference), and that overgeneration → judge → keep-rubric-passers is the shape.
- **Loop-until-done:** frame as stop-on-quiescence (no new findings for K rounds), distinct from the existing loop-until-budget guard; keep both.
- **Classify-and-act** and **fan-out-and-synthesize:** name them and point at the primitive that expresses each (`agent` classifier + branch; `parallel` barrier + synthesize).
Keep it terse — this string is injected into every workflow-authoring context; padding has a token cost. Do not restructure the existing examples; append the section near the existing pattern guidance.

**Files:**
- Modify: `packages/workflows/src/plugin/tools/workflow.ts:214-268`

**Verification:** `cd packages/workflows && bun run ../../scripts/build.ts` (or the repo build script) succeeds; then `bun test src/plugin/tools` passes including the new test from Task 1.1.3. Manual: grep the built `dist/index.js` for each of the six pattern names and confirm all present.

**Done when:** `WORKFLOW_DESCRIPTION` names all six patterns with shape + when-to-use, with the tournament-determinism and generator≠judge constraints stated, and no new primitive was added.

#### Task 1.1.2: Mirror the six patterns in the user-facing README

- [x] Done

**Context:** `packages/workflows/README.md` is the human authoring manual. The Explore pass found three worked examples (fan-out summarize; structured triage ≈ classify-and-act; review+verify ≈ adversarial-verification at §434-474) but no named-pattern catalogue.

**Implementation vision:** Add a `## Patterns` section (sibling to the existing examples) that names all six and, for each, gives a 2-4 line description and a minimal shape. Where an existing example already demonstrates a pattern, cross-reference it ("see the triage example below" for classify-and-act; "see the review workflow" for adversarial-verification) rather than duplicating code. Add short fresh snippets only for the two genuinely-absent patterns (generate-and-filter, tournament) — and for tournament, show the bracket held in a JS loop with `agent()` per comparison, reinforcing the determinism point. Match the README's existing prose voice and code-fence style.

**Files:**
- Modify: `packages/workflows/README.md`

**Verification:** Render-check the markdown (no broken fences/headings); confirm the six pattern names appear as headings or bold labels. If the repo has a markdown linter in `package.json` scripts, run it; otherwise visual review.

**Done when:** README has a patterns section covering all six, reusing existing examples by reference and adding snippets only for the two absent patterns.

#### Task 1.1.3: Lock the pattern names with a regression test

- [x] Done

**Context:** The shipped guidance string is effectively product behavior (it shapes how the model authors workflows). Nothing currently prevents a future edit from silently dropping a pattern name. Existing tool tests live alongside `workflow.ts` under `packages/workflows/src/plugin/tools/`.

**Implementation vision:** Write-the-test-first per TDD: a small `bun test` that imports `WORKFLOW_DESCRIPTION` (export it if not already exported) and asserts the string contains each of the six canonical pattern names (case-insensitive substring match on the canonical hyphenated forms and/or their display labels). RED first: before Task 1.1.1's edit the test fails for `generate-and-filter` and `tournament`. Keep the assertion list as a single source-of-truth array so adding a future pattern is a one-line change.

**Files:**
- Create: `packages/workflows/src/plugin/tools/workflow-description.test.ts`
- Modify: `packages/workflows/src/plugin/tools/workflow.ts` (export `WORKFLOW_DESCRIPTION` if needed)

**Verification:** `cd packages/workflows && bun test src/plugin/tools/workflow-description.test.ts` — fails RED before 1.1.1 (missing `tournament`, `generate-and-filter`), passes GREEN after 1.1.1.

**Done when:** the test asserts all six names and passes; it is wired into the package's default `bun test` run.

---

## Phase 2 — Web-tool provisioning seam + bundled-workflow registry

### Epic 2.1: Workflow agents can be granted explicit tools (the web-tool seam)

**Goal:** A workflow script can cause a spawned agent to receive an explicit tool allowlist/override (so `deep-research` agents get WebSearch / WebFetch and/or the connected Exa/Firecrawl MCP tools), instead of only inheriting whatever the parent session happens to expose.
**Scope:** `packages/workflows/src/runtime/agent-call.ts` (the `runner.launch()` call at ~619-641, which today sets `toolsOverride: { structured_output: true }` only when a schema is present); the `agent()` API surface and its options type in `packages/workflows/src/runtime/index.ts`; the `SessionRunner.launch` signature and its `toolsOverride` plumbing in `packages/core/src/session-runner.ts`; the `WORKFLOW_DESCRIPTION` (document the new `agent()` tool option). This is the **design-invalidating risk** — if web tools cannot be routed to spawned agents through `launch()` + `session.promptAsync({ tools })`, deep-research must be re-scoped.
**Dependencies:** none (but blocks Phase 3)
**Done when:** an `agent(prompt, { tools: [...] })` results in a spawned session whose tool allowlist includes the requested tools, verified by a runtime test using the existing recording-runner test double; the structured-output override continues to compose with an explicit tool list.

**Elaboration note (2026-06-09):** The grounding pass found the cross-package seam **already exists** — `LaunchRequest.toolsOverride?: Record<string, boolean>` (`packages/core/src/types.ts:64`) is already merged by `buildTools()` (`packages/core/src/session-runner.ts:355-357`) into `promptAsync` `body.tools` (`:390`). So Epic 2.1 is **workflows-package-only**; no `@drawers/core` change is needed (that part of the original Done-when is dropped). The only gap is the `agent()` API surface + the `agent-call.ts` toolsOverride assembly. Decided: `AgentOpts.tools` is a `string[]` of tool names to **enable** (mapped to `{name:true}`); when both `schema` and `tools` are present they compose (`{structured_output:true, ...tools}`). Caveat recorded: tool-name strings are environment-dependent (the repo defines none) — the seam is name-agnostic; deep-research (Phase 3) supplies the actual names.

#### Task 2.1.1: Add `tools` to `AgentOpts` and assemble the launch `toolsOverride`

- [x] Done

**Context:** `AgentOpts` is defined at `packages/workflows/src/runtime/types.ts:12-59` (fields: label, phase, schema, model, isolation, agentType, contextDiff, verifyDiff — no `tools`). The launch call is `packages/workflows/src/runtime/agent-call.ts:511-529`; today `toolsOverride: { structured_output: true }` is set **only** inside the `compiled !== undefined` spread (line 522-528), so a no-schema agent gets no toolsOverride at all.

**Implementation vision:** Add `tools?: string[]` to `AgentOpts` with a doc comment (names enable platform/MCP tools for this agent; environment-dependent; empty/absent → inherit session tools, fully inert). In `agent-call.ts`, replace the single conditional spread with an assembled map: build `const toolsOverride: Record<string, boolean> = {}`; if `compiled !== undefined` set `toolsOverride.structured_output = true`; for each non-empty trimmed name in `opts.tools ?? []` set `toolsOverride[name] = true`. Keep `onSessionCreated` gated on `compiled !== undefined` (unchanged). Pass `toolsOverride` to `launch` only when `Object.keys(toolsOverride).length > 0` (so the no-schema/no-tools path is byte-identical to today). Do NOT touch `@drawers/core` — `LaunchRequest.toolsOverride` already accepts this.

**Files:**
- Modify: `packages/workflows/src/runtime/types.ts:12-59` (add `tools?: string[]`)
- Modify: `packages/workflows/src/runtime/agent-call.ts:511-529`
- Test: `packages/workflows/src/runtime/agent-call.test.ts` (FakeRunner records `launches`; existing toolsOverride test at ~364-381)

**Verification:** `cd packages/workflows && bun test src/runtime/agent-call.test.ts` — new tests: (a) `agent(p,{tools:['websearch','webfetch']})` → `launches[0].toolsOverride` deep-equals `{websearch:true,webfetch:true}`; (b) `agent(p,{schema,tools:['websearch']})` → `{structured_output:true,websearch:true}`; (c) `agent(p,{})` (no schema, no tools) → `launches[0].toolsOverride` is `undefined` (inert). RED before the agent-call.ts edit.

**Done when:** the three cases pass; the existing schema-only test (`toolsOverride === {structured_output:true}`) still passes; full package `bun test` green.

#### Task 2.1.2: Document the `tools` option in guidance and README

- [x] Done

**Context:** `WORKFLOW_DESCRIPTION` documents `agent()` opts at `packages/workflows/src/plugin/tools/workflow.ts` (the `- agent(prompt, opts?)` bullet); README documents the same under "The eight globals".

**Implementation vision:** Add a terse `tools` clause to the `agent()` opts description in both places: "tools: string[] — enable named platform/MCP tools for this agent (e.g. web search/fetch for research); names are environment-dependent; omit to inherit the session's tools." Note in the README that this is the seam `deep-research` uses. Do not over-explain.

**Files:**
- Modify: `packages/workflows/src/plugin/tools/workflow.ts` (the agent opts bullet in `WORKFLOW_DESCRIPTION`)
- Modify: `packages/workflows/README.md` ("The eight globals" → agent opts)

**Verification:** `bun run build` green; grep built `dist/index.js` for `tools:` clause presence; README renders.

**Done when:** both surfaces document the `tools` option with the environment-dependent caveat.

### Epic 2.2: Bundled built-in workflows resolve by name with precedence

**Goal:** A workflow can ship inside the plugin bundle and be resolved by name (e.g. `deep-research`) with precedence over (or a documented precedence relative to) a user file of the same name in `.opencode/workflows/`.
**Scope:** `packages/workflows/src/plugin/resolve-source.ts` (`WORKFLOWS_SUBDIR`, `loadSavedWorkflow` ~41-67, `createSourceResolver` ~70-94) and the parallel loader in `packages/workflows/src/plugin/tools/workflow.ts:171-205`; a new built-in registry module that holds bundled sources; `scripts/build.ts` if bundled sources need to be inlined into `dist`.
**Dependencies:** none (but blocks Phase 3)
**Done when:** resolving the name of a bundled workflow returns its source without any file in `.opencode/workflows/`; precedence between built-in and user-authored is decided, implemented, and tested; existing user-file resolution is unchanged (regression test green).

**Elaboration note (2026-06-09):** Resolution is **duplicated**: the in-script `workflow()` global goes through `createSourceResolver` (`packages/workflows/src/plugin/resolve-source.ts:70-94`), while the top-level `workflow` TOOL has its own `loadSavedWorkflow` (`packages/workflows/src/plugin/tools/workflow.ts:172-205`). Both must honor built-ins. Decided to NOT unify the duplication now (out of scope, larger blast radius) — instead share a `BUILTIN_WORKFLOWS` constant + a `lookupBuiltin(name)` helper that both loaders consult first. **Precedence decided: built-in wins over a user file of the same name** — a built-in is a first-class shipped capability and predictable availability beats silent override; reversible in one line if we later want user-override. In Phase 2 `BUILTIN_WORKFLOWS` is **empty** and tests inject a fake registry via deps; Phase 3 populates it with the deep-research source. Build inlining: built-in sources are **TS string constants** (no precedent for non-TS asset embedding in `scripts/build.ts:56-88`; Bun.build only takes JS/TS entrypoints).

#### Task 2.2.1: Built-in registry + resolver precedence (sub-workflow path)

- [x] Done

**Context:** `createSourceResolver({directory, fs})` at `resolve-source.ts:70-94` routes string names to `loadSavedWorkflow` (`:78`) and `{scriptPath}` refs to a relative/absolute read. `SourceResolverDeps` is at `:18-23`. The engine constructs the resolver and threads it as `resolveSubWorkflow`.

**Implementation vision:** Create `packages/workflows/src/plugin/builtins.ts` exporting `BUILTIN_WORKFLOWS: Record<string, string>` (empty object in this phase, with a doc comment that Phase 3 adds `deep-research`) and `lookupBuiltin(name: string, registry?: Record<string,string>): string | undefined` (returns `registry?.[name]`). Add optional `builtins?: Record<string, string>` to `SourceResolverDeps`. In the returned resolver, for the string-name branch (`resolve-source.ts:77`), check `lookupBuiltin(nameOrRef, deps.builtins)` FIRST and return it if defined, before falling to `loadSavedWorkflow` — this is the built-in-wins precedence. Wire the engine's `createSourceResolver(...)` construction site to pass `builtins: BUILTIN_WORKFLOWS`.

**Files:**
- Create: `packages/workflows/src/plugin/builtins.ts`
- Modify: `packages/workflows/src/plugin/resolve-source.ts:18-23,76-79`
- Modify: `packages/workflows/src/plugin/engine.ts` (the `createSourceResolver(...)` call site — locate it; pass `builtins`)
- Test: `packages/workflows/src/plugin/resolve-source.test.ts` (in-memory `makeFs`; add a `builtins` deps fixture)

**Verification:** `cd packages/workflows && bun test src/plugin/resolve-source.test.ts` — new tests: (a) a name present in injected `builtins` resolves to the built-in source even when a `.opencode/workflows/<name>.js` of the same name exists (built-in shadows user); (b) a name absent from builtins still resolves from disk (regression); (c) an unknown name (neither builtin nor disk) still throws the available-list error. RED before the resolve-source edit.

**Done when:** the three cases pass; existing resolve-source tests unchanged-green; engine passes the real (empty) registry without behavior change for current workflows.

#### Task 2.2.2: Honor built-ins in the top-level `workflow` tool loader

- [x] Done

**Context:** The `workflow` tool resolves a `name` arg via its own `loadSavedWorkflow` at `tools/workflow.ts:172-205` (returns `{ok,source}|{ok:false,error}`), with `wfDir` joined at `:287`. This is the path a user/model hits when invoking `deep-research` by name at the top level (not as a sub-workflow), so it must also see built-ins.

**Implementation vision:** Import `BUILTIN_WORKFLOWS` + `lookupBuiltin` from `builtins.ts`. At the top of the tool's `loadSavedWorkflow` (before the disk loop), check `lookupBuiltin(name, BUILTIN_WORKFLOWS)`; if defined, return `{ok:true, source}`. Keep the same built-in-wins precedence as Task 2.2.1. No change to the `{ok,...}` return contract.

**Files:**
- Modify: `packages/workflows/src/plugin/tools/workflow.ts:172-205`
- Test: `packages/workflows/src/plugin/tools/workflow.test.ts` (or a focused new test) — assert a built-in name resolves through the tool path without a disk file.

**Verification:** `cd packages/workflows && bun test src/plugin/tools/workflow.test.ts` — a built-in name (injected for the test, or asserted via a small exported seam) resolves; an unknown name still errors with the available list. RED first if feasible.

**Done when:** the top-level tool path resolves built-ins with built-in-wins precedence; existing tool tests green; full package `bun test` + `bun run build` green.

---

## Phase 3 — `deep-research` built-in workflow

### Epic 3.1: `deep-research` runs end-to-end and returns a cited report

**Goal:** Invoking the `deep-research` built-in with a question fans out web searches across several angles, fetches sources, extracts checkable claims with source attribution, adversarially verifies each claim (drop those that don't survive), and synthesizes a cited report — matching the canonical Anthropic built-in.
**Scope:** a new bundled workflow script (authored against the Phase 2 registry), structured-output schemas for claims and verdicts (validated via the existing `structured_output` mechanism in `packages/workflows/src/runtime/structured/tool.ts:38-76` and `SchemaRegistry`), and an `.opencode/command/deep-research.md` wrapper. Model the script shape on the README review+verify example (§438-474) and the `test-harness/.opencode/workflows/helper.js` skeleton.
**Dependencies:** Epic 2.1 (agents need web tools), Epic 2.2 (ships as a built-in)
**Done when:** `deep-research` invoked with a real question produces a report whose claims cite the source they came from and whose unsupported claims were filtered out; the run is observable in `/workflows`; structured schemas reject malformed agent output and trigger the built-in retry.

**Elaboration note (2026-06-09):** Decided tool names per Fred: `["websearch","webfetch","exa","firecrawl"]` (environment-dependent; unknown names are platform no-ops). Source authored as a TS string constant in a dedicated file (not inline in the registry). Shape: Plan (decompose into 3-5 angles) → Search (fan-out per angle, extract `{text,source}` claims) → Verify (pipeline, one adversarial refuter per claim, assume-false-unless-proven, drop unsupported) → Synthesize (cited report from survivors only). A deterministic `MAX_CLAIMS=40` cap guards runaway verification, logged when it bites (no silent truncation). Live web behavior is not unit-testable (needs real tools); coverage is split into a parse/validity guard and a stubbed control-flow test.

#### Task 3.1.1: Author the deep-research source and register it as a built-in

- [x] Done

**What was built:** `packages/workflows/src/plugin/builtin-deep-research.ts` exporting `DEEP_RESEARCH_SOURCE` (the workflow program as a string; `\\n` escapes, `+` concatenation only, no backticks/`${}` to avoid colliding with the outer TS template); registered in `builtins.ts` as `BUILTIN_WORKFLOWS["deep-research"]`. Validity guard: `builtins.test.ts` runs `parseScript` over every built-in and asserts `meta.name` matches its registry key + the four expected phases — this catches any escaping/syntax slip in the shipped string.

**Verification:** `bun test src/plugin/builtins.test.ts` (2 pass); `grep deep-research dist/index.js` confirms inlining after `bun run build`.

#### Task 3.1.2: Control-flow test of the script logic

- [x] Done

**What was built:** `packages/workflows/src/plugin/builtin-deep-research.test.ts` runs `parseScript(DEEP_RESEARCH_SOURCE).bodySource` through `evaluateScript` with a real pipeline/parallel and label-dispatched stub agents. Asserts: claims thread into a cited report (2 angles × 1 claim → 2 citations, 0 dropped); an adversarially-refuted claim is dropped (`dropped` increments); an empty question returns an honest error WITHOUT spawning agents. Running through `evaluateScript` without `DeterminismError` also proves the script touches only allowed globals.

**Verification:** `bun test src/plugin/builtin-deep-research.test.ts` (3 pass).

#### Task 3.1.3: Command wrapper and README documentation

- [x] Done

**What was built:** `packages/workflows/.opencode/command/deep-research.md` (`$ARGUMENTS` wrapper instructing the model to run the named workflow — satisfying the orchestration opt-in as an explicit named-workflow request); README gains a "Built-in workflows" section + TOC entry documenting the built-in, the tool-name allowlist, the built-in-wins precedence, and how to install the project-scoped command file.

**Verification:** `bun run build` green; README renders.

**Residual:** Live end-to-end (real web tools producing a real cited report) is gated on the user's deployment exposing web tools under the assumed names; not unit-testable here. The `/workflows` TUI observability of a deep-research run is inherited from the existing run-viewer (untouched), validated manually like other runs.

---

## Phase 4 — Save-a-run-as-command

### Epic 4.1: A run's script can be saved as a named workflow via a tool

**Goal:** A model/programmatic caller can persist a completed (or running) run's already-on-disk script to `.opencode/workflows/<name>.js`, validated before write, so it becomes invokable by name.
**Scope:** a new `workflow_save_run` tool registered alongside `workflow`/`workflow_status`/`workflow_stop` in `packages/workflows/src/plugin/index.ts:136-141`; the copy logic (source: `<dataDir>/workflow-scripts/<runId>.js` per `engine.ts:844-851`; dest: `.opencode/workflows/<name>.js` per `resolve-source.ts:16`); reuse `parseScript`/`validateMeta` from `packages/workflows/src/runtime/meta.ts:76-121,272-307` to reject broken scripts before persisting; name sanitization to a safe filename.
**Dependencies:** none (independent; uses existing persistence + validation)
**Done when:** calling the tool with a valid `run_id` + `name` writes a syntactically-valid script to the user workflows dir and the same name then resolves via the existing loader; an invalid/broken source returns an honest error and writes nothing; a name collision is handled with a decided policy (overwrite vs refuse).

**Elaboration note (2026-06-09):** Verified API: `engine.statusOf(runId): RunHandle | undefined`, `RunHandle.record.scriptPath` is the persisted `<dataDir>/workflow-scripts/<runId>.js` (engine.ts:826-838,149). The save core is extracted into a SHARED async `saveRunAsWorkflow(...)` so Epic 4.2's engine-side consumer reuses it (no duplication). Decisions: name must match `^[A-Za-z0-9._-]+$` and not be `.`/`..` (traversal-safe); a name that collides with a BUILT-IN is refused (a built-in wins at resolve time, so saving over it is a no-op trap); a collision with an existing user file is refused unless `overwrite:true`; a source that fails `parseScript` is refused and nothing is written.

#### Task 4.1.1: Shared `saveRunAsWorkflow` + the `workflow_save_run` tool

- [x] Done

**Context:** Tools are registered in `src/plugin/index.ts:136-141` (the `tool:` map). `createWorkflowTool` (`tools/workflow.ts`) is the deps model (`WorkflowToolDeps { directory, fs? }`, `nodeFs()` default, `WORKFLOWS_SUBDIR`, `joinPath`). `workflow_stop`/`workflow_status` are the run_id-arg tool models (`statusOf`, `coerceId`, unknown-run listing). `parseScript` (`runtime/meta.ts`) validates; `lookupBuiltin` (`plugin/builtins.ts`) detects built-in collisions.

**Implementation vision:** New `src/plugin/tools/workflow-save.ts`. Export a pure-ish async `saveRunAsWorkflow(deps: { engine, fs, directory }, input: { runId, name, overwrite? }): Promise<{ ok: true; path: string } | { ok: false; error: string }>`:
1. `validateName(name)` — reject empty / `.` / `..` / anything not matching `^[A-Za-z0-9._-]+$`.
2. reject if `lookupBuiltin(name)` is defined (built-in shadow trap).
3. `handle = engine.statusOf(runId)`; if undefined → `{ok:false, error: unknown-run + known ids}`.
4. read `handle.record.scriptPath` via `fs.readFile`; on failure → `{ok:false,error}`.
5. `parseScript(source)` in a try/catch; on `ScriptSyntaxError`/`MetaError` → `{ok:false, error}` (write nothing).
6. dest = `joinPath(joinPath(directory, WORKFLOWS_SUBDIR), name + ".js")`; if it already reads OK and `!overwrite` → `{ok:false, error: exists, pass overwrite}`.
7. `mkdir(recursive)` + `writeFile(dest, source)`; return `{ok:true, path: dest}`.
Then `createWorkflowSaveRunTool(engine, deps)` wraps it: args `run_id` (string), `name` (string), `overwrite` (boolean optional); returns the honest string for each branch. Register as `workflow_save_run` in `index.ts`.

**Files:**
- Create: `src/plugin/tools/workflow-save.ts`
- Modify: `src/plugin/index.ts:55-57,136-141` (import + register)
- Test: `src/plugin/tools/workflow-save.test.ts`

**Verification:** `bun test src/plugin/tools/workflow-save.test.ts` — cases: valid run+name writes to `.opencode/workflows/<name>.js` (assert via in-memory fs) and the source round-trips; unknown run_id → error; bad name (`../x`, empty) → error, no write; built-in name (`deep-research`) → error, no write; broken script source → error, no write; existing file + no overwrite → error; existing file + overwrite → writes. Use a fake engine exposing `statusOf` + `runs` and an in-memory fs (model `makeFs` from resolve-source.test.ts).

**Done when:** all cases pass; tool registered; full `bun test` + `bun run build` green.

#### Task 4.1.2: (folded into 4.1.1 — tests live with the tool)

- [x] Done (covered by 4.1.1's test file)

### Epic 4.2: The `/workflows` TUI can save the selected run

**Goal:** From the `/workflows` view, the user can press a key to save the currently-selected run as a named workflow (matching the feature's "save from the workflows view" ergonomics).
**Scope:** the TUI route `packages/workflows/src/tui/route.tsx` (command/keybinding layer ~327-351; selected `runId()` signal ~152, ~266); a name-prompt affordance; invoking the same save logic as Epic 4.1 (shared function, not duplicated). Respect the opentui constraint recorded in memory (solid/opentui only in `.tsx`).
**Dependencies:** Epic 4.1 (shares the save function)
**Done when:** a keybinding in `/workflows` saves the selected run to `.opencode/workflows/<name>.js` using the shared, validated save path; the TUI reflects success/failure without crashing the renderer.

**Elaboration note (2026-06-09):** The TUI is a DETACHED viewer — `route.tsx` has only `feedDir`, `controlDir`, and `props.api` (keymap/dialog/toast), NOT the engine or fs. It already controls the engine through a one-way file channel: `writeCancelSentinel({controlDir, runId})` → `control.ts` poller (scans `<runId>.cancel`, calls `onCancel`) → `engine.stopRun`. Save mirrors this exactly: a `<runId>.save` sentinel whose CONTENT is the chosen name → the poller reads it and calls a new `onSave(runId, name)` → the shared `saveRunAsWorkflow`. Name source: the run's display name (`view().name`, the workflow's own `meta.name`) — no text-input widget (avoids the opentui fragility recorded in memory). Result feedback flows back as a feed event the route surfaces as a toast (the channel is one-way; without this, failures are silent). The `route.tsx` keybinding itself is **manual-validation-gated** like the rest of the TUI.

#### Task 4.2.1: Control-channel save backbone (testable)

- [x] Done

**Context:** `src/plugin/control.ts` polls `controlDir` for `SENTINEL_SUFFIX = ".cancel"` and calls `opts.onCancel(runId)` (readdir + rm, content-blind). The engine wires it at `engine.ts:666-674` (`dir: controlDir`, `onCancel`). `writeCancelSentinel` is the TUI-side writer. Feed events are defined in `src/plugin/feed.ts`.

**Implementation vision:** Generalize the poller to also handle a `".save"` suffix: for a `.save` sentinel, `readFile` its content (the target name), call `opts.onSave?.(runId, name)`, then consume (rm) — same consume-and-forget semantics, same error fencing as cancel. Add `writeSaveSentinel({controlDir, runId, name})`. Wire the engine's poller with `onSave: (runId, name) => saveRunAsWorkflow({engine, fs, directory}, {runId, name})`, emitting a feed event with the `{ok|error}` result so the viewer can toast it. Keep cancel behavior byte-identical.

**Files:**
- Modify: `src/plugin/control.ts` (`.save` handling + `onSave` callback + `writeSaveSentinel`)
- Modify: `src/plugin/engine.ts:666-674` (wire `onSave`, pass `directory`/`fs`)
- Modify: `src/plugin/feed.ts` (a save-result event) if needed for toast feedback
- Test: `src/plugin/control.test.ts` (extend — `.save` sentinel triggers `onSave` with the name and is consumed; a `.cancel` still triggers `onCancel`; unreadable dir degrades)

**Verification:** `bun test src/plugin/control.test.ts` — `.save` sentinel with body "myflow" calls `onSave("wf_x","myflow")` and removes the file; cancel path unchanged. Plus the save-integration assertion through the shared fn.

**Done when:** control tests green; cancel regression green; engine wires `onSave` to the shared save fn.

#### Task 4.2.2: `/workflows` save keybinding (manual-validation-gated)

- [x] Done

**Review fix (2026-06-09):** code-reviewer flagged a Medium — the optimistic toast over a name charset that rejects spaces meant a run named "Deep Review" would silently no-op from the `s` key (engine logs the refusal; the one-way channel can't toast it back). Fixed by deriving the save name through a new `slugifyWorkflowName` (`paths.ts`, tested) at the TUI boundary (spaces → `-`, traversal defanged, empty → "workflow"); the resolver finds the slugified file. Also hardened the tool's `name` coercion (a non-string no longer becomes the literal "undefined"). Reviewer otherwise PASS: sentinel always consumed, cancel byte-identical, no circular-import/TDZ, nil-safe, no renderer-crash path.

**Context:** `route.tsx` registers a keymap layer at ~327 and has the cancel-confirm dialog at ~423-459 (model for a run-targeting action using `runId()` + `view().name`). `props.api.ui.toast` exists (used at ~459).

**Implementation vision:** Add a key (e.g. `s`) to the keymap layer that, when a run is selected, calls `writeSaveSentinel({controlDir: props.controlDir, runId: id, name: view().name ?? id})` and shows a toast ("Saving run as <name>…"). No dialog/text-input (name derives from the run). Guard: no-op when no run is selected. The success/failure toast is driven by the feed event from Task 4.2.1.

**Files:**
- Modify: `src/tui/route.tsx` (keybinding + sentinel write + toast)

**Verification:** `bun run build` green (tui.js smoke: jsxDEV=0). Behavior is **manual**: restart opencode, open `/workflows`, press `s` on a run, confirm `.opencode/workflows/<name>.js` is written and a toast shows. Listed in the plan's manual-validation gate.

**Done when:** the keybinding writes the sentinel and toasts; build + tui smoke green; manual validation noted as pending Fred.

---

## Phase 5 — `loop` + `goal` plugin (new package)

### Epic 5.1: New plugin scaffold + `loop` tool with persisted, recoverable scheduling

**Goal:** A third plugin package exists and exposes a general-purpose `loop` tool that re-prompts the current session's task at an interval, with active loops persisted to disk and recovered on plugin restart.
**Scope:** new `packages/<name>` package (proposed `cadence` / `opencode-drawer-cadence` — naming is a judgment call, finalize at elaboration; alternatives: `recurrence`, `loop-goal`) following the plugin anatomy of `background-agents` (entry exports a `const XPlugin: Plugin`, `package.json` with `opencode-drawer-` prefix + `@opencode-ai/plugin` dep, a `scripts/build.ts` TARGETS entry); the `loop` tool registered in the `tool` hook; scheduling via Bun `setInterval` held in plugin scope and cleared in the `dispose` hook (no cron SDK exists); re-prompt via `client.session.promptAsync` (with the `loop` tool disabled per-prompt to prevent recursion); state persistence + restart recovery mirroring how background-agents/workflows persist run state.
**Dependencies:** none
**Done when:** registering a loop re-prompts the task on schedule; the loop survives a plugin reload (recovered from disk); `dispose` clears all timers; stopping a loop is supported.

**Elaboration note (2026-06-09) — applies to Epics 5.1, 5.2, 5.3.** Package: `packages/cadence` (`opencode-drawer-cadence` — name is a judgment call, overridable). Grounded anchors: plugin scaffold mirrors `packages/background-agents/src/index.ts:47-110` (`export const X: Plugin = async ({ client }) => ({ event, tool, dispose })`); data dir via `resolveDataBaseDir()` (`packages/core/src/persistence.ts:104-115`) + leaf `cadence`; injectable interval with unref per `packages/workflows/src/plugin/control.ts:90-96`; re-prompt via `client.session.promptAsync({path:{id},body:{parts:[{type:"text",text}]}})` (`core/session-runner.ts:365-398`); read last reply via `client.session.messages({path:{id}})` (`background-agents/src/engine.ts:142-158`); idle via the `event` hook narrowing `event.type==="session.idle"` → `event.properties.sessionID` (`background-agents/src/index.ts:97-99`, sdk-audit:42); build TARGETS entry `{pkgDir:"packages/cadence", entries:[{entry:"src/index.ts", outName:"index.js", external: SERVER_EXTERNALS}]}` (`scripts/build.ts:51-88`); package.json templated on `packages/background-agents/package.json`.

**Decided semantics (two drivers, no cross-wiring):**
- `loop` is **interval-driven**: every `interval_ms`, optionally check the last assistant message for a completion sentinel (when `until` is set) and STOP if present, else re-prompt the session with `instruction`. Stops at `max_iterations` (safety cap) or `cadence_stop`.
- `goal` is **idle-driven**: on `session.idle` for a session with an active goal, read the last assistant message; if it contains `GOAL_COMPLETE` → done; else re-prompt "<goal> … reply exactly GOAL_COMPLETE when fully met, else keep working" until met or `max_iterations`. This is the anti-premature-completion bar.
- Both share one `createCadenceEngine` over an injectable `FsFacade` store (`<dataDir>/cadence/<id>.json`, atomic write, load-all on init), an injectable interval factory, and the SDK client. Recovery re-arms active `loop` timers; `goal`s are event-driven so need no re-arm. `dispose` clears all timers.

**Implementation approach:** This is a full new package with stateful timer/idle/persistence logic — delegated to a backend-ts specialist against this spec, then adversarially reviewed and verified (build/typecheck/tests) in the main session. Tasks below capture the contract; the dispatch carries the full detail.

#### Task 5.1.1: Package scaffold + `createCadenceEngine` (loop driver) + `loop`/`cadence_stop`/`cadence_list` tools + recovery + dispose

- [x] Done

**Contract:** New `packages/cadence` (package.json, src/index.ts plugin, src/engine.ts, src/store.ts, src/tools/*.ts) + `scripts/build.ts` TARGETS entry + workspace inclusion. `createCadenceEngine` manages directives `{id, sessionID, kind:"loop"|"goal", instruction, intervalMs?, iterations, maxIterations, status:"active"|"done"|"stopped", createdAt}`; loop tick re-prompts and stops at cap/sentinel/stop; persisted per-directive; `store.load()` on init re-arms active loops; `dispose` clears timers. Tools resolve the current session from `ToolContext.sessionID`.
**Verification:** `bun test packages/cadence` — loop fires N times then stops at max (fake timer + fake client records promptAsync calls); `cadence_stop` halts; recovery re-arms a persisted active loop; `dispose` clears. Plus `bun run build` adds `packages/cadence/dist/index.js`.
**Done when:** the loop tool works end-to-end against fakes; build green; the plugin exports a valid `Plugin`.

#### Task 5.2.1: `goal` idle-driven completion gate

- [x] Done

**Contract:** `goal` tool starts a goal directive; the plugin `event` hook routes `session.idle` to `engine.handleEvent`; on idle for an active goal, read the last assistant message, detect `GOAL_COMPLETE` (→ done) else re-prompt toward the goal until `max_iterations`. Shares the engine's store + re-prompt + sentinel helper.
**Verification:** `bun test packages/cadence` — an idle event with a non-sentinel last message re-prompts and increments; a sentinel last message marks done and stops re-prompting; max_iterations gives up; unrelated session idle is ignored.
**Done when:** goal completion detection + re-prompt loop works against fakes; no interference with loop directives.

#### Task 5.3.1: `.opencode/command` wrappers + README

- [x] Done

**Implementation + review note (2026-06-09):** Built by a delegated implementer against the spec, then adversarially reviewed (ring code-reviewer) — the review found and we FIXED 1 critical + 3 high + 2 medium: (C) torn-write race in the store (shared `.tmp` path) → unique-tmp-per-write + honest doc-comment; (H1) substring sentinel match → exact-line match (`split(/\r?\n/).some(l => l.trim() === GOAL_COMPLETE)`); (H2) overlapping ticks double-counting → per-directive in-flight guard + re-read state after every await; (H3) iteration counted on a failed re-prompt → `reprompt` awaits and counts on delivery only; (M2) terminal directives never reclaimed → `finalize` deletes file + map entry; (M3) `stop(id)` cross-session → session-scoped. Rejected the reviewer's DRY recommendation to extract a generic store into `@drawers/core` (speculative shared-package refactor, out of scope) — kept the corrected local store. Gates after fix, independently re-verified: cadence 24 tests, full suite 876 pass, typecheck clean, build green. **Judgment calls (overridable):** package named `cadence`; terminal directives are deleted immediately (no on-disk audit trail of finished/stopped runs — the correct reading of "unbounded growth", revisitable as persist-then-TTL if a history view is wanted later). **Residual:** re-prompting a busy session queues at the SDK (bounded by `max_iterations`); live behavior is manual-validation-gated.

**Contract:** `packages/cadence/.opencode/command/loop.md` and `goal.md` (`$ARGUMENTS` wrappers invoking the `loop`/`goal` tools); a package `README.md` documenting the two drivers, the sentinel, persistence/recovery, the `cadence_stop`/`cadence_list` tools, and that command files are project-scoped (no plugin-level slash registration).
**Verification:** `bun run build` green; README renders.
**Done when:** wrappers + README exist; the package documents its surface honestly.

### Epic 5.2: `goal` completion-gate

**Goal:** A general-purpose `goal` tool sets a hard completion predicate that a loop (or a re-prompt cycle) checks before declaring victory — fighting premature/lazy completion.
**Scope:** the `goal` tool and its interaction with the loop mechanism from Epic 5.1; the enforcement mechanism (a plugin cannot own the main agent loop, so the gate is enforced by re-prompting via the SDK and/or the `chat.message` hook until the predicate is satisfied — exact mechanism decided at elaboration against the SDK surface in `docs/sdk-surface-audit.md`); persistence of the active goal.
**Dependencies:** Epic 5.1 (goal gates a loop's stop condition)
**Done when:** a goal attached to a looped task prevents the loop from stopping until the predicate is met (or a max-iteration/budget guard trips); the gate state is persisted and recoverable.

### Epic 5.3: `.opencode/command` wrappers for `/loop` and `/goal`

**Goal:** Users can type `/loop` and `/goal` and have them invoke the underlying tools, giving the Claude-Code-style ergonomics on top of the model-callable tools.
**Scope:** `.opencode/command/loop.md` and `.opencode/command/goal.md` command files shipped/documented by the plugin; documentation in the new package README; clarify in guidance that these wrappers map to the `loop`/`goal` tools.
**Dependencies:** Epics 5.1, 5.2
**Done when:** the command wrappers exist and invoke the tools with the user's arguments; the package README documents both the tools and the command ergonomics.

---

## Self-Review

- **Spec coverage:** Item 1 → Phase 1. Item 2 (loop+goal plugin) → Phase 5. Item 3 (save-a-run) → Phase 4. Item 4 (deep-research) → Phases 2 (infra) + 3 (script). All four requests covered.
- **Phase boundaries:** each phase ends in working, testable software — Phase 1 ships named guidance + a passing test; Phase 2 ships a proven seam + registry with tests; Phase 3 ships a runnable deep-research; Phase 4 ships save-from-tool and save-from-TUI; Phase 5 ships a working loop+goal plugin.
- **Risk ordering:** the design-invalidating risk (web-tool provisioning, Epic 2.1) is front-loaded ahead of its dependent (Phase 3). The highest-uncertainty work (new plugin, Phase 5) is last because it is an isolated package whose risk invalidates no other phase.
- **Rolling wave:** only Phase 1 is task-detailed; Phases 2-5 are epic-level and will be elaborated against the codebase as it exists when execution reaches them. Open decisions deliberately deferred to elaboration: explicit `agent()` tool-option name (2.1), built-in-vs-user precedence rule (2.2), name-collision policy on save (4.1), new package name (5.1), goal-enforcement mechanism (5.2).
- **Contract consistency:** the save path (`.opencode/workflows/<name>.js`) and validation (`parseScript`/`validateMeta`) are shared between Phase 4's tool and TUI epics; the web-tool seam (2.1) and bundled registry (2.2) are both consumed by deep-research (3.1); these are referenced consistently across epics.
- **No vague tasks in the detailed wave:** Phase 1 tasks name exact files, exact edits, the RED→GREEN test, and the specific decisions (no `tournament()` primitive; generator≠judge; bracket-in-JS).
