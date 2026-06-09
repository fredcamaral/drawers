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
});
