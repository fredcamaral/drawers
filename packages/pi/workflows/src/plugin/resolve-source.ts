/**
 * Shared sub-workflow source resolution (Task 4.3.2, pi port).
 *
 * The engine builds a {@link createSourceResolver} and threads it into
 * `createWorkflowRun` as `resolveSubWorkflow` (spec §8): the library stays fs-free,
 * the plugin owns the fs + saved-name lookup. The same resolution rules the top-
 * level `workflow` TOOL uses for `name`/`script_path` live here too — a saved name
 * maps to `<dir>/.pi/workflows/<name>.js|.mjs`; a `{ scriptPath }` ref is read
 * relative to the project directory. Unknown names and unreadable paths REJECT
 * (catchable script errors, spec §8).
 */

import type { FsFacade } from "@drawers/pi-core";
import { lookupBuiltin } from "./builtins";

/** The saved-workflow subdirectory under the project directory (pi convention). */
const WORKFLOWS_SUBDIR = ".pi/workflows";

export interface SourceResolverDeps {
	/** Project directory — saved-workflow + relative scriptPath resolution root. */
	directory: string;
	/** fs facade; the engine passes its injected one (in-memory in tests). */
	fs: FsFacade;
	/**
	 * Built-in workflow registry (Epic 2.2). A name present here resolves to its
	 * built-in source BEFORE the on-disk lookup, so a built-in wins over a user
	 * file of the same name. The engine passes {@link BUILTIN_WORKFLOWS}; absent
	 * → no built-ins (current behavior). Tests inject a fake registry.
	 */
	builtins?: Record<string, string>;
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
 * Read a saved workflow by name: try `<dir>/.pi/workflows/<name>.js`, then `.mjs`.
 * Returns the source or throws a catchable error listing what IS available
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
	const { directory, fs, builtins } = deps;
	const wfDir = joinPath(directory, WORKFLOWS_SUBDIR);

	return async (nameOrRef) => {
		if (typeof nameOrRef === "string") {
			// Built-in wins over a same-named user file (Epic 2.2).
			const builtin = lookupBuiltin(nameOrRef, builtins);
			if (builtin !== undefined) {
				return builtin;
			}
			return loadSavedWorkflow(fs, wfDir, nameOrRef);
		}
		// An absolute scriptPath (e.g. the persisted path the `workflow` tool hands
		// back for the iterate/resume loop) is used verbatim; relative paths root at
		// the project directory.
		const abs = nameOrRef.scriptPath.startsWith("/")
			? nameOrRef.scriptPath
			: joinPath(directory, nameOrRef.scriptPath);
		try {
			return await fs.readFile(abs, "utf-8");
		} catch (err) {
			throw new Error(
				`could not read sub-workflow scriptPath ${nameOrRef.scriptPath}: ${errorMessage(err)}`,
			);
		}
	};
}
