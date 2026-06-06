import { beforeEach, describe, expect, test } from "bun:test";
import type { IntervalFactory, TimerFactory } from "./completion";
import { ConcurrencyManager } from "./concurrency";
import { createIdGenerator } from "./ids";
import {
	createSessionRunner,
	type EngineClient,
	type SessionCreateBody,
	type SessionPromptAsyncBody,
} from "./session-runner";
import type { BgTask, Clock, LaunchRequest } from "./types";

// ---- deferred-promise scripted fakes (no timers) -------------------------

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: unknown) => void;
}

function defer<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

// Flush enough microtask turns that any already-settled chain has run its
// continuations before we assert. No timers involved.
async function flush(): Promise<void> {
	for (let i = 0; i < 8; i++) {
		await Promise.resolve();
	}
}

interface CreateCall {
	body: SessionCreateBody;
}
interface PromptCall {
	id: string;
	body: SessionPromptAsyncBody;
}
interface AbortCall {
	id: string;
}

/**
 * Scripted fake EngineClient. Each call records its arguments and returns a
 * deferred the test settles by hand, so launch-path timing is fully controlled.
 */
function makeClient() {
	const createCalls: CreateCall[] = [];
	const promptCalls: PromptCall[] = [];
	const abortCalls: AbortCall[] = [];

	let createDeferred = defer<{ data?: { id: string } }>();
	let promptDeferred = defer<void>();

	const client: EngineClient = {
		session: {
			create(opts) {
				createCalls.push({ body: opts.body ?? {} });
				return createDeferred.promise;
			},
			promptAsync(opts) {
				promptCalls.push({ id: opts.path.id, body: opts.body });
				return promptDeferred.promise;
			},
			abort(opts) {
				abortCalls.push({ id: opts.path.id });
				return Promise.resolve({ data: true });
			},
			messages() {
				return Promise.resolve({ data: [] });
			},
			get() {
				return Promise.resolve({ data: { id: "ses" } });
			},
		},
	};

	return {
		client,
		createCalls,
		promptCalls,
		abortCalls,
		resolveCreate: (id: string) => createDeferred.resolve({ data: { id } }),
		rejectCreate: (err: unknown) => createDeferred.reject(err),
		resolvePrompt: () => promptDeferred.resolve(),
		rejectPrompt: (err: unknown) => promptDeferred.reject(err),
		// fresh deferreds in case a test launches twice
		reset: () => {
			createDeferred = defer();
			promptDeferred = defer();
		},
	};
}

function fixedClock(t = 1000): Clock {
	return { now: () => t };
}

// Narrow an array element under noUncheckedIndexedAccess without `!`.
function at<T>(arr: readonly T[], i: number): T {
	const v = arr[i];
	if (v === undefined) {
		throw new Error(`expected element at index ${i}`);
	}
	return v;
}

function baseReq(over: Partial<LaunchRequest> = {}): LaunchRequest {
	return {
		parentSessionID: "ses_parent",
		description: "do the thing",
		prompt: "please do the thing",
		agent: "build",
		depth: 0,
		...over,
	};
}

const RECURSION_GUARD = {
	bg_task: false,
	bg_output: false,
	bg_cancel: false,
	bg_list: false,
	workflow: false,
	workflow_status: false,
	workflow_stop: false,
};

// ---- tests ---------------------------------------------------------------

describe("createSessionRunner — launch happy path", () => {
	let h: ReturnType<typeof makeClient>;
	let concurrency: ConcurrencyManager;

	beforeEach(() => {
		h = makeClient();
		concurrency = new ConcurrencyManager();
	});

	test("launch resolves a running task with session created (parentID+title) and promptAsync dispatched with recursion-guard tools + prompt part", async () => {
		const runner = createSessionRunner({
			client: h.client,
			concurrency,
			ids: createIdGenerator(),
			clock: fixedClock(4242),
		});

		const launched = runner.launch(baseReq({ model: "anthropic/opus" }));
		// create is awaited; settle it so launch can proceed.
		await flush();
		h.resolveCreate("ses_child");
		const task = await launched;

		expect(task.status).toBe("running");
		expect(task.sessionID).toBe("ses_child");
		expect(task.startedAt).toBe(4242);
		expect(task.id.startsWith("bg_")).toBe(true);

		expect(h.createCalls).toHaveLength(1);
		expect(at(h.createCalls, 0).body).toEqual({
			parentID: "ses_parent",
			title: "do the thing",
		});

		expect(h.promptCalls).toHaveLength(1);
		const prompt = at(h.promptCalls, 0);
		expect(prompt.id).toBe("ses_child");
		expect(prompt.body.agent).toBe("build");
		expect(prompt.body.parts).toEqual([
			{ type: "text", text: "please do the thing" },
		]);
		expect(prompt.body.tools).toEqual(RECURSION_GUARD);
		expect(prompt.body.model).toEqual({
			providerID: "anthropic",
			modelID: "opus",
		});

		// slot released only on completion; still held while running.
		expect(concurrency.runningCount("anthropic/opus")).toBe(1);
	});

	test("toolsOverride merges over the recursion guard", async () => {
		const runner = createSessionRunner({
			client: h.client,
			concurrency,
			ids: createIdGenerator(),
			clock: fixedClock(),
		});
		const launched = runner.launch(
			baseReq({ toolsOverride: { read: true, bg_task: true } }),
		);
		await flush();
		h.resolveCreate("ses_child");
		await launched;

		expect(at(h.promptCalls, 0).body.tools).toEqual({
			...RECURSION_GUARD,
			read: true,
			bg_task: true, // explicit override wins
		});
	});

	test("noSpawnTools false omits the recursion guard", async () => {
		const runner = createSessionRunner({
			client: h.client,
			concurrency,
			ids: createIdGenerator(),
			clock: fixedClock(),
		});
		const launched = runner.launch(baseReq({ noSpawnTools: false }));
		await flush();
		h.resolveCreate("ses_child");
		await launched;

		expect(at(h.promptCalls, 0).body.tools).toEqual({});
	});

	test("persist is invoked across the launch lifecycle when provided", async () => {
		const persisted: BgTask[] = [];
		const runner = createSessionRunner({
			client: h.client,
			concurrency,
			ids: createIdGenerator(),
			clock: fixedClock(),
			persist: async (t) => {
				persisted.push({ ...t });
			},
		});
		const launched = runner.launch(baseReq());
		await flush();
		h.resolveCreate("ses_child");
		await launched;
		await flush();

		// at least: pending registration + running transition
		const statuses = persisted.map((p) => p.status);
		expect(statuses).toContain("pending");
		expect(statuses).toContain("running");
	});
});

describe("createSessionRunner — cancel-during-acquire", () => {
	test("waiter cancelled before slot grant: task cancelled, no session.create, no slot leak", async () => {
		const h = makeClient();
		// limit 1 so the second launch queues as a waiter.
		const concurrency = new ConcurrencyManager({ defaultConcurrency: 1 });
		const runner = createSessionRunner({
			client: h.client,
			concurrency,
			ids: createIdGenerator(),
			clock: fixedClock(),
		});

		const model = "anthropic/opus";
		// First launch grabs the only slot and is left in-flight (create pending).
		const first = runner.launch(baseReq({ model }));
		await flush();
		expect(concurrency.runningCount(model)).toBe(1);

		// Second launch must queue — its acquire is pending.
		const secondReq = baseReq({ model, description: "second" });
		const second = runner.launch(secondReq);
		await flush();
		expect(concurrency.queueLength(model)).toBe(1);

		// Cancel the queued task mid-acquire.
		const queued = runner.list().find((t) => t.description === "second");
		if (!queued) {
			throw new Error("expected a queued task");
		}
		void runner.cancel(queued.id);
		await flush();

		const cancelledTask = await second;
		expect(cancelledTask.status).toBe("cancelled");

		// No session was ever created for the cancelled task. (Only the first
		// launch's create call exists.)
		expect(h.createCalls).toHaveLength(1);
		expect(concurrency.queueLength(model)).toBe(0);

		// finish the first so we can assert the slot count returns to baseline.
		h.resolveCreate("ses_first");
		await first;
		concurrency.release(model);
		expect(concurrency.runningCount(model)).toBe(0);
	});
});

describe("createSessionRunner — cancel-between-create-and-prompt", () => {
	test("cancelled after create await: orphan session aborted, task cancelled, slot released, no promptAsync", async () => {
		const h = makeClient();
		const concurrency = new ConcurrencyManager();
		const runner = createSessionRunner({
			client: h.client,
			concurrency,
			ids: createIdGenerator(),
			clock: fixedClock(),
		});
		const model = "anthropic/opus";

		const launched = runner.launch(baseReq({ model }));
		await flush();
		expect(concurrency.runningCount(model)).toBe(1);

		// Mark cancelled while create is still pending.
		const task = at(runner.list(), 0);
		void runner.cancel(task.id);

		// Now resolve create — the post-await re-check must see cancellation.
		h.resolveCreate("ses_orphan");
		const result = await launched;
		// The orphan abort + slot release now run in the completion gate's
		// detached teardown (one microtask hop after the cancelled flip).
		await flush();

		expect(result.status).toBe("cancelled");
		expect(h.abortCalls).toEqual([{ id: "ses_orphan" }]);
		expect(h.promptCalls).toHaveLength(0);
		expect(concurrency.runningCount(model)).toBe(0);
	});
});

describe("createSessionRunner — session.create rejection", () => {
	test("create rejects: launch rejects, task error, slot released", async () => {
		const h = makeClient();
		const concurrency = new ConcurrencyManager();
		const runner = createSessionRunner({
			client: h.client,
			concurrency,
			ids: createIdGenerator(),
			clock: fixedClock(),
		});
		const model = "anthropic/opus";

		const launched = runner.launch(baseReq({ model }));
		await flush();
		expect(concurrency.runningCount(model)).toBe(1);

		h.rejectCreate(new Error("boom"));

		await expect(launched).rejects.toThrow("boom");

		const task = at(runner.list(), 0);
		expect(task.status).toBe("error");
		expect(task.error).toContain("boom");
		expect(h.promptCalls).toHaveLength(0);
		expect(concurrency.runningCount(model)).toBe(0);
	});
});

describe("createSessionRunner — depth exceeded", () => {
	test("depth >= maxDepth rejects with zero concurrency interaction and no task registered", async () => {
		const h = makeClient();
		const concurrency = new ConcurrencyManager();
		const runner = createSessionRunner({
			client: h.client,
			concurrency,
			ids: createIdGenerator(),
			clock: fixedClock(),
			config: { maxDepth: 2 },
		});
		const model = "anthropic/opus";

		await expect(runner.launch(baseReq({ model, depth: 2 }))).rejects.toThrow(
			/depth/i,
		);

		expect(h.createCalls).toHaveLength(0);
		expect(runner.list()).toHaveLength(0);
		expect(concurrency.runningCount(model)).toBe(0);
		expect(concurrency.queueLength(model)).toBe(0);
	});
});

describe("createSessionRunner — promptAsync rejection (.catch path)", () => {
	test("promptAsync rejects: task finalized error, slot released", async () => {
		const h = makeClient();
		const concurrency = new ConcurrencyManager();
		const runner = createSessionRunner({
			client: h.client,
			concurrency,
			ids: createIdGenerator(),
			clock: fixedClock(),
		});
		const model = "anthropic/opus";

		const launched = runner.launch(baseReq({ model }));
		await flush();
		h.resolveCreate("ses_child");
		const task = await launched;
		expect(task.status).toBe("running");
		expect(concurrency.runningCount(model)).toBe(1);

		// Now blow up the fire-and-forget prompt.
		h.rejectPrompt(new Error("prompt failed"));
		await flush();

		const after = at(runner.list(), 0);
		expect(after.status).toBe("error");
		expect(after.error).toContain("prompt failed");
		expect(concurrency.runningCount(model)).toBe(0);
	});
});

describe("createSessionRunner — list", () => {
	test("returns all tasks in createdAt order, filterable by parent", async () => {
		const h = makeClient();
		const concurrency = new ConcurrencyManager();
		let t = 0;
		const clock: Clock = { now: () => t };
		const runner = createSessionRunner({
			client: h.client,
			concurrency,
			ids: createIdGenerator(),
			clock,
		});

		t = 10;
		const a = runner.launch(baseReq({ parentSessionID: "ses_A" }));
		await flush();
		h.resolveCreate("ses_a_child");
		await a;

		h.reset();
		t = 20;
		const b = runner.launch(baseReq({ parentSessionID: "ses_B" }));
		await flush();
		h.resolveCreate("ses_b_child");
		await b;

		const all = runner.list();
		expect(all.map((x) => x.parentSessionID)).toEqual(["ses_A", "ses_B"]);

		const onlyB = runner.list("ses_B");
		expect(onlyB).toHaveLength(1);
		expect(at(onlyB, 0).parentSessionID).toBe("ses_B");
	});
});

describe("createSessionRunner — unimplemented methods", () => {
	test("awaitCompletion/cancel/resume/readOutput/handleEvent/dispose are present", () => {
		const h = makeClient();
		const runner = createSessionRunner({
			client: h.client,
			concurrency: new ConcurrencyManager(),
			ids: createIdGenerator(),
			clock: fixedClock(),
		});
		expect(typeof runner.awaitCompletion).toBe("function");
		expect(typeof runner.cancel).toBe("function");
		expect(typeof runner.resume).toBe("function");
		expect(typeof runner.readOutput).toBe("function");
		expect(typeof runner.handleEvent).toBe("function");
		expect(typeof runner.dispose).toBe("function");
	});
});

// ===========================================================================
// Task 1.3.4 — cancel / resume / readOutput
// ===========================================================================

/** Manual timer/interval factory: nothing fires on its own. */
function makeTimers() {
	let seq = 0;
	const timers = new Map<number, () => void>();
	const intervals = new Map<number, () => void>();
	const setTimer: TimerFactory = (cb, _ms) => {
		const id = ++seq;
		timers.set(id, cb);
		return { clear: () => timers.delete(id) };
	};
	const setIntervalFn: IntervalFactory = (cb, _ms) => {
		const id = ++seq;
		intervals.set(id, cb);
		return { clear: () => intervals.delete(id), unref: () => {} };
	};
	return {
		setTimer,
		setIntervalFn,
		fireAllTimers: () => {
			for (const [id, cb] of [...timers]) {
				timers.delete(id);
				cb();
			}
		},
		tick: () => {
			for (const cb of [...intervals.values()]) {
				cb();
			}
		},
	};
}

function mutableClock(start = 1000): Clock & { set: (t: number) => void } {
	let t = start;
	return { now: () => t, set: (v) => (t = v) };
}

/** A part as readOutput / the gate may observe in a message. */
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

/**
 * Richer scripted client supporting the full second-lifecycle (resume) and
 * output reading: messages scriptable per session, get failures per session,
 * multiple create/prompt turns settled by hand.
 */
function makeLifecycleClient() {
	const createCalls: CreateCall[] = [];
	const promptCalls: PromptCall[] = [];
	const abortCalls: AbortCall[] = [];
	const getCalls: string[] = [];
	const messagesCalls: string[] = [];

	const messagesBySession = new Map<string, MessageEntry[]>();
	const getFails = new Set<string>();
	let nextCreateId = "ses_child";
	let promptDeferred = defer<void>();

	const client: EngineClient = {
		session: {
			create(opts) {
				createCalls.push({ body: opts.body ?? {} });
				return Promise.resolve({ data: { id: nextCreateId } });
			},
			promptAsync(opts) {
				promptCalls.push({ id: opts.path.id, body: opts.body });
				return promptDeferred.promise;
			},
			abort(opts) {
				abortCalls.push({ id: opts.path.id });
				return Promise.resolve({ data: true });
			},
			messages(opts) {
				messagesCalls.push(opts.path.id);
				return Promise.resolve({
					data: messagesBySession.get(opts.path.id) ?? [],
				});
			},
			get(opts) {
				getCalls.push(opts.path.id);
				if (getFails.has(opts.path.id)) {
					return Promise.reject(new Error("session gone"));
				}
				return Promise.resolve({ data: { id: opts.path.id } });
			},
		},
	};

	return {
		client,
		createCalls,
		promptCalls,
		abortCalls,
		getCalls,
		messagesCalls,
		setMessages: (id: string, msgs: MessageEntry[]) =>
			messagesBySession.set(id, msgs),
		setGetFails: (id: string, fails: boolean) =>
			fails ? getFails.add(id) : getFails.delete(id),
		setNextCreateId: (id: string) => {
			nextCreateId = id;
		},
		resolvePrompt: () => promptDeferred.resolve(),
		rejectPrompt: (err: unknown) => promptDeferred.reject(err),
		freshPrompt: () => {
			promptDeferred = defer();
		},
	};
}

const idleEvent = (sessionID: string) =>
	({ type: "session.idle", properties: { sessionID } }) as const;

/** Drive a running task to completed via idle + the min-idle grace window. */
async function completeViaIdle(
	runner: ReturnType<typeof createSessionRunner>,
	timers: ReturnType<typeof makeTimers>,
	clock: Clock & { set: (t: number) => void },
	sessionID: string,
	startedAt: number,
	minIdleMs: number,
): Promise<void> {
	// First idle arrives before grace elapses → defers.
	await runner.handleEvent(idleEvent(sessionID));
	await flush();
	// advance past the grace window, fire the deferred timer.
	clock.set(startedAt + minIdleMs + 1);
	timers.fireAllTimers();
	await flush();
}

describe("createSessionRunner — cancel", () => {
	test("cancel of pending task (waiter queued): no session created, waiter cancelled, task cancelled, slot accounting clean", async () => {
		const h = makeLifecycleClient();
		const concurrency = new ConcurrencyManager({ defaultConcurrency: 1 });
		const runner = createSessionRunner({
			client: h.client,
			concurrency,
			ids: createIdGenerator(),
			clock: fixedClock(),
			startPoll: false,
		});
		const model = "anthropic/opus";

		// First launch grabs the only slot; create resolves immediately (lifecycle
		// client is non-deferred for create), so it goes running.
		h.setNextCreateId("ses_first");
		const first = runner.launch(baseReq({ model }));
		await flush();
		await first;
		expect(concurrency.runningCount(model)).toBe(1);

		// Second launch queues as a waiter.
		const second = runner.launch(baseReq({ model, description: "second" }));
		await flush();
		expect(concurrency.queueLength(model)).toBe(1);

		const queued = runner.list().find((t) => t.description === "second");
		if (!queued) {
			throw new Error("expected queued task");
		}
		const beforeCreates = h.createCalls.length;
		const cancelled = await runner.cancel(queued.id);

		expect(cancelled.status).toBe("cancelled");
		expect(cancelled.error).toBe("cancelled by user");
		// the queued waiter never created a session.
		expect(h.createCalls.length).toBe(beforeCreates);
		expect(concurrency.queueLength(model)).toBe(0);
		// the queued second resolves cancelled.
		expect((await second).status).toBe("cancelled");

		// finish the first to return to baseline.
		await runner.cancel((await first).id);
		await flush();
		expect(concurrency.runningCount(model)).toBe(0);
	});

	test("cancel of already-terminal task: no-op, returns current state, no second onTaskComplete", async () => {
		const h = makeLifecycleClient();
		const concurrency = new ConcurrencyManager();
		const completes: BgTask[] = [];
		const runner = createSessionRunner({
			client: h.client,
			concurrency,
			ids: createIdGenerator(),
			clock: fixedClock(),
			startPoll: false,
			onTaskComplete: (t) => completes.push({ ...t }),
		});
		const model = "anthropic/opus";
		const launched = runner.launch(baseReq({ model }));
		await flush();
		const task = await launched;

		// cancel once → completes once.
		const c1 = await runner.cancel(task.id);
		expect(c1.status).toBe("cancelled");
		const firstCompleteCount = completes.length;
		const firstAbortCount = h.abortCalls.length;

		// cancel again → no-op, resolves with current state, no further teardown.
		const c2 = await runner.cancel(task.id);
		expect(c2.status).toBe("cancelled");
		expect(c2).toBe(c1); // same task object
		expect(completes.length).toBe(firstCompleteCount);
		expect(h.abortCalls.length).toBe(firstAbortCount);
		expect(concurrency.runningCount(model)).toBe(0);
	});

	test("cancel of running task: session aborted exactly once, slot released, resolves after teardown (persisted state visible)", async () => {
		const h = makeLifecycleClient();
		const concurrency = new ConcurrencyManager();
		const persisted: BgTask[] = [];
		const runner = createSessionRunner({
			client: h.client,
			concurrency,
			ids: createIdGenerator(),
			clock: fixedClock(),
			startPoll: false,
			persist: async (t) => {
				persisted.push({ ...t });
			},
		});
		const model = "anthropic/opus";
		h.setNextCreateId("ses_run");
		const launched = runner.launch(baseReq({ model }));
		await flush();
		const task = await launched;
		expect(task.status).toBe("running");
		expect(concurrency.runningCount(model)).toBe(1);

		const cancelled = await runner.cancel(task.id);

		// abort happened exactly once for this session, BEFORE cancel resolved.
		expect(h.abortCalls.filter((a) => a.id === "ses_run")).toHaveLength(1);
		expect(cancelled.status).toBe("cancelled");
		// teardown completed before resolution: slot released + completedAt stamped.
		expect(cancelled.completedAt).toBeDefined();
		expect(concurrency.runningCount(model)).toBe(0);
		// the last persisted snapshot reflects the cancelled+torn-down state.
		const lastPersist = persisted.at(-1);
		expect(lastPersist?.status).toBe("cancelled");
		expect(lastPersist?.completedAt).toBeDefined();
	});
});

describe("createSessionRunner — resume", () => {
	const MIN_IDLE = 5000;

	function makeRunner(h: ReturnType<typeof makeLifecycleClient>) {
		const concurrency = new ConcurrencyManager();
		const clock = mutableClock(1000);
		const timers = makeTimers();
		const completes: BgTask[] = [];
		const runner = createSessionRunner({
			client: h.client,
			concurrency,
			ids: createIdGenerator(),
			clock,
			startPoll: false,
			onTaskComplete: (t) => completes.push({ ...t }),
			setTimer: timers.setTimer,
			setIntervalFn: timers.setIntervalFn,
			config: { minIdleMs: MIN_IDLE, pollMs: 5000 },
		});
		return { runner, concurrency, clock, timers, completes };
	}

	test("resume of terminal task with live session: running, new prompt sent with recursion guard, completes again via idle (full second lifecycle)", async () => {
		const h = makeLifecycleClient();
		const { runner, concurrency, clock, timers, completes } = makeRunner(h);
		const model = "anthropic/opus";

		// --- first lifecycle: launch → idle → completed ---
		h.setNextCreateId("ses_x");
		h.setMessages("ses_x", [
			{ info: { role: "assistant" }, parts: [{ type: "text", text: "turn1" }] },
		]);
		const launched = runner.launch(baseReq({ model }));
		await flush();
		const task = await launched;
		expect(task.status).toBe("running");

		clock.set(1000);
		await completeViaIdle(runner, timers, clock, "ses_x", 1000, MIN_IDLE);
		expect(runner.list()[0]?.status).toBe("completed");
		const completesAfterTurn1 = completes.length;
		expect(completesAfterTurn1).toBe(1);
		expect(concurrency.runningCount(model)).toBe(0);

		// --- resume: new turn ---
		h.freshPrompt();
		const promptsBefore = h.promptCalls.length;
		const resumeAt = 9000;
		clock.set(resumeAt);
		const resumed = await runner.resume(task.id, "second prompt");

		expect(resumed.status).toBe("running");
		expect(resumed.startedAt).toBe(resumeAt);
		expect(resumed.error).toBeUndefined();
		expect(resumed.completedAt).toBeUndefined();
		expect(concurrency.runningCount(model)).toBe(1);

		// new prompt dispatched on the SAME session, with recursion guard.
		expect(h.promptCalls.length).toBe(promptsBefore + 1);
		const lastPrompt = at(h.promptCalls, h.promptCalls.length - 1);
		expect(lastPrompt.id).toBe("ses_x");
		expect(lastPrompt.body.parts).toEqual([
			{ type: "text", text: "second prompt" },
		]);
		expect(lastPrompt.body.tools).toEqual(RECURSION_GUARD);

		// --- second lifecycle completes via idle ---
		h.setMessages("ses_x", [
			{ info: { role: "assistant" }, parts: [{ type: "text", text: "turn2" }] },
		]);
		await completeViaIdle(runner, timers, clock, "ses_x", resumeAt, MIN_IDLE);
		expect(runner.list()[0]?.status).toBe("completed");
		expect(completes.length).toBe(completesAfterTurn1 + 1);
		expect(concurrency.runningCount(model)).toBe(0);
	});

	test("resume rejects on a running task (taskStillRunning), task unchanged", async () => {
		const h = makeLifecycleClient();
		const { runner, concurrency } = makeRunner(h);
		const model = "anthropic/opus";
		const launched = runner.launch(baseReq({ model }));
		await flush();
		const task = await launched;
		expect(task.status).toBe("running");

		await expect(runner.resume(task.id, "x")).rejects.toThrow(
			/taskStillRunning/,
		);
		expect(runner.list()[0]?.status).toBe("running");
		expect(concurrency.runningCount(model)).toBe(1);
	});

	test("resume rejects on expired session (sessionExpired), task stays terminal", async () => {
		const h = makeLifecycleClient();
		const { runner, concurrency } = makeRunner(h);
		const model = "anthropic/opus";
		h.setNextCreateId("ses_y");
		const launched = runner.launch(baseReq({ model }));
		await flush();
		const task = await launched;
		await runner.cancel(task.id);
		expect(runner.list()[0]?.status).toBe("cancelled");

		// session now gone.
		h.setGetFails("ses_y", true);
		const promptsBefore = h.promptCalls.length;

		await expect(runner.resume(task.id, "x")).rejects.toThrow(/sessionExpired/);
		// task unchanged, no slot re-acquired, no new prompt.
		expect(runner.list()[0]?.status).toBe("cancelled");
		expect(concurrency.runningCount(model)).toBe(0);
		expect(h.promptCalls.length).toBe(promptsBefore);
	});

	test("stale-idle protection: an idle from the previous turn arriving right after resume must not complete the new turn", async () => {
		const h = makeLifecycleClient();
		const { runner, concurrency, clock, timers } = makeRunner(h);
		const model = "anthropic/opus";

		// turn 1: launch + complete.
		h.setNextCreateId("ses_z");
		h.setMessages("ses_z", [
			{ info: { role: "assistant" }, parts: [{ type: "text", text: "old" }] },
		]);
		clock.set(1000);
		const launched = runner.launch(baseReq({ model }));
		await flush();
		const task = await launched;
		await completeViaIdle(runner, timers, clock, "ses_z", 1000, MIN_IDLE);
		expect(runner.list()[0]?.status).toBe("completed");

		// resume the same session at a later time (output cache for ses_z would be
		// a positive from the previous turn — must be invalidated).
		h.freshPrompt();
		const resumeAt = 100000;
		clock.set(resumeAt);
		await runner.resume(task.id, "new turn");
		expect(runner.list()[0]?.status).toBe("running");

		// a STALE idle arrives immediately after resume (same time, no new activity).
		// Grace has NOT elapsed for the new turn (startedAt reset to resumeAt).
		await runner.handleEvent(idleEvent("ses_z"));
		await flush();
		// must NOT have completed: still running.
		expect(runner.list()[0]?.status).toBe("running");
		expect(concurrency.runningCount(model)).toBe(1);
	});
});

describe("createSessionRunner — readOutput", () => {
	function makeRunner(h: ReturnType<typeof makeLifecycleClient>) {
		const concurrency = new ConcurrencyManager();
		const runner = createSessionRunner({
			client: h.client,
			concurrency,
			ids: createIdGenerator(),
			clock: fixedClock(),
			startPoll: false,
		});
		return { runner, concurrency };
	}

	test("readOutput on a running task: partial output, status running, summary = last assistant text", async () => {
		const h = makeLifecycleClient();
		const { runner } = makeRunner(h);
		h.setNextCreateId("ses_r");
		const launched = runner.launch(baseReq({ model: "anthropic/opus" }));
		await flush();
		const task = await launched;
		expect(task.status).toBe("running");

		h.setMessages("ses_r", [
			{ info: { role: "user" }, parts: [{ type: "text", text: "hi" }] },
			{
				info: { role: "assistant" },
				parts: [
					{ type: "text", text: "partial " },
					{ type: "text", text: "answer" },
				],
			},
		]);

		const out = await runner.readOutput(task.id);
		expect(out.status).toBe("running");
		expect(out.summaryText).toBe("partial answer");
		expect(out.messages).toBeUndefined(); // no full requested
	});

	test("readOutput full: synthetic parts dropped, long tool result truncated at 2000, error-matching tool result head+tail preserved", async () => {
		const h = makeLifecycleClient();
		const { runner } = makeRunner(h);
		h.setNextCreateId("ses_f");
		const launched = runner.launch(baseReq({ model: "anthropic/opus" }));
		await flush();
		const task = await launched;

		const longOk = "x".repeat(5000); // non-error: plain cap at 2000
		const longErr = `${"A".repeat(3000)}ERROR boom ${"B".repeat(3000)}`; // matches /error/i
		h.setMessages("ses_f", [
			{
				info: { role: "user" },
				parts: [
					{ type: "text", text: "real" },
					{ type: "text", text: "SYNTH", synthetic: true },
				],
			},
			{
				info: { role: "assistant" },
				parts: [
					{ type: "text", text: "answer" },
					{
						type: "tool",
						state: { status: "completed", output: longOk },
					},
					{
						type: "tool",
						state: { status: "error", error: longErr },
					},
				],
			},
		]);

		const out = await runner.readOutput(task.id, { full: true });
		expect(out.status).toBe("running");
		expect(out.summaryText).toBe("answer");
		expect(out.messages).toBeDefined();
		const msgs = out.messages ?? [];

		// synthetic part dropped from the user message.
		const userMsg = msgs.find((m) => m.role === "user");
		expect(userMsg?.parts.map((p) => p.text)).toEqual(["real"]);

		const asst = msgs.find((m) => m.role === "assistant");
		const toolParts = (asst?.parts ?? []).filter((p) => p.type === "tool");
		expect(toolParts).toHaveLength(2);

		// plain (non-error) tool output capped at 2000.
		const okText = toolParts[0]?.text ?? "";
		expect(okText.length).toBe(2000);

		// error tool result: head 1200 + tail 600 + marker (NOT a plain 2000 cap).
		const errText = toolParts[1]?.text ?? "";
		expect(errText).toContain("…[truncated");
		expect(errText.startsWith("A".repeat(1200))).toBe(true);
		expect(errText.endsWith("B".repeat(600))).toBe(true);
	});

	test("readOutput on pending (no session) → graceful, no client call", async () => {
		const h = makeLifecycleClient();
		// limit 0... use limit 1 with one slot held so the second stays pending.
		const concurrency = new ConcurrencyManager({ defaultConcurrency: 1 });
		const runner = createSessionRunner({
			client: h.client,
			concurrency,
			ids: createIdGenerator(),
			clock: fixedClock(),
			startPoll: false,
		});
		const model = "anthropic/opus";
		h.setNextCreateId("ses_a");
		const first = runner.launch(baseReq({ model }));
		await flush();
		await first;
		const second = runner.launch(baseReq({ model, description: "pending" }));
		await flush();
		const pending = runner.list().find((t) => t.description === "pending");
		if (!pending) {
			throw new Error("expected pending task");
		}
		expect(pending.status).toBe("pending");
		expect(pending.sessionID).toBeUndefined();

		const messagesBefore = h.messagesCalls.length;
		const out = await runner.readOutput(pending.id);
		expect(out.status).toBe("pending");
		expect(out.summaryText).toBe("");
		// NO messages call for a session-less task.
		expect(h.messagesCalls.length).toBe(messagesBefore);

		// cleanup
		await runner.cancel(pending.id);
		await runner.cancel((await first).id);
		void second;
	});

	test("readOutput on expired-session terminal → graceful, no rejection, summary = task.error", async () => {
		const h = makeLifecycleClient();
		const { runner } = makeRunner(h);
		h.setNextCreateId("ses_e");
		const launched = runner.launch(baseReq({ model: "anthropic/opus" }));
		await flush();
		const task = await launched;
		await runner.cancel(task.id);

		// messages now fails (session gone).
		h.client.session.messages = () => Promise.reject(new Error("gone"));

		const out = await runner.readOutput(task.id);
		expect(out.status).toBe("cancelled");
		expect(out.summaryText).toBe("cancelled by user");
	});
});

describe("createSessionRunner — slot accounting baseline", () => {
	test("slot accounting returns to baseline after launch+cancel, launch+complete, and resume+complete", async () => {
		const h = makeLifecycleClient();
		const concurrency = new ConcurrencyManager();
		const clock = mutableClock(1000);
		const timers = makeTimers();
		const runner = createSessionRunner({
			client: h.client,
			concurrency,
			ids: createIdGenerator(),
			clock,
			startPoll: false,
			setTimer: timers.setTimer,
			setIntervalFn: timers.setIntervalFn,
			config: { minIdleMs: 5000, pollMs: 5000 },
		});
		const model = "anthropic/opus";

		// launch + cancel
		h.setNextCreateId("ses_1");
		const a = runner.launch(baseReq({ model }));
		await flush();
		await runner.cancel((await a).id);
		expect(concurrency.runningCount(model)).toBe(0);

		// launch + complete via idle
		h.setNextCreateId("ses_2");
		h.setMessages("ses_2", [
			{ info: { role: "assistant" }, parts: [{ type: "text", text: "ok" }] },
		]);
		clock.set(2000);
		const b = runner.launch(baseReq({ model }));
		await flush();
		const bt = await b;
		await completeViaIdle(runner, timers, clock, "ses_2", 2000, 5000);
		expect(concurrency.runningCount(model)).toBe(0);

		// resume + complete via idle
		h.freshPrompt();
		clock.set(50000);
		await runner.resume(bt.id, "again");
		expect(concurrency.runningCount(model)).toBe(1);
		await completeViaIdle(runner, timers, clock, "ses_2", 50000, 5000);
		expect(concurrency.runningCount(model)).toBe(0);
	});
});
