import { describe, expect, test } from "bun:test";
import {
	type CadenceClient,
	createCadenceEngine,
	GOAL_COMPLETE,
	type IntervalHandle,
} from "./engine";
import type { CadenceStore, Directive } from "./store";

/** In-memory store: a Map keyed by directive id. */
function fakeStore(): CadenceStore & { map: Map<string, Directive> } {
	const map = new Map<string, Directive>();
	return {
		map,
		async save(directive) {
			map.set(directive.id, { ...directive });
		},
		async load() {
			return [...map.values()].map((d) => ({ ...d }));
		},
		async delete(id) {
			map.delete(id);
		},
	};
}

/** Fake client recording promptAsync calls; messages returns a canned reply. */
function fakeClient(lastReply = ""): CadenceClient & {
	prompts: Array<{ sessionID: string; text: string }>;
	reply: { value: string };
} {
	const prompts: Array<{ sessionID: string; text: string }> = [];
	const reply = { value: lastReply };
	return {
		prompts,
		reply,
		session: {
			async promptAsync(args) {
				prompts.push({
					sessionID: args.path.id,
					text: args.body.parts[0]?.text ?? "",
				});
				return undefined;
			},
			async messages() {
				return {
					data: [
						{
							info: { role: "assistant" },
							parts: [{ type: "text", text: reply.value }],
						},
					],
				};
			},
		},
	};
}

/** Synchronous fake timer: captures the callback so tests drive ticks manually. */
function fakeTimers(): {
	setIntervalFn: (cb: () => void, ms: number) => IntervalHandle;
	tick(): Promise<void>;
	cleared: { count: number };
	armed: { count: number };
} {
	let cb: (() => void) | undefined;
	const cleared = { count: 0 };
	const armed = { count: 0 };
	return {
		cleared,
		armed,
		setIntervalFn(fn) {
			cb = fn;
			armed.count += 1;
			return {
				clear() {
					cleared.count += 1;
					cb = undefined;
				},
			};
		},
		async tick() {
			cb?.();
			// loopTick awaits messages + promptAsync + save; flush generously so
			// every microtask in the chain settles before assertions run.
			for (let i = 0; i < 10; i += 1) {
				await Promise.resolve();
			}
		},
	};
}

const clock = { now: () => 1000 };

describe("loop", () => {
	test("each tick re-prompts; stops after max_iterations", async () => {
		const client = fakeClient();
		const store = fakeStore();
		const timers = fakeTimers();
		const engine = createCadenceEngine({
			client,
			store,
			setIntervalFn: timers.setIntervalFn,
			clock,
		});

		const directive = await engine.start({
			sessionID: "s1",
			kind: "loop",
			instruction: "do the thing",
			intervalMs: 5000,
			maxIterations: 3,
		});

		await timers.tick();
		await timers.tick();
		await timers.tick();
		// 4th tick: iterations already == max → marks done, no further prompt.
		await timers.tick();

		expect(client.prompts.length).toBe(3);
		expect(client.prompts.every((p) => p.text === "do the thing")).toBe(true);
		// Terminal → deleted from the store and evicted from list().
		expect(store.map.has(directive.id)).toBe(false);
		expect(engine.list("s1")).toHaveLength(0);
		expect(timers.cleared.count).toBeGreaterThanOrEqual(1);
	});

	test("until: sentinel in last reply stops without re-prompting", async () => {
		const client = fakeClient(`all done\n${GOAL_COMPLETE}`);
		const store = fakeStore();
		const timers = fakeTimers();
		const engine = createCadenceEngine({
			client,
			store,
			setIntervalFn: timers.setIntervalFn,
			clock,
		});

		const directive = await engine.start({
			sessionID: "s1",
			kind: "loop",
			instruction: "refine",
			intervalMs: 5000,
			until: "the doc is complete",
			maxIterations: 10,
		});

		await timers.tick();

		expect(client.prompts.length).toBe(0);
		expect(store.map.has(directive.id)).toBe(false);
	});

	test("until: non-sentinel reply re-prompts with the sentinel ask", async () => {
		const client = fakeClient("still working");
		const store = fakeStore();
		const timers = fakeTimers();
		const engine = createCadenceEngine({
			client,
			store,
			setIntervalFn: timers.setIntervalFn,
			clock,
		});

		await engine.start({
			sessionID: "s1",
			kind: "loop",
			instruction: "refine",
			intervalMs: 5000,
			until: "the doc is complete",
			maxIterations: 10,
		});

		await timers.tick();

		expect(client.prompts.length).toBe(1);
		expect(client.prompts[0]?.text).toContain("refine");
		expect(client.prompts[0]?.text).toContain("the doc is complete");
		expect(client.prompts[0]?.text).toContain(GOAL_COMPLETE);
	});

	test("intervalMs is clamped to the 1000ms floor", async () => {
		const client = fakeClient();
		const store = fakeStore();
		const timers = fakeTimers();
		const engine = createCadenceEngine({
			client,
			store,
			setIntervalFn: timers.setIntervalFn,
			clock,
		});

		const directive = await engine.start({
			sessionID: "s1",
			kind: "loop",
			instruction: "x",
			intervalMs: 10,
		});

		expect(store.map.get(directive.id)?.intervalMs).toBe(1000);
	});
});

describe("stop / dispose", () => {
	test("stop halts a loop — no further re-prompts", async () => {
		const client = fakeClient();
		const store = fakeStore();
		const timers = fakeTimers();
		const engine = createCadenceEngine({
			client,
			store,
			setIntervalFn: timers.setIntervalFn,
			clock,
		});

		const directive = await engine.start({
			sessionID: "s1",
			kind: "loop",
			instruction: "go",
			intervalMs: 5000,
			maxIterations: 10,
		});

		await timers.tick();
		expect(client.prompts.length).toBe(1);

		const stopped = await engine.stop(directive.id, "s1");
		expect(stopped?.status).toBe("stopped");
		await timers.tick();

		expect(client.prompts.length).toBe(1);
		// Stopped → deleted from the store and evicted from list().
		expect(store.map.has(directive.id)).toBe(false);
		expect(engine.list("s1")).toHaveLength(0);
	});

	test("dispose clears timers — no re-prompts after dispose", async () => {
		const client = fakeClient();
		const store = fakeStore();
		const timers = fakeTimers();
		const engine = createCadenceEngine({
			client,
			store,
			setIntervalFn: timers.setIntervalFn,
			clock,
		});

		await engine.start({
			sessionID: "s1",
			kind: "loop",
			instruction: "go",
			intervalMs: 5000,
			maxIterations: 10,
		});

		engine.dispose();
		await timers.tick();

		expect(client.prompts.length).toBe(0);
		expect(timers.cleared.count).toBe(1);
	});
});

describe("recover", () => {
	test("a persisted active loop is re-armed and re-prompts on tick", async () => {
		const client = fakeClient();
		const store = fakeStore();
		store.map.set("cadence_persisted", {
			id: "cadence_persisted",
			sessionID: "s1",
			kind: "loop",
			instruction: "resume me",
			intervalMs: 5000,
			iterations: 0,
			maxIterations: 10,
			status: "active",
			createdAt: 1,
		});
		const timers = fakeTimers();
		const engine = createCadenceEngine({
			client,
			store,
			setIntervalFn: timers.setIntervalFn,
			clock,
		});

		await engine.recover();
		expect(timers.armed.count).toBe(1);

		await timers.tick();
		expect(client.prompts.length).toBe(1);
		expect(client.prompts[0]?.text).toBe("resume me");
	});

	test("a persisted done loop is NOT re-armed", async () => {
		const client = fakeClient();
		const store = fakeStore();
		store.map.set("cadence_done", {
			id: "cadence_done",
			sessionID: "s1",
			kind: "loop",
			instruction: "x",
			intervalMs: 5000,
			iterations: 10,
			maxIterations: 10,
			status: "done",
			createdAt: 1,
		});
		const timers = fakeTimers();
		const engine = createCadenceEngine({
			client,
			store,
			setIntervalFn: timers.setIntervalFn,
			clock,
		});

		await engine.recover();
		expect(timers.armed.count).toBe(0);
	});
});

describe("goal (idle-driven)", () => {
	function idle(sessionID: string): unknown {
		return { type: "session.idle", properties: { sessionID } };
	}

	test("non-sentinel last message re-prompts and increments", async () => {
		const client = fakeClient("not yet");
		const store = fakeStore();
		const engine = createCadenceEngine({ client, store, clock });

		const directive = await engine.start({
			sessionID: "s1",
			kind: "goal",
			instruction: "ship the feature",
			maxIterations: 5,
		});

		await engine.handleEvent(idle("s1"));

		expect(client.prompts.length).toBe(1);
		expect(client.prompts[0]?.text).toContain("ship the feature");
		expect(client.prompts[0]?.text).toContain(GOAL_COMPLETE);
		expect(store.map.get(directive.id)?.iterations).toBe(1);
		expect(store.map.get(directive.id)?.status).toBe("active");
	});

	test("sentinel last message marks done and stops", async () => {
		const client = fakeClient(`${GOAL_COMPLETE}`);
		const store = fakeStore();
		const engine = createCadenceEngine({ client, store, clock });

		const directive = await engine.start({
			sessionID: "s1",
			kind: "goal",
			instruction: "ship it",
			maxIterations: 5,
		});

		await engine.handleEvent(idle("s1"));

		expect(client.prompts.length).toBe(0);
		expect(store.map.has(directive.id)).toBe(false);
	});

	test("max_iterations gives up (marks done)", async () => {
		const client = fakeClient("not yet");
		const store = fakeStore();
		const engine = createCadenceEngine({ client, store, clock });

		const directive = await engine.start({
			sessionID: "s1",
			kind: "goal",
			instruction: "ship it",
			maxIterations: 1,
		});

		await engine.handleEvent(idle("s1")); // iter 0 -> 1, re-prompts
		await engine.handleEvent(idle("s1")); // iter 1 >= max -> gives up

		expect(client.prompts.length).toBe(1);
		expect(store.map.has(directive.id)).toBe(false);
	});

	test("idle for an unrelated session (no goal) is a no-op", async () => {
		const client = fakeClient("not yet");
		const store = fakeStore();
		const engine = createCadenceEngine({ client, store, clock });

		await engine.start({
			sessionID: "s1",
			kind: "goal",
			instruction: "ship it",
			maxIterations: 5,
		});

		await engine.handleEvent(idle("OTHER"));

		expect(client.prompts.length).toBe(0);
	});

	test("session.idle never affects a loop directive", async () => {
		const client = fakeClient("not yet");
		const store = fakeStore();
		const timers = fakeTimers();
		const engine = createCadenceEngine({
			client,
			store,
			setIntervalFn: timers.setIntervalFn,
			clock,
		});

		const directive = await engine.start({
			sessionID: "s1",
			kind: "loop",
			instruction: "loop me",
			intervalMs: 5000,
			maxIterations: 5,
		});

		await engine.handleEvent(idle("s1"));

		expect(client.prompts.length).toBe(0);
		expect(store.map.get(directive.id)?.iterations).toBe(0);
	});

	test("idle on a session with a loop AND a goal advances only the goal", async () => {
		const client = fakeClient("not yet");
		const store = fakeStore();
		const timers = fakeTimers();
		const engine = createCadenceEngine({
			client,
			store,
			setIntervalFn: timers.setIntervalFn,
			clock,
		});

		const loop = await engine.start({
			sessionID: "s1",
			kind: "loop",
			instruction: "loop me",
			intervalMs: 5000,
			maxIterations: 5,
		});
		const goal = await engine.start({
			sessionID: "s1",
			kind: "goal",
			instruction: "ship it",
			maxIterations: 5,
		});

		await engine.handleEvent(idle("s1"));

		// Exactly one re-prompt — the goal's — and it carries the goal instruction.
		expect(client.prompts.length).toBe(1);
		expect(client.prompts[0]?.text).toContain("ship it");
		expect(store.map.get(goal.id)?.iterations).toBe(1);
		// The loop is untouched: its iteration count stays at 0.
		expect(store.map.get(loop.id)?.iterations).toBe(0);
	});
});

describe("sentinel matching (exact line, not substring)", () => {
	function idle(sessionID: string): unknown {
		return { type: "session.idle", properties: { sessionID } };
	}

	test("goal: a mere mention of the sentinel does NOT complete", async () => {
		const client = fakeClient(`do not output ${GOAL_COMPLETE} yet`);
		const store = fakeStore();
		const engine = createCadenceEngine({ client, store, clock });

		const directive = await engine.start({
			sessionID: "s1",
			kind: "goal",
			instruction: "ship it",
			maxIterations: 5,
		});

		await engine.handleEvent(idle("s1"));

		// Not complete → re-prompted, still active.
		expect(client.prompts.length).toBe(1);
		expect(store.map.get(directive.id)?.status).toBe("active");
		expect(store.map.get(directive.id)?.iterations).toBe(1);
	});

	test("goal: the sentinel alone on its own line DOES complete", async () => {
		const client = fakeClient(`here is the result\n${GOAL_COMPLETE}\n`);
		const store = fakeStore();
		const engine = createCadenceEngine({ client, store, clock });

		const directive = await engine.start({
			sessionID: "s1",
			kind: "goal",
			instruction: "ship it",
			maxIterations: 5,
		});

		await engine.handleEvent(idle("s1"));

		expect(client.prompts.length).toBe(0);
		expect(store.map.has(directive.id)).toBe(false);
	});

	test("loop until: a mere mention does NOT complete; own-line DOES", async () => {
		const client = fakeClient(`reminder: ${GOAL_COMPLETE} is the sentinel`);
		const store = fakeStore();
		const timers = fakeTimers();
		const engine = createCadenceEngine({
			client,
			store,
			setIntervalFn: timers.setIntervalFn,
			clock,
		});

		const directive = await engine.start({
			sessionID: "s1",
			kind: "loop",
			instruction: "refine",
			intervalMs: 5000,
			until: "done?",
			maxIterations: 5,
		});

		// Mention only → keeps looping (re-prompts).
		await timers.tick();
		expect(client.prompts.length).toBe(1);
		expect(store.map.get(directive.id)?.status).toBe("active");

		// Now the sentinel lands on its own line → completes without a re-prompt.
		client.reply.value = `${GOAL_COMPLETE}`;
		await timers.tick();
		expect(client.prompts.length).toBe(1);
		expect(store.map.has(directive.id)).toBe(false);
	});
});

describe("in-flight guard + count-on-delivery", () => {
	/** Client whose messages()/promptAsync() resolve only when the test releases them. */
	function deferredClient(lastReply: string): CadenceClient & {
		prompts: number;
		releaseMessages(): void;
		releasePrompt(): void;
		failPrompt: { value: boolean };
	} {
		let prompts = 0;
		let resolveMessages: (() => void) | undefined;
		let resolvePrompt: (() => void) | undefined;
		const failPrompt = { value: false };
		return {
			get prompts() {
				return prompts;
			},
			failPrompt,
			releaseMessages() {
				resolveMessages?.();
				resolveMessages = undefined;
			},
			releasePrompt() {
				resolvePrompt?.();
				resolvePrompt = undefined;
			},
			session: {
				promptAsync() {
					return new Promise<unknown>((resolve, reject) => {
						resolvePrompt = () => {
							if (failPrompt.value) {
								reject(new Error("send failed"));
								return;
							}
							prompts += 1;
							resolve(undefined);
						};
					});
				},
				messages() {
					return new Promise((resolve) => {
						resolveMessages = () =>
							resolve({
								data: [
									{
										info: { role: "assistant" },
										parts: [{ type: "text", text: lastReply }],
									},
								],
							});
					});
				},
			},
		};
	}

	test("a messages fetch slower than the interval does not double-fire", async () => {
		const client = deferredClient("still working");
		const store = fakeStore();
		const timers = fakeTimers();
		const engine = createCadenceEngine({
			client,
			store,
			setIntervalFn: timers.setIntervalFn,
			clock,
		});

		const directive = await engine.start({
			sessionID: "s1",
			kind: "loop",
			instruction: "refine",
			intervalMs: 5000,
			until: "done?",
			maxIterations: 10,
		});

		// Tick 1 starts and blocks on the (slow) messages fetch.
		const t1 = timers.tick();
		// Tick 2 fires while tick 1 is still in flight → must be skipped entirely.
		const t2 = timers.tick();

		// Now let the first tick's messages resolve; flush so the engine reaches
		// the promptAsync call and registers its resolver, then release the prompt.
		client.releaseMessages();
		for (let i = 0; i < 10; i += 1) {
			await Promise.resolve();
		}
		client.releasePrompt();
		await t1;
		await t2;

		// Exactly ONE re-prompt and ONE increment, despite two ticks.
		expect(client.prompts).toBe(1);
		expect(store.map.get(directive.id)?.iterations).toBe(1);
	});

	test("a failed re-prompt does NOT advance the iteration count", async () => {
		const client = deferredClient("still working");
		const store = fakeStore();
		const timers = fakeTimers();
		const engine = createCadenceEngine({
			client,
			store,
			setIntervalFn: timers.setIntervalFn,
			clock,
		});

		const directive = await engine.start({
			sessionID: "s1",
			kind: "loop",
			instruction: "refine",
			intervalMs: 5000,
			until: "done?",
			maxIterations: 10,
		});

		client.failPrompt.value = true;
		const t1 = timers.tick();
		client.releaseMessages();
		for (let i = 0; i < 10; i += 1) {
			await Promise.resolve();
		}
		client.releasePrompt(); // rejects
		await t1;

		// Re-prompt failed → no delivery → iteration count unchanged, still active.
		expect(client.prompts).toBe(0);
		expect(store.map.get(directive.id)?.iterations).toBe(0);
		expect(store.map.get(directive.id)?.status).toBe("active");
	});
});

describe("stop is session-scoped", () => {
	test("session B cannot stop session A's directive by id", async () => {
		const client = fakeClient();
		const store = fakeStore();
		const timers = fakeTimers();
		const engine = createCadenceEngine({
			client,
			store,
			setIntervalFn: timers.setIntervalFn,
			clock,
		});

		const directive = await engine.start({
			sessionID: "sessionA",
			kind: "loop",
			instruction: "go",
			intervalMs: 5000,
			maxIterations: 10,
		});

		// Session B tries to stop A's directive by guessing its id → no-op.
		const result = await engine.stop(directive.id, "sessionB");
		expect(result).toBeUndefined();
		expect(store.map.get(directive.id)?.status).toBe("active");
		expect(engine.list("sessionA")).toHaveLength(1);

		// The rightful owner can stop it.
		const owned = await engine.stop(directive.id, "sessionA");
		expect(owned?.status).toBe("stopped");
		expect(store.map.has(directive.id)).toBe(false);
	});
});
