import { describe, expect, test } from "bun:test";
import type { ToolContext } from "@opencode-ai/plugin";
import type { ProgressEvent, StampedProgressEvent } from "../../runtime/types";
import type {
	AgentSummary,
	RunHandle,
	RunRecord,
	WorkflowEngine,
} from "../engine";
import type { EnrichedProgressEvent } from "../feed";
import type { SessionStatsSnapshot } from "../session-stats";
import {
	createWorkflowStatusTool,
	formatDuration,
	formatTokens,
} from "./workflow-status";

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

describe("createWorkflowStatusTool — CC-style phase-grouped progress render", () => {
	test("phase groups with done/total counters; markers per agent status; narrator below", async () => {
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

		// Phase group headers with done/total counters, first-appearance order.
		expect(out).toMatch(/discover\s+1\/1/);
		// build has 2 occurrences (cached + error); both terminal → 2/2, marked ✗.
		expect(out).toMatch(/✗ build\s+2\/2/);
		// stray has no phase → the unnamed group, still running → 0/1, marked …
		expect(out).toMatch(/… \(no phase\)\s+0\/1/);

		// Agent rows with CC-style markers (✓ done/cached, ✗ failed, … running).
		expect(out).toContain("✓ scout");
		expect(out).toContain("✓ impl-a");
		expect(out).toContain("✗ impl-b");
		expect(out).toContain("… stray");

		// Narrator + warn lines (below the tree).
		expect(out).toContain("log: found 3 targets");
		expect(out).toContain("warn: budget tight");

		// First-appearance order: discover group before build group.
		expect(out.indexOf("discover")).toBeLessThan(out.indexOf("build"));
		// scout (discover) appears before impl-a (build).
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

	test("per-agent duration renders from the enriched durationMs on a done row", async () => {
		// Task 8.1.4/8.1.5: duration is the engine-stamped durationMs on the
		// enriched agent:end, not an in-tool start/end pairing.
		const progress: EnrichedProgressEvent[] = [
			{ type: "agent:start", label: "scout", phase: "discover", at: 1_100 },
			{
				type: "agent:end",
				label: "scout",
				status: "completed",
				at: 9_100,
				durationMs: 8_000,
			} as EnrichedProgressEvent,
		];
		const handle: RunHandle = {
			record: makeRecord({ id: "wf_live0002", createdAt: 1_000 }),
			progress,
			now: () => 10_000,
		};
		const engine = fakeEngine([handle]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_live0002" }, ctx());
		// 8000ms → CC-style "8s" on the scout row.
		expect(out).toContain("✓ scout");
		expect(out).toContain("8s");
	});

	test("a still-running agent shows no per-agent duration (no end yet)", async () => {
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
		expect(out).toContain("… busy");
		// No duration / stats segment on a running row with no live snapshot.
		expect(out).not.toContain("busy  ");
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

	test("repeated labels pair their enriched durationMs FIFO (first-unmatched-start)", async () => {
		// Two occurrences of the same label, each ended with its own enriched
		// durationMs; the FIFO pairing attributes each duration to its own row.
		const progress: EnrichedProgressEvent[] = [
			{ type: "agent:start", label: "dup", phase: "p", at: 1_000 },
			{
				type: "agent:end",
				label: "dup",
				status: "completed",
				at: 6_000,
				durationMs: 5_000,
			} as EnrichedProgressEvent,
			{ type: "agent:start", label: "dup", phase: "p", at: 7_000 },
			{
				type: "agent:end",
				label: "dup",
				status: "completed",
				at: 16_000,
				durationMs: 9_000,
			} as EnrichedProgressEvent,
		];
		const handle: RunHandle = {
			record: makeRecord({ id: "wf_live0005", createdAt: 1_000 }),
			progress,
			now: () => 20_000,
		};
		const engine = fakeEngine([handle]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_live0005" }, ctx());
		// First occurrence 5000ms → "5s", second 9000ms → "9s", in row order.
		expect(out).toContain("5s");
		expect(out).toContain("9s");
		expect(out.indexOf("5s")).toBeLessThan(out.indexOf("9s"));
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

	test("a recovered run with rehydrated record.agents renders the real per-agent table (Phase 3.2.3)", async () => {
		// 3.2.2 rehydrates record.agents from the feed at recovery time. This locks the
		// contract that landing data on record.agents surfaces through the existing
		// settledAgentRows render — with progress:[] and no now/settled/budget views.
		const agents: AgentSummary[] = [
			{
				label: "writer",
				phase: "draft",
				sessionID: "ses_w",
				model: "claude-x",
				agentType: "build",
				status: "completed",
				toolCalls: 2,
				durationMs: 6_000,
				tokens: {
					input: 100,
					output: 200,
					reasoning: 0,
					cacheRead: 0,
					cacheWrite: 0,
				},
			},
			{ label: "verify", phase: "review", status: "cached" },
		];
		const handle: RunHandle = {
			record: makeRecord({
				id: "wf_rehy0001",
				status: "error",
				completedAt: 2_000,
				error:
					"interrupted by restart — agents may have mutated the working tree " +
					"before the interrupt; inspect `git status` before resume or relaunch",
				agentCount: 2,
				agents,
			}),
			progress: [],
		};
		const engine = fakeEngine([handle]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_rehy0001" }, ctx());

		// The real per-agent table renders from record.agents: both labels + phases.
		expect(out).toContain("writer");
		expect(out).toContain("verify");
		expect(out).toContain("draft");
		expect(out).toContain("review");
		// Recovery invariants preserved: the error string renders, no elapsed header,
		// no live-counts line.
		expect(out).toContain("interrupted by restart");
		expect(out).not.toContain("running ");
		expect(out).not.toContain(" running / ");
		// Under option (a): the terminal cached/live tally line is PRESENT and reads
		// 0/0 (handle.progress is empty for a recovered run — the per-agent TABLE is the
		// operator-meaningful artifact, the one-liner is a resume-efficiency stat).
		expect(out).toContain("0 cached / 0 live agent calls");
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

// ───────────────────────────── Task 8.1.5 ─────────────────────────────

describe("formatTokens (Task 8.1.5)", () => {
	test("renders the CC-style human token count", () => {
		expect(formatTokens(999)).toBe("999");
		expect(formatTokens(112_700)).toBe("112.7k");
		expect(formatTokens(1_234_567)).toBe("1.2M");
		// Band edges + the zero case a fresh agent shows.
		expect(formatTokens(0)).toBe("0");
		expect(formatTokens(1000)).toBe("1.0k");
		expect(formatTokens(1_000_000)).toBe("1.0M");
	});
});

describe("formatDuration (Task 8.1.5)", () => {
	test("renders the CC-style spaced duration", () => {
		expect(formatDuration(428_000)).toBe("7m 8s");
		// Sub-minute → bare seconds; sub-hour with no leftover seconds drops `0s`.
		expect(formatDuration(8_000)).toBe("8s");
		expect(formatDuration(120_000)).toBe("2m");
		// Hour band: hours + minutes + seconds, spaced.
		expect(formatDuration(3_661_000)).toBe("1h 1m 1s");
	});
});

/** Build a LIVE enriched progress stream (start/launched/end triples). */
function enriched(events: EnrichedProgressEvent[]): EnrichedProgressEvent[] {
	return events;
}

/** A fake engine whose statsSnapshot serves live numbers for running agents. */
function fakeEngineWithStats(
	handles: RunHandle[],
	snaps: Record<string, SessionStatsSnapshot>,
): WorkflowEngine {
	const runs = new Map<string, RunHandle>();
	for (const h of handles) {
		runs.set(h.record.id, h);
	}
	return {
		runs,
		statusOf: (id: string) => runs.get(id),
		statsSnapshot: (sessionID: string) => snaps[sessionID],
	} as unknown as WorkflowEngine;
}

describe("createWorkflowStatusTool — CC-style agent tree, LIVE run (Task 8.1.5)", () => {
	test("groups agents by phase with a done/total counter and per-agent stat rows", async () => {
		const progress = enriched([
			{ type: "agent:start", label: "impl:a", phase: "Implement", at: 1_000 },
			{
				type: "agent:launched",
				label: "impl:a",
				phase: "Implement",
				sessionID: "ses_a",
				model: "anthropic/claude-opus-4-8",
				agentType: "build",
				at: 1_010,
			},
			{
				type: "agent:end",
				label: "impl:a",
				status: "completed",
				sessionID: "ses_a",
				at: 429_010,
				durationMs: 428_000,
				tokens: {
					input: 100_000,
					output: 12_700,
					reasoning: 0,
					cacheRead: 0,
					cacheWrite: 0,
				},
				toolCalls: 51,
				model: "anthropic/claude-opus-4-8",
			} as EnrichedProgressEvent,
			{ type: "agent:start", label: "impl:b", phase: "Implement", at: 430_000 },
		]);
		const handle: RunHandle = {
			record: makeRecord({ id: "wf_tree0001", createdAt: 1_000 }),
			progress,
			now: () => 500_000,
		};
		const engine = fakeEngineWithStats([handle], {
			// impl:b is still running with a live snapshot.
			ses_b: {
				tokens: {
					input: 5_000,
					output: 1_000,
					reasoning: 0,
					cacheRead: 0,
					cacheWrite: 0,
				},
				toolCalls: 3,
				lastTools: [],
				updatedAt: 450_000,
			},
		});
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_tree0001" }, ctx());

		// Phase header with a done/total counter (1 of 2 done).
		expect(out).toMatch(/Implement\s+1\/2/);
		// Completed row: marker, label, short model, tokens·tools·duration.
		expect(out).toContain("impl:a");
		expect(out).toContain("opus-4-8");
		expect(out).not.toContain("anthropic/"); // provider prefix stripped
		// Epic 1.3: input → output+reasoning split, not one flattened total.
		expect(out).toContain("100.0k→12.7k tok"); // input 100000 → out+reason 12700
		expect(out).toContain("51 tools");
		expect(out).toContain("7m 8s"); // 428000ms
	});

	test("renders the input→output token split (Epic 1.3), not a flattened total", async () => {
		const progress = enriched([
			{ type: "agent:start", label: "ctx", phase: "Load", at: 1_000 },
			{
				type: "agent:launched",
				label: "ctx",
				phase: "Load",
				sessionID: "ses_ctx",
				model: "anthropic/claude-opus-4-8",
				at: 1_010,
			},
			{
				type: "agent:end",
				label: "ctx",
				status: "completed",
				sessionID: "ses_ctx",
				at: 9_010,
				durationMs: 8_000,
				// Big input (repeated context-loading), small output — the #8 case the
				// split exists to make legible.
				tokens: {
					input: 950_000,
					output: 4_000,
					reasoning: 1_000,
					cacheRead: 200_000,
					cacheWrite: 0,
				},
				toolCalls: 2,
				model: "anthropic/claude-opus-4-8",
			} as EnrichedProgressEvent,
		]);
		const handle: RunHandle = {
			record: makeRecord({ id: "wf_split001", createdAt: 1_000 }),
			progress,
			now: () => 20_000,
		};
		const engine = fakeEngineWithStats([handle], {});
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_split001" }, ctx());
		// 950k input → 5k output+reasoning; cache is excluded from the split.
		expect(out).toContain("950.0k→5.0k tok");
		// The old flattened total (1.1M) must NOT appear as the token segment.
		expect(out).not.toContain("1.2M tok");
	});

	test("a running agent pulls live token/tool numbers from the engine snapshot", async () => {
		const progress = enriched([
			{ type: "agent:start", label: "live:b", phase: "Build", at: 1_000 },
			{
				type: "agent:launched",
				label: "live:b",
				phase: "Build",
				sessionID: "ses_b",
				model: "openai/gpt-x",
				at: 1_010,
			},
		]);
		const handle: RunHandle = {
			record: makeRecord({ id: "wf_tree0002", createdAt: 1_000 }),
			progress,
			now: () => 60_000,
		};
		const engine = fakeEngineWithStats([handle], {
			ses_b: {
				tokens: {
					input: 40_000,
					output: 2_000,
					reasoning: 0,
					cacheRead: 0,
					cacheWrite: 0,
				},
				toolCalls: 7,
				lastTools: ["bash(ls)"],
				updatedAt: 50_000,
			},
		});
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_tree0002" }, ctx());
		// Epic 1.3 split: 40000 input → 2000 output; live tool count from the snapshot.
		expect(out).toContain("40.0k→2.0k tok");
		expect(out).toContain("7 tools");
		expect(out).toContain("live:b");
	});

	test("a cached agent renders `cached` in place of stats", async () => {
		const progress = enriched([
			{ type: "agent:start", label: "cheap", phase: "Replay", at: 1_000 },
			{
				type: "agent:end",
				label: "cheap",
				status: "cached",
				at: 1_001,
			},
		]);
		const handle: RunHandle = {
			record: makeRecord({ id: "wf_tree0003", createdAt: 1_000 }),
			progress,
			now: () => 5_000,
		};
		const engine = fakeEngineWithStats([handle], {});
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_tree0003" }, ctx());
		expect(out).toContain("cheap");
		expect(out).toContain("cached");
		// No spurious token/tool stats on a cached row.
		expect(out).not.toContain("tok");
	});

	test("a degrade note still renders under the agent's row", async () => {
		const progress = enriched([
			{ type: "agent:start", label: "reviewer", phase: "Review", at: 1_000 },
			{
				type: "agent:launched",
				label: "reviewer",
				phase: "Review",
				sessionID: "ses_r",
				at: 1_010,
			},
			{
				type: "agent:end",
				label: "reviewer",
				status: "error",
				sessionID: "ses_r",
				at: 2_000,
				durationMs: 990,
				note: "null — schema_invalid: missing 'verdict'; raw 6.3k chars preserved",
			} as EnrichedProgressEvent,
		]);
		const handle: RunHandle = {
			record: makeRecord({ id: "wf_tree0004", createdAt: 1_000 }),
			progress,
			now: () => 5_000,
		};
		const engine = fakeEngineWithStats([handle], {});
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_tree0004" }, ctx());
		expect(out).toContain("schema_invalid");
		const lines = out.split("\n");
		const rowIdx = lines.findIndex((l) => l.includes("reviewer"));
		expect(lines[rowIdx + 1]).toContain("schema_invalid");
	});

	test("agents with no phase fall under a single unnamed group", async () => {
		const progress = enriched([
			{ type: "agent:start", label: "loner", at: 1_000 },
			{ type: "agent:end", label: "loner", status: "completed", at: 2_000 },
		]);
		const handle: RunHandle = {
			record: makeRecord({ id: "wf_tree0005", createdAt: 1_000 }),
			progress,
			now: () => 5_000,
		};
		const engine = fakeEngineWithStats([handle], {});
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_tree0005" }, ctx());
		expect(out).toContain("(no phase)");
		expect(out).toContain("loner");
	});

	test("concurrent same-label agents each bind their OWN model + live stats", async () => {
		// The parallel() case: N agents sharing a label, launched back-to-back before
		// any ends. Each agent:launched must claim a DISTINCT occurrence (not the FIFO
		// head), so both running rows show their own model and their own live snapshot
		// — not the last-launched session's, last-writer-wins onto a shared head row.
		const progress = enriched([
			{ type: "agent:start", label: "worker", phase: "Fan", at: 1_000 },
			{ type: "agent:start", label: "worker", phase: "Fan", at: 1_001 },
			{
				type: "agent:launched",
				label: "worker",
				phase: "Fan",
				sessionID: "ses_1",
				model: "anthropic/claude-opus-4-8",
				at: 1_010,
			},
			{
				type: "agent:launched",
				label: "worker",
				phase: "Fan",
				sessionID: "ses_2",
				model: "anthropic/claude-haiku-4-5",
				at: 1_011,
			},
		]);
		const handle: RunHandle = {
			record: makeRecord({ id: "wf_tree0006", createdAt: 1_000 }),
			progress,
			now: () => 60_000,
		};
		const engine = fakeEngineWithStats([handle], {
			ses_1: {
				tokens: {
					input: 30_000,
					output: 1_000,
					reasoning: 0,
					cacheRead: 0,
					cacheWrite: 0,
				},
				toolCalls: 5,
				lastTools: [],
				updatedAt: 50_000,
			},
			ses_2: {
				tokens: {
					input: 7_000,
					output: 500,
					reasoning: 0,
					cacheRead: 0,
					cacheWrite: 0,
				},
				toolCalls: 2,
				lastTools: [],
				updatedAt: 50_000,
			},
		});
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_tree0006" }, ctx());

		// Both occurrences appear as distinct rows under the phase (2 total, 0 done).
		expect(out).toMatch(/Fan\s+0\/2/);
		// First occurrence: opus model + ses_1 split (30k input → 1k output, 5 tools).
		expect(out).toContain("opus-4-8");
		expect(out).toContain("30.0k→1.0k tok");
		expect(out).toContain("5 tools");
		// Second occurrence: haiku model + ses_2 split (7k input → 500 output, 2 tools)
		// — NOT a duplicate of the first row's model/stats.
		expect(out).toContain("haiku-4-5");
		expect(out).toContain("7.0k→500 tok");
		expect(out).toContain("2 tools");
	});
});

describe("createWorkflowStatusTool — CC-style agent tree, SETTLED run (Task 8.1.5)", () => {
	test("renders purely from RunRecord.agents after restart (no progress events)", async () => {
		const agents: AgentSummary[] = [
			{
				label: "impl:kadm-leaf",
				phase: "Implement",
				sessionID: "ses_1",
				model: "anthropic/claude-opus-4-8",
				agentType: "build",
				status: "completed",
				tokens: {
					input: 100_000,
					output: 12_700,
					reasoning: 0,
					cacheRead: 0,
					cacheWrite: 0,
				},
				toolCalls: 51,
				durationMs: 428_000,
			},
			{
				label: "impl:other",
				phase: "Implement",
				status: "cached",
			},
		];
		const engine = fakeEngineWithStats(
			[
				{
					record: makeRecord({
						id: "wf_set00001",
						status: "completed",
						completedAt: 500_000,
						returnValue: { ok: true },
						agents,
					}),
					// Recovered record: progress is empty, render must come from `agents`.
					progress: [],
				},
			],
			{},
		);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_set00001" }, ctx());
		// Both occurrences are terminal (completed + cached) → 2 of 2 done.
		expect(out).toMatch(/Implement\s+2\/2/);
		expect(out).toContain("impl:kadm-leaf");
		expect(out).toContain("opus-4-8");
		// Epic 1.3 split, rendered from RunRecord.agents after restart.
		expect(out).toContain("100.0k→12.7k tok");
		expect(out).toContain("51 tools");
		expect(out).toContain("7m 8s");
		// The cached sibling renders `cached`, no stats.
		expect(out).toContain("impl:other");
		expect(out).toContain("cached");
		// The result preview survives below the tree.
		expect(out).toContain("result:");
		expect(out).toContain('"ok":true');
	});

	test("a settled record carrying no agents still renders header + result (no tree)", async () => {
		const engine = fakeEngineWithStats(
			[
				{
					record: makeRecord({
						id: "wf_set00002",
						status: "completed",
						completedAt: 2_000,
						returnValue: { ok: 1 },
					}),
					progress: [],
				},
			],
			{},
		);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_set00002" }, ctx());
		expect(out).toContain("completed");
		expect(out).toContain("result:");
	});
});

// ---- Epic 2.1/2.2/2.3/2.4: engine git-truth surfaces ----------------------

describe("createWorkflowStatusTool — engine files changed (Epic 2.1)", () => {
	test("renders the sorted, de-duplicated union separate from the agent self-report", async () => {
		const engine = fakeEngine([
			{
				record: makeRecord({
					id: "wf_fc000001",
					status: "completed",
					completedAt: 2_000,
					returnValue: { filesChanged: ["docs/plans/x.md"] },
					checkpoints: [
						{ sha: "s1", label: "a", paths: ["z.ts", "a.ts"] },
						{ sha: "s2", label: "b", paths: ["b.ts", "a.ts"] },
					],
				}),
				progress: [],
			},
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_fc000001" }, ctx());
		// Agent self-report still shown under result:.
		expect(out).toContain('result: {"filesChanged":["docs/plans/x.md"]}');
		// Engine union: sorted + de-duplicated (a.ts appears once).
		expect(out).toContain("files changed (engine-computed, 3):");
		const fcIdx = out.indexOf("files changed (engine-computed");
		const block = out.slice(fcIdx);
		expect(block).toContain("  a.ts");
		expect(block).toContain("  b.ts");
		expect(block).toContain("  z.ts");
		expect(block.indexOf("a.ts")).toBeLessThan(block.indexOf("b.ts"));
		expect(block.indexOf("b.ts")).toBeLessThan(block.indexOf("z.ts"));
	});

	test("a no-checkpoint run renders no engine files block", async () => {
		const engine = fakeEngine([
			{
				record: makeRecord({
					id: "wf_fc000002",
					status: "completed",
					completedAt: 2_000,
					returnValue: { ok: true },
				}),
				progress: [],
			},
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_fc000002" }, ctx());
		expect(out).not.toContain("files changed (engine-computed");
	});

	test("a failed run still surfaces the engine files block", async () => {
		const engine = fakeEngine([
			{
				record: makeRecord({
					id: "wf_fc000003",
					status: "error",
					completedAt: 2_000,
					error: "boom",
					checkpoints: [{ sha: "s1", label: "a", paths: ["a.ts"] }],
				}),
				progress: [],
			},
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_fc000003" }, ctx());
		expect(out).toContain("files changed (engine-computed, 1):");
		expect(out).toContain("  a.ts");
	});

	test("a mode-flipped path is tagged (mode old→new), others bare (Epic 2.3)", async () => {
		const engine = fakeEngine([
			{
				record: makeRecord({
					id: "wf_fc000004",
					status: "completed",
					completedAt: 2_000,
					returnValue: { ok: true },
					checkpoints: [
						{
							sha: "s1",
							label: "a",
							paths: ["scripts/foo.sh", "src/a.ts"],
							modeFlips: { "scripts/foo.sh": "100644→100755" },
						},
					],
				}),
				progress: [],
			},
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_fc000004" }, ctx());
		expect(out).toContain("  scripts/foo.sh  (mode 100644→100755)");
		expect(out).toContain("  src/a.ts");
		expect(out).not.toContain("src/a.ts  (mode");
	});
});

describe("createWorkflowStatusTool — checkpoint ledger (Epic 2.2)", () => {
	const ledgerRecord = () =>
		makeRecord({
			id: "wf_led00001",
			status: "completed",
			completedAt: 2_000,
			returnValue: { ok: true },
			checkpoints: [
				{ sha: "abcdef1234", label: "agent-a", phase: "1", paths: ["a.ts"] },
				{ label: "agent-b", paths: ["b.ts", "c.ts"] },
			],
		});

	test("under full: one line per commit, sha7/label/phase/file-count; (no sha) when absent", async () => {
		const engine = fakeEngine([{ record: ledgerRecord(), progress: [] }]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_led00001", full: true }, ctx());
		expect(out).toContain("checkpoints (2):");
		expect(out).toContain("  abcdef1 agent-a phase=1 (1 files)");
		expect(out).toContain("  (no sha) agent-b (2 files)");
	});

	test("without full: no checkpoint ledger", async () => {
		const engine = fakeEngine([{ record: ledgerRecord(), progress: [] }]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_led00001" }, ctx());
		expect(out).not.toContain("checkpoints (2):");
	});

	test("a no-checkpoint record shows no ledger even under full", async () => {
		const engine = fakeEngine([
			{
				record: makeRecord({
					id: "wf_led00002",
					status: "completed",
					completedAt: 2_000,
					returnValue: { ok: true },
				}),
				progress: [],
			},
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_led00002", full: true }, ctx());
		expect(out).not.toContain("checkpoints (");
	});
});

describe("createWorkflowStatusTool — no-commit contradiction (Epic 2.2/Issue 4)", () => {
	test("flags a 'no commit' claim contradicted by real checkpoints", async () => {
		const engine = fakeEngine([
			{
				record: makeRecord({
					id: "wf_nc000001",
					status: "completed",
					completedAt: 2_000,
					returnValue: { notes: ["No commit was created, per request."] },
					checkpoints: [
						{ sha: "s1", label: "a", paths: ["a.ts"] },
						{ sha: "s2", label: "b", paths: ["b.ts"] },
					],
				}),
				progress: [],
			},
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_nc000001" }, ctx());
		expect(out).toContain(
			"⚠ result claims no commit, but the engine created 2 checkpoint commit(s)",
		);
	});

	test("no flag when checkpoints absent (the note is true)", async () => {
		const engine = fakeEngine([
			{
				record: makeRecord({
					id: "wf_nc000002",
					status: "completed",
					completedAt: 2_000,
					returnValue: { notes: ["No commit was created, per request."] },
				}),
				progress: [],
			},
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_nc000002" }, ctx());
		expect(out).not.toContain("result claims no commit");
	});

	test("no flag when checkpoints exist but result never says 'no commit'", async () => {
		const engine = fakeEngine([
			{
				record: makeRecord({
					id: "wf_nc000003",
					status: "completed",
					completedAt: 2_000,
					returnValue: { notes: ["committed the fix"] },
					checkpoints: [{ sha: "s1", label: "a", paths: ["a.ts"] }],
				}),
				progress: [],
			},
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_nc000003" }, ctx());
		expect(out).not.toContain("result claims no commit");
	});

	test("undefined returnValue does not throw and does not flag", async () => {
		const engine = fakeEngine([
			{
				record: makeRecord({
					id: "wf_nc000004",
					status: "completed",
					completedAt: 2_000,
					checkpoints: [{ sha: "s1", label: "a", paths: ["a.ts"] }],
				}),
				progress: [],
			},
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_nc000004" }, ctx());
		expect(out).not.toContain("result claims no commit");
	});

	test("'no commitments' does NOT flag — the match is word-bounded (#14)", async () => {
		const engine = fakeEngine([
			{
				record: makeRecord({
					id: "wf_nc000005",
					status: "completed",
					completedAt: 2_000,
					returnValue: {
						notes: ["There are no commitments beyond the SLA in scope."],
					},
					checkpoints: [{ sha: "s1", label: "a", paths: ["a.ts"] }],
				}),
				progress: [],
			},
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_nc000005" }, ctx());
		expect(out).not.toContain("result claims no commit");
	});

	test("'no commits' (plural) still flags", async () => {
		const engine = fakeEngine([
			{
				record: makeRecord({
					id: "wf_nc000006",
					status: "completed",
					completedAt: 2_000,
					returnValue: { notes: ["No commits were made."] },
					checkpoints: [{ sha: "s1", label: "a", paths: ["a.ts"] }],
				}),
				progress: [],
			},
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_nc000006" }, ctx());
		expect(out).toContain("result claims no commit");
	});
});

describe("createWorkflowStatusTool — shared-checkpoint marking (#12)", () => {
	test("a shared checkpoint renders a '(shared)' tag in the ledger", async () => {
		const engine = fakeEngine([
			{
				record: makeRecord({
					id: "wf_sh000001",
					status: "completed",
					completedAt: 2_000,
					returnValue: { ok: true },
					checkpoints: [
						{ sha: "abcdef1234", label: "a", paths: ["a.ts"], shared: true },
						{ sha: "1234567890", label: "b", paths: ["b.ts"] },
					],
				}),
				progress: [],
			},
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_sh000001", full: true }, ctx());
		expect(out).toContain("  abcdef1 a (1 files) (shared)");
		expect(out).toContain("  1234567 b (1 files)");
		expect(out).not.toContain("  1234567 b (1 files) (shared)");
	});
});

describe("createWorkflowStatusTool — source diagnostics (Epic 2.4/Issue 6)", () => {
	test("renders an ignored source-path warning naming the rule", async () => {
		const engine = fakeEngine([
			{
				record: makeRecord({
					id: "wf_sd000001",
					status: "completed",
					completedAt: 2_000,
					returnValue: { ok: true },
					sourceDiagnostics: [
						{
							path: "docs/plans/x.md",
							classification: "ignored",
							rule: ".gitignore:47:docs/plans/",
						},
					],
				}),
				progress: [],
			},
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_sd000001" }, ctx());
		expect(out).toContain("source diagnostics:");
		expect(out).toContain(
			"⚠ docs/plans/x.md is ignored (.gitignore:47:docs/plans/) — not a tracked artifact",
		);
	});

	test("no diagnostics → no block", async () => {
		const engine = fakeEngine([
			{
				record: makeRecord({
					id: "wf_sd000002",
					status: "completed",
					completedAt: 2_000,
					returnValue: { ok: true },
				}),
				progress: [],
			},
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_sd000002" }, ctx());
		expect(out).not.toContain("source diagnostics:");
	});

	test("a 'directory' verdict renders the honest spec-must-be-a-file warning (#14)", async () => {
		const engine = fakeEngine([
			{
				record: makeRecord({
					id: "wf_sd000003",
					status: "completed",
					completedAt: 2_000,
					returnValue: { ok: true },
					sourceDiagnostics: [{ path: "docs", classification: "directory" }],
				}),
				progress: [],
			},
		]);
		const t = createWorkflowStatusTool(engine);
		const out = await run(t, { run_id: "wf_sd000003" }, ctx());
		expect(out).toContain("⚠ docs is a directory, not a file");
		expect(out).not.toContain("docs is directory");
	});
});
