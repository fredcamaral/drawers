import { describe, expect, test } from "bun:test";
import {
	ConcurrencyManager,
	createIdGenerator,
	createSessionRunner,
	type EngineClient,
	type SessionRunner,
} from "@drawers/core";
import type { ToolContext } from "@opencode-ai/plugin";
import { createWorkflowRun } from "./index";
import { createStructuredOutputTool } from "./structured/tool";
import type { JournalEntry } from "./types";

/**
 * Spec-conformance suite (Task 3.2.3). Scripts run as template strings against
 * the REAL createSessionRunner with a scripted fake EngineClient. Completion is
 * driven by hand: a controllable clock + manual timers + synthetic
 * `session.idle` events, mirroring packages/core/src/completion.test.ts and
 * session-runner.test.ts. No real sleeps, no wall-clock timers.
 */

// ---- controllable timing fakes -------------------------------------------

interface TimerHandle {
	clear(): void;
}
interface IntervalHandle {
	clear(): void;
	unref?(): void;
}

function makeTimers() {
	let seq = 0;
	const timers = new Map<number, () => void>();
	const intervals = new Map<number, () => void>();
	return {
		setTimer: (cb: () => void): TimerHandle => {
			const id = ++seq;
			timers.set(id, cb);
			return { clear: () => timers.delete(id) };
		},
		setIntervalFn: (cb: () => void): IntervalHandle => {
			const id = ++seq;
			intervals.set(id, cb);
			return { clear: () => intervals.delete(id), unref: () => {} };
		},
		fireAllTimers: () => {
			for (const [id, cb] of [...timers]) {
				timers.delete(id);
				cb();
			}
		},
	};
}

function makeClock(start = 1000): {
	now: () => number;
	set: (t: number) => void;
} {
	let t = start;
	return { now: () => t, set: (v) => (t = v) };
}

async function flush(): Promise<void> {
	for (let i = 0; i < 12; i++) {
		await Promise.resolve();
	}
}

const MIN_IDLE = 5000;

// ---- scripted fake EngineClient ------------------------------------------

interface PartEntry {
	type: string;
	text?: string;
	synthetic?: boolean;
	state?: { status: string; output?: string; error?: string };
}
interface MessageEntry {
	info: { role: "user" | "assistant" };
	parts: PartEntry[];
}

/** A scripted session: the transcript to serve, and an error flag. */
interface SessionScript {
	messages?: MessageEntry[];
	/** When true, the session never reaches a valid-output idle (used for "poison"). */
	poison?: boolean;
	/** When true, session.create rejects (terminal launch failure → degrade null). */
	createThrows?: boolean;
}

/**
 * Scripted fake. Sessions are created sequentially (`ses_1`, `ses_2`, …); each
 * session's transcript is chosen by the order of creation against a queue of
 * scripts. Tracks concurrent live sessions (created-but-not-completed) so cases
 * can assert the concurrency high-water mark.
 */
function makeScriptedClient() {
	const scripts: SessionScript[] = [];
	const transcripts = new Map<string, MessageEntry[]>();
	const poisoned = new Set<string>();
	const abortCalls: string[] = [];
	const liveSessions = new Set<string>();
	// Every promptAsync dispatch: the target sessionID and the concatenated text
	// of its parts. Lets cases assert nudge re-prompts (resume → promptAsync).
	const prompts: { sessionID: string; text: string }[] = [];
	let createSeq = 0;
	let highWater = 0;
	let createThrowsNext = false;

	const client: EngineClient = {
		session: {
			create() {
				const script = scripts.shift();
				if (script?.createThrows || createThrowsNext) {
					return Promise.reject(new Error("session.create boom"));
				}
				const id = `ses_${++createSeq}`;
				transcripts.set(id, script?.messages ?? defaultDone());
				if (script?.poison) {
					poisoned.add(id);
				}
				liveSessions.add(id);
				if (liveSessions.size > highWater) {
					highWater = liveSessions.size;
				}
				return Promise.resolve({ data: { id } });
			},
			promptAsync(opts) {
				const parts = opts.body?.parts ?? [];
				const text = parts.map((p: { text?: string }) => p.text ?? "").join("");
				prompts.push({ sessionID: opts.path.id, text });
				return Promise.resolve(undefined);
			},
			abort(opts) {
				abortCalls.push(opts.path.id);
				liveSessions.delete(opts.path.id);
				return Promise.resolve({ data: true });
			},
			messages(opts) {
				return Promise.resolve({ data: transcripts.get(opts.path.id) ?? [] });
			},
			get() {
				return Promise.resolve({ data: { id: "ses" } });
			},
		},
	};

	return {
		client,
		abortCalls,
		prompts,
		highWater: () => highWater,
		liveCount: () => liveSessions.size,
		/** Queue the script the NEXT create() consumes. */
		queueScript: (s: SessionScript) => scripts.push(s),
		setCreateThrows: (v: boolean) => {
			createThrowsNext = v;
		},
		/** A session reaches a clean completion (drops out of the live set). */
		completeSession: (id: string) => liveSessions.delete(id),
		/** Re-add a completed session to the live set (e.g. before a resume turn). */
		reviveSession: (id: string) => liveSessions.add(id),
		isPoisoned: (id: string) => poisoned.has(id),
		liveSessionIds: () => [...liveSessions],
	};
}

function done(text: string): MessageEntry[] {
	return [{ info: { role: "assistant" }, parts: [{ type: "text", text }] }];
}
function defaultDone(): MessageEntry[] {
	return done("ok");
}

// ---- harness -------------------------------------------------------------

interface Harness {
	runner: SessionRunner;
	client: ReturnType<typeof makeScriptedClient>;
	clock: ReturnType<typeof makeClock>;
	timers: ReturnType<typeof makeTimers>;
	concurrency: ConcurrencyManager;
}

function makeHarness(): Harness {
	const client = makeScriptedClient();
	const clock = makeClock(1000);
	const timers = makeTimers();
	const concurrency = new ConcurrencyManager();
	const runner = createSessionRunner({
		client: client.client,
		concurrency,
		ids: createIdGenerator(),
		clock,
		startPoll: false,
		setTimer: timers.setTimer,
		setIntervalFn: timers.setIntervalFn,
		config: { minIdleMs: MIN_IDLE, pollMs: 5000 },
	});
	return { runner, client, clock, timers, concurrency };
}

/** Drive every currently-live session to completed via idle + grace. */
async function completeAllLive(h: Harness): Promise<void> {
	// Let launches register their sessions first.
	await flush();
	const live = h.client.liveSessionIds();
	h.clock.set(1000 + MIN_IDLE + 1);
	for (const id of live) {
		if (h.client.isPoisoned(id)) {
			continue; // poison: never produce a valid idle.
		}
		await h.runner.handleEvent({
			type: "session.idle",
			properties: { sessionID: id },
		} as never);
		h.client.completeSession(id);
	}
	await flush();
	h.timers.fireAllTimers();
	await flush();
}

/**
 * Drive ONE session's current turn to completed via idle + grace at the given
 * clock time. Used for structured-output cases that interleave tool calls and
 * (for the nudge path) a second resume turn, where `completeAllLive`'s
 * all-at-once sweep is too coarse.
 */
async function completeTurn(
	h: Harness,
	id: string,
	clockTime: number,
): Promise<void> {
	await flush();
	h.clock.set(clockTime);
	h.client.reviveSession(id);
	await h.runner.handleEvent({
		type: "session.idle",
		properties: { sessionID: id },
	} as never);
	await flush();
	h.timers.fireAllTimers();
	await flush();
	h.client.completeSession(id);
	await flush();
}

const META = `export const meta = { name: "wf", description: "round trip" };\n`;

// JSON Schema used across the structured-output conformance cases.
const N_SCHEMA = {
	type: "object",
	properties: { n: { type: "number" } },
	required: ["n"],
	additionalProperties: false,
};

function toolCtx(sessionID: string): ToolContext {
	return { sessionID } as unknown as ToolContext;
}

// ---- (a) meta + return round-trip ----------------------------------------

describe("conformance (a) — meta + return round-trip", () => {
	test("script returns a literal; returnValue matches; meta.name surfaced", async () => {
		const h = makeHarness();
		const run = createWorkflowRun({
			runner: h.runner,
			parentSessionID: "ses_root",
			runId: "run_a",
		});
		const result = await run.run(
			`export const meta = { name: "roundtrip", description: "d" };\nreturn { hello: "world", n: 7 };\n`,
		);
		expect(result.status).toBe("completed");
		expect(result.returnValue).toEqual({ hello: "world", n: 7 });
		expect(result.meta?.name).toBe("roundtrip");
	});
});

// ---- (b) agent() resolves the child's final text -------------------------

describe("conformance (b) — agent() resolves scripted child text", () => {
	test("agent() resolves the scripted child's final assistant text", async () => {
		const h = makeHarness();
		h.client.queueScript({ messages: done("the answer is 42") });
		const run = createWorkflowRun({
			runner: h.runner,
			parentSessionID: "ses_root",
			runId: "run_b",
		});
		const p = run.run(`${META}const r = await agent("compute");\nreturn r;\n`);
		await completeAllLive(h);
		const result = await p;
		expect(result.status).toBe("completed");
		expect(result.returnValue).toBe("the answer is 42");
		expect(result.agentCount).toBe(1);
	});
});

// ---- (c) degrade: child error → null → .filter(Boolean) ------------------

describe("conformance (c) — degrade to null filters out", () => {
	test("a failing child becomes null; script .filter(Boolean) drops it", async () => {
		const h = makeHarness();
		h.client.queueScript({ messages: done("good") });
		h.client.queueScript({ createThrows: true }); // dies → null
		const run = createWorkflowRun({
			runner: h.runner,
			parentSessionID: "ses_root",
			runId: "run_c",
		});
		const p = run.run(
			`${META}const a = await agent("a");\nconst b = await agent("b");\nreturn [a, b].filter(Boolean);\n`,
		);
		await completeAllLive(h);
		const result = await p;
		expect(result.status).toBe("completed");
		expect(result.returnValue).toEqual(["good"]);
	});
});

// ---- (d) pipeline over 3 with a poisoned stage ---------------------------

describe("conformance (d) — pipeline with one poisoned stage", () => {
	test("pipeline over 3 items, middle fails → [x, null, y] shape", async () => {
		const h = makeHarness();
		h.client.queueScript({ messages: done("X") });
		h.client.queueScript({ createThrows: true }); // middle item agent dies
		h.client.queueScript({ messages: done("Y") });
		const run = createWorkflowRun({
			runner: h.runner,
			parentSessionID: "ses_root",
			runId: "run_d",
		});
		// Each pipeline stage calls agent; the middle agent returns null, and the
		// stage throws on null to drop the item.
		const p = run.run(
			`${META}const out = await pipeline([1, 2, 3], async (item) => {\n  const r = await agent("item " + item);\n  if (r === null) throw new Error("poison");\n  return r;\n});\nreturn out;\n`,
		);
		await completeAllLive(h);
		const result = await p;
		expect(result.status).toBe("completed");
		expect(result.returnValue).toEqual(["X", null, "Y"]);
	});
});

// ---- (e) phase()/log() ordering in progress ------------------------------

describe("conformance (e) — phase()/log() ordering in progress", () => {
	test("log events appear in script order; agent:start carries phase title", async () => {
		const h = makeHarness();
		h.client.queueScript({ messages: done("done") });
		const run = createWorkflowRun({
			runner: h.runner,
			parentSessionID: "ses_root",
			runId: "run_e",
		});
		const p = run.run(
			`${META}log("starting");\nphase("Build");\nawait agent("do it");\nlog("finished");\nreturn null;\n`,
		);
		await completeAllLive(h);
		const result = await p;
		expect(result.status).toBe("completed");

		const logs = result.progress
			.filter((e) => e.type === "log")
			.map((e) => (e.type === "log" ? e.message : ""));
		expect(logs).toEqual(["starting", "finished"]);

		const start = result.progress.find((e) => e.type === "agent:start");
		expect(start).toBeDefined();
		if (start?.type === "agent:start") {
			expect(start.phase).toBe("Build");
		}
	});
});

// ---- (f) Date.now() → determinism error ----------------------------------

describe("conformance (f) — Date.now() is a determinism error", () => {
	test("Date.now() in script → status error mentioning determinism", async () => {
		const h = makeHarness();
		const run = createWorkflowRun({
			runner: h.runner,
			parentSessionID: "ses_root",
			runId: "run_f",
		});
		const result = await run.run(`${META}return Date.now();\n`);
		expect(result.status).toBe("error");
		// The DeterminismError surfaces as the run error: it names the banned
		// nondeterministic op (Date.now) — the determinism guard fired (spec §7).
		expect(result.error?.toLowerCase()).toContain("date.now()");
		expect(result.error?.toLowerCase()).toContain("banned");
	});
});

// ---- (g) budget default --------------------------------------------------

describe("conformance (g) — budget default", () => {
	test("no budget → [total, remaining()] === [null, Infinity]", async () => {
		const h = makeHarness();
		const run = createWorkflowRun({
			runner: h.runner,
			parentSessionID: "ses_root",
			runId: "run_g",
		});
		const result = await run.run(
			`${META}return [budget.total, budget.remaining()];\n`,
		);
		expect(result.status).toBe("completed");
		expect(result.returnValue).toEqual([null, Number.POSITIVE_INFINITY]);
	});
});

// ---- (h) cores=4 → gate limit 2 enforced ---------------------------------

describe("conformance (h) — cores gate limit enforced", () => {
	test("cores=4 → at most 2 concurrent sessions live (high-water 2)", async () => {
		const h = makeHarness();
		// Three children that all stay live (no idle) while we inspect the gate.
		h.client.queueScript({ messages: done("1"), poison: true });
		h.client.queueScript({ messages: done("2"), poison: true });
		h.client.queueScript({ messages: done("3"), poison: true });
		const run = createWorkflowRun({
			runner: h.runner,
			parentSessionID: "ses_root",
			runId: "run_h",
			cores: 4,
		});
		// Fire three agents in parallel; none completes (poison), so the third must
		// queue behind the gate. We never resolve them — assert the high-water mark
		// then abort to unwind.
		const p = run.run(
			`${META}await parallel([() => agent("a"), () => agent("b"), () => agent("c")]);\nreturn "done";\n`,
		);
		await flush();
		await flush();
		expect(h.client.highWater()).toBe(2);
		expect(h.client.liveCount()).toBe(2);

		// Unwind: abort the run so the parallel() resolves (aborted agents → null)
		// and the run can settle without hanging the test.
		run.abort();
		await flush();
		const result = await p;
		expect(result.status).toBe("completed");
	});
});

// ---- (i) workflow() without a resolver → NestingError --------------------

describe("conformance (i) — workflow() needs a resolver (depth-1 guard)", () => {
	test("a run with no resolveSubWorkflow → workflow() throws NestingError", async () => {
		const h = makeHarness();
		const run = createWorkflowRun({
			runner: h.runner,
			parentSessionID: "ses_root",
			runId: "run_i",
		});
		// No resolveSubWorkflow → structurally a leaf/child: workflow() is unavailable.
		const result = await run.run(`${META}return workflow("other");\n`);
		expect(result.status).toBe("error");
		expect(result.error).toContain("one level");
	});

	test("a top-level run WITH a resolver runs the child inline and returns its value", async () => {
		const h = makeHarness();
		// The child script returns a literal — no agents, settles instantly.
		const CHILD = `export const meta = { name: "child", description: "c" };\nreturn { from: "child", got: args };\n`;
		const run = createWorkflowRun({
			runner: h.runner,
			parentSessionID: "ses_root",
			runId: "run_i2",
			resolveSubWorkflow: async () => CHILD,
		});
		const result = await run.run(
			`${META}const r = await workflow("helper", { x: 1 });\nreturn r;\n`,
		);
		expect(result.status).toBe("completed");
		expect(result.returnValue).toEqual({ from: "child", got: { x: 1 } });
	});

	test("workflow() inside a child throws NestingError (depth 1, structural)", async () => {
		const h = makeHarness();
		// The child itself tries to nest — its workflow() must throw (resolver undefined).
		const GRANDCHILD = `export const meta = { name: "gc", description: "g" };\nreturn 1;\n`;
		const CHILD = `export const meta = { name: "child", description: "c" };\nreturn await workflow("grandchild");\n`;
		const run = createWorkflowRun({
			runner: h.runner,
			parentSessionID: "ses_root",
			runId: "run_i3",
			resolveSubWorkflow: async (ref) =>
				typeof ref === "string" && ref === "grandchild" ? GRANDCHILD : CHILD,
		});
		// Parent calls workflow("child"); the child's own workflow("grandchild") must
		// throw NestingError, which surfaces as the child's error → parent's
		// workflow() rethrows → parent run status error.
		const result = await run.run(`${META}return await workflow("child");\n`);
		expect(result.status).toBe("error");
		expect(result.error).toContain("one level");
	});
});

// ---- (j) abort(): live child cancelled, later agent() resolves null ------

describe("conformance (j) — abort() cancels live child + degrades later calls", () => {
	test("abort mid-run cancels the live child and later agent() resolves null", async () => {
		const h = makeHarness();
		h.client.queueScript({ messages: done("never"), poison: true }); // long-running
		const run = createWorkflowRun({
			runner: h.runner,
			parentSessionID: "ses_root",
			runId: "run_j",
		});
		// First agent launches and stays live (poison). After it resolves (null via
		// abort), a second agent() must short-circuit to null without launching.
		const p = run.run(
			`${META}const first = await agent("long");\nconst second = await agent("after-abort");\nreturn { first, second, secondIsNull: second === null };\n`,
		);
		await flush();
		await flush();
		// The first child is live.
		const liveBefore = h.client.liveSessionIds();
		expect(liveBefore.length).toBe(1);
		const liveChild = liveBefore[0];
		if (liveChild === undefined) {
			throw new Error("expected a live child session");
		}

		run.abort();
		await flush();
		await flush();

		// The live child was cancelled via runner.cancel → observable abort call.
		expect(h.client.abortCalls).toContain(liveChild);

		const result = await p;
		expect(result.status).toBe("completed");
		const rv = result.returnValue as {
			first: unknown;
			second: unknown;
			secondIsNull: boolean;
		};
		expect(rv.first).toBeNull();
		expect(rv.secondIsNull).toBe(true);
	});
});

// ---- (k) structured output: agent({ schema }) ----------------------------

describe("conformance (k) — structured output", () => {
	const SCRIPT = (schema: object) =>
		`${META}const r = await agent("compute", { schema: ${JSON.stringify(
			schema,
		)} });\nreturn r;\n`;

	test("valid first try → agent() resolves the validated OBJECT", async () => {
		const h = makeHarness();
		const run = createWorkflowRun({
			runner: h.runner,
			parentSessionID: "ses_root",
			runId: "run_k1",
		});
		const tool = createStructuredOutputTool(run.registry);
		const p = run.run(SCRIPT(N_SCHEMA));

		// The child session exists + schema is registered after launch settles.
		await flush();
		await flush();
		const child = h.client.liveSessionIds()[0];
		expect(child).toBeDefined();
		if (child === undefined) {
			throw new Error("expected a live child");
		}

		// The child "calls the tool" with a valid value.
		const accepted = await tool.execute({ result: '{"n":1}' }, toolCtx(child));
		expect(accepted).toBe("accepted");

		await completeAllLive(h);
		const result = await p;
		expect(result.status).toBe("completed");
		expect(result.returnValue).toEqual({ n: 1 });
	});

	test("invalid then valid → retry string first, then resolves the object", async () => {
		const h = makeHarness();
		const run = createWorkflowRun({
			runner: h.runner,
			parentSessionID: "ses_root",
			runId: "run_k2",
		});
		const tool = createStructuredOutputTool(run.registry);
		const p = run.run(SCRIPT(N_SCHEMA));
		await flush();
		await flush();
		const child = h.client.liveSessionIds()[0];
		if (child === undefined) {
			throw new Error("expected a live child");
		}

		// First call: wrong type → retry string (the model would see this and fix).
		const bad = await tool.execute({ result: '{"n":"oops"}' }, toolCtx(child));
		expect(bad as string).toStartWith(
			"schema validation failed — fix and call structured_output again: ",
		);
		// Second call: corrected → accepted.
		const good = await tool.execute({ result: '{"n":2}' }, toolCtx(child));
		expect(good).toBe("accepted");

		await completeAllLive(h);
		const result = await p;
		// The SCRIPT never observed a parse error — only the validated object.
		expect(result.status).toBe("completed");
		expect(result.returnValue).toEqual({ n: 2 });
	});

	test("child never calls the tool → ONE nudge re-prompt, agent() resolves null", async () => {
		const h = makeHarness();
		const run = createWorkflowRun({
			runner: h.runner,
			parentSessionID: "ses_root",
			runId: "run_k3",
		});
		const p = run.run(SCRIPT(N_SCHEMA));
		await flush();
		await flush();
		const child = h.client.liveSessionIds()[0];
		if (child === undefined) {
			throw new Error("expected a live child");
		}

		// First turn completes with NO tool call.
		await completeTurn(h, child, 1000 + MIN_IDLE + 1);
		// The runtime issues exactly one nudge (resume → promptAsync re-dispatch).
		const nudges = h.client.prompts.filter(
			(pr) => pr.sessionID === child && pr.text.includes("have not returned"),
		);
		expect(nudges.length).toBe(1);
		// Second turn (post-nudge) completes, still with no tool call.
		await completeTurn(h, child, 1000 + 3 * MIN_IDLE + 1);

		const result = await p;
		expect(result.status).toBe("completed");
		expect(result.returnValue).toBeNull();
	});

	test("two concurrent structured agents do not cross-validate (registry isolation)", async () => {
		const h = makeHarness();
		const run = createWorkflowRun({
			runner: h.runner,
			parentSessionID: "ses_root",
			runId: "run_k4",
			cores: 8, // gate ≥ 2 so both children launch concurrently.
		});
		const tool = createStructuredOutputTool(run.registry);
		// Two distinct schemas: A wants { n: number }; B wants { s: string }.
		const SCHEMA_B = {
			type: "object",
			properties: { s: { type: "string" } },
			required: ["s"],
			additionalProperties: false,
		};
		const p = run.run(
			`${META}const [a, b] = await parallel([\n` +
				`  () => agent("A", { schema: ${JSON.stringify(N_SCHEMA)} }),\n` +
				`  () => agent("B", { schema: ${JSON.stringify(SCHEMA_B)} }),\n` +
				`]);\nreturn { a, b };\n`,
		);
		await flush();
		await flush();
		const live = h.client.liveSessionIds();
		expect(live.length).toBe(2);
		const [childA, childB] = live;
		if (childA === undefined || childB === undefined) {
			throw new Error("expected two live children");
		}

		// Each child validates against ITS OWN schema. The value valid for A is
		// invalid for B and vice versa — registry isolation by sessionID.
		const aOnA = await tool.execute({ result: '{"n":7}' }, toolCtx(childA));
		const aOnB = await tool.execute({ result: '{"n":7}' }, toolCtx(childB));
		expect(aOnA).toBe("accepted");
		expect(aOnB as string).toStartWith("schema validation failed");

		const bOnB = await tool.execute({ result: '{"s":"hi"}' }, toolCtx(childB));
		expect(bOnB).toBe("accepted");

		await completeAllLive(h);
		const result = await p;
		expect(result.status).toBe("completed");
		expect(result.returnValue).toEqual({ a: { n: 7 }, b: { s: "hi" } });
	});

	test("malformed schema in script → run status error mentioning schema compile", async () => {
		const h = makeHarness();
		const run = createWorkflowRun({
			runner: h.runner,
			parentSessionID: "ses_root",
			runId: "run_k5",
		});
		// `type: "bogus"` is not a valid JSON Schema value — ajv rejects compile.
		const result = await run.run(
			`${META}return await agent("x", { schema: { type: "bogus" } });\n`,
		);
		expect(result.status).toBe("error");
		expect(result.error?.toLowerCase()).toContain("schema");
	});
});

// ---- (l) replay round-trip: live run records → re-run replays cached ------

describe("conformance (l) — replay round-trip", () => {
	test("a recorded run replays with zero launches and the same returnValue", async () => {
		const SCRIPT = `${META}const a = await agent("first");\nconst b = await agent("second");\nreturn [a, b];\n`;

		// --- pass 1: live run, capturing journal entries via onRecord -----------
		const recorded: JournalEntry[] = [];
		const h1 = makeHarness();
		h1.client.queueScript({ messages: done("R1") });
		h1.client.queueScript({ messages: done("R2") });
		const run1 = createWorkflowRun({
			runner: h1.runner,
			parentSessionID: "ses_root",
			runId: "run_l1",
			replay: { entries: [], onRecord: (e) => recorded.push(e) },
		});
		const p1 = run1.run(SCRIPT);
		// Two SEQUENTIAL agent() calls: the second only launches after the first
		// completes, so a single completeAllLive sweep misses it. Drive each live
		// session as it appears, advancing the clock past MIN_IDLE each turn.
		// Two SEQUENTIAL agent() calls: the second only launches after the first
		// completes, so each turn drives ONE freshly-live session. Grace is forced
		// elapsed by advancing the clock past MIN_IDLE; the direct idle path then
		// completes on flush WITHOUT firing the awaitCompletion timeout timer.
		for (let turn = 0; turn < 3; turn += 1) {
			await flush();
			const live = h1.client.liveSessionIds();
			h1.clock.set(1000 + (turn + 1) * MIN_IDLE + 1);
			for (const id of live) {
				await h1.runner.handleEvent({
					type: "session.idle",
					properties: { sessionID: id },
				} as never);
				h1.client.completeSession(id);
			}
			await flush();
		}
		const r1 = await p1;
		expect(r1.status).toBe("completed");
		expect(r1.returnValue).toEqual(["R1", "R2"]);
		expect(recorded.length).toBe(2);

		// --- pass 2: replay with the captured entries → ZERO session.create -----
		const h2 = makeHarness();
		const run2 = createWorkflowRun({
			runner: h2.runner,
			parentSessionID: "ses_root",
			runId: "run_l2",
			replay: { entries: recorded, onRecord: () => {} },
		});
		const r2 = await run2.run(SCRIPT);
		expect(r2.status).toBe("completed");
		expect(r2.returnValue).toEqual(["R1", "R2"]);
		// No child sessions were ever created on the replay pass.
		expect(h2.client.liveCount()).toBe(0);
		expect(h2.client.highWater()).toBe(0);
	});
});
