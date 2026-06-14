import { describe, expect, test } from "bun:test";
import { ItemCapError, parallel, pipeline } from "./compose";

/** A promise paired with its resolver, for deterministic ordering without timers. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("pipeline — no-barrier semantics", () => {
	test("NO-BARRIER PROOF: item B finishes stage 2 while item A is held in stage 1", async () => {
		const events: string[] = [];

		// item A is gated in stage 1 until we release it; item B flows freely.
		const aStage1Gate = deferred<void>();

		const stage1 = async (_prev: unknown, item: unknown) => {
			if (item === "A") {
				events.push("A:stage1:start");
				await aStage1Gate.promise;
				events.push("A:stage1:end");
				return "A1";
			}
			events.push("B:stage1");
			return "B1";
		};

		const stage2 = async (prev: unknown, item: unknown) => {
			if (item === "B") {
				events.push("B:stage2");
				return "B2";
			}
			events.push("A:stage2");
			return `${prev}->A2`;
		};

		const promise = pipeline(["A", "B"], stage1, stage2);

		// Let B's chain run to completion while A is still parked in stage 1.
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(events).toContain("B:stage2");
		expect(events).not.toContain("A:stage1:end");

		// Now release A; its remaining stages complete.
		aStage1Gate.resolve();
		const result = await promise;

		expect(result).toEqual(["A1->A2", "B2"]);
		// B reached stage 2 strictly before A left stage 1 — the proof of no barrier.
		expect(events.indexOf("B:stage2")).toBeLessThan(
			events.indexOf("A:stage1:end"),
		);
	});

	test("stage receives (prev, originalItem, index); prev !== originalItem at stage 2+", async () => {
		const seen: Array<{ prev: unknown; item: unknown; index: number }> = [];

		const stage1 = (_prev: unknown, item: unknown) => `mapped:${item}`;
		const stage2 = (prev: unknown, item: unknown, index: number) => {
			seen.push({ prev, item, index });
			return prev;
		};

		await pipeline(["x", "y"], stage1, stage2);

		expect(seen).toEqual([
			{ prev: "mapped:x", item: "x", index: 0 },
			{ prev: "mapped:y", item: "y", index: 1 },
		]);
		// prev is the previous stage's output, not the original item.
		expect(seen[0]?.prev).not.toBe(seen[0]?.item);
	});

	test("throw->null isolation: poisoned item A -> null, item B completes all stages", async () => {
		const stage1 = (_prev: unknown, item: unknown) => item;
		const stage2 = (_prev: unknown, item: unknown) => {
			if (item === "A") throw new Error("A poisoned");
			return `${item}:s2`;
		};
		const stage3 = (prev: unknown) => `${prev}:s3`;

		const result = await pipeline(["A", "B"], stage1, stage2, stage3);

		expect(result).toEqual([null, "B:s2:s3"]);
	});

	test("a throwing stage skips that item's remaining stages", async () => {
		let stage3Ran = false;
		const stage1 = (_prev: unknown, item: unknown) => item;
		const stage2 = () => {
			throw new Error("boom");
		};
		const stage3 = () => {
			stage3Ran = true;
			return "should-not-happen";
		};

		const result = await pipeline(["only"], stage1, stage2, stage3);

		expect(result).toEqual([null]);
		expect(stage3Ran).toBe(false);
	});

	test("synchronously-throwing stage drops the item to null", async () => {
		const syncThrow = () => {
			throw new Error("sync boom");
		};
		const result = await pipeline(["a", "b"], syncThrow);
		expect(result).toEqual([null, null]);
	});

	test("empty items -> []", async () => {
		const result = await pipeline([], (p: unknown) => p);
		expect(result).toEqual([]);
	});

	test("zero stages -> items returned as-is", async () => {
		const result = await pipeline([1, "two", { three: 3 }]);
		expect(result).toEqual([1, "two", { three: 3 }]);
	});

	test("4097 items -> ItemCapError carrying count and cap", async () => {
		const items = Array.from({ length: 4097 });
		expect(() => pipeline(items, (p: unknown) => p)).toThrow(ItemCapError);
		try {
			pipeline(items, (p: unknown) => p);
			throw new Error("expected ItemCapError");
		} catch (err) {
			expect(err).toBeInstanceOf(ItemCapError);
			const capErr = err as ItemCapError;
			expect(capErr.count).toBe(4097);
			expect(capErr.cap).toBe(4096);
		}
	});

	test("exactly 4096 items is allowed", async () => {
		const items = Array.from({ length: 4096 }, (_, i) => i);
		const result = await pipeline(items, (p: unknown) => p);
		expect(result).toHaveLength(4096);
	});
});

describe("parallel — barrier semantics, never rejects", () => {
	test("runs thunks concurrently and preserves order", async () => {
		const result = await parallel([() => 1, async () => 2, () => "three"]);
		expect(result).toEqual([1, 2, "three"]);
	});

	test("failing thunk -> null in the result array", async () => {
		const result = await parallel([
			() => "ok",
			() => {
				throw new Error("nope");
			},
			async () => "also-ok",
		]);
		expect(result).toEqual(["ok", null, "also-ok"]);
	});

	test("synchronously-throwing thunk -> null slot", async () => {
		const result = await parallel([
			() => {
				throw new Error("sync");
			},
			() => "survivor",
		]);
		expect(result).toEqual([null, "survivor"]);
	});

	test("non-function thunk -> that slot is null", async () => {
		// Off the typed contract, but the spec pins the runtime behavior.
		const thunks = [() => "ok", 42, null] as unknown as Array<() => unknown>;
		const result = await parallel(thunks);
		expect(result).toEqual(["ok", null, null]);
	});

	test("never rejects: all thunks throw -> all-null array", async () => {
		const throwing = Array.from({ length: 5 }, () => () => {
			throw new Error("boom");
		});
		const result = await parallel(throwing);
		expect(result).toEqual([null, null, null, null, null]);
	});

	test("rejecting async thunk -> null slot", async () => {
		const result = await parallel([
			async () => {
				throw new Error("async reject");
			},
			async () => "fine",
		]);
		expect(result).toEqual([null, "fine"]);
	});

	test("empty thunks -> []", async () => {
		const result = await parallel([]);
		expect(result).toEqual([]);
	});

	test("4097 thunks -> ItemCapError carrying count and cap", async () => {
		const thunks = Array.from({ length: 4097 }, () => () => 0);
		expect(() => parallel(thunks)).toThrow(ItemCapError);
		try {
			parallel(thunks);
			throw new Error("expected ItemCapError");
		} catch (err) {
			expect(err).toBeInstanceOf(ItemCapError);
			const capErr = err as ItemCapError;
			expect(capErr.count).toBe(4097);
			expect(capErr.cap).toBe(4096);
		}
	});

	test("exactly 4096 thunks is allowed", async () => {
		const thunks = Array.from({ length: 4096 }, (_, i) => () => i);
		const result = await parallel(thunks);
		expect(result).toHaveLength(4096);
	});
});
