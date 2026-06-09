/**
 * Tool-layer contract tests: the user-facing error strings, the defensive arg
 * coercion (opencode's raw path applies no Zod defaults/coercion), the conditional
 * spreading of optional spec fields, and the list/summary formatting. These live in
 * the tool wrappers, NOT the engine, so the engine tests do not cover them.
 *
 * Each tool is driven against a fake CadenceEngine that records `start` specs and a
 * fake ToolContext carrying only the sessionID the tools read.
 */

import { describe, expect, test } from "bun:test";
import type { ToolContext } from "@opencode-ai/plugin";
import type { CadenceEngine, CadenceSpec, Directive } from "../engine";
import { createGoalTool } from "./goal";
import { createListTool } from "./list";
import { createLoopTool } from "./loop";
import { createStopTool } from "./stop";

/** A directive built from a start spec, with the engine-derived fields filled in. */
function directiveOf(spec: CadenceSpec, id = "cadence_test"): Directive {
	return {
		id,
		sessionID: spec.sessionID,
		kind: spec.kind,
		instruction: spec.instruction,
		intervalMs: spec.intervalMs,
		until: spec.until,
		iterations: 0,
		maxIterations: spec.maxIterations ?? 10,
		status: "active",
		createdAt: 0,
	};
}

interface FakeEngine extends CadenceEngine {
	starts: CadenceSpec[];
	stops: Array<{ id: string; sessionID: string }>;
	stopSessions: string[];
}

/** Engine double recording every call; `list`/`stop` outputs are scripted. */
function fakeEngine(opts?: {
	list?: Directive[];
	stop?: Directive | undefined;
	stopForSession?: Directive[];
}): FakeEngine {
	const starts: CadenceSpec[] = [];
	const stops: Array<{ id: string; sessionID: string }> = [];
	const stopSessions: string[] = [];
	return {
		starts,
		stops,
		stopSessions,
		async start(spec) {
			starts.push(spec);
			return directiveOf(spec);
		},
		async stop(id, sessionID) {
			stops.push({ id, sessionID });
			return opts?.stop;
		},
		async stopForSession(sessionID) {
			stopSessions.push(sessionID);
			return opts?.stopForSession ?? [];
		},
		list() {
			return opts?.list ?? [];
		},
		async handleEvent() {},
		async recover() {},
		dispose() {},
	};
}

/** Minimal ToolContext: tools read only `sessionID`. */
function ctx(sessionID = "s1"): ToolContext {
	return { sessionID } as unknown as ToolContext;
}

/**
 * Drive a tool's execute() with RAW args (the opencode path applies no Zod
 * coercion, so we cast past the inferred arg type on purpose to exercise the
 * defensive coercion). Tools here always resolve to a string.
 */
type ExecutableTool = {
	execute(args: never, context: ToolContext): Promise<unknown>;
};

async function run(
	tool: ExecutableTool,
	args: unknown,
	context: ToolContext = ctx(),
): Promise<string> {
	const res = await tool.execute(args as never, context);
	return res as string;
}

describe("loop tool", () => {
	test("missing/whitespace instruction yields the error string", async () => {
		const engine = fakeEngine();
		const tool = createLoopTool(engine);
		expect(await run(tool, { interval_ms: 1000 })).toBe(
			"instruction is required",
		);
		// Non-string coerces to "" → still the error.
		expect(await run(tool, { instruction: 42, interval_ms: 1000 })).toBe(
			"instruction is required",
		);
		expect(engine.starts).toHaveLength(0);
	});

	test("non-positive / NaN / non-numeric interval_ms yields the interval error", async () => {
		const engine = fakeEngine();
		const tool = createLoopTool(engine);
		for (const bad of [0, -5, Number.NaN, "abc", undefined]) {
			expect(await run(tool, { instruction: "go", interval_ms: bad })).toBe(
				"interval_ms is required and must be a positive number",
			);
		}
		expect(engine.starts).toHaveLength(0);
	});

	test("valid call floors interval, omits absent max, omits empty until", async () => {
		const engine = fakeEngine();
		const tool = createLoopTool(engine);
		const out = await run(tool, {
			instruction: "go",
			interval_ms: 1500.9,
			until: "",
		});

		expect(engine.starts).toHaveLength(1);
		const spec = engine.starts[0];
		expect(spec?.kind).toBe("loop");
		expect(spec?.instruction).toBe("go");
		expect(spec?.intervalMs).toBe(1500); // floored
		expect("maxIterations" in (spec ?? {})).toBe(false); // omitted, not undefined
		expect("until" in (spec ?? {})).toBe(false); // empty string NOT forwarded
		expect(out).toContain("armed");
	});

	test("max_iterations is floored and forwarded; until is forwarded when set", async () => {
		const engine = fakeEngine();
		const tool = createLoopTool(engine);
		await run(tool, {
			instruction: "go",
			interval_ms: 1000,
			max_iterations: 7.8,
			until: "the doc is done",
		});

		const spec = engine.starts[0];
		expect(spec?.maxIterations).toBe(7); // floored
		expect(spec?.until).toBe("the doc is done");
	});
});

describe("goal tool", () => {
	test("missing/whitespace goal yields the error string", async () => {
		const engine = fakeEngine();
		const tool = createGoalTool(engine);
		expect(await run(tool, {})).toBe("goal is required");
		expect(await run(tool, { goal: 99 })).toBe("goal is required");
		expect(engine.starts).toHaveLength(0);
	});

	test("valid call starts a goal; absent max omitted, NaN max omitted", async () => {
		const engine = fakeEngine();
		const tool = createGoalTool(engine);
		await run(tool, { goal: "ship it", max_iterations: Number.NaN });

		expect(engine.starts).toHaveLength(1);
		const spec = engine.starts[0];
		expect(spec?.kind).toBe("goal");
		expect(spec?.instruction).toBe("ship it");
		expect("maxIterations" in (spec ?? {})).toBe(false);
	});
});

describe("cadence_stop tool", () => {
	test("unknown id returns 'no such directive'", async () => {
		const engine = fakeEngine({ stop: undefined });
		const tool = createStopTool(engine);
		expect(await run(tool, { id: "cadence_x" })).toBe(
			"no such directive: cadence_x",
		);
		expect(engine.stops[0]).toEqual({ id: "cadence_x", sessionID: "s1" });
	});

	test("known id returns id and status", async () => {
		const stopped = directiveOf(
			{ sessionID: "s1", kind: "loop", instruction: "x" },
			"cadence_1",
		);
		stopped.status = "stopped";
		const engine = fakeEngine({ stop: stopped });
		const tool = createStopTool(engine);
		expect(await run(tool, { id: "cadence_1" })).toBe("cadence_1 — stopped");
	});

	test("no id with nothing active returns 'nothing to stop'", async () => {
		const engine = fakeEngine({ stopForSession: [] });
		const tool = createStopTool(engine);
		expect(await run(tool, {})).toBe(
			"nothing to stop — no active directives for this session",
		);
		expect(engine.stopSessions).toEqual(["s1"]);
	});

	test("no id with active directives reports the count and ids", async () => {
		const d1 = directiveOf(
			{ sessionID: "s1", kind: "loop", instruction: "a" },
			"cadence_1",
		);
		const d2 = directiveOf(
			{ sessionID: "s1", kind: "goal", instruction: "b" },
			"cadence_2",
		);
		const engine = fakeEngine({ stopForSession: [d1, d2] });
		const tool = createStopTool(engine);
		expect(await run(tool, {})).toBe(
			"stopped 2 directive(s): cadence_1, cadence_2",
		);
	});
});

describe("cadence_list tool", () => {
	test("empty session returns the explicit none string", async () => {
		const engine = fakeEngine({ list: [] });
		const tool = createListTool(engine);
		expect(await run(tool, {})).toBe(
			"no active cadence directives for this session",
		);
	});

	test("formats a loop line (with until) and a goal line", async () => {
		const loop: Directive = {
			id: "cadence_1",
			sessionID: "s1",
			kind: "loop",
			instruction: "refine",
			intervalMs: 2000,
			until: "done?",
			iterations: 3,
			maxIterations: 10,
			status: "active",
			createdAt: 0,
		};
		const goal: Directive = {
			id: "cadence_2",
			sessionID: "s1",
			kind: "goal",
			instruction: "ship it",
			iterations: 1,
			maxIterations: 5,
			status: "active",
			createdAt: 0,
		};
		const engine = fakeEngine({ list: [loop, goal] });
		const tool = createListTool(engine);
		expect(await run(tool, {})).toBe(
			"cadence_1 loop every=2000ms 3/10 until=done?\n" +
				"cadence_2 goal 1/5 — ship it",
		);
	});
});
