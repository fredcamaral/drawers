import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { listRunIds, type RunsFs, resolveRunId } from "./runs";

/**
 * Tests for the feed-dir run resolution (Task 8.3.3). `resolveRunId` carries the
 * open-command's default-to-freshest-run contract; a wrong mtime comparison or
 * suffix filter would silently open the WRONG run. It is exercised against an
 * in-memory readdir/stat seam (the same injection pattern the tailer uses) with no
 * JSX mounted.
 */

const FEED_DIR = "/wf-data/workflow-feed";

/** An in-memory feed dir: a map of basename → mtimeMs, with an injectable fs. */
function makeDir(
	entries: Record<string, number>,
	opts?: { missing?: boolean },
) {
	const fs: RunsFs = {
		readdir: async (path: string) => {
			if (opts?.missing || path !== FEED_DIR) {
				const err = new Error("ENOENT") as Error & { code: string };
				err.code = "ENOENT";
				throw err;
			}
			return Object.keys(entries);
		},
		stat: async (path: string) => {
			const name = path.slice(FEED_DIR.length + 1);
			const mtimeMs = entries[name];
			if (mtimeMs === undefined) {
				const err = new Error("ENOENT") as Error & { code: string };
				err.code = "ENOENT";
				throw err;
			}
			return { mtimeMs };
		},
	};
	return fs;
}

describe("resolveRunId", () => {
	test("an explicit runId passes straight through without scanning", async () => {
		// readdir/stat that throw if touched — an explicit id must short-circuit.
		const fs: RunsFs = {
			readdir: async () => {
				throw new Error("readdir must not be called");
			},
			stat: async () => {
				throw new Error("stat must not be called");
			},
		};
		expect(await resolveRunId(FEED_DIR, "wf_explicit", fs, join)).toBe(
			"wf_explicit",
		);
	});

	test("picks the .jsonl with the greatest mtimeMs", async () => {
		const fs = makeDir({
			"wf_a.jsonl": 100,
			"wf_b.jsonl": 300,
			"wf_c.jsonl": 200,
		});
		expect(await resolveRunId(FEED_DIR, undefined, fs, join)).toBe("wf_b");
	});

	test("ignores non-.jsonl entries even when newer", async () => {
		const fs = makeDir({
			"wf_a.jsonl": 100,
			"scratch.txt": 999,
			"wf_b.jsonl": 200,
		});
		expect(await resolveRunId(FEED_DIR, undefined, fs, join)).toBe("wf_b");
	});

	test("a file vanishing mid-scan is skipped, the survivor wins", async () => {
		const entries = { "wf_gone.jsonl": 500, "wf_live.jsonl": 100 };
		const fs: RunsFs = {
			readdir: async () => Object.keys(entries),
			stat: async (path: string) => {
				const name = path.slice(FEED_DIR.length + 1);
				if (name === "wf_gone.jsonl") {
					const err = new Error("ENOENT") as Error & { code: string };
					err.code = "ENOENT";
					throw err;
				}
				return { mtimeMs: 100 };
			},
		};
		expect(await resolveRunId(FEED_DIR, undefined, fs, join)).toBe("wf_live");
	});

	test("a missing dir yields undefined", async () => {
		const fs = makeDir({}, { missing: true });
		expect(await resolveRunId(FEED_DIR, undefined, fs, join)).toBeUndefined();
	});

	test("an empty dir yields undefined", async () => {
		const fs = makeDir({});
		expect(await resolveRunId(FEED_DIR, undefined, fs, join)).toBeUndefined();
	});

	test("an empty-string explicit falls through to scanning", async () => {
		const fs = makeDir({ "wf_only.jsonl": 1 });
		expect(await resolveRunId(FEED_DIR, "", fs, join)).toBe("wf_only");
	});
});

describe("listRunIds", () => {
	test("returns every .jsonl run, most-recently-modified first", async () => {
		const fs = makeDir({
			"wf_a.jsonl": 100,
			"wf_b.jsonl": 300,
			"wf_c.jsonl": 200,
		});
		expect(await listRunIds(FEED_DIR, fs, join)).toEqual([
			"wf_b",
			"wf_c",
			"wf_a",
		]);
	});

	test("index 0 matches resolveRunId's freshest default", async () => {
		const fs = makeDir({ "wf_old.jsonl": 1, "wf_new.jsonl": 9 });
		const list = await listRunIds(FEED_DIR, fs, join);
		expect(list[0]).toBe(await resolveRunId(FEED_DIR, undefined, fs, join));
	});

	test("ignores non-.jsonl entries even when newer", async () => {
		const fs = makeDir({
			"wf_a.jsonl": 100,
			"scratch.txt": 999,
			"wf_b.jsonl": 200,
		});
		expect(await listRunIds(FEED_DIR, fs, join)).toEqual(["wf_b", "wf_a"]);
	});

	test("a file vanishing mid-scan is skipped", async () => {
		const entries = { "wf_gone.jsonl": 500, "wf_live.jsonl": 100 };
		const fs: RunsFs = {
			readdir: async () => Object.keys(entries),
			stat: async (path: string) => {
				const name = path.slice(FEED_DIR.length + 1);
				if (name === "wf_gone.jsonl") {
					const err = new Error("ENOENT") as Error & { code: string };
					err.code = "ENOENT";
					throw err;
				}
				return { mtimeMs: 100 };
			},
		};
		expect(await listRunIds(FEED_DIR, fs, join)).toEqual(["wf_live"]);
	});

	test("a missing dir yields an empty list", async () => {
		const fs = makeDir({}, { missing: true });
		expect(await listRunIds(FEED_DIR, fs, join)).toEqual([]);
	});
});
