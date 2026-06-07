/**
 * Shared sub-workflow source resolution (Task 4.3.2).
 *
 * The engine builds a {@link createSourceResolver} and threads it into
 * `createWorkflowRun` as `resolveSubWorkflow` (spec §8): the library stays fs-free,
 * the plugin owns the fs + saved-name lookup. The same resolution rules the top-
 * level `workflow` TOOL uses for `name`/`script_path` live here too — a saved name
 * maps to `<dir>/.opencode/workflows/<name>.js|.mjs`; a `{ scriptPath }` ref is read
 * relative to the project directory. Unknown names and unreadable paths REJECT
 * (catchable script errors, spec §8).
 */

import type { FsFacade } from "@drawers/core";

/** The saved-workflow subdirectory under the project directory. */
const WORKFLOWS_SUBDIR = ".opencode/workflows";

export interface SourceResolverDeps {
	/** Project directory — saved-workflow + relative scriptPath resolution root. */
	directory: string;
	/** fs facade; the engine passes its injected one (in-memory in tests). */
	fs: FsFacade;
}

/** Join two path segments with a single separator (no node:path dependency). */
export function joinPath(base: string, rel: string): string {
	const b = base.endsWith("/") ? base.slice(0, -1) : base;
	const r = rel.startsWith("/") ? rel.slice(1) : rel;
	return `${b}/${r}`;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Read a saved workflow by name: try `<dir>/.opencode/workflows/<name>.js`, then
 * `.mjs`. Returns the source or throws a catchable error listing what IS available
 * (mirrors the `workflow` tool's loadSavedWorkflow for a consistent message).
 */
async function loadSavedWorkflow(
	fs: FsFacade,
	wfDir: string,
	name: string,
): Promise<string> {
	for (const ext of [".js", ".mjs"]) {
		try {
			return await fs.readFile(joinPath(wfDir, `${name}${ext}`), "utf-8");
		} catch {
			// Try the next extension.
		}
	}
	let available: string[] = [];
	try {
		available = await fs.readdir(wfDir);
	} catch {
		available = [];
	}
	if (available.length === 0) {
		throw new Error(
			`no workflow named "${name}" — no saved workflows found in ${wfDir}.`,
		);
	}
	throw new Error(
		`no workflow named "${name}". Available: ${available.join(", ")}.`,
	);
}

/** Build a `resolveSubWorkflow` over the project fs + directory (spec §8). */
export function createSourceResolver(
	deps: SourceResolverDeps,
): (nameOrRef: string | { scriptPath: string }) => Promise<string> {
	const { directory, fs } = deps;
	const wfDir = joinPath(directory, WORKFLOWS_SUBDIR);

	return async (nameOrRef) => {
		if (typeof nameOrRef === "string") {
			return loadSavedWorkflow(fs, wfDir, nameOrRef);
		}
		const abs = joinPath(directory, nameOrRef.scriptPath);
		try {
			return await fs.readFile(abs, "utf-8");
		} catch (err) {
			throw new Error(
				`could not read sub-workflow scriptPath ${nameOrRef.scriptPath}: ${errorMessage(err)}`,
			);
		}
	};
}
