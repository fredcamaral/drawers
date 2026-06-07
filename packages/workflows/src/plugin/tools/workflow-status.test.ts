import { describe, expect, test } from "bun:test";
import type { ToolContext } from "@opencode-ai/plugin";
import type { ProgressEvent, StampedProgressEvent } from "../../runtime/types";
import type { RunHandle, RunRecord, WorkflowEngine } from "../engine";
import { createWorkflowStatusTool } from "./workflow-status";

/** Stamp a flat list of events at successive `at` offsets (Task 6.2.1 helper). */
function stamp(events: ProgressEvent[], ats: number[]): StampedProgressEvent[] {
	return events.map((e, i) => ({ ...e, at: ats[i] ?? 0 }));
}

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
		// 2500ms → humanized to seconds-with-one-decimal (shared formatter).
		expect(out).toContain("(2.5s)");
	});
});

describe("createWorkflowStatusTool — wait_ms (single-turn settle affordance)", () => {
	test("wait_ms>0 on a LIVE run awaits the handle's settle promise, then re-renders terminal", async () => {
		// A live handle whose settle resolves after a tick, flipping the record.
		const record = makeRecord({ id: "wf_wait0001", status: "running" });
		let resolveSettle: () => void = () => {};
		const handle: RunHandle = {
			record,
			progress: [],
			settled: new Promise<void>((r) => {
				resolveSettle = r;
			}),
		};
		const engine = fakeEngine([handle]);
		const t = createWorkflowStatusTool(engine);

		// Flip + resolve on the next tick (simulating the detached run settling).
		setTimeout(() => {
			record.status = "completed";
			record.completedAt = 3_000;
			record.returnValue = { done: true };
			resolveSettle();
		}, 5);

		const out = await run(t, { run_id: "wf_wait0001", wait_ms: 5_000 }, ctx());
		expect(out).toContain("completed");
		expect(out).toContain('"done":true');
	});

	test("wait_ms times out → renders the still-running snapshot (no throw)", async () => {
		const record = makeRecord({ id: "wf_wait0002", status: "running" });
		const handle: RunHandle = {
			record,
			progress: [],
			// Never resolves within the tiny wait window.
			settled: new Promise<void>(() => {}),
		};
		const engine = fakeEngine([handle]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_wait0002", wait_ms: 10 }, ctx());
		expect(out).toContain("running");
	});

	test("wait_ms coerces a numeric string and caps at 120000", async () => {
		// A terminal run returns immediately regardless of wait_ms; we only assert the
		// coercion path does not throw on a string / oversized value.
		const engine = fakeEngine([
			{
				record: makeRecord({
					id: "wf_wait0003",
					status: "completed",
					completedAt: 2_000,
				}),
				progress: [],
			},
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(
			t,
			{ run_id: "wf_wait0003", wait_ms: "999999999" as unknown as number },
			ctx(),
		);
		expect(out).toContain("completed");
	});

	test("wait_ms ignored when the run is already terminal (no await)", async () => {
		const engine = fakeEngine([
			{
				record: makeRecord({
					id: "wf_wait0004",
					status: "completed",
					completedAt: 2_000,
				}),
				progress: [],
				// No settled promise — a terminal run must not require one.
			},
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_wait0004", wait_ms: 5_000 }, ctx());
		expect(out).toContain("completed");
	});
});

describe("createWorkflowStatusTool — flat chronological progress render", () => {
	test("phase headers inserted on phase change; markers per agent status", async () => {
		const progress = stamp(
			[
				{ type: "agent:start", label: "scout", phase: "discover" },
				{ type: "agent:end", label: "scout", status: "completed" },
				{ type: "log", message: "found 3 targets" },
				{ type: "agent:start", label: "impl-a", phase: "build" },
				{ type: "agent:end", label: "impl-a", status: "cached" },
				{ type: "agent:start", label: "impl-b", phase: "build" },
				{ type: "agent:end", label: "impl-b", status: "error" },
				{ type: "warn", message: "budget tight" },
				{ type: "agent:start", label: "stray" },
			],
			[],
		);
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

describe("createWorkflowStatusTool — agent:end note + empty warning (Task 7.2.1)", () => {
	test("a diagnostic note renders after the agent's marker line", async () => {
		const progress = stamp(
			[
				{ type: "agent:start", label: "reviewer" },
				{
					type: "agent:end",
					label: "reviewer",
					status: "error",
					note: "null — schema_invalid: missing 'verdict'; raw 6.3k chars preserved",
				},
			],
			[1_000, 1_500],
		);
		const engine = fakeEngine([
			{
				record: makeRecord({ id: "wf_note00001", status: "completed" }),
				progress,
			},
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_note00001" }, ctx());
		expect(out).toContain("schema_invalid");
		expect(out).toContain("raw 6.3k chars preserved");
		// The note follows the agent marker line, not a phase header.
		const lines = out.split("\n");
		const markerIdx = lines.findIndex((l) => l.includes("reviewer"));
		expect(lines[markerIdx + 1]).toContain("schema_invalid");
	});

	test("an empty_output note renders the ⚠ empty output warning", async () => {
		const progress = stamp(
			[
				{ type: "agent:start", label: "summarizer" },
				{
					type: "agent:end",
					label: "summarizer",
					status: "completed",
					note: "empty output",
				},
			],
			[1_000, 1_500],
		);
		const engine = fakeEngine([
			{
				record: makeRecord({ id: "wf_empty0001", status: "completed" }),
				progress,
			},
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_empty0001" }, ctx());
		expect(out).toContain("⚠ empty output");
	});

	test("an agent:end with no note renders no extra line", async () => {
		const progress = stamp(
			[
				{ type: "agent:start", label: "clean" },
				{ type: "agent:end", label: "clean", status: "completed" },
			],
			[1_000, 1_500],
		);
		const engine = fakeEngine([
			{
				record: makeRecord({ id: "wf_clean0001", status: "completed" }),
				progress,
			},
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_clean0001" }, ctx());
		expect(out).not.toContain("⚠");
		expect(out).not.toContain("null —");
	});
});

describe("createWorkflowStatusTool — untruncated full result (Task 7.2.2)", () => {
	test("full:true renders the COMPLETE returnValue JSON (no 2000-char cut)", async () => {
		const big = { blob: "x".repeat(5000) };
		const engine = fakeEngine([
			{
				record: makeRecord({
					id: "wf_full00001",
					status: "completed",
					completedAt: 2_000,
					returnValue: big,
				}),
				progress: [],
			},
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_full00001", full: true }, ctx());
		expect(out).toContain(JSON.stringify(big));
		expect(out).not.toContain("(truncated)");
	});

	test("default view still previews at 2000 with the truncation marker", async () => {
		const big = { blob: "x".repeat(5000) };
		const engine = fakeEngine([
			{
				record: makeRecord({
					id: "wf_prev00001",
					status: "completed",
					completedAt: 2_000,
					returnValue: big,
				}),
				progress: [],
			},
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_prev00001" }, ctx());
		expect(out).toContain("(truncated)");
		expect(out).not.toContain(JSON.stringify(big));
	});

	test("full:true renders persisted per-agent diagnostics", async () => {
		const engine = fakeEngine([
			{
				record: makeRecord({
					id: "wf_fdiag0001",
					status: "completed",
					completedAt: 2_000,
					returnValue: { ok: true },
					diagnostics: [
						{
							label: "reviewer",
							index: 0,
							reason: "schema_invalid",
							rawText: "the raw prose the model produced",
							childSessionID: "ses_x",
						},
					],
				}),
				progress: [],
			},
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_fdiag0001", full: true }, ctx());
		expect(out).toContain("diagnostics:");
		expect(out).toContain("reviewer");
		expect(out).toContain("schema_invalid");
		expect(out).toContain("the raw prose the model produced");
	});

	test("a result over 200k chars renders a path trailer, never a silent cut", async () => {
		const huge = { blob: "y".repeat(210_000) };
		const engine = fakeEngine([
			{
				record: makeRecord({
					id: "wf_huge00001",
					status: "completed",
					completedAt: 2_000,
					returnValue: huge,
					scriptPath: "/wf-data/workflow-scripts/wf_huge00001.js",
				}),
				progress: [],
			},
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_huge00001", full: true }, ctx());
		expect(out).toContain("exceeds 200k chars");
		expect(out).toContain("wf_huge00001.json");
	});

	test("full:true works for a terminal persisted record (no live handle fields)", async () => {
		const big = { blob: "z".repeat(4000) };
		const engine = fakeEngine([
			{
				// A recovered/terminal record: no `now`, no `settled`, no `budget`.
				record: makeRecord({
					id: "wf_term00001",
					status: "completed",
					completedAt: 2_000,
					returnValue: big,
				}),
				progress: [],
			},
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_term00001", full: true }, ctx());
		expect(out).toContain(JSON.stringify(big));
	});
});

describe("createWorkflowStatusTool — resume (Task 4.2.2)", () => {
	test("header shows 'resumed from <id>' when the record was resumed", async () => {
		const engine = fakeEngine([
			{
				record: makeRecord({
					id: "wf_res00010",
					status: "running",
					resumedFrom: "wf_prior001",
				}),
				progress: [],
			},
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_res00010" }, ctx());
		expect(out).toContain("resumed from wf_prior001");
	});

	test("terminal run appends 'N cached / M live agent calls' from progress", async () => {
		const progress = stamp(
			[
				{ type: "agent:start", label: "a", phase: "p" },
				{ type: "agent:end", label: "a", status: "cached" },
				{ type: "agent:start", label: "b", phase: "p" },
				{ type: "agent:end", label: "b", status: "cached" },
				{ type: "agent:start", label: "c", phase: "p" },
				{ type: "agent:end", label: "c", status: "completed" },
			],
			[],
		);
		const engine = fakeEngine([
			{
				record: makeRecord({
					id: "wf_counts001",
					status: "completed",
					completedAt: 2_000,
					resumedFrom: "wf_prior002",
					returnValue: { ok: true },
				}),
				progress,
			},
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_counts001" }, ctx());
		// 2 cached, 1 live (completed counts as live, not cached).
		expect(out).toContain("2 cached / 1 live agent calls");
		expect(out).toContain("resumed from wf_prior002");
	});

	test("a non-resumed terminal run still reports cached/live counts", async () => {
		const progress = stamp(
			[
				{ type: "agent:start", label: "a", phase: "p" },
				{ type: "agent:end", label: "a", status: "completed" },
			],
			[],
		);
		const engine = fakeEngine([
			{
				record: makeRecord({
					id: "wf_fresh010",
					status: "completed",
					completedAt: 2_000,
					returnValue: 1,
				}),
				progress,
			},
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_fresh010" }, ctx());
		expect(out).toContain("0 cached / 1 live agent calls");
		expect(out).not.toContain("resumed from");
	});

	test("a running run does NOT append the cached/live tally — placeholder", async () => {
		const progress = stamp(
			[
				{ type: "agent:start", label: "a", phase: "p" },
				{ type: "agent:end", label: "a", status: "cached" },
			],
			[],
		);
		const engine = fakeEngine([
			{ record: makeRecord({ id: "wf_run_old1" }), progress },
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_run_old1" }, ctx());
		expect(out).not.toContain("agent calls");
	});
});

describe("createWorkflowStatusTool — budget line (Task 4.3.1)", () => {
	test("a terminal run with a budget shows spent/total at the settled snapshot", async () => {
		const engine = fakeEngine([
			{
				record: makeRecord({
					id: "wf_bud00001",
					status: "completed",
					completedAt: 2_000,
					returnValue: 1,
					budgetTotal: 1000,
					budgetSpent: 350,
				}),
				progress: [],
			},
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_bud00001" }, ctx());
		expect(out).toContain("budget: 350/1000 output tokens");
	});

	test("a live run reads LIVE spend from the budget view on the handle", async () => {
		const liveBudget = {
			total: 1000,
			spent: () => 120,
			remaining: () => 880,
		};
		const engine = fakeEngine([
			{
				record: makeRecord({ id: "wf_bud00002", budgetTotal: 1000 }),
				progress: [],
				budget: liveBudget,
			},
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_bud00002" }, ctx());
		// Live spend comes from the view (120), not the record's settled snapshot.
		expect(out).toContain("budget: 120/1000 output tokens");
	});

	test("a run with NO budget shows no budget line", async () => {
		const engine = fakeEngine([
			{
				record: makeRecord({
					id: "wf_bud00003",
					status: "completed",
					completedAt: 2_000,
					returnValue: 1,
				}),
				progress: [],
			},
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_bud00003" }, ctx());
		expect(out).not.toContain("budget:");
	});
});

describe("createWorkflowStatusTool — live elapsed + counts (Task 6.2.1)", () => {
	test("a LIVE run with a now() view shows total elapsed in the header", async () => {
		const handle: RunHandle = {
			record: makeRecord({ id: "wf_live0001", createdAt: 1_000 }),
			progress: [],
			// Live clock view: 4200ms past createdAt.
			now: () => 5_200,
		};
		const engine = fakeEngine([handle]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_live0001" }, ctx());
		// Status word then elapsed in parens (no double "running") — 4200ms → "4.2s".
		expect(out).toContain("wf_live0001 — demo workflow — running (4.2s)");
	});

	test("per-agent elapsed renders on a done marker (end.at − start.at)", async () => {
		const progress = stamp(
			[
				{ type: "agent:start", label: "scout", phase: "discover" },
				{ type: "agent:end", label: "scout", status: "completed" },
			],
			[1_100, 1_900],
		);
		const handle: RunHandle = {
			record: makeRecord({ id: "wf_live0002", createdAt: 1_000 }),
			progress,
			now: () => 2_000,
		};
		const engine = fakeEngine([handle]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_live0002" }, ctx());
		// 1900 − 1100 = 800ms on the done line.
		expect(out).toContain("[done] scout (800ms)");
	});

	test("a still-running agent shows no per-agent elapsed (no end to pair)", async () => {
		const progress = stamp(
			[{ type: "agent:start", label: "busy", phase: "p" }],
			[1_100],
		);
		const handle: RunHandle = {
			record: makeRecord({ id: "wf_live0003", createdAt: 1_000 }),
			progress,
			now: () => 3_000,
		};
		const engine = fakeEngine([handle]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_live0003" }, ctx());
		expect(out).toContain("[running] busy");
		expect(out).not.toContain("[running] busy (");
	});

	test("a LIVE run shows a counts line: running / done / failed / cached", async () => {
		const progress = stamp(
			[
				{ type: "agent:start", label: "a", phase: "p" },
				{ type: "agent:end", label: "a", status: "completed" },
				{ type: "agent:start", label: "b", phase: "p" },
				{ type: "agent:end", label: "b", status: "cached" },
				{ type: "agent:start", label: "c", phase: "p" },
				{ type: "agent:end", label: "c", status: "error" },
				{ type: "agent:start", label: "d", phase: "p" },
			],
			[1_100, 1_200, 1_300, 1_400, 1_500, 1_600, 1_700],
		);
		const handle: RunHandle = {
			record: makeRecord({ id: "wf_live0004", createdAt: 1_000 }),
			progress,
			now: () => 2_000,
		};
		const engine = fakeEngine([handle]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_live0004" }, ctx());
		// 1 still running (d), 1 done (a), 1 failed (c), 1 cached (b).
		expect(out).toContain("1 running / 1 done / 1 failed / 1 cached");
	});

	test("repeated labels pair chronologically (first-unmatched-start)", async () => {
		const progress = stamp(
			[
				{ type: "agent:start", label: "dup", phase: "p" },
				{ type: "agent:end", label: "dup", status: "completed" },
				{ type: "agent:start", label: "dup", phase: "p" },
				{ type: "agent:end", label: "dup", status: "completed" },
			],
			[1_000, 1_300, 1_500, 2_100],
		);
		const handle: RunHandle = {
			record: makeRecord({ id: "wf_live0005", createdAt: 1_000 }),
			progress,
			now: () => 3_000,
		};
		const engine = fakeEngine([handle]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_live0005" }, ctx());
		// First pair: 1300−1000=300ms; second: 2100−1500=600ms — in chronological order.
		expect(out).toContain("[done] dup (300ms)");
		expect(out).toContain("[done] dup (600ms)");
		expect(out.indexOf("(300ms)")).toBeLessThan(out.indexOf("(600ms)"));
	});

	test("a recovered run (no now view) renders as today — no elapsed header, no counts line", async () => {
		// Recovered runs are flipped to a terminal status on recovery and carry no
		// live now() view; the live-only surfaces must stay absent.
		const handle: RunHandle = {
			record: makeRecord({
				id: "wf_recov001",
				status: "error",
				completedAt: 2_000,
				error: "interrupted by restart",
			}),
			progress: [],
		};
		const engine = fakeEngine([handle]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_recov001" }, ctx());
		expect(out).not.toContain("running ");
		expect(out).not.toContain(" running / ");
	});
});

describe("createWorkflowStatusTool — live TUI title during wait_ms (Task 6.2.3)", () => {
	/** A fake interval scheduler the test fires manually (no real 1s wall wait). */
	function fakeTimers() {
		const cbs = new Map<number, () => void>();
		let next = 1;
		return {
			cbs,
			setIntervalFn: (cb: () => void): number => {
				const id = next;
				next += 1;
				cbs.set(id, cb);
				return id;
			},
			clearIntervalFn: (id: unknown): void => {
				cbs.delete(id as number);
			},
			/** Fire every live interval callback once. */
			tick: () => {
				for (const cb of cbs.values()) {
					cb();
				}
			},
		};
	}

	/** A ToolContext whose metadata({ title }) calls are captured. */
	function captureCtx(): {
		context: ToolContext;
		titles: string[];
	} {
		const titles: string[] = [];
		const context = {
			sessionID: "ses_parent",
			metadata: (input: { title?: string }) => {
				if (input.title !== undefined) {
					titles.push(input.title);
				}
			},
		} as unknown as ToolContext;
		return { context, titles };
	}

	test("a blocked wait with progress emits a metadata title reflecting live counts", async () => {
		const progress = stamp(
			[
				{ type: "agent:start", label: "a", phase: "Review" },
				{ type: "agent:end", label: "a", status: "completed" },
				{ type: "agent:start", label: "b", phase: "Review" },
			],
			[1_100, 1_500, 1_600],
		);
		let resolveSettle: () => void = () => {};
		const handle: RunHandle = {
			record: makeRecord({
				id: "wf_tui00001",
				description: "review-changes",
				status: "running",
				createdAt: 1_000,
			}),
			progress,
			now: () => 2_000,
			settled: new Promise<void>((r) => {
				resolveSettle = r;
			}),
		};
		const engine = fakeEngine([handle]);
		const timers = fakeTimers();
		const t = createWorkflowStatusTool(engine, {
			setIntervalFn: timers.setIntervalFn,
			clearIntervalFn: timers.clearIntervalFn,
		});
		const { context, titles } = captureCtx();

		// Start the blocked call; fire one tick mid-flight, then settle.
		const pending = (
			t as unknown as {
				execute: (
					a: Record<string, unknown>,
					c: ToolContext,
				) => Promise<unknown>;
			}
		).execute({ run_id: "wf_tui00001", wait_ms: 5_000 }, context);
		// Let the execute body register the interval, then fire it.
		await Promise.resolve();
		timers.tick();
		resolveSettle();
		await pending;

		expect(titles.length).toBeGreaterThan(0);
		const last = titles[titles.length - 1] ?? "";
		// Title carries the name, current phase, done/seen agents, and elapsed.
		expect(last).toContain("review-changes");
		expect(last).toContain("Review");
		expect(last).toContain("1/2");
		await engine.dispose?.();
	});

	test("the interval is always cleared on settle (no leaked timer)", async () => {
		let resolveSettle: () => void = () => {};
		const handle: RunHandle = {
			record: makeRecord({
				id: "wf_tui00002",
				status: "running",
				createdAt: 1_000,
			}),
			progress: [],
			now: () => 2_000,
			settled: new Promise<void>((r) => {
				resolveSettle = r;
			}),
		};
		const engine = fakeEngine([handle]);
		const timers = fakeTimers();
		const t = createWorkflowStatusTool(engine, {
			setIntervalFn: timers.setIntervalFn,
			clearIntervalFn: timers.clearIntervalFn,
		});
		const { context } = captureCtx();

		const pending = (
			t as unknown as {
				execute: (
					a: Record<string, unknown>,
					c: ToolContext,
				) => Promise<unknown>;
			}
		).execute({ run_id: "wf_tui00002", wait_ms: 5_000 }, context);
		await Promise.resolve();
		resolveSettle();
		await pending;
		// Cleared: no live callbacks remain.
		expect(timers.cbs.size).toBe(0);
	});

	test("no interval is registered when wait_ms is 0/absent", async () => {
		const handle: RunHandle = {
			record: makeRecord({
				id: "wf_tui00003",
				status: "running",
				createdAt: 1_000,
			}),
			progress: [],
			now: () => 2_000,
			settled: new Promise<void>(() => {}),
		};
		const engine = fakeEngine([handle]);
		const timers = fakeTimers();
		const t = createWorkflowStatusTool(engine, {
			setIntervalFn: timers.setIntervalFn,
			clearIntervalFn: timers.clearIntervalFn,
		});
		const { context } = captureCtx();
		// No wait_ms → immediate snapshot, no interval ever set.
		await run(t, { run_id: "wf_tui00003" }, context);
		expect(timers.cbs.size).toBe(0);
	});

	test("a metadata throw never escapes (host may not implement it)", async () => {
		let resolveSettle: () => void = () => {};
		const handle: RunHandle = {
			record: makeRecord({
				id: "wf_tui00004",
				status: "running",
				createdAt: 1_000,
			}),
			progress: [],
			now: () => 2_000,
			settled: new Promise<void>((r) => {
				resolveSettle = r;
			}),
		};
		const engine = fakeEngine([handle]);
		const timers = fakeTimers();
		const t = createWorkflowStatusTool(engine, {
			setIntervalFn: timers.setIntervalFn,
			clearIntervalFn: timers.clearIntervalFn,
		});
		const throwingCtx = {
			sessionID: "ses_parent",
			metadata: () => {
				throw new Error("host has no metadata channel");
			},
		} as unknown as ToolContext;

		const pending = (
			t as unknown as {
				execute: (
					a: Record<string, unknown>,
					c: ToolContext,
				) => Promise<unknown>;
			}
		).execute({ run_id: "wf_tui00004", wait_ms: 5_000 }, throwingCtx);
		await Promise.resolve();
		// Firing the tick must not throw despite metadata throwing.
		expect(() => timers.tick()).not.toThrow();
		resolveSettle();
		const out = outputText((await pending) as string | { output: string });
		// Final render still produced.
		expect(out).toContain("wf_tui00004");
		expect(timers.cbs.size).toBe(0);
	});
});

describe("createWorkflowStatusTool — running tally suppression", () => {
	test("a running run does NOT append the cached/live tally", async () => {
		const progress = stamp(
			[
				{ type: "agent:start", label: "a", phase: "p" },
				{ type: "agent:end", label: "a", status: "cached" },
			],
			[],
		);
		const engine = fakeEngine([
			{ record: makeRecord({ id: "wf_running01" }), progress },
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_running01" }, ctx());
		expect(out).not.toContain("agent calls");
	});
});
