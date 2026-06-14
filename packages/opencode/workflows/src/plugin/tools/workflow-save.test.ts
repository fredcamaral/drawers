import { describe, expect, test } from "bun:test";
import type { FsFacade } from "@drawers/core";
import type { WorkflowEngine } from "../engine";
import { saveRunAsWorkflow } from "./workflow-save";

/**
 * Tests for the shared save-a-run core (Epic 4.1). The tool and the TUI
 * control-channel consumer both go through saveRunAsWorkflow, so exercising it
 * directly covers both surfaces' validation + write behavior.
 */

type RecordingFs = FsFacade & { files: Map<string, string> };

function makeFs(initial: Record<string, string> = {}): RecordingFs {
	const files = new Map(Object.entries(initial));
	return {
		files,
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
		writeFile: async (path: string, data: string) => {
			files.set(path, data);
		},
		rename: async () => undefined,
		rm: async () => undefined,
	} as RecordingFs;
}

/** Minimal engine exposing only what saveRunAsWorkflow reads. */
function fakeEngine(opts: {
	runId: string;
	scriptPath: string;
	extraRuns?: string[];
}): WorkflowEngine {
	const ids = [opts.runId, ...(opts.extraRuns ?? [])];
	const runs = new Map(ids.map((id) => [id, {}]));
	return {
		runs,
		statusOf: (id: string) =>
			id === opts.runId
				? ({ record: { scriptPath: opts.scriptPath } } as never)
				: undefined,
	} as unknown as WorkflowEngine;
}

const DIR = "/proj";
const SCRIPT_PATH = "/data/workflow-scripts/wf_1.js";
const VALID =
	'export const meta = { name: "saved", description: "d" }\nreturn 1';
const DEST = "/proj/.opencode/workflows/myflow.js";

describe("saveRunAsWorkflow", () => {
	test("writes a valid run's script to .opencode/workflows/<name>.js", async () => {
		const fs = makeFs({ [SCRIPT_PATH]: VALID });
		const engine = fakeEngine({ runId: "wf_1", scriptPath: SCRIPT_PATH });
		const r = await saveRunAsWorkflow(
			{ engine, fs, directory: DIR },
			{ runId: "wf_1", name: "myflow" },
		);
		expect(r).toEqual({ ok: true, path: DEST, name: "myflow" });
		expect(fs.files.get(DEST)).toBe(VALID);
	});

	test("unknown run_id refuses and lists known runs", async () => {
		const fs = makeFs({ [SCRIPT_PATH]: VALID });
		const engine = fakeEngine({
			runId: "wf_1",
			scriptPath: SCRIPT_PATH,
			extraRuns: ["wf_2"],
		});
		const r = await saveRunAsWorkflow(
			{ engine, fs, directory: DIR },
			{ runId: "wf_404", name: "myflow" },
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("unknown run_id wf_404");
		expect(fs.files.has(DEST)).toBe(false);
	});

	test.each([
		["../escape"],
		[""],
		["a/b"],
		[".."],
	])("a bad name %p refuses and writes nothing", async (badName) => {
		const fs = makeFs({ [SCRIPT_PATH]: VALID });
		const engine = fakeEngine({ runId: "wf_1", scriptPath: SCRIPT_PATH });
		const r = await saveRunAsWorkflow(
			{ engine, fs, directory: DIR },
			{ runId: "wf_1", name: badName },
		);
		expect(r.ok).toBe(false);
		expect([...fs.files.keys()]).toEqual([SCRIPT_PATH]);
	});

	test("a built-in name refuses (would never load)", async () => {
		const fs = makeFs({ [SCRIPT_PATH]: VALID });
		const engine = fakeEngine({ runId: "wf_1", scriptPath: SCRIPT_PATH });
		const r = await saveRunAsWorkflow(
			{ engine, fs, directory: DIR },
			{ runId: "wf_1", name: "deep-research" },
		);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("built-in");
	});

	test("an invalid script source refuses and writes nothing", async () => {
		const fs = makeFs({ [SCRIPT_PATH]: "export const meta = {  // broken" });
		const engine = fakeEngine({ runId: "wf_1", scriptPath: SCRIPT_PATH });
		const r = await saveRunAsWorkflow(
			{ engine, fs, directory: DIR },
			{ runId: "wf_1", name: "myflow" },
		);
		expect(r.ok).toBe(false);
		expect(fs.files.has(DEST)).toBe(false);
	});

	test("an existing file refuses without overwrite, replaces with it", async () => {
		const fs = makeFs({ [SCRIPT_PATH]: VALID, [DEST]: "OLD" });
		const engine = fakeEngine({ runId: "wf_1", scriptPath: SCRIPT_PATH });

		const refused = await saveRunAsWorkflow(
			{ engine, fs, directory: DIR },
			{ runId: "wf_1", name: "myflow" },
		);
		expect(refused.ok).toBe(false);
		expect(fs.files.get(DEST)).toBe("OLD");

		const replaced = await saveRunAsWorkflow(
			{ engine, fs, directory: DIR },
			{ runId: "wf_1", name: "myflow", overwrite: true },
		);
		expect(replaced.ok).toBe(true);
		expect(fs.files.get(DEST)).toBe(VALID);
	});
});
