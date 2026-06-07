/**
 * `workflow` — launch a workflow run (Task 4.1.3).
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
 * Defensive coercion (Phase 2 NaN lesson): opencode's raw execute path does NOT
 * apply Zod defaults/coercion, so `args` may arrive as a real object, a JSON
 * string, an empty string, or absent — each handled explicitly here.
 */

import type { FsFacade } from "@drawers/core";
import { type ToolContext, tool } from "@opencode-ai/plugin";
import { parseScript } from "../../runtime/meta";
import type { WorkflowEngine } from "../engine";

/** The saved-workflow subdirectory under the project directory. */
const WORKFLOWS_SUBDIR = ".opencode/workflows";

export interface WorkflowToolDeps {
	/** Project directory — saved-workflow + relative script_path resolution root. */
	directory: string;
	/** Injectable fs facade; tests pass in-memory. Defaults to node:fs/promises. */
	fs?: FsFacade;
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
 * lesson: opencode's raw execute path applies no Zod coercion, so the arg may
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

/** A node:fs/promises-backed default facade (used when no fs is injected). */
function nodeFs(): FsFacade {
	// Lazy require so the module stays import-light for the in-memory test path.
	const fs = require("node:fs/promises") as {
		mkdir: FsFacade["mkdir"];
		readdir: FsFacade["readdir"];
		readFile: FsFacade["readFile"];
		writeFile: FsFacade["writeFile"];
		rename: FsFacade["rename"];
		rm: FsFacade["rm"];
	};
	return fs;
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
	const hasSchema = /\bschema\b/.test(source);

	lines.push(
		`Detected call-sites (static approximation, not a DAG): ${agents} agent, ` +
			`${pipelines} pipeline, ${parallels} parallel, ${workflows} workflow` +
			`${hasSchema ? "; schema present" : ""}.`,
	);
	return lines;
}

/** Read a saved workflow by name: try <dir>/<name>.js, then .mjs. */
async function loadSavedWorkflow(
	fs: FsFacade,
	wfDir: string,
	name: string,
): Promise<{ ok: true; source: string } | { ok: false; error: string }> {
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
const WORKFLOW_DESCRIPTION = `Run a workflow: an orchestration script that fans out to MANY agents and can consume large token volumes. ONLY use this when the user has opted into orchestration (the \`ultracode\` keyword, a standing ultracode toggle, an explicit request for multi-agent orchestration, a skill that invokes it, or a request to run a named/saved workflow); otherwise use single agent calls, or describe the workflow and its rough cost and ask. Returns immediately with a run_id — the run executes in the background and you are notified on completion; do not poll (workflow_status with wait_ms is the blocking option for single-turn contexts).

## Script format

Plain JavaScript, not TypeScript — type annotations fail to parse. The script must begin with a meta export that is a pure literal (no variables, calls, spreads, or template interpolation):

  export const meta = {
    name: 'review-changes',                       // required
    description: 'Review changed files',          // required
    phases: [{ title: 'Review' }, { title: 'Verify' }],  // optional; titles must match phase() calls
  }

The body below the meta runs in an async context: use top-level await freely; a top-level return value becomes the workflow result.

## Script API (the only globals available)

- agent(prompt, opts?) → Promise — spawn a subagent. Resolves to its final text, or a validated object when opts.schema (a JSON Schema) is set, or null when the agent fails. Filter nulls: results.filter(Boolean). opts: label (display), phase (progress group — use inside pipeline/parallel stages instead of the global phase()), schema, model ('provider/model' override; omit to inherit), agentType. isolation:'worktree' is recognized but NOT yet supported (the agent runs without isolation).
- pipeline(items, stage1, stage2, ...) → Promise<any[]> — run each item through all stages with NO barrier between stages: item A can be in stage 3 while item B is in stage 1. DEFAULT to this for multi-stage work. Each stage receives (prevResult, originalItem, index). A throwing stage drops that item to null.
- parallel(thunks) → Promise<any[]> — run thunks (() => Promise) concurrently with a BARRIER: awaits all before returning; a failed thunk yields null, the call never rejects. Use ONLY when a later step genuinely needs ALL results together (dedup, cross-item comparison, early-exit on count).
- phase(title) — start a progress group for subsequent agent() calls.
- log(message) — emit a narrator line to the user.
- args — the tool-call args value, verbatim.
- budget — { total: number|null, spent(): number, remaining(): number }. Hard ceiling: once spent() reaches total, further agent() calls throw. Guard loops: while (budget.total && budget.remaining() > 50_000) { ... }.
- workflow(nameOrRef, args?) — run another workflow inline (a saved name or { scriptPath }) and return its result. One level deep only; a child workflow error THROWS (unlike agent()'s null) — catch to handle.

## Determinism (violations throw)

Date.now(), Math.random(), and argless new Date() are banned — they would poison the resume cache. Pass timestamps in via args; vary prompts/labels by index instead of randomness. No setTimeout/setInterval/queueMicrotask, no process/require/fetch. console.log routes to log(). new Date(ms), Date.parse, and Date.UTC work.

## Caps and failure semantics

Lifetime cap of 1000 agent() calls per run (cached replays count); 4096 items max per pipeline/parallel call; concurrent agents capped at min(16, cores − 2) — excess queue. agent() failures degrade to null; cap/budget violations throw and stop the run.

## Resume and saved workflows

Every successful agent() result is journaled. Relaunch with resume_from_run_id and every agent() call whose (prompt, opts) key matches a journaled call replays from cache (instant, zero tokens), matched per-item by key + occurrence — independent of position, so editing one item still replays unchanged items (including expensive siblings) for free; only changed, new, and previously-failed calls run live. N byte-identical calls replay their N journaled results, then the N+1th runs live. Replay returns the FROZEN journaled result; a call that re-runs live may legitimately return a different answer — agents are non-deterministic. Same script + same args → full cache hit; failures are never cached (they re-run). Survives opencode restarts. Saved workflows live at .opencode/workflows/<name>.js (or .mjs) in the project and are invoked by name.

## Minimal example

  export const meta = { name: 'review', description: 'Review files, verify findings', phases: [{ title: 'Review' }, { title: 'Verify' }] }
  const FINDINGS = { type: 'object', properties: { issues: { type: 'array', items: { type: 'string' } } }, required: ['issues'] }
  const results = await pipeline(
    args.files,
    (f) => agent('Review ' + f + ' for bugs. Return issues.', { phase: 'Review', schema: FINDINGS }),
    (r, f) => r && parallel(r.issues.map((i) => () => agent('Verify in ' + f + ': ' + i, { phase: 'Verify' }))),
  )
  return { verified: results.flat().filter(Boolean) }`;

export function createWorkflowTool(
	engine: WorkflowEngine,
	deps: WorkflowToolDeps,
) {
	const directory = deps.directory;
	const fs = deps.fs ?? nodeFs();
	const wfDir = joinPath(directory, WORKFLOWS_SUBDIR);

	return tool({
		description: WORKFLOW_DESCRIPTION,
		args: {
			script: tool.schema
				.string()
				.optional()
				.describe("Inline self-contained workflow script (JavaScript)."),
			script_path: tool.schema
				.string()
				.optional()
				.describe(
					"Path to a script file (resolved relative to the project directory).",
				),
			name: tool.schema
				.string()
				.optional()
				.describe(
					"Name of a saved workflow in .opencode/workflows/<name>.js (or .mjs).",
				),
			args: tool.schema
				.string()
				.optional()
				.describe(
					"JSON-encoded value exposed to the script as `args` (a raw object " +
						"is also accepted).",
				),
			resume_from_run_id: tool.schema
				.string()
				.optional()
				.describe(
					"Resume a prior run by its run_id (spec §7): every agent() call " +
						"matching a journaled call key replays from cache (per-item, " +
						"position-independent); changed/new/failed calls run live. A " +
						"re-run may differ — replay returns the frozen result. " +
						"Source/args default to the prior run's when omitted.",
				),
			budget_tokens: tool.schema
				.number()
				.optional()
				.describe(
					"Output-token ceiling for the whole workflow (sum of child agents' " +
						"output+reasoning tokens). When the budget is exhausted, further " +
						"agent() calls are refused. Omit for no ceiling.",
				),
		},
		async execute(args, context: ToolContext) {
			const resumeFrom = trimmedOrAbsent(args.resume_from_run_id);
			// Coerce defensively (raw execute path skips Zod) → number | undefined.
			const budgetTokens = coerceBudgetTokens(args.budget_tokens);

			const script = trimmedOrAbsent(args.script);
			const scriptPath = trimmedOrAbsent(args.script_path);
			const name = trimmedOrAbsent(args.name);

			const present = [script, scriptPath, name].filter((v) => v !== undefined);
			// The source xor only applies when NOT resuming: a resume may carry zero
			// source params (inherit the prior script) or exactly one (an edited
			// source). Two-or-more is always an error.
			if (resumeFrom === undefined) {
				if (present.length !== 1) {
					return (
						"provide exactly one of `script`, `script_path`, or `name` " +
						`(got ${present.length}).`
					);
				}
			} else if (present.length > 1) {
				return (
					"on resume, provide at most one source override " +
					`(\`script\`, \`script_path\`, or \`name\`) — got ${present.length}.`
				);
			}

			// Resolve args BEFORE loading source — a garbage `args` should fail fast
			// without touching disk or launching.
			const argsResult = resolveArgs(args.args);
			if (!argsResult.ok) {
				return argsResult.error;
			}

			// --- Resolve the script source (optional on resume) ------------------
			let source: string | undefined;
			if (script !== undefined) {
				source = script;
			} else if (name !== undefined) {
				const loaded = await loadSavedWorkflow(fs, wfDir, name);
				if (!loaded.ok) {
					return loaded.error;
				}
				source = loaded.source;
			} else if (scriptPath !== undefined) {
				const abs = joinPath(directory, scriptPath);
				try {
					source = await fs.readFile(abs, "utf-8");
				} catch (err) {
					return `could not read script_path ${scriptPath}: ${errorMessage(err)}`;
				}
			}
			// source stays undefined only on a resume with no override → the engine
			// reads the prior run's persisted script.

			let result: Awaited<ReturnType<WorkflowEngine["startRun"]>>;
			try {
				result = await engine.startRun({
					source,
					args: argsResult.value,
					parentSessionID: context.sessionID,
					...(resumeFrom !== undefined ? { resumeFromRunId: resumeFrom } : {}),
					...(budgetTokens !== undefined ? { budgetTokens } : {}),
				});
			} catch (err) {
				// Resume guards (unknown id / still-running) throw — surface them as
				// honest tool text rather than a thrown tool error.
				return errorMessage(err);
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
			return [head, ...architectureEcho(source)].join("\n");
		},
	});
}
