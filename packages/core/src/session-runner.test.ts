import { beforeEach, describe, expect, test } from "bun:test";
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
		runner.markCancelled(queued.id);
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
		runner.markCancelled(task.id);

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
