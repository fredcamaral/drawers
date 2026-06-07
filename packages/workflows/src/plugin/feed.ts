/**
 * Live progress feed — the on-disk JSONL event stream that backs Phase 8's
 * observability (the feed file is the bus; the native TUI viewer only tails it).
 *
 * The engine appends every engine-stamped progress event to
 * `<dataDir>/workflow-feed/<runId>.jsonl`, bracketed by a `run:start` line at
 * record creation and a `run:end` line at settle. Headless runs still produce
 * the feed — the viewer is a lens, not a dependency. There is exactly ONE
 * writer per run; `handle.progress` (read by `workflow_status`) and this file
 * see the same enriched stream.
 *
 * Writes serialize through a single promise-chain queue (mirroring the journal
 * idiom) so concurrent `append()` calls never interleave a half-line, each line
 * being `JSON.stringify(event) + "\n"`. Writes are FENCED with a dead-state
 * latch: the first fs error logs once, flips the writer dead, and every later
 * append is dropped silently — a broken disk must never break a run (same stance
 * as the engine's `onProgress` fencing). `settled()` awaits the chain drain and
 * NEVER rejects; the engine calls it before resolving a run (mirroring the
 * journal-drain step).
 *
 * Feed files are append-only and are NOT garbage-collected by this module —
 * retention is out of scope for Task 8.1.2.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ProgressEvent, StampedProgressEvent } from "../runtime/types";
import type { SessionTokenSnapshot } from "./session-stats";

/**
 * An engine-side enriched `agent:end` (Task 8.1.4) — a stamped progress event
 * widened at the engine choke point with the per-agent stats the runtime
 * deliberately never carries (it is clock-free and telemetry-free by design).
 * Plugin-local: the runtime layer never sees enrichment. Both `handle.progress`
 * (read by `workflow_status`) and the feed file carry this identical widened
 * object — one source of truth — so it lives here beside the {@link FeedEvent}
 * union it joins. Non-end events ride through as plain {@link StampedProgressEvent}.
 */
export type EnrichedProgressEvent =
	| StampedProgressEvent
	| (Extract<ProgressEvent, { type: "agent:end" }> & {
			at: number;
			/** `agent:end.at − agent:launched.at`, from the engine clock. */
			durationMs?: number;
			/** The collector's final rolled-up token snapshot. */
			tokens?: SessionTokenSnapshot;
			/** Terminal tool-call count from the collector. */
			toolCalls?: number;
			/** Resolved model, carried from `agent:launched`. */
			model?: string;
			/** Resolved subagent type, carried from `agent:launched`. */
			agentType?: string;
	  });

/** A run-lifecycle line bracketing the feed — written once at record creation. */
export interface RunStartLine {
	type: "run:start";
	runId: string;
	parentSessionID: string;
	/** The persisted script path, when one exists (always set in practice). */
	scriptPath?: string;
	at: number;
}

/**
 * Emitted once when an external sentinel requests cancel (Task 8.2.1), BEFORE the
 * terminal `run:end`; a viewer tailing the feed renders a "cancelling…" state on
 * sight. Feed-only/engine-only, like {@link RunStartLine} — the runtime
 * `ProgressEvent` union is NOT widened.
 */
export interface RunCancelRequestedLine {
	type: "run:cancel-requested";
	runId: string;
	at: number;
}

/** A run-lifecycle line bracketing the feed — written once at settle. */
export interface RunEndLine {
	type: "run:end";
	status: string;
	/** Number of agents the run launched, when the run produced a count. */
	agentCount?: number;
	/** Output tokens spent, when a budget was set on the run. */
	budgetSpent?: number;
	at: number;
}

/**
 * A throttled per-agent live-stats line (Task 8.1.3) — FEED-ONLY (never pushed to
 * `handle.progress`; `workflow_status` reads collector snapshots directly). The
 * engine emits at most one per session per throttle window when its stats change,
 * so a TUI viewer tailing the feed sees live token/tool growth without the engine
 * widening the runtime progress vocabulary. Tokens are the collector's rolled-up
 * totals; `lastTools` is the ≤3-deep ring of `toolName(inputPreview)` labels.
 */
export interface AgentStatsLine {
	type: "agent:stats";
	label: string;
	sessionID: string;
	tokens: {
		input: number;
		output: number;
		reasoning: number;
		cacheRead: number;
		cacheWrite: number;
	};
	toolCalls: number;
	lastTools: string[];
	at: number;
}

/**
 * One line in the feed file: an engine-stamped (and, for live `agent:end`,
 * enriched) progress event, one of the two run-lifecycle lines, or a throttled
 * per-agent stats line. Every member carries `at` (engine wall-clock), so a tail
 * reader can order by emission time without a separate timestamp column.
 */
export type FeedEvent =
	| EnrichedProgressEvent
	| RunStartLine
	| RunCancelRequestedLine
	| RunEndLine
	| AgentStatsLine;

/** The minimal fs surface the feed writer uses. Defaults to `node:fs/promises`. */
export interface FeedFs {
	mkdir(path: string, opts: { recursive: true }): Promise<unknown>;
	appendFile(path: string, data: string, enc: "utf-8"): Promise<void>;
}

const defaultFs: FeedFs = {
	mkdir: (path, opts) => mkdir(path, opts),
	appendFile: (path, data, enc) => appendFile(path, data, enc),
};

export interface FeedLogger {
	error?(msg: string, meta?: Record<string, unknown>): void;
}

export interface FeedWriterOptions {
	/** The feed subdir; the file is `<dir>/<runId>.jsonl`. Created on first write. */
	dir: string;
	runId: string;
	/** Injectable fs facade; defaults to `node:fs/promises`. */
	fs?: FeedFs;
	logger?: FeedLogger;
}

export interface FeedWriter {
	/** Append one line. Fenced: a write failure drops the line, never throws. */
	append(event: FeedEvent): void;
	/** Await the write chain drain. Never rejects (fenced). */
	settled(): Promise<void>;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function createFeedWriter(opts: FeedWriterOptions): FeedWriter {
	const fs = opts.fs ?? defaultFs;
	const logger = opts.logger;
	const path = join(opts.dir, `${opts.runId}.jsonl`);

	// Single serial write chain (append order = emission order). `dead` latches on
	// the first fs error: we log once, then drop every later append. `dirEnsured`
	// is created lazily on the first write so headless/empty runs need no dir.
	let tail: Promise<void> = Promise.resolve();
	let dead = false;
	let dirEnsured = false;

	async function ensureDir(): Promise<void> {
		if (dirEnsured) {
			return;
		}
		await fs.mkdir(opts.dir, { recursive: true });
		dirEnsured = true;
	}

	function append(event: FeedEvent): void {
		if (dead) {
			return;
		}
		const line = `${JSON.stringify(event)}\n`;
		tail = tail.then(async () => {
			if (dead) {
				return;
			}
			try {
				await ensureDir();
				await fs.appendFile(path, line, "utf-8");
			} catch (err) {
				// First failure flips the writer dead and logs once; subsequent appends
				// are dropped at the `dead` guard. A broken disk must not break a run.
				dead = true;
				logger?.error?.("workflow feed write failed — feed disabled for run", {
					runId: opts.runId,
					err: errorText(err),
				});
			}
		});
	}

	function settled(): Promise<void> {
		return tail.then(
			() => undefined,
			() => undefined,
		);
	}

	return { append, settled };
}
