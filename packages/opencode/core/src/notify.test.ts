import { describe, expect, test } from "bun:test";
import { createNotificationQueue, type TaskNotice } from "./notify";
import type { BgTask, TaskStatus } from "./types";

// --- task fixtures ---------------------------------------------------------

let seq = 0;

function makeTask(over: Partial<BgTask> = {}): BgTask {
	seq += 1;
	return {
		id: `bg_${seq.toString().padStart(8, "0")}`,
		parentSessionID: "parent_a",
		description: "do the thing",
		agent: "build",
		status: "completed",
		createdAt: 1000,
		startedAt: 1100,
		completedAt: 1600,
		depth: 0,
		concurrencyKey: "k",
		...over,
	};
}

function flush(): Promise<void> {
	return (async () => {
		for (let i = 0; i < 12; i++) {
			await Promise.resolve();
		}
	})();
}

/** First notice of a single-element pending list, asserted non-empty. */
function only(notices: TaskNotice[]): TaskNotice {
	expect(notices).toHaveLength(1);
	const notice = notices[0];
	if (!notice) {
		throw new Error("expected a notice");
	}
	return notice;
}

// ---------------------------------------------------------------------------

describe("notification queue", () => {
	// Named test 1: completion with no pending parent turn → notice waits.
	test("completion with no pending parent turn → notice waits indefinitely", () => {
		const q = createNotificationQueue({});
		const task = makeTask({ parentSessionID: "parent_a" });
		q.push(task);

		// Nothing auto-drains: pending() shows it, repeatedly.
		expect(q.pending("parent_a")).toHaveLength(1);
		expect(q.pending("parent_a")).toHaveLength(1);
		expect(q.pending()).toHaveLength(1);
	});

	// Named test 2: restart with un-flushed notice → seed re-queues, no onNotify.
	test("restart with un-flushed notice → seed re-queues it, NO onNotify fired", () => {
		const fired: TaskNotice[] = [];
		const q = createNotificationQueue({ onNotify: (n) => fired.push(n) });
		const task = makeTask({ notified: undefined });

		q.seed([task]);

		expect(q.pending(task.parentSessionID)).toHaveLength(1);
		expect(fired).toHaveLength(0); // no toast storm on restart
	});

	// Named test 3: restart with flushed notice → seed skips it.
	test("restart with flushed notice (notified: true) → seed skips it", () => {
		const q = createNotificationQueue({});
		const task = makeTask({ notified: true });

		q.seed([task]);

		expect(q.pending(task.parentSessionID)).toHaveLength(0);
	});

	// Named test 4: two tasks same parent → one flush, both, oldest first.
	test("two tasks completing for same parent → one flushFor returns both, oldest first", () => {
		const q = createNotificationQueue({});
		const first = makeTask({
			parentSessionID: "parent_a",
			description: "first",
			completedAt: 1500,
		});
		const second = makeTask({
			parentSessionID: "parent_a",
			description: "second",
			completedAt: 1700,
		});
		q.push(first);
		q.push(second);

		const flushed = q.flushFor("parent_a");
		expect(flushed.map((n) => n.taskId)).toEqual([first.id, second.id]);
		// Drained: a second flush is empty.
		expect(q.flushFor("parent_a")).toHaveLength(0);
	});

	// Named test 5: dedup keyed on taskId+completedAt.
	test("dedup: same task pushed twice → one notice; resumed task (new completedAt) → second notice allowed", () => {
		const q = createNotificationQueue({});
		const task = makeTask({ id: "bg_dedup01", completedAt: 2000 });

		q.push(task);
		q.push(task); // identical taskId+completedAt → no-op
		expect(q.pending(task.parentSessionID)).toHaveLength(1);

		// Resume lifecycle: per Task 1.3.4, resume resets notified=undefined and
		// stamps a fresh completedAt. Same taskId, new completedAt → allowed.
		const resumed = makeTask({
			id: "bg_dedup01",
			notified: undefined,
			completedAt: 3000,
		});
		q.push(resumed);
		expect(q.pending(task.parentSessionID)).toHaveLength(2);
	});

	// Named test 6: flushFor calls markNotified per notice; rejection logged,
	// flush result unaffected.
	test("flushFor calls markNotified per notice; markNotified rejection is logged, flush result unaffected", async () => {
		const marked: string[] = [];
		const errors: string[] = [];
		const q = createNotificationQueue({
			markNotified: async (taskId) => {
				marked.push(taskId);
				throw new Error("persist boom");
			},
			logger: { error: (msg) => errors.push(msg) },
		});
		const t1 = makeTask({ parentSessionID: "p", description: "one" });
		const t2 = makeTask({ parentSessionID: "p", description: "two" });
		q.push(t1);
		q.push(t2);

		const flushed = q.flushFor("p");
		// flush is synchronous and returns both regardless of markNotified outcome.
		expect(flushed).toHaveLength(2);

		await flush();
		expect(marked).toEqual([t1.id, t2.id]);
		expect(errors.length).toBeGreaterThanOrEqual(1);
	});

	// Named test 7: non-terminal push ignored.
	test("non-terminal push ignored", () => {
		const q = createNotificationQueue({});
		for (const status of ["pending", "running"] as TaskStatus[]) {
			q.push(makeTask({ status }));
		}
		expect(q.pending()).toHaveLength(0);
	});

	// Named test 8: onNotify on live push, not on seed; absent onNotify no throw.
	test("onNotify fires on live push, not on seed; absent onNotify doesn't throw", () => {
		const fired: TaskNotice[] = [];
		const q = createNotificationQueue({ onNotify: (n) => fired.push(n) });

		q.push(makeTask({ description: "live" }));
		expect(fired).toHaveLength(1);

		q.seed([makeTask({ description: "seeded", notified: undefined })]);
		expect(fired).toHaveLength(1); // unchanged: seed never fires onNotify

		// absent onNotify path must not throw.
		const q2 = createNotificationQueue({});
		expect(() => q2.push(makeTask())).not.toThrow();
	});

	// Named test 9: flushFor for empty parent → []; other parents untouched.
	test("flushFor for parent with nothing → empty array; other parents' notices untouched", () => {
		const q = createNotificationQueue({});
		const other = makeTask({ parentSessionID: "parent_b" });
		q.push(other);

		expect(q.flushFor("parent_a")).toEqual([]);
		// parent_b's notice untouched.
		expect(q.pending("parent_b")).toHaveLength(1);
		expect(q.flushFor("parent_b")).toHaveLength(1);
	});

	// --- notice content + duration + hint --------------------------------------

	test("notice carries status, description, and a default retrieval hint", () => {
		const q = createNotificationQueue({});
		const task = makeTask({
			id: "bg_abcd1234",
			description: "summarize the report",
			status: "completed",
			startedAt: 1000,
			completedAt: 1750,
		});
		q.push(task);

		const notice = only(q.pending(task.parentSessionID));
		expect(notice.taskId).toBe("bg_abcd1234");
		expect(notice.status).toBe("completed");
		expect(notice.description).toBe("summarize the report");
		expect(notice.durationMs).toBe(750);
		expect(notice.hint).toContain("bg_abcd1234");
		expect(notice.hint).toContain('bg_output(task_id="bg_abcd1234")');
	});

	test("durationMs falls back to createdAt when startedAt absent", () => {
		const q = createNotificationQueue({});
		const task = makeTask({
			startedAt: undefined,
			createdAt: 500,
			completedAt: 900,
		});
		q.push(task);
		expect(only(q.pending(task.parentSessionID)).durationMs).toBe(400);
	});

	test("durationMs omitted when completedAt absent", () => {
		const q = createNotificationQueue({});
		// terminal status but no completedAt stamped (defensive).
		const task = makeTask({ status: "error", completedAt: undefined });
		q.push(task);
		expect(only(q.pending(task.parentSessionID)).durationMs).toBeUndefined();
	});

	test("renderHint override replaces the default hint text", () => {
		const q = createNotificationQueue({
			renderHint: (t) => `custom:${t.id}`,
		});
		const task = makeTask({ id: "bg_override" });
		q.push(task);
		expect(only(q.pending(task.parentSessionID)).hint).toBe(
			"custom:bg_override",
		);
	});

	test("seeded duplicate is suppressed by a later live push", () => {
		const fired: TaskNotice[] = [];
		const q = createNotificationQueue({ onNotify: (n) => fired.push(n) });
		const task = makeTask({ id: "bg_seed01", completedAt: 2000 });

		q.seed([task]); // enqueues, no onNotify, records in seen-set
		expect(q.pending(task.parentSessionID)).toHaveLength(1);

		q.push(task); // same taskId+completedAt → no-op, no second notice
		expect(q.pending(task.parentSessionID)).toHaveLength(1);
		expect(fired).toHaveLength(0);
	});

	// Finding #8: the onNotify fence — a throwing toast callback must not break
	// the push path (the notice still enqueues) and must be logged.
	test("onNotify throwing is fenced: notice still enqueues, error logged", () => {
		const errors: string[] = [];
		const q = createNotificationQueue({
			onNotify: () => {
				throw new Error("toast boom");
			},
			logger: { error: (msg) => errors.push(msg) },
		});
		const task = makeTask();
		expect(() => q.push(task)).not.toThrow();
		expect(q.pending(task.parentSessionID)).toHaveLength(1);
		expect(errors.some((m) => m.includes("onNotify"))).toBe(true);
	});

	// Finding #8: the `"${id}:?"` seenKey fallback — a terminal push with NO
	// completedAt still dedups (both pushes key to `id:?`). Near-unreachable from
	// the engine (terminal transitions stamp completedAt) but the type allows it.
	test("terminal push without completedAt dedups via the ':?' seenKey fallback", () => {
		const q = createNotificationQueue({});
		const task = makeTask({ id: "bg_nocomp01", completedAt: undefined });
		q.push(task);
		q.push({ ...task });
		expect(q.pending(task.parentSessionID)).toHaveLength(1);
	});
});

// ---- finding #4 primitive: consume(parent, notices) -------------------------

describe("notification queue — consume", () => {
	test("consume drains EXACTLY the given notices, leaving later arrivals queued", () => {
		const q = createNotificationQueue({});
		const a = makeTask({ description: "alpha" });
		q.push(a);
		const snapshot = q.pending(a.parentSessionID);
		// A second notice arrives AFTER the snapshot was taken (the wake's
		// mid-flight scenario).
		const b = makeTask({ description: "beta" });
		q.push(b);

		q.consume(a.parentSessionID, snapshot);

		const remaining = q.pending(a.parentSessionID);
		expect(remaining).toHaveLength(1);
		expect(remaining[0]?.description).toBe("beta");
	});

	test("consume runs markNotified for exactly the drained notices", async () => {
		const marked: string[] = [];
		const q = createNotificationQueue({
			markNotified: async (id) => {
				marked.push(id);
			},
		});
		const a = makeTask({ id: "bg_consume1" });
		q.push(a);
		const snapshot = q.pending(a.parentSessionID);
		const b = makeTask({ id: "bg_consume2" });
		q.push(b);

		q.consume(a.parentSessionID, snapshot);
		await flush();
		expect(marked).toEqual(["bg_consume1"]);
	});

	test("consume of already-drained notices is a no-op (no double markNotified)", async () => {
		const marked: string[] = [];
		const q = createNotificationQueue({
			markNotified: async (id) => {
				marked.push(id);
			},
		});
		const a = makeTask({ id: "bg_raced001" });
		q.push(a);
		const snapshot = q.pending(a.parentSessionID);
		// The passive flush wins the race and drains everything first.
		q.flushFor(a.parentSessionID);
		q.consume(a.parentSessionID, snapshot);
		await flush();
		expect(marked).toEqual(["bg_raced001"]);
		expect(q.pending(a.parentSessionID)).toHaveLength(0);
	});

	test("consume prunes the dedup seen-set so a resume-style re-completion re-queues", () => {
		const q = createNotificationQueue({});
		const a = makeTask({ id: "bg_reseen01", completedAt: 2000 });
		q.push(a);
		q.consume(a.parentSessionID, q.pending(a.parentSessionID));
		expect(q.pending(a.parentSessionID)).toHaveLength(0);
		// Same completion key again — drained keys must not block (parity with
		// flushFor's prune-on-drain semantics).
		q.push({ ...a });
		expect(q.pending(a.parentSessionID)).toHaveLength(1);
	});

	test("consume for an unknown parent is a silent no-op", () => {
		const q = createNotificationQueue({});
		expect(() => q.consume("parent_nobody", [])).not.toThrow();
	});
});
