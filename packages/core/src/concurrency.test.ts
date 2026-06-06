import { describe, expect, test } from "bun:test";
import { ConcurrencyManager, WaiterCancelledError } from "./concurrency";

// A deferred lets a test observe whether a queued acquire() has settled
// without relying on timers. We poll the promise state by racing it against
// an already-resolved sentinel flushed through the microtask queue.
async function settledState(
	promise: Promise<unknown>,
): Promise<"pending" | "resolved" | "rejected"> {
	let state: "pending" | "resolved" | "rejected" = "pending";
	// Attach observers synchronously; they fire on the microtask queue when the
	// promise has already settled.
	promise.then(
		() => {
			state = "resolved";
		},
		() => {
			state = "rejected";
		},
	);
	// Flush several microtask turns so any already-settled promise's observers
	// run before we read the state. A still-pending promise leaves it "pending".
	for (let i = 0; i < 5; i++) {
		await Promise.resolve();
	}
	return state;
}

describe("ConcurrencyManager — limit resolution precedence", () => {
	test("limit precedence: model > provider > default > 5; and 0 at each level", () => {
		// default fallback of 5 when nothing configured
		expect(new ConcurrencyManager().limitFor("anthropic/opus")).toBe(5);

		// defaultConcurrency overrides the hardcoded 5
		expect(
			new ConcurrencyManager({ defaultConcurrency: 3 }).limitFor(
				"anthropic/opus",
			),
		).toBe(3);

		// providerConcurrency overrides default
		expect(
			new ConcurrencyManager({
				defaultConcurrency: 3,
				providerConcurrency: { anthropic: 7 },
			}).limitFor("anthropic/opus"),
		).toBe(7);

		// modelConcurrency overrides provider and default
		expect(
			new ConcurrencyManager({
				defaultConcurrency: 3,
				providerConcurrency: { anthropic: 7 },
				modelConcurrency: { "anthropic/opus": 9 },
			}).limitFor("anthropic/opus"),
		).toBe(9);

		// 0 at model level => unlimited
		expect(
			new ConcurrencyManager({
				modelConcurrency: { "anthropic/opus": 0 },
			}).limitFor("anthropic/opus"),
		).toBe(0);

		// 0 at provider level => unlimited
		expect(
			new ConcurrencyManager({
				providerConcurrency: { anthropic: 0 },
			}).limitFor("anthropic/opus"),
		).toBe(0);

		// 0 at default level => unlimited
		expect(
			new ConcurrencyManager({ defaultConcurrency: 0 }).limitFor(
				"anthropic/opus",
			),
		).toBe(0);
	});
});

describe("ConcurrencyManager — key resolution", () => {
	test("key resolution: model-limit set -> full string; provider-limit set -> provider; neither -> full string", () => {
		// model-level set => key is the full model string
		expect(
			new ConcurrencyManager({
				modelConcurrency: { "anthropic/opus": 2 },
			}).keyFor("anthropic/opus"),
		).toBe("anthropic/opus");

		// provider-level set (no model-level) => key is the provider
		expect(
			new ConcurrencyManager({
				providerConcurrency: { anthropic: 2 },
			}).keyFor("anthropic/opus"),
		).toBe("anthropic");

		// neither set => key is the full model string
		expect(
			new ConcurrencyManager({ defaultConcurrency: 2 }).keyFor(
				"anthropic/opus",
			),
		).toBe("anthropic/opus");

		// model-level wins over provider-level for key selection
		expect(
			new ConcurrencyManager({
				providerConcurrency: { anthropic: 2 },
				modelConcurrency: { "anthropic/opus": 1 },
			}).keyFor("anthropic/opus"),
		).toBe("anthropic/opus");
	});
});

describe("ConcurrencyManager — acquire / release / queueing", () => {
	test("zero-limit (unlimited) never queues: many concurrent acquires resolve immediately", async () => {
		const mgr = new ConcurrencyManager({ defaultConcurrency: 0 });
		const model = "anthropic/opus";

		const acquires = Array.from({ length: 50 }, () => mgr.acquire(model));
		// All should resolve; none should be queued.
		const holders = await Promise.all(acquires);
		expect(holders).toHaveLength(50);
		for (const h of holders) {
			expect(typeof h.id).toBe("string");
		}
		expect(mgr.queueLength(model)).toBe(0);
		// Unlimited does not track a running count for limiting purposes.
		expect(mgr.runningCount(model)).toBe(0);
	});

	test("fast-path: acquire under limit resolves without queueing", async () => {
		const mgr = new ConcurrencyManager({ defaultConcurrency: 2 });
		const model = "anthropic/opus";

		const a = mgr.acquire(model);
		const b = mgr.acquire(model);
		expect(await settledState(a)).toBe("resolved");
		expect(await settledState(b)).toBe("resolved");
		expect(mgr.runningCount(model)).toBe(2);
		expect(mgr.queueLength(model)).toBe(0);
	});

	test("at-limit acquire enqueues FIFO and is unblocked by release", async () => {
		const mgr = new ConcurrencyManager({ defaultConcurrency: 1 });
		const model = "anthropic/opus";

		await mgr.acquire(model); // holds the only slot
		const queued = mgr.acquire(model); // must queue
		expect(await settledState(queued)).toBe("pending");
		expect(mgr.queueLength(model)).toBe(1);

		mgr.release(model); // hand off to queued waiter
		expect(await settledState(queued)).toBe("resolved");
		expect(mgr.queueLength(model)).toBe(0);
	});

	test("release with empty queue decrements count", async () => {
		const mgr = new ConcurrencyManager({ defaultConcurrency: 2 });
		const model = "anthropic/opus";

		await mgr.acquire(model);
		await mgr.acquire(model);
		expect(mgr.runningCount(model)).toBe(2);

		mgr.release(model);
		expect(mgr.runningCount(model)).toBe(1);
		mgr.release(model);
		expect(mgr.runningCount(model)).toBe(0);
	});

	test("handoff does not change running count", async () => {
		const mgr = new ConcurrencyManager({ defaultConcurrency: 1 });
		const model = "anthropic/opus";

		await mgr.acquire(model);
		expect(mgr.runningCount(model)).toBe(1);

		const queued = mgr.acquire(model);
		expect(await settledState(queued)).toBe("pending");

		mgr.release(model); // direct handoff — count must stay at 1
		expect(await settledState(queued)).toBe("resolved");
		expect(mgr.runningCount(model)).toBe(1);

		mgr.release(model); // now nothing queued — decrement
		expect(mgr.runningCount(model)).toBe(0);
	});

	test("release when only settled (cancelled) waiters remain decrements — no handoff to a corpse", async () => {
		const mgr = new ConcurrencyManager({ defaultConcurrency: 1 });
		const model = "anthropic/opus";

		await mgr.acquire(model); // holds slot, count = 1
		const queued = mgr.acquire(model); // queued
		const id = await mgr.waiterId(queued);

		mgr.cancelWaiter(model, id); // settle (reject) the only waiter
		await expect(queued).rejects.toBeInstanceOf(WaiterCancelledError);

		mgr.release(model); // queue holds only a corpse => must decrement
		expect(mgr.runningCount(model)).toBe(0);
	});
});

describe("ConcurrencyManager — cancellation", () => {
	test("cancel of an already-resolved waiter is a no-op", async () => {
		const mgr = new ConcurrencyManager({ defaultConcurrency: 1 });
		const model = "anthropic/opus";

		await mgr.acquire(model);
		const queued = mgr.acquire(model);
		const id = await mgr.waiterId(queued);

		mgr.release(model); // resolves the waiter via handoff
		await queued; // resolved
		expect(mgr.runningCount(model)).toBe(1);

		// Cancelling an already-resolved waiter must not throw, reject, or
		// disturb counts.
		expect(() => mgr.cancelWaiter(model, id)).not.toThrow();
		expect(mgr.runningCount(model)).toBe(1);
	});

	test("cancelWaiter rejects the specific queued waiter with WaiterCancelledError", async () => {
		const mgr = new ConcurrencyManager({ defaultConcurrency: 1 });
		const model = "anthropic/opus";

		await mgr.acquire(model);
		const queued = mgr.acquire(model);
		const id = await mgr.waiterId(queued);

		mgr.cancelWaiter(model, id);
		await expect(queued).rejects.toBeInstanceOf(WaiterCancelledError);
		expect(mgr.queueLength(model)).toBe(0);
	});

	test("cancelWaiter on unknown id is a no-op", async () => {
		const mgr = new ConcurrencyManager({ defaultConcurrency: 1 });
		const model = "anthropic/opus";

		await mgr.acquire(model);
		const queued = mgr.acquire(model);
		await mgr.waiterId(queued);

		expect(() => mgr.cancelWaiter(model, "no-such-id")).not.toThrow();
		expect(mgr.queueLength(model)).toBe(1);

		mgr.release(model);
		await queued;
	});

	test("cancelWaiters rejects all queued waiters for the key", async () => {
		const mgr = new ConcurrencyManager({ defaultConcurrency: 1 });
		const model = "anthropic/opus";

		await mgr.acquire(model);
		const q1 = mgr.acquire(model);
		const q2 = mgr.acquire(model);
		const q3 = mgr.acquire(model);
		expect(mgr.queueLength(model)).toBe(3);

		mgr.cancelWaiters(model);
		await expect(q1).rejects.toBeInstanceOf(WaiterCancelledError);
		await expect(q2).rejects.toBeInstanceOf(WaiterCancelledError);
		await expect(q3).rejects.toBeInstanceOf(WaiterCancelledError);
		expect(mgr.queueLength(model)).toBe(0);
	});

	test("clear rejects all waiters everywhere and resets counts", async () => {
		const mgr = new ConcurrencyManager({ defaultConcurrency: 1 });
		const a = "anthropic/opus";
		const b = "openai/gpt";

		await mgr.acquire(a);
		await mgr.acquire(b);
		const qa = mgr.acquire(a);
		const qb = mgr.acquire(b);

		mgr.clear();
		await expect(qa).rejects.toBeInstanceOf(WaiterCancelledError);
		await expect(qb).rejects.toBeInstanceOf(WaiterCancelledError);
		expect(mgr.runningCount(a)).toBe(0);
		expect(mgr.runningCount(b)).toBe(0);
		expect(mgr.queueLength(a)).toBe(0);
		expect(mgr.queueLength(b)).toBe(0);
	});

	test("settle-once: handoff and cancel never both fire (first settle wins)", async () => {
		const mgr = new ConcurrencyManager({ defaultConcurrency: 1 });
		const model = "anthropic/opus";

		await mgr.acquire(model);
		const queued = mgr.acquire(model);
		const id = await mgr.waiterId(queued);

		// Hand off the slot (resolves the waiter)...
		mgr.release(model);
		await queued;
		// ...then attempt to cancel the same waiter. Must be a no-op, not a
		// second settle. The promise stays resolved.
		mgr.cancelWaiter(model, id);
		expect(await settledState(queued)).toBe("resolved");
	});
});

describe("ConcurrencyManager — FIFO under interleaving", () => {
	test("interleaved acquire/cancel/release preserves FIFO among surviving waiters", async () => {
		const mgr = new ConcurrencyManager({ defaultConcurrency: 1 });
		const model = "anthropic/opus";

		await mgr.acquire(model); // slot held

		const order: string[] = [];
		// Track resolution order; swallow rejections (cancelled waiters) so they
		// don't surface as unhandled.
		const track = (p: Promise<unknown>, label: string): void => {
			p.then(
				() => order.push(label),
				() => {},
			);
		};

		const w1 = mgr.acquire(model);
		const id1 = mgr.waiterId(w1);
		track(w1, "w1");

		const w2 = mgr.acquire(model);
		const id2 = mgr.waiterId(w2);
		track(w2, "w2");

		const w3 = mgr.acquire(model);
		mgr.waiterId(w3);
		track(w3, "w3");

		const w4 = mgr.acquire(model);
		mgr.waiterId(w4);
		track(w4, "w4");

		expect(mgr.queueLength(model)).toBe(4);

		// Cancel the head (w1) and a middle one (w2). Survivors: w3, w4.
		mgr.cancelWaiter(model, id1);
		mgr.cancelWaiter(model, id2);
		await expect(w1).rejects.toBeInstanceOf(WaiterCancelledError);
		await expect(w2).rejects.toBeInstanceOf(WaiterCancelledError);
		expect(mgr.queueLength(model)).toBe(2);

		// Release hands the slot to w3 (next surviving FIFO), not w4.
		mgr.release(model);
		await w3;
		expect(await settledState(w4)).toBe("pending");

		// Release again hands off to w4.
		mgr.release(model);
		await w4;

		expect(order).toEqual(["w3", "w4"]);
	});
});
