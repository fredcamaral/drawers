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

import { appendFile, mkdir, readFile } from "node:fs/promises";
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
	/**
	 * The DECLARED phase titles from `meta.phases`, in order (Task 8.3.3). Lets the
	 * viewer paint the whole pipeline as pending headers from the first frame — agents
	 * (created imperatively as execution reaches each phase) fill in live. Absent when
	 * the script declared no `meta.phases`; a viewer then derives phases from agents
	 * alone (the prior behavior).
	 */
	phases?: string[];
	/**
	 * The workflow's human name from `meta.name` (Task 8.3.x) — the run's display
	 * identity in the viewer header (so a glance reads "My Workflow", not the raw
	 * `wf_…` id). Optional so OLD feeds (written before this field existed) parse and
	 * reduce unchanged; a viewer then falls back to the runId. The engine always sets
	 * it in practice — `extractName` falls back to `"workflow"` — so the absence is a
	 * pure backward-compat concern, not a live one.
	 */
	name?: string;
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
 * A per-agent checkpoint line (Epic 2.1) — FEED-ONLY, like {@link AgentStatsLine}
 * (never pushed to `handle.progress`). The engine appends it after a live agent's
 * `agent:end` commit lands, so a TUI viewer tailing the feed can later surface the
 * forensic checkpoint (sha + the exact paths committed) without the engine widening
 * the runtime progress vocabulary. Absent on cached/degraded ends (no commit) and on
 * empty-diff or operator-refused checkpoints (`committed: false` → no line emitted).
 */
export interface AgentCheckpointLine {
	type: "agent:checkpoint";
	label: string;
	/**
	 * The committing agent's child sessionID. Absent on a MERGE-BACK ledger line
	 * (an isolated agent's merge is recorded by the engine's per-run worktree
	 * wrapper, which knows the scratch branch but not the session).
	 */
	sessionID?: string;
	/** The new commit sha the checkpoint created. */
	sha?: string;
	/** The exact pathspecs committed (workflow-touched, baseline-excluded). */
	paths: string[];
	/** The active progress phase, when one was known at the emit site. */
	phase?: string;
	/** Mode flips (Epic 2.3): path → `"<oldmode>→<newmode>"`; absent on none. */
	modeFlips?: Record<string, string>;
	/**
	 * Committed while other unisolated agents were live (parallel() on one shared
	 * tree) — attribution is approximate; see `CheckpointRecord.shared`.
	 */
	shared?: boolean;
	at: number;
}

/**
 * One line in the feed file: an engine-stamped (and, for live `agent:end`,
 * enriched) progress event, one of the two run-lifecycle lines, a throttled
 * per-agent stats line, or a per-agent checkpoint line. Every member carries `at`
 * (engine wall-clock), so a tail reader can order by emission time without a
 * separate timestamp column.
 */
export type FeedEvent =
	| EnrichedProgressEvent
	| RunStartLine
	| RunCancelRequestedLine
	| RunEndLine
	| AgentStatsLine
	| AgentCheckpointLine;

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

// ---- feed recovery counter (Phase 3.2.1) ----------------------------------

/** The minimal read fs the recovery counter needs. Defaults to `node:fs/promises`. */
export interface FeedReadFs {
	readFile(path: string, enc: "utf-8"): Promise<string>;
}

const defaultReadFs: FeedReadFs = {
	readFile: (path, enc) => readFile(path, enc),
};

/**
 * A per-agent rollup reconstructed from a persisted feed (Phase 3.2). Structurally
 * identical to the engine's `AgentSummary` so a recovered run's `record.agents`
 * can be set directly from it — defined HERE (not imported from engine) to keep
 * the dependency one-way (engine → feed), never a cycle.
 */
export interface FeedAgentSummary {
	label: string;
	phase?: string;
	sessionID?: string;
	model?: string;
	agentType?: string;
	status: string;
	tokens?: SessionTokenSnapshot;
	toolCalls?: number;
	durationMs?: number;
	note?: string;
	/** The conclusion preview the agent passed forward (`agent:end.result`). */
	result?: string;
}

/**
 * The per-checkpoint git truth rehydrated from an `agent:checkpoint` feed line
 * (Epic 2.2 recovery parity). Structurally a `CheckpointRecord` (engine.ts) —
 * including `phase` and `shared`, which the feed line now carries from the emit
 * site (older feeds simply lack them and rehydrate without). Defined HERE (not
 * imported from engine) to keep the dependency one-way (engine → feed).
 */
export interface FeedCheckpoint {
	sha?: string;
	paths: string[];
	label: string;
	/** The active progress phase at commit time, when the feed line carried one. */
	phase?: string;
	/** Mode flips (Epic 2.3): path → `"<oldmode>→<newmode>"`; absent on none. */
	modeFlips?: Record<string, string>;
	/** Shared-tree parallel commit (approximate attribution); see the engine type. */
	shared?: boolean;
}

/** The outcome counts a recovered run rehydrates from its feed (Phase 3.2.1). */
export interface FeedCounts {
	/** Total `agent:end` lines (every agent-call outcome). */
	agentCount: number;
	/** Live launches (`agent:end` with a status other than `cached`). */
	live: number;
	/** Replayed-from-journal calls (`agent:end` with status `cached`). */
	cached: number;
	/** Per-agent rollup, one entry per `agent:end`, in feed order. */
	agents: FeedAgentSummary[];
	/**
	 * Per-checkpoint ledger harvested from `agent:checkpoint` lines (Epic 2.2). One
	 * entry per committed checkpoint, in feed order, so a rehydrated run keeps its
	 * `filesChanged`/ledger. Empty when the feed carried no checkpoint lines.
	 */
	checkpoints: FeedCheckpoint[];
}

/** The launch metadata carried from `agent:launched` to its matching `agent:end`. */
interface FeedLaunchMeta {
	phase?: string;
	model?: string;
	agentType?: string;
}

/**
 * The enriched `agent:end` shape as the counter reads it. A narrow on
 * `type === "agent:end"` collapses the plain stamped end and the enriched end to
 * their COMMON fields (the enriched extras are optional members of only one arm),
 * so the counter views a confirmed-enriched end through this alias to read the
 * stats the engine wrote at the choke point. Mirrors the enrichment in
 * {@link EnrichedProgressEvent}'s `agent:end` member.
 */
type EnrichedAgentEnd = Extract<ProgressEvent, { type: "agent:end" }> & {
	durationMs?: number;
	tokens?: SessionTokenSnapshot;
	toolCalls?: number;
	model?: string;
	agentType?: string;
};

/**
 * Tally agent-call outcomes from a persisted feed file (Phase 3.2.1). Used at
 * engine recovery to rehydrate a crashed run's per-agent table from disk — the
 * record itself carries no per-agent data on a real crash (persisted only at
 * settle), so the feed is the only source of truth.
 *
 * MUST mirror the engine choke point's pairing: a LIVE `agent:end`'s phase lives
 * on its `agent:launched` (NOT the enriched end), and a CACHED end's phase on its
 * `agent:start` — so the reader walks and pairs start/launched → end to recover
 * phase (and model/agentType). Direct-pairing on the end alone would collapse
 * every recovered agent into the single `(no phase)` group.
 *
 * FENCED — recovery runs inside the engine's `readyPromise`, where a throw poisons
 * startup for ALL runs. So: a missing file → empty result (mirrors journal.load's
 * ENOENT→[]); a truncated FINAL line is dropped (crash mid-append); and — DIVERGING
 * from journal.load, which throws on interior corruption — an interior bad line is
 * dropped-and-continued. This function never throws.
 */
export async function readFeedCounts(
	path: string,
	fs: FeedReadFs = defaultReadFs,
): Promise<FeedCounts> {
	const empty: FeedCounts = {
		agentCount: 0,
		live: 0,
		cached: 0,
		agents: [],
		checkpoints: [],
	};

	let raw: string;
	try {
		raw = await fs.readFile(path, "utf-8");
	} catch {
		// Missing/unreadable feed (ENOENT or a dead writer that wrote nothing) → 0/0.
		return empty;
	}

	const lines = raw.split("\n").filter((l) => l.length > 0);
	const events: FeedEvent[] = [];
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] as string;
		try {
			events.push(JSON.parse(line) as FeedEvent);
		} catch {
			// A truncated FINAL line is a crash mid-append; an interior bad line is
			// corruption. Both are dropped (recovery never throws) — unlike journal.load,
			// which throws on interior lines (it runs on the resume path, not startup).
		}
	}

	// Pair start/launched → end to recover phase + launch meta, exactly like the
	// engine choke point. `startQueue` is a label-keyed FIFO so a CACHED end (no
	// session) recovers its phase from the matching synchronous start.
	const launchMeta = new Map<string, FeedLaunchMeta>();
	const startQueue: Array<{ label: string; phase?: string }> = [];
	const claimStartPhase = (label: string): string | undefined => {
		const idx = startQueue.findIndex((s) => s.label === label);
		if (idx === -1) {
			return undefined;
		}
		const [claimed] = startQueue.splice(idx, 1);
		return claimed?.phase;
	};

	const agents: FeedAgentSummary[] = [];
	const checkpoints: FeedCheckpoint[] = [];
	let live = 0;
	let cached = 0;

	for (const e of events) {
		if (e.type === "agent:checkpoint") {
			// Epic 2.2 recovery parity: harvest the per-checkpoint git truth a real
			// crash dropped from the record (the record persists only at settle).
			// Every field is defensively guarded — the parse above only proves valid
			// JSON, not a well-formed line, and `label` feeds render paths that assume
			// a string (a malformed line must degrade to "(unknown)", not poison the
			// rehydrated ledger).
			checkpoints.push({
				...(typeof e.sha === "string" ? { sha: e.sha } : {}),
				paths: Array.isArray(e.paths) ? e.paths : [],
				label: typeof e.label === "string" ? e.label : "(unknown)",
				...(typeof e.phase === "string" ? { phase: e.phase } : {}),
				...(e.modeFlips !== undefined ? { modeFlips: e.modeFlips } : {}),
				...(e.shared === true ? { shared: true } : {}),
			});
		} else if (e.type === "agent:start") {
			startQueue.push({ label: e.label, phase: e.phase });
		} else if (e.type === "agent:launched") {
			launchMeta.set(e.sessionID, {
				phase: e.phase,
				model: e.model,
				agentType: e.agentType,
			});
			// The launched start is now live — drop it from the cached-start queue.
			claimStartPhase(e.label);
		} else if (e.type === "agent:end") {
			if (e.sessionID !== undefined) {
				// LIVE agent: phase/model/agentType from agent:launched; stats from the
				// enriched end (it carries tokens/toolCalls/durationMs/model/agentType).
				const end = e as EnrichedAgentEnd;
				const meta = launchMeta.get(e.sessionID);
				launchMeta.delete(e.sessionID);
				const model = end.model ?? meta?.model;
				const agentType = end.agentType ?? meta?.agentType;
				agents.push({
					label: e.label,
					...(meta?.phase !== undefined ? { phase: meta.phase } : {}),
					sessionID: e.sessionID,
					...(model !== undefined ? { model } : {}),
					...(agentType !== undefined ? { agentType } : {}),
					status: e.status,
					...(end.tokens !== undefined ? { tokens: end.tokens } : {}),
					...(end.toolCalls !== undefined ? { toolCalls: end.toolCalls } : {}),
					...(end.durationMs !== undefined
						? { durationMs: end.durationMs }
						: {}),
					...(e.note !== undefined ? { note: e.note } : {}),
					...(e.result !== undefined ? { result: e.result } : {}),
				});
				live += 1;
			} else {
				// CACHED / degraded-pre-launch end (no session): phase from the start.
				const phase = claimStartPhase(e.label);
				agents.push({
					label: e.label,
					...(phase !== undefined ? { phase } : {}),
					status: e.status,
					...(e.note !== undefined ? { note: e.note } : {}),
					...(e.result !== undefined ? { result: e.result } : {}),
				});
				if (e.status === "cached") {
					cached += 1;
				} else {
					live += 1;
				}
			}
		}
	}

	return { agentCount: agents.length, live, cached, agents, checkpoints };
}
