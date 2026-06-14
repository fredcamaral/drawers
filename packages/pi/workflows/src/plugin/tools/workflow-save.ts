/**
 * `workflow_save_run` — persist a run's script as a reusable named workflow
 * (Epic 4.1, pi port). A run already writes its script to `<dataDir>/
 * workflow-scripts/<runId>.js` at launch; "saving" copies that validated source
 * to `<project>/.pi/workflows/<name>.js`, where the existing name-resolver then
 * finds it.
 *
 * The core is the shared {@link saveRunAsWorkflow} so the `/workflows` TUI (Epic
 * 4.2, via the control-channel sentinel) reuses the exact same validated path
 * instead of duplicating it — the engine imports it directly. Every refusal is an
 * honest string/result, never a thrown crash: bad name, built-in collision,
 * unknown run, unreadable/invalid source, or an existing file without `overwrite`
 * all decline and write nothing.
 *
 * Node-safe: no Bun.* APIs.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseScript } from "../../runtime/meta";
import { lookupBuiltin } from "../builtins";
import type { WorkflowEngine } from "../engine";
import { type FsFacade, nodeFs } from "../fs";
import { joinPath } from "../resolve-source";

/** The saved-workflow subdirectory under the project directory. */
const WORKFLOWS_SUBDIR = ".pi/workflows";

/** A model-readable tool result. */
function text(message: string) {
	return { content: [{ type: "text" as const, text: message }], details: {} };
}

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Coerce a raw arg to string (pi's raw path may hand a non-string). */
function coerceId(raw: unknown): string {
	return typeof raw === "string" ? raw : String(raw);
}

/**
 * Reject names that are empty, dot-only, or carry anything outside a safe
 * filename charset (no `/`, `\`, traversal). Returns an error string or null.
 */
function validateName(name: string): string | null {
	if (name.length === 0) return "name must not be empty.";
	if (name === "." || name === "..") return `invalid name "${name}".`;
	if (!/^[A-Za-z0-9._-]+$/.test(name)) {
		return `invalid name "${name}" — use only letters, digits, '.', '-', '_'.`;
	}
	return null;
}

/**
 * The narrow run-lookup surface saveRunAsWorkflow needs — satisfied by the full
 * {@link WorkflowEngine} (the tool path) and by the engine's own internals (the
 * TUI control-channel consumer), so neither has to hand over more than this.
 */
export interface RunLookup {
	statusOf(runId: string): { record: { scriptPath: string } } | undefined;
	runs: ReadonlyMap<string, unknown>;
}

export interface SaveDeps {
	engine: RunLookup;
	fs: FsFacade;
	directory: string;
}

export interface SaveInput {
	runId: string;
	name: string;
	overwrite?: boolean;
}

export type SaveResult =
	| { ok: true; path: string; name: string }
	| { ok: false; error: string };

/**
 * Validate and copy a run's persisted script to `.pi/workflows/<name>.js`. Shared
 * by the tool and the TUI control-channel consumer.
 */
export async function saveRunAsWorkflow(
	deps: SaveDeps,
	input: SaveInput,
): Promise<SaveResult> {
	const name = input.name.trim();
	const nameErr = validateName(name);
	if (nameErr !== null) return { ok: false, error: nameErr };

	// A built-in wins at resolve time, so saving a user file over its name would
	// be a silent no-op — refuse instead of writing a file that never loads.
	if (lookupBuiltin(name) !== undefined) {
		return {
			ok: false,
			error: `"${name}" is a built-in workflow; built-ins take precedence, so a saved file by that name would never load. Pick another name.`,
		};
	}

	const handle = deps.engine.statusOf(input.runId);
	if (handle === undefined) {
		const known = [...deps.engine.runs.keys()];
		return {
			ok: false,
			error: `unknown run_id ${input.runId}. Known runs: ${known.length > 0 ? known.join(", ") : "(none)"}.`,
		};
	}

	const scriptPath = handle.record.scriptPath;
	let source: string;
	try {
		source = await deps.fs.readFile(scriptPath, "utf-8");
	} catch (err) {
		return {
			ok: false,
			error: `could not read the run's script at ${scriptPath}: ${errMsg(err)}.`,
		};
	}

	// Refuse to persist a script that is not a valid workflow (write nothing).
	try {
		parseScript(source);
	} catch (err) {
		return {
			ok: false,
			error: `the run's script is not a valid workflow (${errMsg(err)}); nothing was saved.`,
		};
	}

	const wfDir = joinPath(deps.directory, WORKFLOWS_SUBDIR);
	const dest = joinPath(wfDir, `${name}.js`);

	if (input.overwrite !== true) {
		try {
			await deps.fs.readFile(dest, "utf-8");
			return {
				ok: false,
				error: `a workflow named "${name}" already exists at ${dest}; pass overwrite:true to replace it.`,
			};
		} catch {
			// Not found → safe to write.
		}
	}

	try {
		await deps.fs.mkdir(wfDir, { recursive: true });
		await deps.fs.writeFile(dest, source, "utf-8");
	} catch (err) {
		return { ok: false, error: `failed to write ${dest}: ${errMsg(err)}.` };
	}

	return { ok: true, path: dest, name };
}

export interface WorkflowSaveToolDeps {
	/** Lazy engine resolution — tools register at load, the engine exists at session_start. */
	getEngine: () => WorkflowEngine;
	/** Project directory — saved-workflow destination root. */
	directory: () => string;
	/** Injectable fs facade; tests pass in-memory. Defaults to node:fs/promises. */
	fs?: FsFacade;
}

export function createWorkflowSaveRunTool(deps: WorkflowSaveToolDeps) {
	const fs = deps.fs ?? nodeFs();
	return defineTool({
		name: "workflow_save_run",
		label: "Workflow save run",
		description:
			"Save a finished or running workflow run's script as a reusable named " +
			"workflow at .pi/workflows/<name>.js, so it can be re-invoked later by " +
			"name. Validates the script before writing; refuses on a bad/built-in " +
			"name, unknown run_id, invalid source, or an existing file (unless " +
			"overwrite). Writes nothing on any refusal.",
		promptSnippet: "Save a workflow run's script as a reusable named workflow",
		parameters: Type.Object({
			run_id: Type.String({
				description: "the wf_ run id returned by the workflow tool",
			}),
			name: Type.String({
				description:
					"the name to save it under (letters, digits, '.', '-', '_')",
			}),
			overwrite: Type.Optional(
				Type.Boolean({
					description: "replace an existing saved workflow of the same name",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const engine = deps.getEngine();
			const directory = deps.directory();
			const result = await saveRunAsWorkflow(
				{ engine, fs, directory },
				{
					runId: coerceId(params.run_id),
					// Do NOT coerce a non-string name — String(undefined) would become the
					// literal "undefined", which passes validation. Empty → refused.
					name: typeof params.name === "string" ? params.name : "",
					overwrite: params.overwrite === true,
				},
			);
			if (!result.ok) return text(result.error);
			return text(
				`Saved run ${coerceId(params.run_id)} as workflow "${result.name}" → ${result.path}. Re-invoke it with the workflow tool: { "name": "${result.name}" }.`,
			);
		},
	});
}
