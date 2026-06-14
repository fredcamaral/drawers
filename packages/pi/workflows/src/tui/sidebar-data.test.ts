import { describe, expect, test } from "bun:test";
import type { FeedEvent } from "../plugin/feed";
import {
	activeRuns,
	isActive,
	type SidebarFs,
	summarizeFeedFile,
} from "./sidebar-data";

/**
 * Tests for the sidebar data layer (Task 8.3.4). `summarize` itself is covered in
 * reducer.test.ts; here we cover the two correctness invariants the sidebar depends
 * on: a SETTLED run must not appear (only running/cancelling are active), and the
 * survivors sort longest-running first (elapsed-desc). The readdir/readFile seam is
 * injected against a hand-built JSONL dir — no JSX, no real disk.
 */

const FEED_DIR = "/wf-data/workflow-feed";

/** Render a feed (array of events) as the JSONL text a feed file holds. */
function jsonl(events: FeedEvent[]): string {
	return `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

/** A minimal active (running) feed started at `startedAt` with one open agent. */
function activeFeed(runId: string, startedAt: number): FeedEvent[] {
	return [
		{ type: "run:start", runId, parentSessionID: "ses_p", at: startedAt },
		{ type: "agent:start", label: "impl", phase: "build", at: startedAt + 1 },
		{
			type: "agent:launched",
			label: "impl",
			phase: "build",
			sessionID: `ses_${runId}`,
			model: "anthropic/claude-opus-4-8",
			at: startedAt + 2,
		},
	];
}

/** The same feed plus a terminal `run:end` (a SETTLED run the sidebar must drop). */
function settledFeed(runId: string, startedAt: number): FeedEvent[] {
	return [
		...activeFeed(runId, startedAt),
		{
			type: "agent:end",
			label: "impl",
			status: "completed",
			sessionID: `ses_${runId}`,
			durationMs: 10,
			at: startedAt + 5,
		} as FeedEvent,
		{ type: "run:end", status: "completed", at: startedAt + 6 },
	];
}

/** An in-memory feed dir backed by a basename → JSONL-text map. */
function makeDir(files: Record<string, string>): SidebarFs {
	return {
		readdir: async (path: string) => {
			if (path !== FEED_DIR) {
				const err = new Error("ENOENT") as Error & { code: string };
				err.code = "ENOENT";
				throw err;
			}
			return Object.keys(files);
		},
		readFile: async (path: string) => {
			const name = path.slice(FEED_DIR.length + 1);
			const text = files[name];
			if (text === undefined) {
				const err = new Error("ENOENT") as Error & { code: string };
				err.code = "ENOENT";
				throw err;
			}
			return text;
		},
	};
}

describe("isActive", () => {
	test("running and cancelling are active; terminal statuses are not", () => {
		expect(isActive("running")).toBe(true);
		expect(isActive("cancelling")).toBe(true);
		expect(isActive("completed")).toBe(false);
		expect(isActive("error")).toBe(false);
		expect(isActive("cancelled")).toBe(false);
	});
});

describe("summarizeFeedFile", () => {
	test("folds an active feed into a running summary with live elapsed", async () => {
		const fs = makeDir({ "wf_a.jsonl": jsonl(activeFeed("wf_a", 1000)) });
		const summary = await summarizeFeedFile(`${FEED_DIR}/wf_a.jsonl`, 5000, fs);
		expect(summary?.status).toBe("running");
		expect(summary?.runId).toBe("wf_a");
		expect(summary?.totalAgents).toBe(1);
		expect(summary?.doneAgents).toBe(0);
		expect(summary?.elapsedMs).toBe(4000);
	});

	test("folds a settled feed into a terminal summary (excluded by the caller)", async () => {
		const fs = makeDir({ "wf_b.jsonl": jsonl(settledFeed("wf_b", 1000)) });
		const summary = await summarizeFeedFile(
			`${FEED_DIR}/wf_b.jsonl`,
			999_999,
			fs,
		);
		expect(summary?.status).toBe("completed");
		expect(isActive(summary?.status ?? "completed")).toBe(false);
	});

	test("a vanished file yields undefined, never throws", async () => {
		const fs = makeDir({});
		expect(
			await summarizeFeedFile(`${FEED_DIR}/gone.jsonl`, 1, fs),
		).toBeUndefined();
	});
});

describe("activeRuns", () => {
	test("excludes settled runs and keeps only the active ones", async () => {
		const fs = makeDir({
			"wf_live.jsonl": jsonl(activeFeed("wf_live", 1000)),
			"wf_done.jsonl": jsonl(settledFeed("wf_done", 1000)),
		});
		const runs = await activeRuns(FEED_DIR, fs, 5000);
		expect(runs.map((r) => r.runId)).toEqual(["wf_live"]);
	});

	test("orders active runs by elapsedMs descending (longest-running on top)", async () => {
		const fs = makeDir({
			// `wf_old` started earlier → larger elapsed at the same `now` → sorts first.
			"wf_new.jsonl": jsonl(activeFeed("wf_new", 4000)),
			"wf_old.jsonl": jsonl(activeFeed("wf_old", 1000)),
		});
		const runs = await activeRuns(FEED_DIR, fs, 5000);
		expect(runs.map((r) => r.runId)).toEqual(["wf_old", "wf_new"]);
		expect(runs[0]?.elapsedMs).toBe(4000);
		expect(runs[1]?.elapsedMs).toBe(1000);
	});

	test("ignores non-.jsonl entries", async () => {
		const fs = makeDir({
			"wf_live.jsonl": jsonl(activeFeed("wf_live", 1000)),
			"notes.txt": "ignore me",
		});
		const runs = await activeRuns(FEED_DIR, fs, 5000);
		expect(runs.map((r) => r.runId)).toEqual(["wf_live"]);
	});

	test("a missing feed dir yields an empty list, never throws", async () => {
		const fs = makeDir({ "wf_live.jsonl": jsonl(activeFeed("wf_live", 1000)) });
		expect(await activeRuns("/nope", fs, 5000)).toEqual([]);
	});
});
