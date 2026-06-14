/**
 * `workflow` — launch a workflow run (Task 4.1.3, pi port).
 *
 * The model-facing entry point for orchestration. It selects a script source,
 * loads it, and fires `engine.startRun(...)` DETACHED — returning the runId and
 * persisted script path immediately (the parent is never blocked; §2.3).
 *
 * Opt-in gate (§2.1): a workflow can spawn dozens of agents and burn large token
 * volumes, so it is explicitly opt-in. The tool DESCRIPTION carries that gate —
 * it is the only enforcement point the harness gives us, so the model must read
 * it as a hard precondition.
 *
 * Source selection: EXACTLY ONE of `script` / `script_path` / `name`, after
 * coercing empty/whitespace strings to absent. Zero or 2+ → an honest error
 * naming the rule.
 *
 * pi shell vs opencode:
 *   - `tool()` (opencode) → `defineTool` (pi): typebox params, `execute` takes
 *     `(toolCallId, params, signal, onUpdate, ctx)` and returns a `text(...)`
 *     result. `context.sessionID` → `ctx.sessionManager.getSessionId()`.
 *   - the engine is resolved through a LAZY `getEngine()` thunk (gotcha #1: tools
 *     register at LOAD, the engine is built in `session_start`), and `directory`
 *     through a getter so the SAME registration is correct for the whole session.
 *   - `.opencode/workflows` → `.pi/workflows`.
 *
 * Defensive coercion (Phase 2 NaN lesson): pi's raw execute path does NOT apply
 * typebox defaults/coercion (gotcha #4), so `args` may arrive as a real object, a
 * JSON string, an empty string, or absent — each handled explicitly here.
 *
 * Node-safe: no Bun.* APIs.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import {
	defineTool,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseScript } from "../../runtime/meta";
import { BUILTIN_WORKFLOWS, lookupBuiltin } from "../builtins";
import type { WorkflowEngine } from "../engine";
import { type FsFacade, nodeFs } from "../fs";

/** The saved-workflow subdirectory under the project directory. */
const WORKFLOWS_SUBDIR = ".pi/workflows";

export interface WorkflowToolDeps {
	/** Lazy engine resolution — tools register at load, the engine exists at session_start. */
	getEngine: () => WorkflowEngine;
	/** Project directory — saved-workflow + relative script_path resolution root. */
	directory: () => string;
	/** Injectable fs facade; tests pass in-memory. Defaults to node:fs/promises. */
	fs?: FsFacade;
}

/** A model-readable tool result. */
function text(message: string) {
	return { content: [{ type: "text" as const, text: message }], details: {} };
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Coerce a string arg to a trimmed value, or undefined when empty/absent. */
function trimmedOrAbsent(raw: unknown): string | undefined {
	if (typeof raw !== "string") {
		return undefined;
	}
	const t = raw.trim();
	return t.length > 0 ? t : undefined;
}

/**
 * Coerce `budget_tokens` to a positive finite number, or undefined (Phase 2 NaN
 * lesson: pi's raw execute path applies no typebox coercion, so the arg may
 * arrive as a number, a numeric string, an empty string, NaN, or absent).
 * `Number("")` is 0 and `Number("x")` is NaN — both fail the finite/>0 gate and
 * become undefined (no budget), so a garbage value never silently disables caps
 * NOR detonates the factory.
 */
function coerceBudgetTokens(raw: unknown): number | undefined {
	if (raw === undefined || raw === null) {
		return undefined;
	}
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Join two path segments with a single separator (no node:path dependency). */
function joinPath(base: string, rel: string): string {
	const b = base.endsWith("/") ? base.slice(0, -1) : base;
	const r = rel.startsWith("/") ? rel.slice(1) : rel;
	return `${b}/${r}`;
}

/**
 * Resolve `args` to the verbatim JSON value the script will see, or a typed
 * failure. Object → pass through; JSON string → parse; empty/whitespace/absent →
 * undefined; unparseable string → honest error.
 */
type ArgsResult = { ok: true; value: unknown } | { ok: false; error: string };

function resolveArgs(raw: unknown): ArgsResult {
	if (raw === undefined || raw === null) {
		return { ok: true, value: undefined };
	}
	if (typeof raw === "object") {
		// Already a real JSON value (array or object) — pass through verbatim.
		return { ok: true, value: raw };
	}
	if (typeof raw === "string") {
		if (raw.trim().length === 0) {
			return { ok: true, value: undefined };
		}
		try {
			return { ok: true, value: JSON.parse(raw) };
		} catch (err) {
			return {
				ok: false,
				error:
					"`args` must be a JSON-encoded value but did not parse as JSON: " +
					`${errorMessage(err)}. Pass valid JSON (or a raw object), or omit it.`,
			};
		}
	}
	// Number/boolean — accept verbatim (a script may legitimately read a scalar).
	return { ok: true, value: raw };
}

/**
 * Build the architecture-echo block for the immediate return (Task 6.2.2).
 *
 * This is an HONEST APPROXIMATION, not a DAG: static analysis of arbitrary JS
 * cannot promise the real execution shape (a primitive may be called in a loop,
 * behind a branch, or not at all). So the counts are cheap regex hits over the
 * source, explicitly labeled "detected" call-sites. The journal records the real
 * shape after execution; this just orients the model at submit time.
 *
 * The block carries (when extractable): meta name + phase titles, then a single
 * detected-primitives line counting `agent(`, `pipeline(`, `parallel(`,
 * `workflow(` call-sites and noting whether any `schema` appears. Returns `[]`
 * when no source is in hand (a resume that inherits the prior script) so the
 * caller emits nothing.
 */
function architectureEcho(source: string | undefined): string[] {
	if (source === undefined) {
		return [];
	}
	const lines: string[] = [];

	// Meta name + phases — parsed leniently; a parse failure just omits this line.
	try {
		const { meta } = parseScript(source);
		const phases = meta.phases?.map((p) => p.title) ?? [];
		lines.push(
			phases.length > 0
				? `Architecture: ${meta.name} — phases: ${phases.join(" → ")}.`
				: `Architecture: ${meta.name}.`,
		);
	} catch {
		// Unparseable meta → skip the name/phases line; still report detected counts.
	}

	const count = (re: RegExp): number => source.match(re)?.length ?? 0;
	// Word-boundary before the name so `subAgent(` / `myPipeline(` do not match.
	const agents = count(/\bagent\(/g);
	const pipelines = count(/\bpipeline\(/g);
	const parallels = count(/\bparallel\(/g);
	const workflows = count(/\bworkflow\(/g);
	const shells = count(/\bshell\(/g);
	const hasSchema = /\bschema\b/.test(source);

	lines.push(
		`Detected call-sites (static approximation, not a DAG): ${agents} agent, ` +
			`${pipelines} pipeline, ${parallels} parallel, ${workflows} workflow, ` +
			`${shells} shell${hasSchema ? "; schema present" : ""}.`,
	);

	// Advisory nudges (heuristic, best-effort, never blocking) — at most two,
	// schema first then disk-truth. These are regex heuristics over arbitrary JS
	// and may false-positive; they lead with "consider:" and stay advisory.
	const gatedShape = pipelines > 0 || parallels > 0;
	// `\bverify\b` does NOT match inside `verifyDiff` (no word boundary after
	// `verify`), so a good script using verifyDiff/contextDiff stays silent.
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
	return lines;
}

/**
 * Resolve a workflow by name: a built-in wins over a same-named user file (Epic
 * 2.2), then try <dir>/<name>.js, then .mjs. `builtins` defaults to the shipped
 * registry; tests inject a fake to exercise precedence without a real built-in.
 */
export async function loadSavedWorkflow(
	fs: FsFacade,
	wfDir: string,
	name: string,
	builtins: Record<string, string> = BUILTIN_WORKFLOWS,
): Promise<{ ok: true; source: string } | { ok: false; error: string }> {
	const builtin = lookupBuiltin(name, builtins);
	if (builtin !== undefined) {
		return { ok: true, source: builtin };
	}
	for (const ext of [".js", ".mjs"]) {
		try {
			const source = await fs.readFile(
				joinPath(wfDir, `${name}${ext}`),
				"utf-8",
			);
			return { ok: true, source };
		} catch {
			// Try the next extension.
		}
	}
	// Not found — list what IS available in the dir to guide the model.
	let available: string[] = [];
	try {
		available = await fs.readdir(wfDir);
	} catch {
		available = [];
	}
	if (available.length === 0) {
		return {
			ok: false,
			error: `no workflow named "${name}" — no saved workflows found in ${wfDir}.`,
		};
	}
	return {
		ok: false,
		error: `no workflow named "${name}". Available: ${available.join(", ")}.`,
	};
}

/**
 * The tool description doubles as the authoring manual: the orchestrating model
 * writes the scripts, so the contract must live where the model reads it. This
 * is the same trade Claude Code's Workflow tool makes — a fat description taxes
 * every turn of every session, in exchange for correct scripts on the first try.
 * The full reference (with worked examples) is the package README.
 */
export const WORKFLOW_DESCRIPTION = `Run a workflow: an orchestration script that fans out to MANY agents and can consume large token volumes. ONLY use this when the user has opted into orchestration (the \`ultracode\` keyword, a standing ultracode toggle, an explicit request for multi-agent orchestration, a skill that invokes it, or a request to run a named/saved workflow); otherwise use single agent calls, or describe the workflow and its rough cost and ask. Returns immediately with a run_id — the run executes in the background and you are notified on completion; do not poll (workflow_status with wait_ms is the blocking option for single-turn contexts).

## Script format

Plain JavaScript, not TypeScript — type annotations fail to parse. The script must begin with a meta export that is a pure literal (no variables, calls, spreads, or template interpolation):

  export const meta = {
    name: 'review-changes',                       // required
    description: 'Review changed files',          // required
    phases: [{ title: 'Review' }, { title: 'Verify' }],  // optional; titles must match phase() calls
  }

The body below the meta runs in an async context: use top-level await freely; a top-level return value becomes the workflow result.

## Script API (the only globals available)

- agent(prompt, opts?) → Promise — spawn a subagent. Resolves to its final text, or a validated object when opts.schema (a JSON Schema) is set, or null when the agent fails. If later control flow branches on a result (a count, a pass/fail, a list to fan out over), that agent MUST have a schema — free text cannot be gated. Filter nulls: results.filter(Boolean). opts: label (display), phase (progress group — use inside pipeline/parallel stages instead of the global phase()), schema, model ('provider/model' override; omit to inherit), agentType, tools (string[] — enable named platform/MCP tools for this agent, e.g. web search/fetch for research; names are environment-dependent and a no-op if the platform lacks them; omit to inherit the session's tools), skills (string[] — canonical skill names from the workflow_skills tool, e.g. \`ring:writing-trds\`; use EXACT names, each binds that skill's instructions into the spawned step. UNLIKE agentType/tools, an UNKNOWN name FAILS the step loudly, so verify names via workflow_skills first; a skill-bound step needs file-read tools (Read/Bash) enabled if the skill references bundled resources), contextDiff. isolation:'worktree' runs the agent in its OWN git worktree (a scratch branch checked out in a sibling dir) when the run is git-backed, so parallel mutating agents never overwrite each other on one tree; it degrades to null with a loud diagnostic ONLY on a non-git / no-shell checkout (where there is no worktree primitive) rather than silently running unisolated. WORKTREE ENVIRONMENT: the checkout is HEAD + the agent's own edits + a node_modules symlinked from the main tree when one exists (so test/lint checks can run); OTHER untracked artifacts (.env, build output, generated files) are ABSENT — a verifyDiff {check} that needs them will fail environmentally. MERGE-BACK + CONFLICT RESULT: when an isolated agent settles with real work, the engine merges its scratch branch back into the main tree; on a REAL merge conflict the agent() call resolves to a structured {status:'conflict', branch, files, baseRef} value (NOT the agent's text, NOT a throw — the batch survives) and the worktree+branch are PRESERVED so a follow-up resolver step can act on them — a conflict means two agents got overlapping scope, which is a decomposition error to fix in the script. contextDiff:true (FOR REVIEW AGENTS) injects the engine-computed REAL git diff (since run start) as model-only context, and refuses the review (degrades to null) when that diff is empty — so a reviewer reviews what is actually ON DISK, never narrative-only claims. The diff does not change the resume cache key, so a reviewer still replays its verdict on resume. On a non-git checkout it is inert (the review runs with no diff). verifyDiff (FOR FIX/IMPLEMENT AGENTS) is a post-condition the engine checks AFTER the agent settles, against GIT/DISK truth — NOT the agent's self-report. Setting verifyDiff IMPLIES worktree isolation on a git-backed engine (the check must observe only THIS agent's edits, not a sibling's). verifyDiff:true (or {}) asserts the agent actually wrote work — modified files, NEW files, and commits the agent made inside its worktree all count; verifyDiff:{check:'<cmd>'} runs <cmd> (e.g. a test) in the agent's worktree and asserts exit 0. VERIFY GATES THE MERGE: when verify fails for an isolated agent, its work is NOT merged to the main branch — the result is downgraded to null (so it re-runs on resume, never on top of its own failed work) and the worktree+scratch branch (named wf/<run_id>/<label> in the warn) are preserved for inspection/recovery. verifyDiff:false is identical to omitting it. It does NOT change the resume cache key. Best-effort: it proves something is on disk or a command passed, not that the work is correct. Inert on a non-git checkout.
- pipeline(items, stage1, stage2, ...) → Promise<any[]> — run each item through all stages with NO barrier between stages: item A can be in stage 3 while item B is in stage 1. DEFAULT to this for multi-stage work. Each stage receives (prevResult, originalItem, index). A throwing stage drops that item to null.
- parallel(thunks) → Promise<any[]> — run thunks (() => Promise) concurrently with a BARRIER: awaits all before returning; a failed thunk yields null, the call never rejects. Use ONLY when a later step genuinely needs ALL results together (dedup, cross-item comparison, early-exit on count).
- phase(title) — start a progress group for subsequent agent() calls.
- log(message) — emit a narrator line to the user.
- args — the tool-call args value, verbatim.
- budget — { total: number|null, spent(): number, remaining(): number }. Hard ceiling: once spent() reaches total, further agent() calls throw. Guard loops: while (budget.total && budget.remaining() > 50_000) { ... }.
- workflow(nameOrRef, args?) — run another workflow inline (a saved name or { scriptPath }) and return its result. One level deep only; a child workflow error THROWS (unlike agent()'s null) — catch to handle.
- shell(command, opts?) → Promise<{command, passed, exitCode, stdout, stderr, available}> — run a deterministic command via the repo-bound host shell. This is the CHEAP counterpart to agent(): the OS decides FACTS (did the gate pass?), so do NOT spend an agent to discover a command's exit code — run shell() and hand a FAILED result's stderr to an agent for JUDGMENT (why it failed, how to fix). NEVER throws on a non-zero exit; that is a passed:false VALUE you branch on. passed is exitCode === (opts.expectExitCode ?? 0). opts: label (display), cwd (relative to project root, or absolute), expectExitCode (default 0). available:false means no shell capability here (a no-shell checkout) — an honest unavailable result, NEVER a fabricated pass, so it is never cached and re-runs on resume. An available result IS journaled and replays on resume like agent() (a gate that passed once replays passed, never re-runs). stdout/stderr are capped (~100k chars each). Counts against the 1000-unit lifetime cap. Example: const t = await shell('make test'); if (!t.passed) await agent('Investigate this failing gate:\\n' + t.stderr).

## Determinism (violations throw)

Date.now(), Math.random(), and argless new Date() are banned — they would poison the resume cache. Pass timestamps in via args; vary prompts/labels by index instead of randomness. No setTimeout/setInterval/queueMicrotask, no process/require/fetch. console.log routes to log(). new Date(ms), Date.parse, and Date.UTC work.

## Caps and failure semantics

Lifetime cap of 1000 agent() calls per run (cached replays count); 4096 items max per pipeline/parallel call; concurrent agents capped at min(16, cores − 2) — excess queue. agent() failures degrade to null; cap/budget violations throw and stop the run.

## Acting on failures

agent() failures and failed verifyDiff/contextDiff post-conditions degrade to null — the script keeps running unless you decide otherwise. An isolated agent can also resolve to {status:'conflict', branch, files, baseRef} (merge-back conflict; its worktree is preserved) — branch on result && result.status === 'conflict' to dispatch a resolver or stop. When a stage gates downstream work, DECIDE explicitly: stop the run (throw), escalate (spawn a fix/repair agent), or record-and-continue. For SEQUENTIAL phases where phase N+1 builds on phase N's code, the default is to STOP on a red gate rather than compound onto broken work; for independent fan-out, record-and-continue and report the failures in the result.

## Resume and saved workflows

Every successful agent() result is journaled. Relaunch with resume_from_run_id and every agent() call whose (prompt, opts) key matches a journaled call replays from cache (instant, zero tokens), matched per-item by key + occurrence — independent of position, so editing one item still replays unchanged items (including expensive siblings) for free; only changed, new, and previously-failed calls run live. N byte-identical calls replay their N journaled results, then the N+1th runs live. Replay returns the FROZEN journaled result; a call that re-runs live may legitimately return a different answer — agents are non-deterministic. Same script + same args → full cache hit; failures are never cached (they re-run). Survives pi restarts. Saved workflows live at .pi/workflows/<name>.js (or .mjs) in the project and are invoked by name.

## Patterns

Seven composable shapes — name the pattern in the script and the orchestration sharpens. Each is "spawn isolated agents, then combine"; mix them freely.

- classify-and-act — one agent classifies the input, then branch/route to a specialist agent per class (or classify the OUTPUT at the end to shape it). Mixed backlogs, triage.
- fan-out-and-synthesize — split into independent steps, agent() per step (clean context each, no cross-contamination), then a BARRIER synthesis step (parallel, then merge the structured outputs). Per-file audits, multi-angle research.
- adversarial-verification — for each finding, spawn a SEPARATE agent whose only job is to refute it against a rubric; producer and skeptic never share a context, which kills self-preference. A finding survives only if the skeptic cannot knock it down. Security findings, factual claims. (The minimal example below is this shape.)
- generate-and-filter — overgenerate N candidates, then a judge agent keeps only the rubric-passers. The generator and the judge MUST be different agents — a generator grading its own output is self-preference again. Naming, design exploration.
- tournament — N agents attempt the SAME task with different approaches; a judge compares them PAIRWISE ("is A better than B?") until one wins — comparative judgment is more reliable than absolute 1–10 scoring. The deterministic JS loop holds the bracket; only the running order stays in context. Taste-based ranking, sorting 1000+ items. There is no tournament() primitive: use agent() + a plain loop — keeping the bracket in JS is exactly what preserves resume.
- loop-until-done — for unknown-size work, loop spawning agents until a stop condition is met (no new findings for K rounds, no errors left in the logs) instead of a fixed pass count; pair with the budget guard as a ceiling. Bug hunts, log-driven root-cause.
- review-against-disk-truth — reviewers get contextDiff:true so they review the engine-computed REAL git diff (and the review is REFUSED when the diff is empty, so a reviewer can never pass on narrative-only claims); implement/fix agents get verifyDiff (verifyDiff:true asserts the unit wrote to disk; verifyDiff:{check:'<cmd>'} asserts a command exits 0). Never review by telling an agent to run \`git diff\` itself — contextDiff is the engine's tamper-proof channel. Code review, fix loops.

Route by role with agentType, which accepts the name of any agent you can delegate to directly in this environment. Use the EXACT canonical name from that roster (names are namespaced, e.g. \`ring:code-reviewer\`) — a near-miss is NOT corrected; an unknown agentType SILENTLY falls back to the default generalist, so an unverified guess degrades quality without erroring. Prefer a name you know is in the roster, and a specialist (a domain engineer for implementation, dedicated reviewer agents for review, a planning agent for decomposition) over the default generalist whenever one exists; a parallel panel of distinct reviewer agentTypes catches what one generalist misses, and a narrower panel on later rounds saves tokens.

## Minimal example

  export const meta = { name: 'review', description: 'Review files, verify findings', phases: [{ title: 'Review' }, { title: 'Verify' }] }
  const FINDINGS = { type: 'object', properties: { issues: { type: 'array', items: { type: 'string' } } }, required: ['issues'] }
  const results = await pipeline(
    args.files,
    (f) => agent('Review ' + f + ' for bugs. Return issues.', { phase: 'Review', schema: FINDINGS, contextDiff: true }),
    (r, f) => r && parallel(r.issues.map((i) => () => agent('Verify in ' + f + ': ' + i, { phase: 'Verify' }))),
  )
  return { verified: results.flat().filter(Boolean) }

## Fix-and-verify example (verifyDiff)

  export const meta = { name: 'fix', description: 'Fix files, verify each lands on disk' }
  const fixed = await parallel(args.files.map((f) =>
    () => agent('Fix the failing tests in ' + f + '.', { label: 'fix ' + f, verifyDiff: { check: 'bun test ' + f } }),
  ))
  return { fixed: fixed.filter(Boolean) }

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

agentType names are environment-dependent — the example's \`domain-engineer\`/\`code-reviewer\` are illustrative; substitute the exact canonical names from your delegation roster (an unknown name silently falls back to the generalist rather than erroring).`;

export function createWorkflowTool(deps: WorkflowToolDeps) {
	const fs = deps.fs ?? nodeFs();

	return defineTool({
		name: "workflow",
		label: "Workflow",
		description: WORKFLOW_DESCRIPTION,
		promptSnippet: "Run a multi-agent orchestration workflow script",
		parameters: Type.Object({
			script: Type.Optional(
				Type.String({
					description: "Inline self-contained workflow script (JavaScript).",
				}),
			),
			script_path: Type.Optional(
				Type.String({
					description:
						"Path to a script file (resolved relative to the project directory).",
				}),
			),
			name: Type.Optional(
				Type.String({
					description:
						"Name of a saved workflow in .pi/workflows/<name>.js (or .mjs).",
				}),
			),
			args: Type.Optional(
				Type.String({
					description:
						"JSON-encoded value exposed to the script as `args` (a raw object " +
						"is also accepted).",
				}),
			),
			resume_from_run_id: Type.Optional(
				Type.String({
					description:
						"Resume a prior run by its run_id (spec §7): every agent() call " +
						"matching a journaled call key replays from cache (per-item, " +
						"position-independent); changed/new/failed calls run live. A " +
						"re-run may differ — replay returns the frozen result. " +
						"Source/args default to the prior run's when omitted.",
				}),
			),
			budget_tokens: Type.Optional(
				Type.Number({
					description:
						"Output-token ceiling for the whole workflow (sum of child agents' " +
						"output+reasoning tokens). When the budget is exhausted, further " +
						"agent() calls are refused. Omit for no ceiling.",
				}),
			),
			spec_path: Type.Optional(
				Type.String({
					description:
						"Path to the run's source-of-truth FILE (e.g. a rolling-wave plan " +
						"doc): repo-relative, or absolute under the project directory — a " +
						"path resolving outside the project is rejected. Classified for a " +
						"git diagnostic; if untracked/ignored it is copied into " +
						"worktree-isolated agents so they can see it. The copy is READ-ONLY " +
						"input: an agent edit to it is never merged (a loud warning names " +
						"where the edited bytes survive). Omit if none.",
				}),
			),
		}),
		async execute(
			_toolCallId,
			params,
			_signal,
			_onUpdate,
			ctx: ExtensionContext,
		) {
			const engine = deps.getEngine();
			const directory = deps.directory();
			const wfDir = joinPath(directory, WORKFLOWS_SUBDIR);

			const resumeFrom = trimmedOrAbsent(params.resume_from_run_id);
			// Coerce defensively (raw execute path skips typebox) → number | undefined.
			const budgetTokens = coerceBudgetTokens(params.budget_tokens);

			const script = trimmedOrAbsent(params.script);
			const scriptPath = trimmedOrAbsent(params.script_path);
			const name = trimmedOrAbsent(params.name);

			// spec_path containment (model-supplied input): support repo-relative AND
			// absolute (the documented contract), resolve absolute-aware (a naive
			// join() both mangles absolute paths and lets `../..` escape the repo),
			// then REQUIRE the result inside the project directory — an escaping path
			// is rejected loudly here, at the tool boundary. The engine receives the
			// normalized REPO-RELATIVE path so classification and the worktree copy
			// share one canonical shape.
			let specPath = trimmedOrAbsent(params.spec_path);
			if (specPath !== undefined) {
				const root = resolve(directory);
				const abs = isAbsolute(specPath)
					? resolve(specPath)
					: resolve(root, specPath);
				if (abs !== root && !abs.startsWith(root + sep)) {
					return text(
						`spec_path must resolve inside the project directory (${directory}); ` +
							`"${specPath}" resolves to ${abs}. Pass a repo-relative path or an ` +
							"absolute path under the project.",
					);
				}
				specPath = relative(root, abs);
			}

			const present = [script, scriptPath, name].filter((v) => v !== undefined);
			// The source xor only applies when NOT resuming: a resume may carry zero
			// source params (inherit the prior script) or exactly one (an edited
			// source). Two-or-more is always an error.
			if (resumeFrom === undefined) {
				if (present.length !== 1) {
					return text(
						"provide exactly one of `script`, `script_path`, or `name` " +
							`(got ${present.length}).`,
					);
				}
			} else if (present.length > 1) {
				return text(
					"on resume, provide at most one source override " +
						`(\`script\`, \`script_path\`, or \`name\`) — got ${present.length}.`,
				);
			}

			// Resolve args BEFORE loading source — a garbage `args` should fail fast
			// without touching disk or launching.
			const argsResult = resolveArgs(params.args);
			if (!argsResult.ok) {
				return text(argsResult.error);
			}

			// --- Resolve the script source (optional on resume) ------------------
			let source: string | undefined;
			if (script !== undefined) {
				source = script;
			} else if (name !== undefined) {
				const loaded = await loadSavedWorkflow(fs, wfDir, name);
				if (!loaded.ok) {
					return text(loaded.error);
				}
				source = loaded.source;
			} else if (scriptPath !== undefined) {
				// An absolute path (the exact path the launch message returns) loads
				// verbatim; a relative path resolves under the project directory (Epic
				// 1.2). `joinPath` strips a leading `/`, so without this guard an absolute
				// path would be re-rooted under `directory` → ENOENT. POSIX-only by the
				// `startsWith("/")` idiom, matching `resolve-source.ts`.
				const abs = scriptPath.startsWith("/")
					? scriptPath
					: joinPath(directory, scriptPath);
				try {
					source = await fs.readFile(abs, "utf-8");
				} catch (err) {
					return text(
						`could not read script_path ${scriptPath}: ${errorMessage(err)}`,
					);
				}
			}
			// source stays undefined only on a resume with no override → the engine
			// reads the prior run's persisted script.

			let result: Awaited<ReturnType<WorkflowEngine["startRun"]>>;
			try {
				result = await engine.startRun({
					...(source !== undefined ? { source } : {}),
					// Spread `args` ONLY when present (Epic 1.1): the engine inherits the
					// prior run's persisted args on resume via `"args" in args`, so passing
					// `args: undefined` unconditionally would always set the key and defeat
					// inheritance. An explicit value still overrides the prior.
					...(argsResult.value !== undefined ? { args: argsResult.value } : {}),
					parentSessionID: ctx.sessionManager.getSessionId(),
					...(resumeFrom !== undefined ? { resumeFromRunId: resumeFrom } : {}),
					...(budgetTokens !== undefined ? { budgetTokens } : {}),
					...(specPath !== undefined ? { specPath } : {}),
				});
			} catch (err) {
				// Resume guards (unknown id / still-running) throw — surface them as
				// honest tool text rather than a thrown tool error.
				return text(errorMessage(err));
			}

			const launched =
				resumeFrom !== undefined
					? `Resumed workflow ${result.runId} (${result.name}), resumed from ${resumeFrom}.`
					: `Launched workflow ${result.runId} (${result.name}).`;
			// The run-id-first line + persistence + no-poll guidance stay one line (the
			// model parses the leading line for the run id). The architecture echo
			// (Task 6.2.2) follows as its own line(s) — empty on a source-less resume.
			const head = [
				launched,
				`Script persisted at ${result.scriptPath}.`,
				"It runs in the background — do not poll; you will be notified on " +
					`completion. Use workflow_status run_id=${result.runId} to inspect ` +
					"progress or read the result.",
			].join(" ");
			return text([head, ...architectureEcho(source)].join("\n"));
		},
	});
}
