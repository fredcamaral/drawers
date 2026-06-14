import { describe, expect, test } from "bun:test";
import type { FeedEvent } from "../plugin/feed";
import {
	createRunStateReducer,
	parseFeedLine,
	type RunViewState,
	summarize,
} from "./reducer";

/**
 * Tests for the feed parser + run-state reducer (Task 8.3.1). The reducer is a
 * pure fold over already-parsed `FeedEvent[]` — no clock, no io — so every test
 * hand-builds a feed and asserts the resulting model. The pairing rules MIRROR
 * `workflow-status.ts` exactly so the on-disk feed view and the in-memory handle
 * view agree (concurrent same-label agents keep their own sessionID-bound stats).
 */

/** Reduce a feed in file order and return the final view state. */
function reduce(events: FeedEvent[]): RunViewState {
	const reducer = createRunStateReducer();
	for (const e of events) {
		reducer.apply(e);
	}
	return reducer.state();
}

describe("parseFeedLine", () => {
	test("parses each FeedEvent member to its typed event", () => {
		const lines: FeedEvent[] = [
			{
				type: "run:start",
				runId: "wf_1",
				parentSessionID: "ses_p",
				name: "demo",
				at: 1,
			},
			{ type: "agent:start", label: "impl", phase: "build", at: 2 },
			{
				type: "agent:launched",
				label: "impl",
				phase: "build",
				sessionID: "ses_a",
				model: "anthropic/claude-opus-4-8",
				agentType: "build",
				at: 3,
			},
			{
				type: "agent:stats",
				label: "impl",
				sessionID: "ses_a",
				tokens: {
					input: 10,
					output: 2,
					reasoning: 0,
					cacheRead: 0,
					cacheWrite: 0,
				},
				toolCalls: 1,
				lastTools: ["read(foo.ts)"],
				at: 4,
			},
			{
				type: "agent:end",
				label: "impl",
				status: "completed",
				sessionID: "ses_a",
				at: 5,
			},
			{ type: "run:cancel-requested", runId: "wf_1", at: 6 },
			{ type: "run:end", status: "completed", at: 7 },
			{ type: "log", message: "hi", at: 8 },
			{ type: "warn", message: "careful", at: 9 },
		];
		for (const line of lines) {
			expect(parseFeedLine(JSON.stringify(line))).toEqual(line);
		}
	});

	test("returns undefined for a truncated half-line", () => {
		const full = JSON.stringify({
			type: "run:start",
			runId: "wf_1",
			parentSessionID: "ses_p",
			at: 1,
		});
		const half = full.slice(0, Math.floor(full.length / 2));
		expect(parseFeedLine(half)).toBeUndefined();
	});

	test("returns undefined for an unknown type", () => {
		expect(
			parseFeedLine(JSON.stringify({ type: "something:else" })),
		).toBeUndefined();
	});

	test("returns undefined for a missing/non-string type", () => {
		expect(parseFeedLine(JSON.stringify({ at: 1 }))).toBeUndefined();
		expect(parseFeedLine(JSON.stringify({ type: 42 }))).toBeUndefined();
	});

	test("returns undefined for non-JSON and for a JSON non-object", () => {
		expect(parseFeedLine("{not json")).toBeUndefined();
		expect(parseFeedLine("42")).toBeUndefined();
		expect(parseFeedLine("null")).toBeUndefined();
		expect(parseFeedLine('"a string"')).toBeUndefined();
	});
});

describe("createRunStateReducer — prompt preview", () => {
	test("agent:start promptPreview lands on the agent's prompt", () => {
		const state = reduce([
			{
				type: "run:start",
				runId: "wf_p",
				parentSessionID: "ses_parent",
				at: 1,
			},
			{
				type: "agent:start",
				label: "survey",
				phase: "Survey",
				promptPreview: "survey the repo and report",
				at: 2,
			},
			{
				type: "agent:launched",
				label: "survey",
				phase: "Survey",
				sessionID: "ses_a",
				at: 3,
			},
		]);
		const agent = state.phases[0]?.agents[0];
		expect(agent?.prompt).toBe("survey the repo and report");
	});

	test("an agent:start without promptPreview leaves prompt undefined", () => {
		const state = reduce([
			{
				type: "run:start",
				runId: "wf_p",
				parentSessionID: "ses_parent",
				at: 1,
			},
			{ type: "agent:start", label: "x", phase: "P", at: 2 },
		]);
		expect(state.phases[0]?.agents[0]?.prompt).toBeUndefined();
	});
});

describe("createRunStateReducer — conclusion (agent:end result)", () => {
	test("agent:end result lands on the agent as the step conclusion", () => {
		const state = reduce([
			{
				type: "run:start",
				runId: "wf_r",
				parentSessionID: "ses_parent",
				at: 1,
			},
			{ type: "agent:start", label: "review", phase: "Review", at: 2 },
			{
				type: "agent:launched",
				label: "review",
				phase: "Review",
				sessionID: "ses_a",
				at: 3,
			},
			{
				type: "agent:end",
				label: "review",
				status: "completed",
				sessionID: "ses_a",
				result: '{"status":"completed","summary":"phase 4 is safe to start"}',
				at: 4,
			} as FeedEvent,
		]);
		expect(state.phases[0]?.agents[0]?.result).toBe(
			'{"status":"completed","summary":"phase 4 is safe to start"}',
		);
	});

	test("a cached end carries its frozen conclusion forward", () => {
		const state = reduce([
			{
				type: "run:start",
				runId: "wf_r",
				parentSessionID: "ses_parent",
				at: 1,
			},
			{ type: "agent:start", label: "cached", phase: "P", at: 2 },
			{
				type: "agent:end",
				label: "cached",
				status: "cached",
				result: "replayed conclusion",
				at: 3,
			} as FeedEvent,
		]);
		const agent = state.phases[0]?.agents[0];
		expect(agent?.status).toBe("cached");
		expect(agent?.result).toBe("replayed conclusion");
	});

	test("an agent:end without result leaves the conclusion undefined", () => {
		const state = reduce([
			{
				type: "run:start",
				runId: "wf_r",
				parentSessionID: "ses_parent",
				at: 1,
			},
			{ type: "agent:start", label: "x", phase: "P", at: 2 },
			{
				type: "agent:launched",
				label: "x",
				phase: "P",
				sessionID: "ses_x",
				at: 3,
			},
			{
				type: "agent:end",
				label: "x",
				status: "completed",
				sessionID: "ses_x",
				at: 4,
			} as FeedEvent,
		]);
		expect(state.phases[0]?.agents[0]?.result).toBeUndefined();
	});
});

describe("createRunStateReducer — full multi-phase feed", () => {
	const tokens = (over: Partial<Record<string, number>> = {}) => ({
		input: 0,
		output: 0,
		reasoning: 0,
		cacheRead: 0,
		cacheWrite: 0,
		...over,
	});

	const feed: FeedEvent[] = [
		{ type: "run:start", runId: "wf_run", parentSessionID: "ses_p", at: 100 },
		// Phase "build": one live agent + one cached agent.
		{ type: "agent:start", label: "impl", phase: "build", at: 110 },
		{
			type: "agent:launched",
			label: "impl",
			phase: "build",
			sessionID: "ses_impl",
			model: "anthropic/claude-opus-4-8",
			agentType: "build",
			at: 120,
		},
		{
			type: "agent:stats",
			label: "impl",
			sessionID: "ses_impl",
			tokens: tokens({ input: 50, output: 10 }),
			toolCalls: 2,
			lastTools: ["read(a.ts)", "edit(a.ts)"],
			at: 130,
		},
		{
			type: "agent:end",
			label: "impl",
			status: "completed",
			sessionID: "ses_impl",
			durationMs: 80,
			tokens: tokens({ input: 60, output: 12, reasoning: 1 }),
			toolCalls: 3,
			model: "anthropic/claude-opus-4-8",
			agentType: "build",
			at: 200,
		} as FeedEvent,
		// A cached end (no sessionID, no stats).
		{ type: "agent:start", label: "cachedwork", phase: "build", at: 205 },
		{ type: "agent:end", label: "cachedwork", status: "cached", at: 206 },
		// Phase "review": one live agent.
		{ type: "agent:start", label: "review", phase: "review", at: 210 },
		{
			type: "agent:launched",
			label: "review",
			phase: "review",
			sessionID: "ses_review",
			model: "anthropic/claude-sonnet-4-5",
			agentType: "review",
			at: 220,
		},
		{
			type: "agent:end",
			label: "review",
			status: "completed",
			sessionID: "ses_review",
			durationMs: 40,
			tokens: tokens({ input: 30, output: 5 }),
			toolCalls: 1,
			model: "anthropic/claude-sonnet-4-5",
			agentType: "review",
			at: 260,
		} as FeedEvent,
		{ type: "run:end", status: "completed", at: 300 },
	];

	test("sets runId/startedAt/endedAt and terminal status", () => {
		const s = reduce(feed);
		expect(s.runId).toBe("wf_run");
		expect(s.startedAt).toBe(100);
		expect(s.endedAt).toBe(300);
		expect(s.status).toBe("completed");
	});

	test("carries the run:start name onto the view state", () => {
		const s = reduce([
			{
				type: "run:start",
				runId: "wf_named",
				parentSessionID: "ses_p",
				name: "My Workflow",
				at: 100,
			},
		]);
		expect(s.name).toBe("My Workflow");
	});

	test("degrades to undefined name on an old feed lacking it (view falls back to runId)", () => {
		// Existing fixtures never carry `name` — the reducer must not invent one.
		const s = reduce(feed);
		expect(s.name).toBeUndefined();
		// startedAt is still derived from run:start.at (the view's relative-age anchor).
		expect(s.startedAt).toBe(100);
	});

	test("groups agents by phase with first-appearance order", () => {
		const s = reduce(feed);
		expect(s.phases.map((p) => p.name)).toEqual(["build", "review"]);
	});

	test("computes phase done/total/marker", () => {
		const s = reduce(feed);
		const build = s.phases[0];
		const review = s.phases[1];
		expect(build?.total).toBe(2);
		expect(build?.done).toBe(2);
		expect(build?.marker).toBe("✓");
		expect(review?.total).toBe(1);
		expect(review?.done).toBe(1);
		expect(review?.marker).toBe("✓");
	});

	test("closes the live agent with enriched duration and summed tokens", () => {
		const s = reduce(feed);
		const impl = s.phases[0]?.agents.find((a) => a.label === "impl");
		expect(impl?.status).toBe("completed");
		expect(impl?.durationMs).toBe(80);
		expect(impl?.model).toBe("anthropic/claude-opus-4-8");
		expect(impl?.sessionID).toBe("ses_impl");
		// 60 + 12 + 1 + 0 + 0 (the enriched end's snapshot, summed).
		expect(impl?.tokens).toBe(73);
		expect(impl?.toolCalls).toBe(3);
	});

	test("renders a cached end with no stats", () => {
		const s = reduce(feed);
		const cached = s.phases[0]?.agents.find((a) => a.label === "cachedwork");
		expect(cached?.status).toBe("cached");
		expect(cached?.tokens).toBeUndefined();
		expect(cached?.sessionID).toBeUndefined();
	});
});

describe("createRunStateReducer — state() yields fresh AgentView snapshots", () => {
	// The route renders agents through Solid's <For>, which memoizes per item
	// REFERENCE. If state() reused the same AgentView object across calls, an agent
	// whose stats/status changed in place would keep its object identity and the row
	// would freeze (the Epic's live-update headline). state() must return a NEW
	// AgentView object on each call so identity changes drive a re-render.
	test("a re-read after an in-place mutation returns a new AgentView identity with the new values", () => {
		const reducer = createRunStateReducer();
		reducer.apply({
			type: "run:start",
			runId: "wf_live",
			parentSessionID: "ses_p",
			at: 1,
		});
		reducer.apply({
			type: "agent:start",
			label: "impl",
			phase: "build",
			at: 10,
		});
		reducer.apply({
			type: "agent:launched",
			label: "impl",
			phase: "build",
			sessionID: "ses_impl",
			model: "anthropic/claude-opus-4-8",
			at: 20,
		});

		const before = reducer.state().phases[0]?.agents[0];
		expect(before?.status).toBeUndefined();
		expect(before?.tokens).toBeUndefined();

		// A live stats line mutates the occurrence in place internally.
		reducer.apply({
			type: "agent:stats",
			label: "impl",
			sessionID: "ses_impl",
			tokens: {
				input: 40,
				output: 8,
				reasoning: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			toolCalls: 2,
			lastTools: ["read(z.ts)"],
			at: 30,
		});

		const after = reducer.state().phases[0]?.agents[0];
		// Identity must change so <For> re-renders the row.
		expect(after).not.toBe(before);
		// And the snapshot must carry the new live values.
		expect(after?.tokens).toBe(48);
		expect(after?.toolCalls).toBe(2);
		// The earlier snapshot stays frozen (it is a copy, not the live object).
		expect(before?.tokens).toBeUndefined();
	});

	test("each state() call returns distinct AgentView objects even with no change", () => {
		const reducer = createRunStateReducer();
		reducer.apply({
			type: "run:start",
			runId: "wf_id",
			parentSessionID: "ses_p",
			at: 1,
		});
		reducer.apply({ type: "agent:start", label: "a", phase: "p", at: 2 });
		const first = reducer.state().phases[0]?.agents[0];
		const second = reducer.state().phases[0]?.agents[0];
		expect(first).not.toBe(second);
		expect(first).toEqual(second);
	});
});

describe("createRunStateReducer — concurrent same-label agents", () => {
	const tokens = (input: number) => ({
		input,
		output: 0,
		reasoning: 0,
		cacheRead: 0,
		cacheWrite: 0,
	});

	test("each occurrence retains its OWN sessionID-bound stats", () => {
		const feed: FeedEvent[] = [
			{ type: "run:start", runId: "wf_c", parentSessionID: "ses_p", at: 1 },
			{ type: "agent:start", label: "rev", phase: "fan", at: 10 },
			{ type: "agent:start", label: "rev", phase: "fan", at: 11 },
			{
				type: "agent:launched",
				label: "rev",
				phase: "fan",
				sessionID: "ses_1",
				model: "m1",
				at: 12,
			},
			{
				type: "agent:launched",
				label: "rev",
				phase: "fan",
				sessionID: "ses_2",
				model: "m2",
				at: 13,
			},
			{
				type: "agent:stats",
				label: "rev",
				sessionID: "ses_2",
				tokens: tokens(200),
				toolCalls: 9,
				lastTools: ["grep(x)"],
				at: 14,
			},
			{
				type: "agent:stats",
				label: "rev",
				sessionID: "ses_1",
				tokens: tokens(100),
				toolCalls: 4,
				lastTools: ["read(y)"],
				at: 15,
			},
			// Ends arrive in COMPLETION order (ses_2 first), each carrying its sessionID.
			{
				type: "agent:end",
				label: "rev",
				status: "completed",
				sessionID: "ses_2",
				durationMs: 50,
				tokens: tokens(220),
				toolCalls: 10,
				at: 60,
			} as FeedEvent,
			{
				type: "agent:end",
				label: "rev",
				status: "completed",
				sessionID: "ses_1",
				durationMs: 90,
				tokens: tokens(110),
				toolCalls: 5,
				at: 100,
			} as FeedEvent,
			{ type: "run:end", status: "completed", at: 200 },
		];
		const s = reduce(feed);
		const agents = s.phases[0]?.agents ?? [];
		expect(agents.length).toBe(2);
		const bySession = new Map(agents.map((a) => [a.sessionID, a]));
		expect(bySession.get("ses_1")?.model).toBe("m1");
		expect(bySession.get("ses_1")?.tokens).toBe(110);
		expect(bySession.get("ses_1")?.toolCalls).toBe(5);
		expect(bySession.get("ses_1")?.durationMs).toBe(90);
		expect(bySession.get("ses_2")?.model).toBe("m2");
		expect(bySession.get("ses_2")?.tokens).toBe(220);
		expect(bySession.get("ses_2")?.toolCalls).toBe(10);
		expect(bySession.get("ses_2")?.durationMs).toBe(50);
	});
});

describe("createRunStateReducer — cancel-requested then terminal", () => {
	test("flips to cancelling, then settles to the terminal status", () => {
		const reducer = createRunStateReducer();
		reducer.apply({
			type: "run:start",
			runId: "wf_x",
			parentSessionID: "ses_p",
			at: 1,
		});
		reducer.apply({ type: "agent:start", label: "a", phase: "p", at: 2 });
		reducer.apply({ type: "run:cancel-requested", runId: "wf_x", at: 3 });
		expect(reducer.state().status).toBe("cancelling");
		reducer.apply({ type: "run:end", status: "cancelled", at: 4 });
		expect(reducer.state().status).toBe("cancelled");
		expect(reducer.state().endedAt).toBe(4);
	});
});

describe("createRunStateReducer — failure path (✗ marker + error terminal)", () => {
	// The reducer is the core of a live-observability viewer; surfacing failures is its
	// job. A phase with one failed and one completed sibling must read ✗ (any-failed
	// dominates), the failed occurrence keeps status "error", the failure counts as a
	// terminal occurrence in done, and a run:end status "error" settles the run "error".
	test("a failed agent among a completed sibling marks the phase ✗ and the run error", () => {
		const tokens = (input: number) => ({
			input,
			output: 0,
			reasoning: 0,
			cacheRead: 0,
			cacheWrite: 0,
		});
		const feed: FeedEvent[] = [
			{ type: "run:start", runId: "wf_err", parentSessionID: "ses_p", at: 1 },
			{ type: "agent:start", label: "ok", phase: "build", at: 10 },
			{
				type: "agent:launched",
				label: "ok",
				phase: "build",
				sessionID: "ses_ok",
				model: "anthropic/claude-opus-4-8",
				at: 11,
			},
			{ type: "agent:start", label: "boom", phase: "build", at: 12 },
			{
				type: "agent:launched",
				label: "boom",
				phase: "build",
				sessionID: "ses_boom",
				model: "anthropic/claude-opus-4-8",
				at: 13,
			},
			{
				type: "agent:end",
				label: "ok",
				status: "completed",
				sessionID: "ses_ok",
				durationMs: 50,
				tokens: tokens(30),
				toolCalls: 1,
				at: 60,
			} as FeedEvent,
			{
				type: "agent:end",
				label: "boom",
				status: "error",
				sessionID: "ses_boom",
				note: "boom failed",
				durationMs: 20,
				at: 70,
			} as FeedEvent,
			{ type: "run:end", status: "error", at: 100 },
		];
		const s = reduce(feed);
		expect(s.status).toBe("error");
		expect(s.endedAt).toBe(100);
		const build = s.phases[0];
		expect(build?.name).toBe("build");
		// Both occurrences are terminal (one ok, one error) → done counts both.
		expect(build?.done).toBe(2);
		expect(build?.total).toBe(2);
		// Any-failed dominates the phase marker even with a completed sibling.
		expect(build?.marker).toBe("✗");
		const boom = build?.agents.find((a) => a.label === "boom");
		expect(boom?.status).toBe("error");
		expect(boom?.note).toBe("boom failed");
		const ok = build?.agents.find((a) => a.label === "ok");
		expect(ok?.status).toBe("completed");
	});
});

describe("summarize — sidebar one-line run summary (Task 8.3.4)", () => {
	const tokens = (input: number) => ({
		input,
		output: 0,
		reasoning: 0,
		cacheRead: 0,
		cacheWrite: 0,
	});

	// Two phases, three agents total: build has one ended + one running, review
	// has one running. So done/total = 1/3 and one agent is still running.
	const inflightFeed: FeedEvent[] = [
		{ type: "run:start", runId: "wf_summ", parentSessionID: "ses_p", at: 1000 },
		{ type: "agent:start", label: "impl", phase: "build", at: 1010 },
		{
			type: "agent:launched",
			label: "impl",
			phase: "build",
			sessionID: "ses_impl",
			model: "anthropic/claude-opus-4-8",
			at: 1020,
		},
		{
			type: "agent:end",
			label: "impl",
			status: "completed",
			sessionID: "ses_impl",
			durationMs: 80,
			tokens: tokens(60),
			toolCalls: 3,
			at: 1100,
		} as FeedEvent,
		{ type: "agent:start", label: "fix", phase: "build", at: 1110 },
		{
			type: "agent:launched",
			label: "fix",
			phase: "build",
			sessionID: "ses_fix",
			model: "anthropic/claude-opus-4-8",
			at: 1120,
		},
		{ type: "agent:start", label: "review", phase: "review", at: 1130 },
		{
			type: "agent:launched",
			label: "review",
			phase: "review",
			sessionID: "ses_rev",
			model: "anthropic/claude-sonnet-4-5",
			at: 1140,
		},
	];

	test("aggregates done/total agents and running status for an in-flight run", () => {
		const state = reduce(inflightFeed);
		// `now` is supplied by the caller (the reducer is clock-free): 5000 - 1000.
		const summary = summarize(state, 5000);
		expect(summary.runId).toBe("wf_summ");
		expect(summary.status).toBe("running");
		expect(summary.totalAgents).toBe(3);
		// One of three agents has settled (`impl`); the leading number is the DONE count
		// (CC's `done/total` parity), so 1 of 3 finished.
		expect(summary.doneAgents).toBe(1);
		expect(summary.elapsedMs).toBe(4000);
	});

	test("interposes cancelling and still counts done agents", () => {
		const state = reduce([
			...inflightFeed,
			{ type: "run:cancel-requested", runId: "wf_summ", at: 2000 },
		]);
		const summary = summarize(state, 5000);
		expect(summary.status).toBe("cancelling");
		expect(summary.doneAgents).toBe(1);
	});

	test("summarizes a settled run with terminal status and feed-derived elapsed", () => {
		const settledFeed: FeedEvent[] = [
			...inflightFeed,
			{
				type: "agent:end",
				label: "fix",
				status: "completed",
				sessionID: "ses_fix",
				durationMs: 40,
				at: 1200,
			} as FeedEvent,
			{
				type: "agent:end",
				label: "review",
				status: "completed",
				sessionID: "ses_rev",
				durationMs: 30,
				at: 1300,
			} as FeedEvent,
			{ type: "run:end", status: "completed", at: 1500 },
		];
		const state = reduce(settledFeed);
		// A settled run ignores `now` and uses endedAt - startedAt (1500 - 1000).
		const summary = summarize(state, 999_999);
		expect(summary.status).toBe("completed");
		expect(summary.doneAgents).toBe(3);
		expect(summary.totalAgents).toBe(3);
		expect(summary.elapsedMs).toBe(500);
	});

	test("elapsedMs is 0 before any run:start stamp is seen", () => {
		const summary = summarize(reduce([]), 5000);
		expect(summary.runId).toBeUndefined();
		expect(summary.totalAgents).toBe(0);
		expect(summary.doneAgents).toBe(0);
		expect(summary.elapsedMs).toBe(0);
	});
});

describe("createRunStateReducer — in-flight prefix (no run:end)", () => {
	test("yields a coherent running state with open occurrences", () => {
		const feed: FeedEvent[] = [
			{ type: "run:start", runId: "wf_p", parentSessionID: "ses_p", at: 1 },
			{ type: "agent:start", label: "impl", phase: "build", at: 10 },
			{
				type: "agent:launched",
				label: "impl",
				phase: "build",
				sessionID: "ses_impl",
				model: "anthropic/claude-opus-4-8",
				at: 20,
			},
			{
				type: "agent:stats",
				label: "impl",
				sessionID: "ses_impl",
				tokens: {
					input: 40,
					output: 8,
					reasoning: 0,
					cacheRead: 0,
					cacheWrite: 0,
				},
				toolCalls: 2,
				lastTools: ["read(z.ts)"],
				at: 30,
			},
		];
		const s = reduce(feed);
		expect(s.status).toBe("running");
		expect(s.endedAt).toBeUndefined();
		const impl = s.phases[0]?.agents[0];
		expect(impl?.status).toBeUndefined();
		expect(impl?.sessionID).toBe("ses_impl");
		// Live stats from the throttled agent:stats line (48 total).
		expect(impl?.tokens).toBe(48);
		expect(impl?.toolCalls).toBe(2);
		expect(impl?.lastTools).toEqual(["read(z.ts)"]);
		expect(s.phases[0]?.done).toBe(0);
		expect(s.phases[0]?.total).toBe(1);
		expect(s.phases[0]?.marker).toBe("…");
	});
});

describe("createRunStateReducer — declared phases (meta.phases seeding)", () => {
	test("seeds the WHOLE pipeline as pending headers before any agent launches", () => {
		const s = reduce([
			{
				type: "run:start",
				runId: "wf_p",
				parentSessionID: "ses_p",
				phases: ["Preflight", "Phase 1", "Phase 2", "Final"],
				at: 1,
			},
		]);
		expect(s.phases.map((p) => p.name)).toEqual([
			"Preflight",
			"Phase 1",
			"Phase 2",
			"Final",
		]);
		// Every declared phase is pending (no occurrences yet): marker "·", 0/0.
		for (const p of s.phases) {
			expect(p.marker).toBe("·");
			expect(p.total).toBe(0);
			expect(p.done).toBe(0);
			expect(p.agents).toEqual([]);
		}
	});

	test("agents overlay their declared phase; later phases stay pending", () => {
		const s = reduce([
			{
				type: "run:start",
				runId: "wf_p",
				parentSessionID: "ses_p",
				phases: ["Phase 1", "Phase 2"],
				at: 1,
			},
			{ type: "agent:start", label: "impl", phase: "Phase 1", at: 2 },
			{
				type: "agent:end",
				label: "impl",
				status: "completed",
				at: 3,
			},
		]);
		// Declared order preserved; Phase 1 now reflects its done agent, Phase 2 pending.
		expect(s.phases.map((p) => p.name)).toEqual(["Phase 1", "Phase 2"]);
		expect(s.phases[0]?.marker).toBe("✓");
		expect(s.phases[0]?.done).toBe(1);
		expect(s.phases[0]?.total).toBe(1);
		expect(s.phases[1]?.marker).toBe("·");
		expect(s.phases[1]?.total).toBe(0);
	});

	test("an agent phase not in meta.phases appends after the declared ones", () => {
		const s = reduce([
			{
				type: "run:start",
				runId: "wf_p",
				parentSessionID: "ses_p",
				phases: ["Phase 1"],
				at: 1,
			},
			{ type: "agent:start", label: "stray", phase: "Hotfix", at: 2 },
		]);
		expect(s.phases.map((p) => p.name)).toEqual(["Phase 1", "Hotfix"]);
		expect(s.phases[0]?.marker).toBe("·"); // declared, still pending
		expect(s.phases[1]?.total).toBe(1); // the stray agent's phase
	});

	test("no declared phases → derive from agents alone (prior behavior)", () => {
		const s = reduce([
			{ type: "run:start", runId: "wf_p", parentSessionID: "ses_p", at: 1 },
			{ type: "agent:start", label: "a", phase: "build", at: 2 },
		]);
		expect(s.phases.map((p) => p.name)).toEqual(["build"]);
		expect(s.phases[0]?.total).toBe(1);
	});
});
