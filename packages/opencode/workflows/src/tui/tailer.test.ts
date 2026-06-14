import { describe, expect, test } from "bun:test";
import type { FeedEvent } from "../plugin/feed";
import { createFeedTailer, type TailerFs, type TailerWatcher } from "./tailer";

/**
 * Feed-tailer unit tests (Task 8.3.2). The tailer owns the io that streams a
 * growing append-only feed file into the reducer line-by-line; every fs primitive
 * is injected so the tests drive `readNew()` deterministically against an in-memory
 * growing buffer with NO real timers or watchers (real `fs.watch` delivery is
 * platform-dependent and is NOT asserted in CI — the poll fallback is the
 * guaranteed path). The watcher/poll change signals are funnelled by hand so a
 * single test can simulate a watch event, a poll tick, or both arriving together.
 */

const PATH = "/wf-data/workflow-feed/wf_1.jsonl";

/** One JSONL line for a `run:start` framing event (the simplest feed line). */
function startLine(runId: string): string {
	const event: FeedEvent = {
		type: "run:start",
		runId,
		parentSessionID: "ses_p",
		at: 1,
	};
	return `${JSON.stringify(event)}\n`;
}

/** One JSONL line for an `agent:start` event tagged with a label. */
function agentLine(label: string, at: number): string {
	const event: FeedEvent = { type: "agent:start", label, at };
	return `${JSON.stringify(event)}\n`;
}

/**
 * An in-memory growing feed file with an injectable read/stat surface and a hand
 * driven watcher. The test appends bytes with {@link grow} (no terminating newline
 * is added — the caller writes exact chunks, including mid-line splits) and then
 * fires {@link emitWatch} or calls the tailer's `tick()` to drive a read. `present`
 * starts false so a missing-file `start()` is exercised; the first `grow` makes the
 * file appear.
 */
function makeFeedFile() {
	let buf = Buffer.alloc(0);
	let present = false;
	let watchListener: (() => void) | undefined;
	const calls = { stat: 0, read: 0, watchClosed: 0 };

	const fs: TailerFs = {
		stat: async (path: string) => {
			calls.stat += 1;
			if (path !== PATH || !present) {
				const err = new Error("ENOENT") as Error & { code: string };
				err.code = "ENOENT";
				throw err;
			}
			return { size: buf.length };
		},
		read: async (path: string, offset: number, length: number) => {
			calls.read += 1;
			if (path !== PATH || !present) {
				const err = new Error("ENOENT") as Error & { code: string };
				err.code = "ENOENT";
				throw err;
			}
			// Return RAW bytes (the tailer owns decoding so it can hold a partial
			// multibyte char as bytes across a read boundary).
			return buf.subarray(offset, offset + length);
		},
	};

	const watchFn = (path: string, listener: () => void): TailerWatcher => {
		if (path !== PATH) {
			throw new Error(`unexpected watch path: ${path}`);
		}
		watchListener = listener;
		return {
			close: () => {
				calls.watchClosed += 1;
				watchListener = undefined;
			},
		};
	};

	return {
		fs,
		watchFn,
		calls,
		/** Append a raw chunk (string or exact bytes, may end mid-line) and make the file present. */
		grow(chunk: string | Uint8Array): void {
			present = true;
			const bytes =
				typeof chunk === "string" ? Buffer.from(chunk, "utf-8") : chunk;
			buf = Buffer.concat([buf, bytes]);
		},
		hasWatcher(): boolean {
			return watchListener !== undefined;
		},
	};
}

/** Collect emitted events; the tailer parses lines before calling `onEvent`. */
function collector() {
	const events: FeedEvent[] = [];
	return { events, onEvent: (e: FeedEvent) => events.push(e) };
}

describe("createFeedTailer — line buffering", () => {
	test("a chunk that ends mid-line is held until the next chunk completes it", async () => {
		const file = makeFeedFile();
		const { events, onEvent } = collector();
		const tailer = createFeedTailer({
			path: PATH,
			onEvent,
			watchFn: file.watchFn,
			statFn: file.fs.stat,
			readFn: file.fs.read,
		});

		const line1 = startLine("wf_1");
		const line2 = agentLine("impl", 2);
		// Chunk 2 ends mid-line2: the buffered partial must NOT parse.
		const split = Math.floor(line2.length / 2);

		file.grow(line1 + line2.slice(0, split));
		await tailer.start();

		// Only the first complete line is emitted; the partial is buffered.
		expect(events.map((e) => e.type)).toEqual(["run:start"]);

		// Chunk 3 completes line2 and adds a third line; a change-driven tick reads it.
		const line3 = agentLine("review", 3);
		file.grow(line2.slice(split) + line3);
		await tailer.tick();

		expect(events.map((e) => e.type)).toEqual([
			"run:start",
			"agent:start",
			"agent:start",
		]);
		await tailer.stop();
	});
});

describe("createFeedTailer — multibyte read boundary", () => {
	test("a line split mid-multibyte-character across two reads emits intact", async () => {
		const file = makeFeedFile();
		const { events, onEvent } = collector();
		const tailer = createFeedTailer({
			path: PATH,
			onEvent,
			watchFn: file.watchFn,
			statFn: file.fs.stat,
			readFn: file.fs.read,
		});

		// An agent label carrying a 3-byte (`✓`), 4-byte (`🚀`), and 2-byte (`é`) char.
		const event: FeedEvent = { type: "agent:start", label: "✓ 🚀 café", at: 2 };
		const line = `${JSON.stringify(event)}\n`;
		const bytes = Buffer.from(line, "utf-8");

		// Cut the line 1 byte INTO the 3-byte `✓` (the first multibyte char): the prior
		// `partial`-string code re-encoded the decoded U+FFFD to 3 bytes and overshot the
		// offset, dropping the rest of the char and the next line. The byte-buffered tail
		// must reassemble the char and emit the label verbatim.
		const cut = bytes.indexOf(Buffer.from("✓", "utf-8")[0] ?? 0) + 1;

		file.grow(bytes.subarray(0, cut));
		await tailer.start();
		// The partial multibyte char is held — nothing parses yet.
		expect(events).toEqual([]);

		file.grow(bytes.subarray(cut));
		await tailer.tick();

		expect(events).toHaveLength(1);
		expect(events[0]).toEqual(event);
		await tailer.stop();
	});
});

describe("createFeedTailer — byte offset", () => {
	test("a growth read parses only the appended bytes, never re-emitting earlier lines", async () => {
		const file = makeFeedFile();
		const { events, onEvent } = collector();
		const tailer = createFeedTailer({
			path: PATH,
			onEvent,
			watchFn: file.watchFn,
			statFn: file.fs.stat,
			readFn: file.fs.read,
		});

		file.grow(startLine("wf_1") + agentLine("impl", 2));
		await tailer.start();
		expect(events.length).toBe(2);
		const readsAfterStart = file.calls.read;

		file.grow(agentLine("review", 3));
		await tailer.tick();

		// Exactly one more event — the appended line — and the prior two are intact.
		expect(events.map((e) => e.type)).toEqual([
			"run:start",
			"agent:start",
			"agent:start",
		]);
		// The growth read read forward from the offset (one additional read call).
		expect(file.calls.read).toBe(readsAfterStart + 1);
		await tailer.stop();
	});
});

describe("createFeedTailer — missing file at start", () => {
	test("a missing file emits nothing and does not throw, then emits once it appears", async () => {
		const file = makeFeedFile();
		const { events, onEvent } = collector();
		const tailer = createFeedTailer({
			path: PATH,
			onEvent,
			watchFn: file.watchFn,
			statFn: file.fs.stat,
			readFn: file.fs.read,
		});

		// File absent: start must not throw and must emit nothing.
		await tailer.start();
		expect(events).toEqual([]);

		// The file appears; a tick reads it from offset 0.
		file.grow(startLine("wf_1"));
		await tailer.tick();
		expect(events.map((e) => e.type)).toEqual(["run:start"]);
		await tailer.stop();
	});
});

describe("createFeedTailer — in-flight latch", () => {
	test("a watch event and a poll tick arriving together emit each line exactly once", async () => {
		const file = makeFeedFile();
		const { events, onEvent } = collector();
		const tailer = createFeedTailer({
			path: PATH,
			onEvent,
			watchFn: file.watchFn,
			statFn: file.fs.stat,
			readFn: file.fs.read,
		});

		file.grow(startLine("wf_1"));
		await tailer.start();
		events.length = 0;

		// Two new lines appear, then a watch event and a poll tick fire together.
		file.grow(agentLine("impl", 2) + agentLine("review", 3));
		const watchRead = tailer.tick();
		const pollRead = tailer.tick();
		await Promise.all([watchRead, pollRead]);

		// Each appended line is emitted exactly once despite the concurrent reads.
		expect(events.map((e) => e.type)).toEqual(["agent:start", "agent:start"]);
		await tailer.stop();
	});
});

describe("createFeedTailer — stop", () => {
	test("stop halts further reads and closes the watcher", async () => {
		const file = makeFeedFile();
		const { events, onEvent } = collector();
		const tailer = createFeedTailer({
			path: PATH,
			onEvent,
			watchFn: file.watchFn,
			statFn: file.fs.stat,
			readFn: file.fs.read,
		});

		file.grow(startLine("wf_1"));
		await tailer.start();
		expect(file.hasWatcher()).toBe(true);

		await tailer.stop();
		expect(file.calls.watchClosed).toBe(1);
		expect(file.hasWatcher()).toBe(false);

		const readsAfterStop = file.calls.read;
		file.grow(agentLine("impl", 2));
		await tailer.tick();

		// No read happened after stop; no new events emitted.
		expect(file.calls.read).toBe(readsAfterStop);
		expect(events.map((e) => e.type)).toEqual(["run:start"]);
	});
});

describe("createFeedTailer — non-parseable lines", () => {
	test("a non-JSON line is skipped while valid lines around it still emit", async () => {
		const file = makeFeedFile();
		const { events, onEvent } = collector();
		const tailer = createFeedTailer({
			path: PATH,
			onEvent,
			watchFn: file.watchFn,
			statFn: file.fs.stat,
			readFn: file.fs.read,
		});

		file.grow(`${startLine("wf_1")}not json at all\n${agentLine("impl", 2)}`);
		await tailer.start();

		expect(events.map((e) => e.type)).toEqual(["run:start", "agent:start"]);
		await tailer.stop();
	});
});
