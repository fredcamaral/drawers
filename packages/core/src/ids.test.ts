import { describe, expect, test } from "bun:test";
import { createIdGenerator } from "./ids";

describe("createIdGenerator", () => {
	test("generated ID matches the bg_ + 8-char lowercase alphanumeric format", () => {
		const gen = createIdGenerator();
		const id = gen.next(new Set());
		expect(id).toMatch(/^bg_[a-z0-9]{8}$/);
	});

	test("regenerates a different ID when the first candidate collides", () => {
		// Random source that yields the same byte sequence on the first two
		// candidates, then diverges. Each next() consumes 8 draws (one per char).
		const sequences = [
			new Array(8).fill(0), // candidate 1 -> collides with liveIds
			new Array(8).fill(0.5), // candidate 2 -> distinct, accepted
		];
		let call = 0;
		const random = () => {
			const seqIndex = Math.min(Math.floor(call / 8), sequences.length - 1);
			const seq = sequences[seqIndex] ?? [];
			const value = seq[call % 8] ?? 0;
			call += 1;
			return value;
		};
		const gen = createIdGenerator({ random });

		// First, learn what the colliding candidate looks like with a fresh gen
		// driven by the same all-zero sequence.
		const probe = createIdGenerator({ random: () => 0 }).next(new Set());

		const id = gen.next(new Set([probe]));
		expect(id).toMatch(/^bg_[a-z0-9]{8}$/);
		expect(id).not.toBe(probe);
	});

	test("throws a bounded-attempts error when every candidate collides", () => {
		// Pin random so every candidate is identical, and seed liveIds with it.
		const fixed = createIdGenerator({ random: () => 0 }).next(new Set());
		const gen = createIdGenerator({ random: () => 0 });
		expect(() => gen.next(new Set([fixed]))).toThrow(/attempts/i);
	});

	test("produces unique IDs across 10k generations from the default source", () => {
		const gen = createIdGenerator();
		const live = new Set<string>();
		for (let i = 0; i < 10_000; i += 1) {
			const id = gen.next(live);
			expect(live.has(id)).toBe(false);
			live.add(id);
		}
		expect(live.size).toBe(10_000);
	});
});
