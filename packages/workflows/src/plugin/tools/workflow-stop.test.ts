import { describe, expect, test } from "bun:test";
import type { FsFacade, IdGenerator } from "@drawers/core";
import type { ToolContext } from "@opencode-ai/plugin";
import {
	createWorkflowEngine,
	type RunHandle,
	type RunRecord,
	type WorkflowEngine,
} from "../engine";
import { createWorkflowStopTool } from "./workflow-stop";

/**
 * Tests for `workflow_stop` (Task 4.1.3). The running→cancelled path drives the
 * REAL engine (so stopRun's record flip is exercised end-to-end); the terminal
 * no-op and unknown-id paths use a minimal fake to pin those render branches.
 */

function basename(path: string): string {
	const i = path.lastIndexOf("/");
	return i === -1 ? path : path.slice(i + 1);
}
function dirname(path: string): string {
	const i = path.lastIndexOf("/");
	return i === -1 ? "" : path.slice(0, i);
}

function makeFs(initial: Record<string, string> = {}) {
	const files = new Map<string, string>(Object.entries(initial));
	const facade: FsFacade = {
		mkdir: async () => undefined,
		readdir: async (dir: string) => {
			const out: string[] = [];
			for (const key of files.keys()) {
				if (dirname(key) === dir) {
					out.push(basename(key));
				}
			}
			return out;
		},
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
		rm: async (path: string) => {
			files.delete(path);
		},
	};
	return { facade };
}

function makeClient() {
	return {
		session: {
			create: async () => ({ data: { id: "ses_child" } }),
			promptAsync: async () => undefined,
			abort: async () => undefined,
			messages: async () => ({ data: [] }),
			get: async () => ({ data: { id: "ses_child" } }),
		},
	};
}

const noopLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

function fixedIds(...ids: string[]): IdGenerator {
	let i = 0;
	return {
		next: () => {
			const id = ids[i] ?? `wf_overflow${i}`;
			i += 1;
			return id;
		},
	};
}

const META = `export const meta = { name: "demo", description: "d" };\n`;
const HANGING = `${META}await agent("do work");\nreturn "done";\n`;

function makeRecord(over: Partial<RunRecord> = {}): RunRecord {
	return {
		id: "wf_test0001",
		parentSessionID: "ses_parent",
		status: "running",
		description: "demo workflow",
		createdAt: 1_000,
		scriptPath: "/wf-data/workflow-scripts/wf_test0001.js",
		...over,
	};
}

function fakeEngine(handles: RunHandle[]): WorkflowEngine {
	const runs = new Map<string, RunHandle>();
	for (const h of handles) {
		runs.set(h.record.id, h);
	}
	return {
		runs,
		statusOf: (id: string) => runs.get(id),
		stopRun: () => {
			throw new Error("stopRun should not be called for terminal/unknown");
		},
	} as unknown as WorkflowEngine;
}

const ctx = () => ({ sessionID: "ses_parent" }) as unknown as ToolContext;

/** Resolve a ToolResult (string | object) to its output text. */
function outputText(result: string | { output: string }): string {
	return typeof result === "string" ? result : result.output;
}

/** Invoke the tool and coerce its result to the output string. */
async function run(
	// biome-ignore lint/suspicious/noExplicitAny: tool() execute is generically typed per its arg schema.
	t: { execute: (...a: any[]) => Promise<unknown> },
	args: Record<string, unknown>,
	c: ToolContext,
): Promise<string> {
	return outputText((await t.execute(args, c)) as string | { output: string });
}

describe("createWorkflowStopTool — running → cancelled", () => {
	test("stops a live run and confirms cancellation", async () => {
		const { facade } = makeFs();
		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: "/wf-data",
			fs: facade,
			clock: { now: () => 1_000_000 },
			logger: noopLogger,
			ids: fixedIds("wf_stop0001"),
		});

		const handle = await engine.startRun({
			source: HANGING,
			parentSessionID: "ses_parent",
		});
		expect(engine.statusOf(handle.runId)?.record.status).toBe("running");

		const t = createWorkflowStopTool(engine);
		const out = await run(t, { run_id: handle.runId }, ctx());

		expect(out.toLowerCase()).toContain("cancelled");
		expect(out).toContain(handle.runId);
		expect(engine.statusOf(handle.runId)?.record.status).toBe("cancelled");

		await engine.dispose();
	});
});

describe("createWorkflowStopTool — terminal no-op", () => {
	test("already-completed run → reports status, no stopRun", async () => {
		const engine = fakeEngine([
			{
				record: makeRecord({ id: "wf_done0001", status: "completed" }),
				progress: [],
			},
		]);
		const t = createWorkflowStopTool(engine);
		const out = await run(t, { run_id: "wf_done0001" }, ctx());
		expect(out).toContain("wf_done0001");
		expect(out).toContain("completed");
		expect(out.toLowerCase()).toContain("already");
	});
});

describe("createWorkflowStopTool — unknown id", () => {
	test("lists known runIds", async () => {
		const engine = fakeEngine([
			{ record: makeRecord({ id: "wf_a0000001" }), progress: [] },
		]);
		const t = createWorkflowStopTool(engine);
		const out = await run(t, { run_id: "wf_missing" }, ctx());
		expect(out).toContain("wf_missing");
		expect(out).toContain("wf_a0000001");
	});

	test("coerces non-string run_id", async () => {
		const engine = fakeEngine([]);
		const t = createWorkflowStopTool(engine);
		const out = await run(t, { run_id: 999 as unknown as string }, ctx());
		expect(out).toContain("999");
	});
});
