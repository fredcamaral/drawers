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

export function createWorkflowTool(
	engine: WorkflowEngine,
	deps: WorkflowToolDeps,
) {
	const directory = deps.directory;
	const fs = deps.fs ?? nodeFs();
	const wfDir = joinPath(directory, WORKFLOWS_SUBDIR);

	return tool({
		description:
			"Run a workflow: an orchestration script that can fan out to MANY agents " +
			"and consume large token volumes. ONLY use this when the user has opted " +
			"into orchestration (the `ultracode` keyword, a standing ultracode toggle, " +
			"an explicit request for multi-agent orchestration, a skill that invokes " +
			"it, or a request to run a named/saved workflow); otherwise use single " +
			"Agent calls or describe the workflow and its rough cost and ask. Returns " +
			"immediately with a run_id — it runs in the background and notifies you on " +
			"completion; do not poll.",
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
				.describe("Resume a prior run by its run_id (not yet supported)."),
		},
		async execute(args, context: ToolContext) {
			// Resume is a distinct mode — surface the placeholder before anything else
			// so a resume request is never silently treated as a fresh launch.
			const resumeFrom = trimmedOrAbsent(args.resume_from_run_id);
			if (resumeFrom !== undefined) {
				return `resume lands in Task 4.2.2 (requested resume_from_run_id=${resumeFrom}).`;
			}

			const script = trimmedOrAbsent(args.script);
			const scriptPath = trimmedOrAbsent(args.script_path);
			const name = trimmedOrAbsent(args.name);

			const present = [script, scriptPath, name].filter((v) => v !== undefined);
			if (present.length !== 1) {
				return (
					"provide exactly one of `script`, `script_path`, or `name` " +
					`(got ${present.length}).`
				);
			}

			// Resolve args BEFORE loading source — a garbage `args` should fail fast
			// without touching disk or launching.
			const argsResult = resolveArgs(args.args);
			if (!argsResult.ok) {
				return argsResult.error;
			}

			// --- Resolve the script source --------------------------------------
			let source: string;
			if (script !== undefined) {
				source = script;
			} else if (name !== undefined) {
				const loaded = await loadSavedWorkflow(fs, wfDir, name);
				if (!loaded.ok) {
					return loaded.error;
				}
				source = loaded.source;
			} else {
				// script_path (the exactly-one check guarantees it is set here).
				const abs = joinPath(directory, scriptPath as string);
				try {
					source = await fs.readFile(abs, "utf-8");
				} catch (err) {
					return `could not read script_path ${scriptPath}: ${errorMessage(err)}`;
				}
			}

			const result = await engine.startRun({
				source,
				args: argsResult.value,
				parentSessionID: context.sessionID,
			});

			return [
				`Launched workflow ${result.runId} (${result.name}).`,
				`Script persisted at ${result.scriptPath}.`,
				"It runs in the background — do not poll; you will be notified on " +
					`completion. Use workflow_status run_id=${result.runId} to inspect ` +
					"progress or read the result.",
			].join(" ");
		},
	});
}
