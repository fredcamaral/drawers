import { describe, expect, test } from "bun:test";
import type { FsFacade } from "@drawers/core";
import { loadSavedWorkflow } from "./workflow";

/**
 * The top-level `workflow` tool resolves a `name` through its own loader (a
 * second copy of saved-name resolution). Epic 2.2 makes that path honor the
 * built-in registry too, with the SAME built-in-wins precedence as the in-script
 * `workflow()` resolver — so a built-in invoked at the top level resolves without
 * a disk file, and cannot be shadowed by a same-named user file.
 */

function makeFs(initial: Record<string, string> = {}): FsFacade {
	const files = new Map(Object.entries(initial));
	return {
		mkdir: async () => undefined,
		readdir: async () => [...files.keys()],
		readFile: async (path: string) => {
			const f = files.get(path);
			if (f === undefined) {
				const err = new Error("ENOENT") as Error & { code: string };
				err.code = "ENOENT";
				throw err;
			}
			return f;
		},
		writeFile: async () => undefined,
		rename: async () => undefined,
		rm: async () => undefined,
	};
}

const WF_DIR = "/proj/.opencode/workflows";

describe("workflow tool loadSavedWorkflow — built-in precedence", () => {
	const builtins = { "deep-research": "BUILTIN SOURCE" };

	test("a built-in resolves without any disk file", async () => {
		const fs = makeFs({});
		const r = await loadSavedWorkflow(fs, WF_DIR, "deep-research", builtins);
		expect(r).toEqual({ ok: true, source: "BUILTIN SOURCE" });
	});

	test("a built-in shadows a same-named user file", async () => {
		const fs = makeFs({ [`${WF_DIR}/deep-research.js`]: "USER SOURCE" });
		const r = await loadSavedWorkflow(fs, WF_DIR, "deep-research", builtins);
		expect(r).toEqual({ ok: true, source: "BUILTIN SOURCE" });
	});

	test("a name in neither built-ins nor disk still fails with the dir hint", async () => {
		const fs = makeFs({});
		const r = await loadSavedWorkflow(fs, WF_DIR, "ghost", builtins);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("ghost");
	});
});
