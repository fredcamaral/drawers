import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCadenceStore, type Directive } from "./store";

async function tempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "cadence-store-"));
}

const sample: Directive = {
	id: "cadence_1",
	sessionID: "s1",
	kind: "loop",
	instruction: "do it",
	intervalMs: 5000,
	until: "done?",
	iterations: 2,
	maxIterations: 10,
	status: "active",
	createdAt: 1234,
};

describe("CadenceStore", () => {
	test("save → load round-trips a directive", async () => {
		const baseDir = await tempDir();
		try {
			const store = createCadenceStore({ baseDir });
			await store.save(sample);
			const loaded = await store.load();
			expect(loaded.length).toBe(1);
			expect(loaded[0]).toEqual(sample);
		} finally {
			await rm(baseDir, { recursive: true, force: true });
		}
	});

	test("load on a missing dir returns []", async () => {
		const baseDir = join(tmpdir(), `cadence-missing-${Date.now()}`);
		const store = createCadenceStore({ baseDir });
		const loaded = await store.load();
		expect(loaded).toEqual([]);
	});

	test("delete removes a directive's file", async () => {
		const baseDir = await tempDir();
		try {
			const store = createCadenceStore({ baseDir });
			await store.save(sample);
			await store.delete(sample.id);
			const loaded = await store.load();
			expect(loaded).toEqual([]);
		} finally {
			await rm(baseDir, { recursive: true, force: true });
		}
	});

	test("a corrupt JSON file is skipped, not thrown, and does not poison others", async () => {
		const baseDir = await tempDir();
		try {
			const store = createCadenceStore({ baseDir });
			await store.save(sample);
			// Drop a malformed file alongside the valid one.
			await writeFile(
				join(baseDir, "cadence_broken.json"),
				"{ not json",
				"utf-8",
			);

			const loaded = await store.load();

			// The valid directive survives; the corrupt file is silently skipped.
			expect(loaded).toHaveLength(1);
			expect(loaded[0]).toEqual(sample);
		} finally {
			await rm(baseDir, { recursive: true, force: true });
		}
	});

	test("a file missing/NaN numeric fields is rejected (the cap depends on them)", async () => {
		const baseDir = await tempDir();
		try {
			const store = createCadenceStore({ baseDir });
			// All five string/discriminator fields present, but the numeric invariants
			// the engine's safety cap relies on are missing or NaN. Each must be skipped
			// so an undefined/NaN counter never crosses into the engine.
			const base = {
				sessionID: "s1",
				kind: "loop" as const,
				instruction: "do it",
				intervalMs: 5000,
				status: "active" as const,
				createdAt: 1234,
				iterations: 0,
				maxIterations: 10,
			};
			const corrupt: Record<string, unknown> = {
				missing_iterations: { ...base, id: "c1", iterations: undefined },
				missing_max: { ...base, id: "c2", maxIterations: undefined },
				nan_iterations: { ...base, id: "c3", iterations: Number.NaN },
				zero_max: { ...base, id: "c4", maxIterations: 0 },
				missing_created: { ...base, id: "c5", createdAt: undefined },
				loop_no_interval: { ...base, id: "c6", intervalMs: undefined },
			};
			for (const [name, value] of Object.entries(corrupt)) {
				await writeFile(
					join(baseDir, `${name}.json`),
					JSON.stringify(value),
					"utf-8",
				);
			}
			// A goal with no intervalMs is valid (its trigger is idle, not a timer).
			await writeFile(
				join(baseDir, "valid_goal.json"),
				JSON.stringify({
					...base,
					id: "g1",
					kind: "goal",
					intervalMs: undefined,
				}),
				"utf-8",
			);

			const loaded = await store.load();

			// Only the goal survives; every numerically-corrupt loop is skipped.
			expect(loaded).toHaveLength(1);
			expect(loaded[0]?.id).toBe("g1");
		} finally {
			await rm(baseDir, { recursive: true, force: true });
		}
	});
});
