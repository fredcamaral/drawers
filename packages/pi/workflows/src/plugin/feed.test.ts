import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StampedProgressEvent } from "../runtime/types";
import {
	createFeedWriter,
	type FeedEvent,
	type FeedFs,
	type FeedReadFs,
	readFeedCounts,
} from "./feed";

// ---- helpers --------------------------------------------------------------

async function tmpDir(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "wf-feed-"));
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

function stamped(over: Partial<StampedProgressEvent> = {}): FeedEvent {
	return {
		type: "log",
		message: "hello",
		at: 1000,
		...over,
	} as FeedEvent;
}

async function readLines(path: string): Promise<FeedEvent[]> {
	const raw = await readFile(path, "utf-8");
	return raw
		.split("\n")
		.filter((l) => l.length > 0)
		.map((l) => JSON.parse(l) as FeedEvent);
}

// ---- createFeedWriter -----------------------------------------------------

describe("createFeedWriter", () => {
	test("writes run:start / events / run:end as one JSONL line each, in append order", async () => {
		const dir = await tmpDir();
		try {
			const w = createFeedWriter({ dir, runId: "wf_a" });
			w.append({
				type: "run:start",
				runId: "wf_a",
				parentSessionID: "ses_parent",
				scriptPath: "/scripts/wf_a.js",
				at: 100,
			});
			w.append(stamped({ type: "agent:start", label: "a", at: 200 }));
			w.append(
				stamped({
					type: "agent:end",
					label: "a",
					status: "completed",
					at: 300,
				}),
			);
			w.append({
				type: "run:end",
				status: "completed",
				agentCount: 1,
				at: 400,
			});
			await w.settled();

			const lines = await readLines(join(dir, "wf_a.jsonl"));
			expect(lines).toHaveLength(4);
			expect(lines[0]?.type).toBe("run:start");
			expect(lines[1]?.type).toBe("agent:start");
			expect(lines[2]?.type).toBe("agent:end");
			expect(lines[3]?.type).toBe("run:end");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("round-trips a run:cancel-requested line, ordered in the chain like any other", async () => {
		const dir = await tmpDir();
		try {
			const w = createFeedWriter({ dir, runId: "wf_cancel" });
			w.append({
				type: "run:start",
				runId: "wf_cancel",
				parentSessionID: "ses_p",
				at: 10,
			});
			const cancel: FeedEvent = {
				type: "run:cancel-requested",
				runId: "wf_cancel",
				at: 20,
			};
			w.append(cancel);
			w.append({ type: "run:end", status: "cancelled", at: 30 });
			await w.settled();

			const lines = await readLines(join(dir, "wf_cancel.jsonl"));
			expect(lines).toHaveLength(3);
			expect(lines[1]).toEqual(cancel);
			expect(lines[1]?.type).toBe("run:cancel-requested");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("creates the feed dir (mkdir -p) on first append", async () => {
		const dir = await tmpDir();
		try {
			const nested = join(dir, "does-not-exist-yet");
			const w = createFeedWriter({ dir: nested, runId: "wf_b" });
			w.append({
				type: "run:start",
				runId: "wf_b",
				parentSessionID: "ses_p",
				at: 1,
			});
			await w.settled();
			const lines = await readLines(join(nested, "wf_b.jsonl"));
			expect(lines).toHaveLength(1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("serializes interleaved appends in emission order (no half-lines)", async () => {
		const dir = await tmpDir();
		try {
			const w = createFeedWriter({ dir, runId: "wf_c" });
			// Fire many without awaiting between — the internal chain must serialize
			// them so order is preserved and no line is interleaved/clobbered.
			for (let i = 0; i < 50; i += 1) {
				w.append(stamped({ type: "log", message: `m${i}`, at: i }));
			}
			await w.settled();
			const lines = await readLines(join(dir, "wf_c.jsonl"));
			expect(lines).toHaveLength(50);
			expect(lines.map((l) => (l as { message: string }).message)).toEqual(
				Array.from({ length: 50 }, (_, i) => `m${i}`),
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("fenced: a throwing fs records nothing, logs once, and settled still resolves", async () => {
		const { logger, errors } = makeLogger();
		// An fs whose appendFile always throws — simulating a broken disk. The writer
		// must flip dead on the first failure, drop all subsequent appends, and log
		// exactly once. A broken disk must NEVER reject the drain.
		const throwingFs: FeedFs = {
			mkdir: async () => undefined,
			appendFile: async () => {
				throw new Error("EIO: disk on fire");
			},
		};
		const w = createFeedWriter({
			dir: "/nowhere",
			runId: "wf_d",
			fs: throwingFs,
			logger,
		});
		w.append({ type: "run:start", runId: "wf_d", parentSessionID: "p", at: 1 });
		w.append(stamped({ type: "log", message: "second", at: 2 }));
		w.append({ type: "run:end", status: "error", at: 3 });
		// Must resolve, never reject.
		await w.settled();
		expect(errors).toHaveLength(1);
		expect(errors[0]?.msg).toContain("feed");
	});

	test("after a dead-state failure, subsequent appends are dropped silently (one log total)", async () => {
		const { logger, errors } = makeLogger();
		let calls = 0;
		// Fails on the very first append, succeeds thereafter — but the writer is
		// already dead, so nothing is written and no further logs are emitted.
		const written: string[] = [];
		const flakyFs: FeedFs = {
			mkdir: async () => undefined,
			appendFile: async (_path, data) => {
				calls += 1;
				if (calls === 1) {
					throw new Error("transient");
				}
				written.push(data);
			},
		};
		const w = createFeedWriter({
			dir: "/x",
			runId: "wf_e",
			fs: flakyFs,
			logger,
		});
		w.append(stamped({ type: "log", message: "one", at: 1 }));
		w.append(stamped({ type: "log", message: "two", at: 2 }));
		await w.settled();
		expect(written).toHaveLength(0);
		expect(errors).toHaveLength(1);
	});
});

// ---- readFeedCounts (Phase 3.2.1) -----------------------------------------

/** Build a string feed file from a list of events, JSONL. */
function feedFile(events: FeedEvent[]): string {
	return `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

/** A read fs serving one path from raw text (ENOENT for anything else). */
function readFs(path: string, raw: string | undefined): FeedReadFs {
	return {
		readFile: async (p) => {
			if (p !== path || raw === undefined) {
				const err = new Error("ENOENT") as Error & { code: string };
				err.code = "ENOENT";
				throw err;
			}
			return raw;
		},
	};
}

describe("readFeedCounts", () => {
	test("counts live vs cached agent:end lines and rebuilds AgentSummary[] with phase", async () => {
		// A LIVE agent's phase lives on agent:launched, NOT on its enriched agent:end —
		// so the reader must PAIR launched→end to recover phase (blocker fix).
		const events: FeedEvent[] = [
			{ type: "run:start", runId: "wf_r", parentSessionID: "p", at: 1 },
			{ type: "agent:start", label: "writer", phase: "draft", at: 2 },
			{
				type: "agent:launched",
				label: "writer",
				phase: "draft",
				sessionID: "ses_1",
				model: "claude-x",
				agentType: "build",
				at: 3,
			},
			{
				type: "agent:end",
				label: "writer",
				status: "completed",
				sessionID: "ses_1",
				at: 9,
				durationMs: 6,
				toolCalls: 4,
				model: "claude-x",
				agentType: "build",
				tokens: {
					input: 10,
					output: 20,
					reasoning: 0,
					cacheRead: 0,
					cacheWrite: 0,
				},
			} as FeedEvent,
			// A CACHED agent: agent:start carries the phase; agent:end has no sessionID.
			{ type: "agent:start", label: "verify", phase: "review", at: 10 },
			{ type: "agent:end", label: "verify", status: "cached", at: 11 },
			{ type: "run:end", status: "completed", agentCount: 2, at: 12 },
		];
		const path = "/feed/wf_r.jsonl";
		const counts = await readFeedCounts(path, readFs(path, feedFile(events)));
		expect(counts.agentCount).toBe(2);
		expect(counts.live).toBe(1);
		expect(counts.cached).toBe(1);
		expect(counts.agents).toHaveLength(2);
		// LIVE agent: phase recovered from agent:launched, stats from the enriched end.
		expect(counts.agents[0]).toMatchObject({
			label: "writer",
			phase: "draft",
			sessionID: "ses_1",
			model: "claude-x",
			agentType: "build",
			status: "completed",
			toolCalls: 4,
			durationMs: 6,
		});
		expect(counts.agents[0]?.tokens?.input).toBe(10);
		// CACHED agent: phase recovered from agent:start, no stats.
		expect(counts.agents[1]).toMatchObject({
			label: "verify",
			phase: "review",
			status: "cached",
		});
		expect(counts.agents[1]?.sessionID).toBeUndefined();
	});

	test("carries the degrade note from a degraded live agent:end", async () => {
		const events: FeedEvent[] = [
			{ type: "agent:start", label: "x", phase: "p1", at: 1 },
			{
				type: "agent:launched",
				label: "x",
				phase: "p1",
				sessionID: "ses_x",
				at: 2,
			},
			{
				type: "agent:end",
				label: "x",
				status: "error",
				sessionID: "ses_x",
				note: "null — status_error",
				at: 3,
			} as FeedEvent,
		];
		const path = "/feed/wf_n.jsonl";
		const counts = await readFeedCounts(path, readFs(path, feedFile(events)));
		expect(counts.agentCount).toBe(1);
		expect(counts.live).toBe(1);
		expect(counts.cached).toBe(0);
		expect(counts.agents[0]).toMatchObject({
			label: "x",
			phase: "p1",
			status: "error",
			note: "null — status_error",
		});
	});

	test("a missing feed file → empty result, never throws", async () => {
		const counts = await readFeedCounts(
			"/feed/missing.jsonl",
			readFs("/feed/other.jsonl", undefined),
		);
		expect(counts).toEqual({
			agentCount: 0,
			live: 0,
			cached: 0,
			agents: [],
			checkpoints: [],
		});
	});

	test("drops a truncated FINAL line (crash mid-append)", async () => {
		const good = JSON.stringify({
			type: "agent:end",
			label: "a",
			status: "completed",
			sessionID: "s",
			at: 1,
		});
		const truncated = '{"type":"agent:end","label":"b","stat';
		const path = "/feed/wf_t.jsonl";
		const counts = await readFeedCounts(
			path,
			readFs(path, `${good}\n${truncated}`),
		);
		// Only the intact line counts; the truncated tail is dropped, not thrown.
		expect(counts.agentCount).toBe(1);
		expect(counts.live).toBe(1);
	});

	test("an INTERIOR bad line degrades gracefully (drop-and-continue, never throws)", async () => {
		// Diverges from journal.load (which throws on interior corruption): recovery
		// runs inside readyPromise, so a throw would poison engine startup for ALL runs.
		const a = JSON.stringify({
			type: "agent:end",
			label: "a",
			status: "completed",
			sessionID: "s1",
			at: 1,
		});
		const bad = "{not json at all";
		const c = JSON.stringify({
			type: "agent:end",
			label: "c",
			status: "completed",
			sessionID: "s2",
			at: 3,
		});
		const path = "/feed/wf_i.jsonl";
		const counts = await readFeedCounts(
			path,
			readFs(path, `${a}\n${bad}\n${c}\n`),
		);
		// The two intact agent:end lines count; the interior garbage is skipped.
		expect(counts.agentCount).toBe(2);
		expect(counts.live).toBe(2);
		expect(counts.agents.map((x) => x.label)).toEqual(["a", "c"]);
	});

	test("an empty / agent-less feed → zero counts", async () => {
		const events: FeedEvent[] = [
			{ type: "run:start", runId: "wf_e", parentSessionID: "p", at: 1 },
			{ type: "run:end", status: "error", at: 2 },
		];
		const path = "/feed/wf_e.jsonl";
		const counts = await readFeedCounts(path, readFs(path, feedFile(events)));
		expect(counts).toEqual({
			agentCount: 0,
			live: 0,
			cached: 0,
			agents: [],
			checkpoints: [],
		});
	});

	test("reads a real on-disk feed file end-to-end", async () => {
		const dir = await tmpDir();
		try {
			const path = join(dir, "wf_disk.jsonl");
			const events: FeedEvent[] = [
				{ type: "agent:start", label: "a", phase: "ph", at: 1 },
				{
					type: "agent:launched",
					label: "a",
					phase: "ph",
					sessionID: "ses_a",
					at: 2,
				},
				{
					type: "agent:end",
					label: "a",
					status: "completed",
					sessionID: "ses_a",
					at: 3,
				} as FeedEvent,
			];
			await writeFile(path, feedFile(events), "utf-8");
			const counts = await readFeedCounts(path);
			expect(counts.agentCount).toBe(1);
			expect(counts.agents[0]).toMatchObject({ label: "a", phase: "ph" });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	// ---- Epic 2.2/2.3: harvest agent:checkpoint lines into the ledger -------

	test("harvests agent:checkpoint lines (with/without sha, with modeFlips)", async () => {
		const events: FeedEvent[] = [
			{
				type: "agent:checkpoint",
				label: "agent-a",
				sessionID: "ses_a",
				sha: "abcdef1234",
				paths: ["a.ts"],
				modeFlips: { "a.ts": "100644→100755" },
				at: 1,
			},
			{
				type: "agent:end",
				label: "agent-a",
				status: "completed",
				sessionID: "ses_a",
				at: 2,
			},
			{
				type: "agent:checkpoint",
				label: "agent-b",
				sessionID: "ses_b",
				paths: ["b.ts", "c.ts"],
				at: 3,
			},
		];
		const path = "/feed/wf_cp.jsonl";
		const counts = await readFeedCounts(path, readFs(path, feedFile(events)));
		expect(counts.checkpoints).toEqual([
			{
				sha: "abcdef1234",
				paths: ["a.ts"],
				label: "agent-a",
				modeFlips: { "a.ts": "100644→100755" },
			},
			{ paths: ["b.ts", "c.ts"], label: "agent-b" },
		]);
	});

	test("a truncated final checkpoint line is dropped, prior ones kept", async () => {
		const good = JSON.stringify({
			type: "agent:checkpoint",
			label: "a",
			sessionID: "s",
			sha: "deadbeef",
			paths: ["a.ts"],
			at: 1,
		});
		const truncated = '{"type":"agent:checkpoint","label":"b","pat';
		const path = "/feed/wf_ct.jsonl";
		const counts = await readFeedCounts(
			path,
			readFs(path, `${good}\n${truncated}`),
		);
		expect(counts.checkpoints).toHaveLength(1);
		expect(counts.checkpoints[0]).toMatchObject({
			label: "a",
			sha: "deadbeef",
		});
	});

	test("a feed with no checkpoint lines → checkpoints: []", async () => {
		const events: FeedEvent[] = [
			{
				type: "agent:end",
				label: "a",
				status: "completed",
				sessionID: "s",
				at: 1,
			},
		];
		const path = "/feed/wf_nc.jsonl";
		const counts = await readFeedCounts(path, readFs(path, feedFile(events)));
		expect(counts.checkpoints).toEqual([]);
	});

	test("a checkpoint line with a MISSING/garbage label harvests as '(unknown)', never poisons the ledger (#14)", async () => {
		// Valid JSON but a malformed line: `paths` was guarded, `label` was not — a
		// label-less line used to land `label: undefined` in the rehydrated ledger
		// (which the render paths assume is a string).
		const noLabel = JSON.stringify({
			type: "agent:checkpoint",
			sha: "feedface",
			paths: ["x.ts"],
			at: 1,
		});
		const numericLabel = JSON.stringify({
			type: "agent:checkpoint",
			label: 42,
			paths: ["y.ts"],
			at: 2,
		});
		const path = "/feed/wf_badlabel.jsonl";
		const counts = await readFeedCounts(
			path,
			readFs(path, `${noLabel}\n${numericLabel}`),
		);
		expect(counts.checkpoints).toEqual([
			{ sha: "feedface", paths: ["x.ts"], label: "(unknown)" },
			{ paths: ["y.ts"], label: "(unknown)" },
		]);
	});

	test("phase and shared on a checkpoint line are carried into the rehydrated ledger (#14)", async () => {
		const events: FeedEvent[] = [
			{
				type: "agent:checkpoint",
				label: "agent-a",
				sessionID: "ses_a",
				sha: "abc1234",
				paths: ["a.ts"],
				phase: "Implement",
				shared: true,
				at: 1,
			},
			{
				// A merge-back ledger line: no sessionID, no phase — still harvests.
				type: "agent:checkpoint",
				label: "iso-0",
				sha: "def5678",
				paths: ["b.ts"],
				at: 2,
			},
		];
		const path = "/feed/wf_phase.jsonl";
		const counts = await readFeedCounts(path, readFs(path, feedFile(events)));
		expect(counts.checkpoints).toEqual([
			{
				sha: "abc1234",
				paths: ["a.ts"],
				label: "agent-a",
				phase: "Implement",
				shared: true,
			},
			{ sha: "def5678", paths: ["b.ts"], label: "iso-0" },
		]);
	});
});
