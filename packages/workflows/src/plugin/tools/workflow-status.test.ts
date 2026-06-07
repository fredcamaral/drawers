import { describe, expect, test } from "bun:test";
import type { ToolContext } from "@opencode-ai/plugin";
import type { ProgressEvent } from "../../runtime/types";
import type { RunHandle, RunRecord, WorkflowEngine } from "../engine";
import { createWorkflowStatusTool } from "./workflow-status";

/**
 * Tests for `workflow_status` (Task 4.1.3). The render is a pure function of the
 * run handle (record + progress), so these drive a MINIMAL fake engine exposing
 * only `runs`/`statusOf` — the render contract is what is under test, not the
 * engine wiring (that is covered by engine.test.ts).
 */

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

describe("createWorkflowStatusTool — unknown id", () => {
	test("lists known runIds", async () => {
		const engine = fakeEngine([
			{ record: makeRecord({ id: "wf_known001" }), progress: [] },
			{ record: makeRecord({ id: "wf_known002" }), progress: [] },
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_nope" }, ctx());
		expect(out).toContain("wf_nope");
		expect(out).toContain("wf_known001");
		expect(out).toContain("wf_known002");
	});

	test("coerces non-string run_id", async () => {
		const engine = fakeEngine([]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: 123 as unknown as string }, ctx());
		expect(out).toContain("123");
	});
});

describe("createWorkflowStatusTool — header", () => {
	test("running header has no durationMs", async () => {
		const engine = fakeEngine([
			{ record: makeRecord({ id: "wf_run00001" }), progress: [] },
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_run00001" }, ctx());
		expect(out).toContain("wf_run00001 — demo workflow — running");
		expect(out).not.toContain("ms");
	});

	test("terminal header includes durationMs", async () => {
		const engine = fakeEngine([
			{
				record: makeRecord({
					id: "wf_done0001",
					status: "completed",
					createdAt: 1_000,
					completedAt: 3_500,
					returnValue: { ok: true },
				}),
				progress: [],
			},
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_done0001" }, ctx());
		expect(out).toContain("completed");
		expect(out).toContain("2500ms");
	});
});

describe("createWorkflowStatusTool — flat chronological progress render", () => {
	test("phase headers inserted on phase change; markers per agent status", async () => {
		const progress: ProgressEvent[] = [
			{ type: "agent:start", label: "scout", phase: "discover" },
			{ type: "agent:end", label: "scout", status: "completed" },
			{ type: "log", message: "found 3 targets" },
			{ type: "agent:start", label: "impl-a", phase: "build" },
			{ type: "agent:end", label: "impl-a", status: "cached" },
			{ type: "agent:start", label: "impl-b", phase: "build" },
			{ type: "agent:end", label: "impl-b", status: "error" },
			{ type: "warn", message: "budget tight" },
			{ type: "agent:start", label: "stray" },
		];
		const engine = fakeEngine([
			{ record: makeRecord({ id: "wf_prog0001" }), progress },
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_prog0001" }, ctx());

		// Phase headers, first-appearance order.
		expect(out).toContain("discover");
		expect(out).toContain("build");
		expect(out).toContain("(no phase)");

		// Markers.
		expect(out).toContain("[done] scout");
		expect(out).toContain("[cached] impl-a");
		expect(out).toContain("[failed] impl-b");
		// start without end → running.
		expect(out).toContain("[running] stray");

		// Narrator + warn lines.
		expect(out).toContain("log: found 3 targets");
		expect(out).toContain("warn: budget tight");

		// Chronological: build header appears after discover.
		expect(out.indexOf("discover")).toBeLessThan(out.indexOf("build"));
		// scout (done) appears before impl-a (build).
		expect(out.indexOf("scout")).toBeLessThan(out.indexOf("impl-a"));
	});
});

describe("createWorkflowStatusTool — tail", () => {
	test("completed renders result JSON", async () => {
		const engine = fakeEngine([
			{
				record: makeRecord({
					id: "wf_res00001",
					status: "completed",
					completedAt: 2_000,
					returnValue: { answer: 42 },
				}),
				progress: [],
			},
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_res00001" }, ctx());
		expect(out).toContain("result:");
		expect(out).toContain('"answer":42');
	});

	test("result truncated at 2000 chars with marker", async () => {
		const big = { blob: "x".repeat(5000) };
		const engine = fakeEngine([
			{
				record: makeRecord({
					id: "wf_big00001",
					status: "completed",
					completedAt: 2_000,
					returnValue: big,
				}),
				progress: [],
			},
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_big00001" }, ctx());
		expect(out).toContain("(truncated)");
		// The JSON.stringify head is capped at 2000 chars.
		const full = JSON.stringify(big);
		expect(out).not.toContain(full);
	});

	test("error renders error message", async () => {
		const engine = fakeEngine([
			{
				record: makeRecord({
					id: "wf_err00001",
					status: "error",
					completedAt: 2_000,
					error: "boom happened",
				}),
				progress: [],
			},
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_err00001" }, ctx());
		expect(out).toContain("error: boom happened");
	});
});
