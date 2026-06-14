import { describe, expect, test } from "bun:test";
import {
	type BranchEntry,
	type CadenceHost,
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

/** Build the single assistant branch entry the host returns from a reply string. */
function assistantBranch(reply: string): BranchEntry[] {
	return [
		{
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: reply }],
			},
		},
	];
}

/**
 * Fake host recording reprompt() calls; getBranchEntries() returns a canned
 * assistant reply. Replaces opencode's SDK CadenceClient — both calls are scoped
 * to the current session, so no sessionID flows through.
 */
function fakeHost(lastReply = ""): CadenceHost & {
	prompts: string[];
	reply: { value: string };
} {
	const prompts: string[] = [];
	const reply = { value: lastReply };
	return {
		prompts,
		reply,
		reprompt(text) {
			prompts.push(text);
			return true;
		},
		getBranchEntries() {
			return assistantBranch(reply.value);
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
			// loopTick awaits getBranchEntries + reprompt + save; flush generously so
			// every microtask in the chain settles before assertions run.
			for (let i = 0; i < 10; i += 1) {
				await Promise.resolve();
			}
		},
	};
}

const clock = { now: () => 1000 };

/** Host whose reprompt()/getBranchEntries() resolve only when the test releases them. */
function deferredHost(lastReply: string): CadenceHost & {
	prompts: number;
	releaseBranch(): void;
	releasePrompt(): void;
	failPrompt: { value: boolean };
} {
	let prompts = 0;
	let resolveBranch: (() => void) | undefined;
	let resolvePrompt: (() => void) | undefined;
	const failPrompt = { value: false };
	return {
		get prompts() {
			return prompts;
		},
		failPrompt,
		releaseBranch() {
			resolveBranch?.();
			resolveBranch = undefined;
		},
		releasePrompt() {
			resolvePrompt?.();
			resolvePrompt = undefined;
		},
		reprompt() {
			return new Promise<boolean>((resolve, reject) => {
				resolvePrompt = () => {
					if (failPrompt.value) {
						reject(new Error("send failed"));
						return;
					}
					prompts += 1;
					resolve(true);
				};
			});
		},
		getBranchEntries() {
			return new Promise<BranchEntry[]>((resolve) => {
				resolveBranch = () => resolve(assistantBranch(lastReply));
			});
		},
	};
}

describe("loop", () => {
	test("each tick re-prompts; stops after max_iterations", async () => {
		const host = fakeHost();
		const store = fakeStore();
		const timers = fakeTimers();
		const engine = createCadenceEngine({
			host,
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

		expect(host.prompts.length).toBe(3);
		expect(host.prompts.every((p) => p === "do the thing")).toBe(true);
		// Terminal → deleted from the store and evicted from list().
		expect(store.map.has(directive.id)).toBe(false);
		expect(engine.list("s1")).toHaveLength(0);
		expect(timers.cleared.count).toBeGreaterThanOrEqual(1);
	});

	test("until: sentinel honored only after the first re-prompt (arming baseline)", async () => {
		const host = fakeHost(`all done\n${GOAL_COMPLETE}`);
		const store = fakeStore();
		const timers = fakeTimers();
		const engine = createCadenceEngine({
			host,
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

		// Tick 1: iterations == 0, so the pre-existing sentinel is IGNORED — the loop
		// re-prompts first (a stale GOAL_COMPLETE must not satisfy a zero-work loop).
		await timers.tick();
		expect(host.prompts.length).toBe(1);
		expect(store.map.get(directive.id)?.iterations).toBe(1);
		expect(store.map.get(directive.id)?.status).toBe("active");

		// Tick 2: iterations > 0, the sentinel now finalizes without another re-prompt.
		await timers.tick();
		expect(host.prompts.length).toBe(1);
		expect(store.map.has(directive.id)).toBe(false);
	});

	test("until: non-sentinel reply re-prompts with the sentinel ask", async () => {
		const host = fakeHost("still working");
		const store = fakeStore();
		const timers = fakeTimers();
		const engine = createCadenceEngine({
			host,
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

		expect(host.prompts.length).toBe(1);
		expect(host.prompts[0]).toContain("refine");
		expect(host.prompts[0]).toContain("the doc is complete");
		expect(host.prompts[0]).toContain(GOAL_COMPLETE);
	});

	test("intervalMs is clamped to the 1000ms floor", async () => {
		const host = fakeHost();
		const store = fakeStore();
		const timers = fakeTimers();
		const engine = createCadenceEngine({
			host,
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
		const host = fakeHost();
		const store = fakeStore();
		const timers = fakeTimers();
		const engine = createCadenceEngine({
			host,
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
		expect(host.prompts.length).toBe(1);

		const stopped = await engine.stop(directive.id, "s1");
		expect(stopped?.status).toBe("stopped");
		await timers.tick();

		expect(host.prompts.length).toBe(1);
		// Stopped → deleted from the store and evicted from list().
		expect(store.map.has(directive.id)).toBe(false);
		expect(engine.list("s1")).toHaveLength(0);
	});

	test("dispose clears timers — no re-prompts after dispose", async () => {
		const host = fakeHost();
		const store = fakeStore();
		const timers = fakeTimers();
		const engine = createCadenceEngine({
			host,
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

		expect(host.prompts.length).toBe(0);
		expect(timers.cleared.count).toBe(1);
	});
});

describe("recover", () => {
	test("a persisted active loop is re-armed and re-prompts on tick", async () => {
		const host = fakeHost();
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
			host,
			store,
			setIntervalFn: timers.setIntervalFn,
			clock,
		});

		await engine.recover();
		expect(timers.armed.count).toBe(1);

		await timers.tick();
		expect(host.prompts.length).toBe(1);
		expect(host.prompts[0]).toBe("resume me");
	});

	test("a persisted done loop is NOT re-armed", async () => {
		const host = fakeHost();
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
			host,
			store,
			setIntervalFn: timers.setIntervalFn,
			clock,
		});

		await engine.recover();
		expect(timers.armed.count).toBe(0);
	});

	test("a persisted active goal is rehydrated and re-armed on agent_end (no timer)", async () => {
		const host = fakeHost("not yet");
		const store = fakeStore();
		store.map.set("cadence_goal", {
			id: "cadence_goal",
			sessionID: "s1",
			kind: "goal",
			instruction: "resume the goal",
			iterations: 0,
			maxIterations: 10,
			status: "active",
			createdAt: 1,
		});
		const timers = fakeTimers();
		const engine = createCadenceEngine({
			host,
			store,
			setIntervalFn: timers.setIntervalFn,
			clock,
		});

		await engine.recover();
		// A goal arms no timer — its trigger is agent_end, not a clock.
		expect(timers.armed.count).toBe(0);
		expect(engine.list("s1")).toHaveLength(1);

		await engine.handleEvent();
		expect(host.prompts.length).toBe(1);
		expect(host.prompts[0]).toContain("resume the goal");
	});
});

describe("goal (agent-end driven)", () => {
	test("non-sentinel last message re-prompts and increments", async () => {
		const host = fakeHost("not yet");
		const store = fakeStore();
		const engine = createCadenceEngine({ host, store, clock });

		const directive = await engine.start({
			sessionID: "s1",
			kind: "goal",
			instruction: "ship the feature",
			maxIterations: 5,
		});

		await engine.handleEvent();

		expect(host.prompts.length).toBe(1);
		expect(host.prompts[0]).toContain("ship the feature");
		expect(host.prompts[0]).toContain(GOAL_COMPLETE);
		expect(store.map.get(directive.id)?.iterations).toBe(1);
		expect(store.map.get(directive.id)?.status).toBe("active");
	});

	test("sentinel honored only after the first re-prompt (arming baseline)", async () => {
		const host = fakeHost(`${GOAL_COMPLETE}`);
		const store = fakeStore();
		const engine = createCadenceEngine({ host, store, clock });

		const directive = await engine.start({
			sessionID: "s1",
			kind: "goal",
			instruction: "ship it",
			maxIterations: 5,
		});

		// Event 1: iterations == 0, the pre-existing sentinel is IGNORED — the goal
		// re-prompts first so a stale GOAL_COMPLETE can't satisfy it with zero work.
		await engine.handleEvent();
		expect(host.prompts.length).toBe(1);
		expect(store.map.get(directive.id)?.iterations).toBe(1);
		expect(store.map.get(directive.id)?.status).toBe("active");

		// Event 2: iterations > 0, the sentinel now finalizes the goal.
		await engine.handleEvent();
		expect(host.prompts.length).toBe(1);
		expect(store.map.has(directive.id)).toBe(false);
	});

	test("max_iterations gives up (marks done)", async () => {
		const host = fakeHost("not yet");
		const store = fakeStore();
		const engine = createCadenceEngine({ host, store, clock });

		const directive = await engine.start({
			sessionID: "s1",
			kind: "goal",
			instruction: "ship it",
			maxIterations: 1,
		});

		await engine.handleEvent(); // iter 0 -> 1, re-prompts
		await engine.handleEvent(); // iter 1 >= max -> gives up

		expect(host.prompts.length).toBe(1);
		expect(store.map.has(directive.id)).toBe(false);
	});

	test("agent_end with no goal directive is a no-op", async () => {
		const host = fakeHost("not yet");
		const store = fakeStore();
		const engine = createCadenceEngine({ host, store, clock });

		await engine.handleEvent();

		expect(host.prompts.length).toBe(0);
	});

	test("agent_end never affects a loop directive", async () => {
		const host = fakeHost("not yet");
		const store = fakeStore();
		const timers = fakeTimers();
		const engine = createCadenceEngine({
			host,
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

		await engine.handleEvent();

		expect(host.prompts.length).toBe(0);
		expect(store.map.get(directive.id)?.iterations).toBe(0);
	});

	test("agent_end with a loop AND a goal advances only the goal", async () => {
		const host = fakeHost("not yet");
		const store = fakeStore();
		const timers = fakeTimers();
		const engine = createCadenceEngine({
			host,
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

		await engine.handleEvent();

		// Exactly one re-prompt — the goal's — and it carries the goal instruction.
		expect(host.prompts.length).toBe(1);
		expect(host.prompts[0]).toContain("ship it");
		expect(store.map.get(goal.id)?.iterations).toBe(1);
		// The loop is untouched: its iteration count stays at 0.
		expect(store.map.get(loop.id)?.iterations).toBe(0);
	});
});

describe("sentinel matching (exact line, not substring)", () => {
	test("goal: a mere mention of the sentinel does NOT complete", async () => {
		const host = fakeHost(`do not output ${GOAL_COMPLETE} yet`);
		const store = fakeStore();
		const engine = createCadenceEngine({ host, store, clock });

		const directive = await engine.start({
			sessionID: "s1",
			kind: "goal",
			instruction: "ship it",
			maxIterations: 5,
		});

		await engine.handleEvent();

		// Not complete → re-prompted, still active.
		expect(host.prompts.length).toBe(1);
		expect(store.map.get(directive.id)?.status).toBe("active");
		expect(store.map.get(directive.id)?.iterations).toBe(1);
	});

	test("goal: the sentinel alone on its own line DOES complete (after arming)", async () => {
		const host = fakeHost(`here is the result\n${GOAL_COMPLETE}\n`);
		const store = fakeStore();
		const engine = createCadenceEngine({ host, store, clock });

		const directive = await engine.start({
			sessionID: "s1",
			kind: "goal",
			instruction: "ship it",
			maxIterations: 5,
		});

		// Event 1 arms (iterations 0 → 1, re-prompts); event 2 honors the own-line sentinel.
		await engine.handleEvent();
		await engine.handleEvent();

		expect(host.prompts.length).toBe(1);
		expect(store.map.has(directive.id)).toBe(false);
	});

	test("loop until: a mere mention does NOT complete; own-line DOES", async () => {
		const host = fakeHost(`reminder: ${GOAL_COMPLETE} is the sentinel`);
		const store = fakeStore();
		const timers = fakeTimers();
		const engine = createCadenceEngine({
			host,
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
		expect(host.prompts.length).toBe(1);
		expect(store.map.get(directive.id)?.status).toBe("active");

		// Now the sentinel lands on its own line → completes without a re-prompt.
		host.reply.value = `${GOAL_COMPLETE}`;
		await timers.tick();
		expect(host.prompts.length).toBe(1);
		expect(store.map.has(directive.id)).toBe(false);
	});
});

describe("lastAssistantText extraction", () => {
	test("concatenates only the LAST assistant entry's text parts, ignoring user/tool entries", async () => {
		const store = fakeStore();
		const timers = fakeTimers();
		// A branch with a trailing user message after the assistant turn must not
		// shadow the assistant text: the engine scans from the end for the last
		// assistant entry. We build a custom host to script the full branch.
		const branch: BranchEntry[] = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "part-A " },
						{ type: "tool_use", id: "t1" },
						{ type: "text", text: `part-B\n${GOAL_COMPLETE}` },
					],
				},
			},
			{
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "noise" }] },
			},
		];
		const prompts: string[] = [];
		const host: CadenceHost = {
			reprompt(text) {
				prompts.push(text);
				return true;
			},
			getBranchEntries() {
				return branch;
			},
		};
		const engine = createCadenceEngine({
			host,
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

		// Tick 1 arms (iterations 0 → 1), tick 2 reads the assistant text and finds
		// the own-line sentinel in the concatenated parts → completes.
		await timers.tick();
		await timers.tick();

		expect(prompts.length).toBe(1);
		expect(store.map.has(directive.id)).toBe(false);
	});

	test("an empty branch never completes a goal (treated as no sentinel)", async () => {
		const store = fakeStore();
		const host: CadenceHost & { prompts: string[] } = {
			prompts: [],
			reprompt(text) {
				this.prompts.push(text);
				return true;
			},
			getBranchEntries() {
				return [];
			},
		};
		const engine = createCadenceEngine({ host, store, clock });

		const directive = await engine.start({
			sessionID: "s1",
			kind: "goal",
			instruction: "ship it",
			maxIterations: 5,
		});

		await engine.handleEvent(); // arms
		await engine.handleEvent(); // no sentinel (empty branch) → re-prompts again

		expect(host.prompts.length).toBe(2);
		expect(store.map.get(directive.id)?.status).toBe("active");
	});
});

describe("in-flight guard + count-on-delivery", () => {
	test("a branch fetch slower than the interval does not double-fire", async () => {
		const host = deferredHost("still working");
		const store = fakeStore();
		const timers = fakeTimers();
		const engine = createCadenceEngine({
			host,
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

		// Tick 1 starts and blocks on the (slow) reprompt enqueue. With iterations==0
		// the arming baseline skips the branch read, so the re-prompt is the only
		// await — and it is where tick 1 parks.
		const t1 = timers.tick();
		// Tick 2 fires while tick 1 is still in flight → the in-flight guard must skip
		// it entirely (no second branch read, no second re-prompt).
		const t2 = timers.tick();

		// Release the prompt so tick 1 completes its single delivery.
		host.releasePrompt();
		await t1;
		await t2;

		// Exactly ONE re-prompt and ONE increment, despite two ticks.
		expect(host.prompts).toBe(1);
		expect(store.map.get(directive.id)?.iterations).toBe(1);
	});

	test("a failed re-prompt does NOT advance the iteration count", async () => {
		const host = deferredHost("still working");
		const store = fakeStore();
		const timers = fakeTimers();
		const engine = createCadenceEngine({
			host,
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

		host.failPrompt.value = true;
		const t1 = timers.tick();
		host.releasePrompt(); // rejects
		await t1;

		// Re-prompt failed → no delivery → iteration count unchanged, still active.
		expect(host.prompts).toBe(0);
		expect(store.map.get(directive.id)?.iterations).toBe(0);
		expect(store.map.get(directive.id)?.status).toBe("active");
	});
});

describe("stop is session-scoped", () => {
	test("session B cannot stop session A's directive by id", async () => {
		const host = fakeHost();
		const store = fakeStore();
		const timers = fakeTimers();
		const engine = createCadenceEngine({
			host,
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

	test("stopForSession stops only the target session's active directives", async () => {
		const host = fakeHost();
		const store = fakeStore();
		const timers = fakeTimers();
		const engine = createCadenceEngine({
			host,
			store,
			setIntervalFn: timers.setIntervalFn,
			clock,
		});

		const a1 = await engine.start({
			sessionID: "s1",
			kind: "loop",
			instruction: "a1",
			intervalMs: 5000,
			maxIterations: 10,
		});
		const a2 = await engine.start({
			sessionID: "s1",
			kind: "goal",
			instruction: "a2",
			maxIterations: 10,
		});
		const b1 = await engine.start({
			sessionID: "s2",
			kind: "loop",
			instruction: "b1",
			intervalMs: 5000,
			maxIterations: 10,
		});
		// An already-finalized directive in s1 must be excluded from the sweep.
		const doneA = await engine.start({
			sessionID: "s1",
			kind: "loop",
			instruction: "done",
			intervalMs: 5000,
			maxIterations: 10,
		});
		await engine.stop(doneA.id, "s1");

		const armedBefore = timers.armed.count; // a1, b1, doneA
		const clearedBefore = timers.cleared.count; // doneA's stop cleared one

		const stopped = await engine.stopForSession("s1");

		// Returned array: exactly s1's two still-active directives, neither the
		// already-stopped one nor s2's.
		const ids = stopped.map((d) => d.id).sort();
		expect(ids).toEqual([a1.id, a2.id].sort());
		expect(stopped.every((d) => d.status === "stopped")).toBe(true);

		// s1's active directives are gone from the store and from list().
		expect(store.map.has(a1.id)).toBe(false);
		expect(store.map.has(a2.id)).toBe(false);
		expect(engine.list("s1")).toHaveLength(0);

		// s2 is untouched: still active in the store and listed.
		expect(store.map.get(b1.id)?.status).toBe("active");
		expect(engine.list("s2")).toHaveLength(1);

		// Only the loop among the stopped pair owned a timer (a1), so exactly one
		// more timer was cleared by this sweep.
		expect(timers.cleared.count).toBe(clearedBefore + 1);
		expect(timers.armed.count).toBe(armedBefore); // sweep arms nothing
	});

	test("dispose mid-await does not deliver a re-prompt or persist", async () => {
		const host = deferredHost("still working");
		const store = fakeStore();
		const timers = fakeTimers();
		const engine = createCadenceEngine({
			host,
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

		// Tick fires and blocks on the (slow) re-prompt enqueue.
		const t1 = timers.tick();
		// Plugin is torn down WHILE the tick is mid-await on reprompt.
		engine.dispose();
		host.releasePrompt();
		await t1;

		// The disposed guard bails before counting/persisting: iterations stays 0.
		expect(store.map.get(directive.id)?.iterations).toBe(0);
	});
});
