import { describe, expect, test } from "bun:test";
import {
	type CompletionGateDeps,
	createCompletionGate,
	type IntervalFactory,
	type TimerFactory,
} from "./completion";
import type { BgTask, Clock, TaskStatus } from "./types";

// ---- controllable fakes (no real timers, no real sleeps) -----------------

/**
 * A manual timer/interval factory. `fire(id)` runs a one-shot timer's callback;
 * `tick()` runs every live interval callback once. Nothing fires on its own.
 */
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
		liveTimerCount: () => timers.size,
		liveIntervalCount: () => intervals.size,
	};
}

function flush(): Promise<void> {
	return (async () => {
		for (let i = 0; i < 12; i++) {
			await Promise.resolve();
		}
	})();
}

/** A mutable clock so we can advance time across grace/stale windows. */
function makeClock(start = 1000): Clock & { set: (t: number) => void } {
	let t = start;
	return { now: () => t, set: (v) => (t = v) };
}

interface MessageEntry {
	info: { role: "user" | "assistant" };
	parts: Array<{ type: string; text?: string }>;
}

/**
 * Scripted SDK surface for the gate: messages/get/abort. Each is overridable
 * per session id so tests script validation, existence, and abort behavior.
 */
function makeSdk() {
	const messagesBySession = new Map<string, MessageEntry[]>();
	const getFails = new Set<string>();
	const abortCalls: string[] = [];
	let abortRejects = false;

	return {
		abortCalls,
		setMessages: (id: string, msgs: MessageEntry[]) =>
			messagesBySession.set(id, msgs),
		setGetFails: (id: string, fails: boolean) =>
			fails ? getFails.add(id) : getFails.delete(id),
		setAbortRejects: (v: boolean) => (abortRejects = v),
		client: {
			messages: async (id: string) => messagesBySession.get(id) ?? [],
			get: async (id: string) => {
				if (getFails.has(id)) throw new Error("session gone");
				return { id };
			},
			abort: async (id: string) => {
				abortCalls.push(id);
				if (abortRejects) throw new Error("abort failed");
			},
		},
	};
}

const VALID_OUTPUT: MessageEntry[] = [
	{ info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] },
];
const EMPTY_OUTPUT: MessageEntry[] = [
	{ info: { role: "assistant" }, parts: [{ type: "text", text: "" }] },
];

interface Harness {
	gate: ReturnType<typeof createCompletionGate>;
	task: BgTask;
	tasks: Map<string, BgTask>;
	timers: ReturnType<typeof makeTimers>;
	sdk: ReturnType<typeof makeSdk>;
	clock: Clock & { set: (t: number) => void };
	completes: BgTask[];
	freed: string[];
}

interface HarnessOpts {
	status?: TaskStatus;
	startedAt?: number;
	staleTimeoutMs?: number;
	minIdleMs?: number;
	pollMs?: number;
	maxGetMisses?: number;
}

function makeHarness(opts: HarnessOpts = {}): Harness {
	const clock = makeClock(1000);
	const timers = makeTimers();
	const sdk = makeSdk();
	const completes: BgTask[] = [];
	const freed: string[] = [];

	const task: BgTask = {
		id: "bg_test0001",
		sessionID: "ses_child",
		parentSessionID: "ses_parent",
		description: "do the thing",
		agent: "build",
		status: opts.status ?? "running",
		createdAt: 1000,
		startedAt: opts.startedAt ?? 1000,
		depth: 0,
		concurrencyKey: "anthropic/opus",
	};
	const tasks = new Map<string, BgTask>([[task.id, task]]);

	const deps: CompletionGateDeps = {
		getTask: (id) => tasks.get(id),
		runningTasks: () =>
			[...tasks.values()].filter(
				(t) => t.status === "running" || t.status === "pending",
			),
		freeSlot: (t) => {
			freed.push(t.id);
		},
		abortSession: (id) => sdk.client.abort(id),
		fetchMessages: (id) => sdk.client.messages(id),
		sessionExists: async (id) => {
			await sdk.client.get(id);
		},
		clock,
		persist: async () => {},
		onTaskComplete: (t) => {
			completes.push(t);
		},
		setTimer: timers.setTimer,
		setIntervalFn: timers.setIntervalFn,
		config: {
			minIdleMs: opts.minIdleMs ?? 5000,
			pollMs: opts.pollMs ?? 5000,
			staleTimeoutMs: opts.staleTimeoutMs ?? 45 * 60 * 1000,
			maxGetMisses: opts.maxGetMisses ?? 3,
		},
	};

	const gate = createCompletionGate(deps);
	return { gate, task, tasks, timers, sdk, clock, completes, freed };
}

// ===========================================================================

describe("tryComplete — synchronous mutex", () => {
	test("first flip wins, returns true; status set in same tick before any await", () => {
		const h = makeHarness();
		const won = h.gate.tryComplete(h.task.id, "completed");
		// status flipped synchronously, BEFORE any awaited teardown.
		expect(h.task.status).toBe("completed");
		// tryComplete returns a boolean synchronously (the flip result).
		expect(won).toBe(true);
	});

	test("second call on an already-terminal task is a no-op (returns false)", async () => {
		const h = makeHarness();
		expect(h.gate.tryComplete(h.task.id, "completed")).toBe(true);
		await flush();
		const before = { ...h.task };
		expect(h.gate.tryComplete(h.task.id, "error", "late")).toBe(false);
		await flush();
		// no status/error/completedAt mutation, single completion emit, single free.
		expect(h.task.status).toBe(before.status);
		expect(h.task.error).toBeUndefined();
		expect(h.completes).toHaveLength(1);
		expect(h.freed).toEqual([h.task.id]);
	});

	test("unknown task id → false, no throw", () => {
		const h = makeHarness();
		expect(h.gate.tryComplete("bg_nope", "completed")).toBe(false);
	});

	test("teardown order: slot freed, session NOT aborted on completed, completedAt + persist + callback", async () => {
		const h = makeHarness();
		h.gate.tryComplete(h.task.id, "completed");
		await flush();
		expect(h.freed).toEqual([h.task.id]);
		expect(h.sdk.abortCalls).toEqual([]); // completed does not abort
		expect(h.task.completedAt).toBe(1000);
		expect(h.completes).toHaveLength(1);
	});

	test("cancelled terminal awaits abort; abort failure is caught, not rethrown", async () => {
		const h = makeHarness();
		h.sdk.setAbortRejects(true);
		h.gate.tryComplete(h.task.id, "cancelled", "stale");
		await flush();
		expect(h.task.status).toBe("cancelled");
		expect(h.task.error).toBe("stale");
		expect(h.sdk.abortCalls).toEqual(["ses_child"]); // awaited even though it rejects
		expect(h.completes).toHaveLength(1); // teardown completed despite abort failure
	});
});

describe("handleEvent — session.idle gating", () => {
	test("idle after min-grace with valid output → completes", async () => {
		const h = makeHarness();
		h.sdk.setMessages("ses_child", VALID_OUTPUT);
		h.clock.set(1000 + 5000); // grace elapsed
		await h.gate.handleEvent({
			type: "session.idle",
			properties: { sessionID: "ses_child" },
		} as never);
		await flush();
		expect(h.task.status).toBe("completed");
		expect(h.completes).toHaveLength(1);
	});

	test("idle with empty assistant output → does NOT complete (left to safety nets)", async () => {
		const h = makeHarness();
		h.sdk.setMessages("ses_child", EMPTY_OUTPUT);
		h.clock.set(1000 + 5000);
		await h.gate.handleEvent({
			type: "session.idle",
			properties: { sessionID: "ses_child" },
		} as never);
		await flush();
		expect(h.task.status).toBe("running");
		expect(h.completes).toHaveLength(0);
	});

	test("idle before min-grace defers via timer; re-check completes after grace", async () => {
		const h = makeHarness({ minIdleMs: 5000 });
		h.sdk.setMessages("ses_child", VALID_OUTPUT);
		// only 2s elapsed → too early, must defer.
		h.clock.set(1000 + 2000);
		await h.gate.handleEvent({
			type: "session.idle",
			properties: { sessionID: "ses_child" },
		} as never);
		await flush();
		expect(h.task.status).toBe("running"); // deferred, not completed yet
		expect(h.timers.liveTimerCount()).toBe(1);

		// grace now elapsed; fire the deferred timer.
		h.clock.set(1000 + 5000);
		h.timers.fireAllTimers();
		await flush();
		expect(h.task.status).toBe("completed");
	});

	test("idle deferral re-check no-ops when task was cancelled during the wait", async () => {
		const h = makeHarness({ minIdleMs: 5000 });
		h.sdk.setMessages("ses_child", VALID_OUTPUT);
		h.clock.set(1000 + 2000);
		await h.gate.handleEvent({
			type: "session.idle",
			properties: { sessionID: "ses_child" },
		} as never);
		await flush();
		expect(h.timers.liveTimerCount()).toBe(1);

		// cancel during the deferral.
		h.gate.tryComplete(h.task.id, "cancelled", "user cancelled");
		await flush();
		expect(h.task.status).toBe("cancelled");

		// the deferred timer fires late — must not resurrect/complete.
		h.clock.set(1000 + 5000);
		h.timers.fireAllTimers();
		await flush();
		expect(h.task.status).toBe("cancelled");
		expect(h.completes).toHaveLength(1); // only the cancel
	});

	test("double idle events → second is a no-op (single completion)", async () => {
		const h = makeHarness();
		h.sdk.setMessages("ses_child", VALID_OUTPUT);
		h.clock.set(1000 + 5000);
		const idle = {
			type: "session.idle",
			properties: { sessionID: "ses_child" },
		} as never;
		await h.gate.handleEvent(idle);
		await h.gate.handleEvent(idle);
		await flush();
		expect(h.task.status).toBe("completed");
		expect(h.completes).toHaveLength(1);
		expect(h.freed).toEqual([h.task.id]);
	});

	test("session.error for tracked session → error with message", async () => {
		const h = makeHarness();
		await h.gate.handleEvent({
			type: "session.error",
			properties: {
				sessionID: "ses_child",
				error: { name: "ProviderAuthError", data: { message: "no creds" } },
			},
		} as never);
		await flush();
		expect(h.task.status).toBe("error");
		expect(h.completes).toHaveLength(1);
	});

	test("idle for an untracked session is ignored", async () => {
		const h = makeHarness();
		await h.gate.handleEvent({
			type: "session.idle",
			properties: { sessionID: "ses_unknown" },
		} as never);
		await flush();
		expect(h.task.status).toBe("running");
	});

	test("unknown event type is ignored silently", async () => {
		const h = makeHarness();
		await h.gate.handleEvent({
			type: "file.edited",
			properties: { file: "x" },
		} as never);
		await flush();
		expect(h.task.status).toBe("running");
	});
});

describe("safety poll", () => {
	test("poll completes a running task that missed its idle event (valid + grace elapsed)", async () => {
		const h = makeHarness({ pollMs: 5000, minIdleMs: 5000 });
		h.sdk.setMessages("ses_child", VALID_OUTPUT);
		h.gate.start();
		// session went quiet: last activity older than poll period.
		h.clock.set(1000 + 6000);
		h.timers.tick();
		await flush();
		expect(h.task.status).toBe("completed");
	});

	test("N consecutive session.get failures → error('session gone')", async () => {
		const h = makeHarness({ pollMs: 5000, maxGetMisses: 3 });
		h.sdk.setGetFails("ses_child", true);
		h.gate.start();
		for (let i = 0; i < 3; i++) {
			h.clock.set(1000 + 6000 * (i + 1));
			h.timers.tick();
			await flush();
		}
		expect(h.task.status).toBe("error");
		expect(h.task.error).toContain("session gone");
	});

	test("get failures below threshold do not complete", async () => {
		const h = makeHarness({ pollMs: 5000, maxGetMisses: 3 });
		h.sdk.setGetFails("ses_child", true);
		h.gate.start();
		for (let i = 0; i < 2; i++) {
			h.clock.set(1000 + 6000 * (i + 1));
			h.timers.tick();
			await flush();
		}
		expect(h.task.status).toBe("running");
	});

	test("stale timeout → cancelled with anti-replacement instruction", async () => {
		const h = makeHarness({ pollMs: 5000, staleTimeoutMs: 45 * 60 * 1000 });
		h.gate.start();
		h.clock.set(1000 + 46 * 60 * 1000); // past stale window
		h.timers.tick();
		await flush();
		expect(h.task.status).toBe("cancelled");
		expect(h.task.error).toMatch(/do not create a replacement/i);
		expect(h.sdk.abortCalls).toEqual(["ses_child"]);
	});

	test("poll skips tasks that are still active (last activity within poll period)", async () => {
		const h = makeHarness({ pollMs: 5000 });
		h.sdk.setMessages("ses_child", VALID_OUTPUT);
		h.gate.start();
		// recent activity keeps it out of the quiet set.
		h.gate.handleEvent({
			type: "message.updated",
			properties: { info: { sessionID: "ses_child" } },
		} as never);
		h.clock.set(1000 + 2000); // only 2s since activity < pollMs
		h.timers.tick();
		await flush();
		expect(h.task.status).toBe("running");
	});

	test("poll has a re-entrancy guard (overlapping ticks do not double-process)", async () => {
		const h = makeHarness({ pollMs: 5000 });
		h.sdk.setMessages("ses_child", VALID_OUTPUT);
		h.gate.start();
		h.clock.set(1000 + 6000);
		// two synchronous ticks before microtasks drain.
		h.timers.tick();
		h.timers.tick();
		await flush();
		expect(h.completes).toHaveLength(1);
		expect(h.freed).toEqual([h.task.id]);
	});
});

describe("awaitCompletion", () => {
	test("resolves on completed", async () => {
		const h = makeHarness();
		const p = h.gate.awaitCompletion(h.task.id);
		h.gate.tryComplete(h.task.id, "completed");
		const t = await p;
		expect(t.status).toBe("completed");
	});

	test("resolves on error", async () => {
		const h = makeHarness();
		const p = h.gate.awaitCompletion(h.task.id);
		h.gate.tryComplete(h.task.id, "error", "boom");
		expect((await p).status).toBe("error");
	});

	test("resolves on cancelled", async () => {
		const h = makeHarness();
		const p = h.gate.awaitCompletion(h.task.id);
		h.gate.tryComplete(h.task.id, "cancelled");
		expect((await p).status).toBe("cancelled");
	});

	test("already-terminal task resolves immediately", async () => {
		const h = makeHarness({ status: "completed" });
		expect((await h.gate.awaitCompletion(h.task.id)).status).toBe("completed");
	});

	test("timeout rejects WITHOUT completing the task; registry entry cleared", async () => {
		const h = makeHarness();
		const p = h.gate.awaitCompletion(h.task.id, 1000);
		await flush();
		// fire the timeout timer.
		h.timers.fireAllTimers();
		await expect(p).rejects.toThrow(/timeout/i);
		// task NOT completed by the timeout.
		expect(h.task.status).toBe("running");
		expect(h.completes).toHaveLength(0);
	});

	test("dispose rejects pending waiters with a disposal error, no status mutation", async () => {
		const h = makeHarness();
		const p = h.gate.awaitCompletion(h.task.id);
		await h.gate.dispose();
		await expect(p).rejects.toThrow(/dispos/i);
		expect(h.task.status).toBe("running"); // no mutation on dispose
	});
});

describe("dispose", () => {
	test("clears the poll interval and any live timers", async () => {
		const h = makeHarness();
		h.gate.start();
		expect(h.timers.liveIntervalCount()).toBe(1);
		await h.gate.dispose();
		expect(h.timers.liveIntervalCount()).toBe(0);
		expect(h.timers.liveTimerCount()).toBe(0);
	});
});

// ===========================================================================
// RACE TESTS (the contract). Manual timers/deferreds, no real sleeps.
// ===========================================================================

describe("RACE: idle vs safety-poll in the same tick", () => {
	test("exactly one winner: single onTaskComplete, single completedAt, single free", async () => {
		const h = makeHarness({ pollMs: 5000, minIdleMs: 5000 });
		h.sdk.setMessages("ses_child", VALID_OUTPUT);
		h.gate.start();
		h.clock.set(1000 + 6000);

		// idle event and poll tick fire in the same synchronous tick.
		const idle = h.gate.handleEvent({
			type: "session.idle",
			properties: { sessionID: "ses_child" },
		} as never);
		h.timers.tick();
		await idle;
		await flush();

		expect(h.task.status).toBe("completed");
		expect(h.completes).toHaveLength(1);
		expect(h.freed).toEqual([h.task.id]);
	});
});

describe("RACE: cancel vs idle (both orders)", () => {
	test("cancel first → cancel wins, idle is a no-op", async () => {
		const h = makeHarness({ minIdleMs: 0 });
		h.sdk.setMessages("ses_child", VALID_OUTPUT);
		expect(h.gate.tryComplete(h.task.id, "cancelled")).toBe(true);
		await h.gate.handleEvent({
			type: "session.idle",
			properties: { sessionID: "ses_child" },
		} as never);
		await flush();
		expect(h.task.status).toBe("cancelled");
		expect(h.completes).toHaveLength(1);
		expect(h.freed).toEqual([h.task.id]);
	});

	test("idle first → completed wins, later cancel is a no-op", async () => {
		const h = makeHarness({ minIdleMs: 0 });
		h.sdk.setMessages("ses_child", VALID_OUTPUT);
		h.clock.set(1000 + 1);
		await h.gate.handleEvent({
			type: "session.idle",
			properties: { sessionID: "ses_child" },
		} as never);
		await flush();
		expect(h.task.status).toBe("completed");
		expect(h.gate.tryComplete(h.task.id, "cancelled")).toBe(false);
		await flush();
		expect(h.task.status).toBe("completed");
		expect(h.completes).toHaveLength(1);
		expect(h.freed).toEqual([h.task.id]);
	});
});

describe("RACE: stale timeout vs real completion", () => {
	test("one winner, no double teardown (both fire same tick)", async () => {
		const h = makeHarness({ pollMs: 5000, staleTimeoutMs: 1, minIdleMs: 0 });
		h.sdk.setMessages("ses_child", VALID_OUTPUT);
		h.gate.start();
		h.clock.set(1000 + 6000); // both stale and grace satisfied

		// real completion via idle racing the poll's stale check in one tick.
		const idle = h.gate.handleEvent({
			type: "session.idle",
			properties: { sessionID: "ses_child" },
		} as never);
		h.timers.tick();
		await idle;
		await flush();

		// exactly one terminal, one free, one callback regardless of who won.
		expect(["completed", "cancelled"]).toContain(h.task.status);
		expect(h.completes).toHaveLength(1);
		expect(h.freed).toEqual([h.task.id]);
	});
});

describe("RACE: slot accounting back to baseline", () => {
	test("every terminal path frees the slot exactly once", async () => {
		for (const terminal of ["completed", "error", "cancelled"] as const) {
			const h = makeHarness();
			h.gate.tryComplete(h.task.id, terminal);
			await flush();
			expect(h.freed).toEqual([h.task.id]); // freed exactly once
		}
	});

	test("the happy-path completion releases the slot the launch path held", async () => {
		const h = makeHarness();
		h.sdk.setMessages("ses_child", VALID_OUTPUT);
		h.clock.set(1000 + 5000);
		await h.gate.handleEvent({
			type: "session.idle",
			properties: { sessionID: "ses_child" },
		} as never);
		await flush();
		expect(h.freed).toEqual([h.task.id]);
	});
});
