import { describe, expect, test } from "bun:test";
import type { FsFacade } from "@drawers/core";
import { createSourceResolver } from "./resolve-source";

/**
 * Tests for the shared sub-workflow source resolver (Task 4.3.2). The engine
 * builds this and threads it into createWorkflowRun as `resolveSubWorkflow`; it
 * mirrors the saved-name / scriptPath resolution the `workflow` tool already does.
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

const DIR = "/proj";

describe("createSourceResolver — saved name", () => {
	test("resolves <dir>/.opencode/workflows/<name>.js", async () => {
		const fs = makeFs({
			"/proj/.opencode/workflows/helper.js": "JS SOURCE",
		});
		const resolve = createSourceResolver({ directory: DIR, fs });
		await expect(resolve("helper")).resolves.toBe("JS SOURCE");
	});

	test("falls back to .mjs", async () => {
		const fs = makeFs({
			"/proj/.opencode/workflows/helper.mjs": "MJS SOURCE",
		});
		const resolve = createSourceResolver({ directory: DIR, fs });
		await expect(resolve("helper")).resolves.toBe("MJS SOURCE");
	});

	test("unknown name rejects with a catchable error naming the name", async () => {
		const fs = makeFs({});
		const resolve = createSourceResolver({ directory: DIR, fs });
		await expect(resolve("ghost")).rejects.toThrow(/ghost/);
	});
});

describe("createSourceResolver — built-in precedence (Epic 2.2)", () => {
	const builtins = { research: "BUILTIN SOURCE" };

	test("a built-in name shadows a saved user file of the same name", async () => {
		const fs = makeFs({
			"/proj/.opencode/workflows/research.js": "USER SOURCE",
		});
		const resolve = createSourceResolver({ directory: DIR, fs, builtins });
		await expect(resolve("research")).resolves.toBe("BUILTIN SOURCE");
	});

	test("a name absent from built-ins still resolves from disk", async () => {
		const fs = makeFs({
			"/proj/.opencode/workflows/helper.js": "USER SOURCE",
		});
		const resolve = createSourceResolver({ directory: DIR, fs, builtins });
		await expect(resolve("helper")).resolves.toBe("USER SOURCE");
	});

	test("a name in neither built-ins nor disk still rejects", async () => {
		const fs = makeFs({});
		const resolve = createSourceResolver({ directory: DIR, fs, builtins });
		await expect(resolve("ghost")).rejects.toThrow(/ghost/);
	});
});

describe("createSourceResolver — scriptPath ref", () => {
	test("resolves { scriptPath } relative to the project directory", async () => {
		const fs = makeFs({ "/proj/flows/x.js": "REF SOURCE" });
		const resolve = createSourceResolver({ directory: DIR, fs });
		await expect(resolve({ scriptPath: "flows/x.js" })).resolves.toBe(
			"REF SOURCE",
		);
	});

	test("unreadable path rejects (catchable)", async () => {
		const fs = makeFs({});
		const resolve = createSourceResolver({ directory: DIR, fs });
		await expect(resolve({ scriptPath: "nope.js" })).rejects.toThrow();
	});

	test("absolute { scriptPath } outside the project dir resolves verbatim", async () => {
		// The `workflow` tool hands the model the persisted ABSOLUTE script path for
		// the iterate/resume loop. An absolute path must be read as-is, NOT re-rooted
		// at the project directory.
		const abs =
			"/Users/x/.local/share/opencode-drawers/workflow-scripts/wf_abc.js";
		const fs = makeFs({ [abs]: "ABS SOURCE" });
		const resolve = createSourceResolver({ directory: DIR, fs });
		await expect(resolve({ scriptPath: abs })).resolves.toBe("ABS SOURCE");
	});
});
