import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntentJournalEntry, JournalEntry } from "../runtime/types";
import { computeCallKey, createJournal, type JournalFs } from "./journal";

// ---- helpers --------------------------------------------------------------

async function tmpFile(): Promise<{ path: string; dir: string }> {
	const dir = await mkdtemp(join(tmpdir(), "wf-journal-"));
	return { path: join(dir, "nested", "journal.jsonl"), dir };
}

interface LoggedError {
	msg: string;
	meta?: Record<string, unknown>;
}

function makeLogger() {
	const errors: LoggedError[] = [];
	return {
		logger: {
			error: (msg: string, meta?: Record<string, unknown>) =>
				errors.push({ msg, meta }),
		},
		errors,
	};
}

function entry(over: Partial<JournalEntry> = {}): JournalEntry {
	return { index: 0, key: "k0", status: "ok", result: "r0", ...over };
}

/**
 * A write-ahead intent entry (Phase 3). A sibling of {@link entry} rather than a
 * `Partial<JournalEntry>` overload: after the union, a Partial distributes over
 * both members and the spread no longer narrows to one cleanly.
 */
function intentEntry(
	over: Partial<IntentJournalEntry> = {},
): IntentJournalEntry {
	return { index: 0, key: "k0", status: "intent", ...over };
}

// ---- computeCallKey -------------------------------------------------------

describe("computeCallKey", () => {
	test("is a 64-char sha256 hex string", () => {
		const key = computeCallKey({ prompt: "hello" });
		expect(key).toMatch(/^[0-9a-f]{64}$/);
	});

	test("is stable across schema key ordering (key-sorted stringify)", () => {
		const a = computeCallKey({
			prompt: "p",
			schema: { type: "object", properties: { a: { type: "number" } } },
		});
		const b = computeCallKey({
			prompt: "p",
			schema: { properties: { a: { type: "number" } }, type: "object" },
		});
		expect(a).toBe(b);
	});

	test("is stable across input field ordering", () => {
		const a = computeCallKey({ prompt: "p", model: "m", agentType: "g" });
		const b = computeCallKey({ agentType: "g", model: "m", prompt: "p" });
		expect(a).toBe(b);
	});

	test("is sensitive to the prompt", () => {
		expect(computeCallKey({ prompt: "a" })).not.toBe(
			computeCallKey({ prompt: "b" }),
		);
	});

	test("is sensitive to the model", () => {
		expect(computeCallKey({ prompt: "p", model: "m1" })).not.toBe(
			computeCallKey({ prompt: "p", model: "m2" }),
		);
	});

	test("is sensitive to schema presence", () => {
		expect(computeCallKey({ prompt: "p" })).not.toBe(
			computeCallKey({ prompt: "p", schema: { type: "object" } }),
		);
	});

	test("is stable for nested arrays/primitives", () => {
		const a = computeCallKey({
			prompt: "p",
			schema: { enum: [1, 2, 3], nested: { z: true, a: [false, null] } },
		});
		const b = computeCallKey({
			prompt: "p",
			schema: { nested: { a: [false, null], z: true }, enum: [1, 2, 3] },
		});
		expect(a).toBe(b);
	});
});

// ---- createJournal: record / load round-trip ------------------------------

describe("createJournal", () => {
	test("records entries and loads them back intact (round-trip)", async () => {
		const { path, dir } = await tmpFile();
		try {
			const j = createJournal({ path });
			await j.record(entry({ index: 0, key: "k0", result: "r0" }));
			await j.record(entry({ index: 1, key: "k1", result: { n: 7 } }));
			const loaded = await j.load();
			expect(loaded).toEqual([
				{ index: 0, key: "k0", status: "ok", result: "r0" },
				{ index: 1, key: "k1", status: "ok", result: { n: 7 } },
			]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("creates the parent directory (mkdir -p of dirname)", async () => {
		const { path, dir } = await tmpFile();
		try {
			const j = createJournal({ path });
			await j.record(entry());
			// File lives under a nested dir that did not exist before.
			const contents = await readFile(path, "utf-8");
			expect(contents.trim().split("\n").length).toBe(1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("missing file → load returns []", async () => {
		const { path, dir } = await tmpFile();
		try {
			const j = createJournal({ path });
			expect(await j.load()).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("appends as JSONL (one stringified entry per line)", async () => {
		const { path, dir } = await tmpFile();
		try {
			const j = createJournal({ path });
			await j.record(entry({ index: 0 }));
			await j.record(entry({ index: 1 }));
			const lines = (await readFile(path, "utf-8")).split("\n").filter(Boolean);
			expect(lines.length).toBe(2);
			expect(JSON.parse(lines[0] as string).index).toBe(0);
			expect(JSON.parse(lines[1] as string).index).toBe(1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("tolerates a truncated final line: drops it and logs", async () => {
		const { logger, errors } = makeLogger();
		// In-memory fs facade serving a file whose last line is a half-written
		// JSON object (crash mid-append).
		const good = JSON.stringify(entry({ index: 0, key: "k0" }));
		const truncated = '{"index":1,"key":"k1","status":"ok","resul';
		const file = `${good}\n${truncated}`;
		const fs = memFs({ "/j.jsonl": file });
		const j = createJournal({ path: "/j.jsonl", fs, logger });
		const loaded = await j.load();
		expect(loaded).toEqual([
			{ index: 0, key: "k0", status: "ok", result: "r0" },
		]);
		expect(errors.length).toBe(1);
	});

	test("write-queue serializes concurrent records into two intact lines", async () => {
		const { path, dir } = await tmpFile();
		try {
			const j = createJournal({ path });
			// Fire both without awaiting between — the queue must serialize them so
			// neither write interleaves/clobbers the other.
			await Promise.all([
				j.record(entry({ index: 0, key: "k0" })),
				j.record(entry({ index: 1, key: "k1" })),
			]);
			const lines = (await readFile(path, "utf-8")).split("\n").filter(Boolean);
			expect(lines.length).toBe(2);
			const parsed = lines.map((l) => JSON.parse(l));
			expect(parsed.map((p) => p.index).sort()).toEqual([0, 1]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	// ---- Phase 3: write-ahead intent records ----------------------------------

	test("an intent entry round-trips through record/load intact", async () => {
		const { path, dir } = await tmpFile();
		try {
			const j = createJournal({ path });
			await j.record(intentEntry({ index: 0, key: "k0", label: "do work" }));
			const loaded = await j.load();
			expect(loaded).toEqual([
				{ index: 0, key: "k0", status: "intent", label: "do work" },
			]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("an intent WITHOUT a matching completion is a valid line, NOT dropped as corruption", async () => {
		// A crash leaves an intent with no `ok`. It is a fully-formed line, unlike a
		// truncated final line — load() must retain it (any future validation must not
		// treat a missing completion as corruption).
		const { path, dir } = await tmpFile();
		try {
			const j = createJournal({ path });
			await j.record(entry({ index: 0, key: "k0", result: "r0" }));
			await j.record(
				intentEntry({ index: 1, key: "k1", label: "interrupted" }),
			);
			const loaded = await j.load();
			expect(loaded).toEqual([
				{ index: 0, key: "k0", status: "ok", result: "r0" },
				{ index: 1, key: "k1", status: "intent", label: "interrupted" },
			]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("a mixed journal loads both members; filtering to status==='ok' drops intents", async () => {
		// The replay-cache-poison guard, asserted at the data level: a journal with a
		// settled ok(0) and an intent(1) loads both, but the resume load-filter keeps
		// only the settled entry — the intent never reaches the replay cache.
		const { path, dir } = await tmpFile();
		try {
			const j = createJournal({ path });
			await j.record(entry({ index: 0, key: "k0", result: "settled-0" }));
			await j.record(intentEntry({ index: 1, key: "k1", label: "K1" }));
			const loaded = await j.load();
			expect(loaded).toHaveLength(2);
			const settled = loaded.filter((e) => e.status === "ok");
			expect(settled).toEqual([
				{ index: 0, key: "k0", status: "ok", result: "settled-0" },
			]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

// ---- tiny in-memory fs facade for the truncated-line case -----------------

function memFs(initial: Record<string, string>): JournalFs {
	const files = new Map<string, string>(Object.entries(initial));
	return {
		mkdir: async () => undefined,
		readFile: async (p) => {
			const v = files.get(p);
			if (v === undefined) {
				const err = new Error("ENOENT") as Error & { code: string };
				err.code = "ENOENT";
				throw err;
			}
			return v;
		},
		appendFile: async (p, data) => {
			files.set(p, (files.get(p) ?? "") + data);
		},
	};
}
