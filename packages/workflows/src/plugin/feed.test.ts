import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StampedProgressEvent } from "../runtime/types";
import { createFeedWriter, type FeedEvent, type FeedFs } from "./feed";

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
