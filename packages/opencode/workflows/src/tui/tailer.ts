/**
 * Feed tailer (Task 8.3.2) — the io layer that streams a growing append-only
 * `<dataDir>/workflow-feed/<runId>.jsonl` into the reducer (8.3.1) line-by-line,
 * and replays a completed file from offset 0 after a TUI restart.
 *
 * Unlike the server engine — constrained to the injected `FsFacade` (Task 8.2.2
 * explains why `fs.watch` was rejected THERE) — the TUI surface loads via plain
 * `import()` with full Bun fs access (`.references/opencode/.../plugin/loader.ts`),
 * so `node:fs`'s `watch`/`open`/`read`/`stat` are all available here. Feed files
 * are append-only and never rewritten (the writer only `appendFile`s), so a tailer
 * only ever reads FORWARD from a byte offset, and a trailing partial line (no
 * terminating newline) is only ever a not-yet-flushed tail — never corruption — so
 * it is buffered until the next read completes it, never parsed early.
 *
 * Change detection is dual: a `watch` on the file drives reads when the host
 * filesystem delivers events, and a `pollMs` interval `stat`s-and-reads-on-growth
 * as a FALLBACK for platforms/filesystems where `fs.watch` does not fire (network
 * mounts, some container overlays). Both paths funnel through the same idempotent
 * `readNew()` guarded by a single in-flight latch, so a watch event and a poll tick
 * arriving together never double-read the same bytes. Real `fs.watch` delivery is
 * platform-dependent and is NOT unit-asserted — the poll fallback is the guaranteed
 * path; the watch path is validated by the manual step (Task 8.3.4).
 *
 * The tailer owns io ONLY — it holds NO reducer state. The caller wires `onEvent`
 * to the reducer's `apply`. Every fs primitive is injectable so a test drives
 * `tick()` deterministically against an in-memory growing buffer with no real
 * timers or watchers. The poll interval, when armed from the default, is UNREF'd
 * (mirroring `control.ts`) so the tailer never holds the process open on its own.
 */

import { watch as nodeWatch } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { FeedEvent } from "../plugin/feed";
import { parseFeedLine } from "./reducer";

/** The newline byte (`\n`) feed lines are delimited by. */
const NEWLINE = 0x0a;
/** A shared zero-length tail, used while no partial bytes are held. */
const EMPTY = new Uint8Array(0);

/** A live filesystem watch handle — only `close()` is used. */
export interface TailerWatcher {
	close(): void;
}

/** The minimal fs surface the tailer reads through. Injectable for tests. */
export interface TailerFs {
	/** Current byte size of the file; rejects (ENOENT) when the file is absent. */
	stat(path: string): Promise<{ size: number }>;
	/**
	 * Read `[offset, offset + length)` and return the RAW bytes actually read (the
	 * `subarray(0, bytesRead)`). The tailer — not the reader — owns UTF-8 decoding so
	 * a multibyte character split across a read boundary is held as bytes and never
	 * decoded mid-sequence (decoding here would emit U+FFFD and desync the offset).
	 */
	read(path: string, offset: number, length: number): Promise<Uint8Array>;
}

export interface FeedTailerOptions {
	/** The feed file to tail. */
	path: string;
	/** Called once per parsed feed line, in file order. */
	onEvent(event: FeedEvent): void;
	/** Optional sink for non-ENOENT read/stat failures (logged, never thrown). */
	onError?(err: unknown): void;
	/**
	 * Arm a change watch on the file; the listener fires on any change. Defaults to
	 * `node:fs`'s `watch`. A missing file is tolerated — the listener may never fire,
	 * and the poll fallback covers detection until the file appears.
	 */
	watchFn?(path: string, listener: () => void): TailerWatcher;
	/** Byte size of the file. Defaults to `node:fs/promises`' `stat`. */
	statFn?(path: string): Promise<{ size: number }>;
	/**
	 * Read a byte range and return the RAW bytes read (NOT decoded — see {@link TailerFs.read}).
	 * Defaults to a `node:fs/promises` open/read/close.
	 */
	readFn?(path: string, offset: number, length: number): Promise<Uint8Array>;
	/** Poll-fallback cadence in ms (default 250). */
	pollMs?: number;
}

export interface FeedTailer {
	/**
	 * Read the file from offset 0, then arm the watch + poll loop. A missing file is
	 * NOT an error — it emits nothing and begins watching for the file's appearance.
	 */
	start(): Promise<void>;
	/** One change-driven read: `stat` then read forward from the offset on growth. */
	tick(): Promise<void>;
	/** Close the watcher and clear the poll interval (idempotent). */
	stop(): void;
}

/**
 * Default reader: open, read `[offset, offset + length)` into a buffer, close, and
 * return the RAW bytes read. The tailer decodes complete lines itself, so this never
 * decodes — a partial multibyte char at the tail stays as bytes until completed.
 */
async function defaultRead(
	path: string,
	offset: number,
	length: number,
): Promise<Uint8Array> {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(length);
		const { bytesRead } = await handle.read(buffer, 0, length, offset);
		return buffer.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

/** Default watcher: `node:fs`'s `watch`, firing the listener on any change. */
function defaultWatch(path: string, listener: () => void): TailerWatcher {
	const watcher = nodeWatch(path, () => {
		listener();
	});
	return { close: () => watcher.close() };
}

/** A missing file (ENOENT) is the steady state before the run appears, not an error. */
function isEnoent(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: unknown }).code === "ENOENT"
	);
}

export function createFeedTailer(opts: FeedTailerOptions): FeedTailer {
	const statFn = opts.statFn ?? stat;
	const readFn = opts.readFn ?? defaultRead;
	const watchFn = opts.watchFn ?? defaultWatch;
	const pollMs = opts.pollMs ?? 250;

	// Byte offset of the next unread byte; reads only ever advance it forward.
	let offset = 0;
	// Trailing BYTES after the last "\n" — a not-yet-flushed partial line held back
	// until a later read completes it (append-only writes guarantee this is a tail).
	// Held as bytes, never a decoded string, so a multibyte character split across a
	// read boundary is reassembled before decode rather than corrupted into U+FFFD.
	let partial: Uint8Array = EMPTY;
	let stopped = false;
	let watcher: TailerWatcher | undefined;
	let pollHandle: unknown;

	// In-flight latch: a read in progress sets `inFlight`; a concurrent `readNew()`
	// flags `rerun` instead of starting a second read, and the running one loops once
	// it drains so a watch event + poll tick arriving together never double-read.
	let inFlight = false;
	let rerun = false;

	/**
	 * Append freshly read BYTES to the held partial, decode only up to the last "\n"
	 * (so no incomplete multibyte char is ever decoded), emit the complete lines, and
	 * carry the trailing bytes after the last "\n" as the next partial.
	 */
	function consume(chunk: Uint8Array): void {
		const combined =
			partial.length === 0 ? chunk : Buffer.concat([partial, chunk]);
		const lastNewline = combined.lastIndexOf(NEWLINE);
		if (lastNewline === -1) {
			// No complete line yet — hold everything as the partial tail.
			partial = combined;
			return;
		}
		// Decode only `[0, lastNewline]` (complete lines); carry the rest as bytes.
		const complete = Buffer.from(
			combined.buffer,
			combined.byteOffset,
			lastNewline + 1,
		).toString("utf-8");
		partial =
			lastNewline + 1 < combined.length
				? combined.subarray(lastNewline + 1)
				: EMPTY;
		for (const line of complete.split("\n")) {
			if (line.length === 0) {
				continue;
			}
			const event = parseFeedLine(line);
			if (event !== undefined) {
				opts.onEvent(event);
			}
		}
	}

	/** Read the file's grown tail `[offset, size)` once, advancing the offset. */
	async function readOnce(): Promise<void> {
		let size: number;
		try {
			const info = await statFn(opts.path);
			size = info.size;
		} catch (err) {
			// A missing file is the normal pre-appearance state — silently no-op.
			if (!isEnoent(err)) {
				opts.onError?.(err);
			}
			return;
		}
		if (size <= offset) {
			// No growth (or a truncation we do not chase — feeds are append-only).
			return;
		}
		const length = size - offset;
		let chunk: Uint8Array;
		try {
			chunk = await readFn(opts.path, offset, length);
		} catch (err) {
			if (!isEnoent(err)) {
				opts.onError?.(err);
			}
			return;
		}
		// Advance by the bytes ACTUALLY read — never by re-encoding decoded text, which
		// overshoots on a multibyte boundary (a split char re-encodes to U+FFFD's 3 bytes).
		offset += chunk.byteLength;
		consume(chunk);
	}

	/**
	 * The single idempotent read entrypoint, latched so concurrent triggers (a watch
	 * event and a poll tick) collapse into one in-flight read plus at most one
	 * follow-up — never two reads racing on `offset`.
	 */
	async function readNew(): Promise<void> {
		if (stopped) {
			return;
		}
		if (inFlight) {
			rerun = true;
			return;
		}
		inFlight = true;
		try {
			do {
				rerun = false;
				await readOnce();
			} while (rerun && !stopped);
		} finally {
			inFlight = false;
		}
	}

	async function start(): Promise<void> {
		// Read whatever already exists (a completed file replays fully from offset 0),
		// then arm change detection. Watching may fail on a missing file on some hosts;
		// the poll fallback covers detection until the file appears, so a watch arm
		// failure is tolerated.
		await readNew();
		if (stopped) {
			return;
		}
		try {
			watcher = watchFn(opts.path, () => {
				void readNew();
			});
		} catch (err) {
			opts.onError?.(err);
		}
		pollHandle = setPoll(() => {
			void readNew();
		}, pollMs);
	}

	function stop(): void {
		stopped = true;
		watcher?.close();
		watcher = undefined;
		if (pollHandle !== undefined) {
			clearInterval(pollHandle as ReturnType<typeof setInterval>);
			pollHandle = undefined;
		}
	}

	return { start, tick: readNew, stop };
}

/**
 * Arm the poll fallback as an UNREF'd interval (mirroring `control.ts`): a
 * referenced repeating timer would hold the event loop open. Tests never reach
 * this — they drive `tick()` directly with no real timer.
 */
function setPoll(cb: () => void, ms: number): unknown {
	const handle = setInterval(cb, ms);
	(handle as { unref?: () => void }).unref?.();
	return handle;
}
