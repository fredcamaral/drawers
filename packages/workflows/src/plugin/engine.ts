/**
 * Engine factory for the workflows plugin (Task 4.1.2).
 *
 * `createWorkflowEngine` assembles the collaborators a workflow host needs into
 * one wired unit:
 *   - a core {@link SessionRunner} over the adapted SDK client, configured with
 *     an UNLIMITED {@link ConcurrencyManager} (`defaultConcurrency: 0`) — the
 *     per-run workflow gate inside {@link createWorkflowRun} is the authoritative
 *     limiter (elaboration deviation e), so the runner must not double-cap;
 *   - a {@link createTaskStore} for the runner's child tasks at
 *     `<dataDir>/workflow-tasks`;
 *   - a SECOND {@link createTaskStore} for {@link RunRecord}s at
 *     `<dataDir>/workflow-runs` (the store validates only id/parentSessionID/
 *     status, so the wider RunRecord round-trips through one documented widening);
 *   - ONE {@link createSchemaRegistry} shared across every run, behind the single
 *     global `structured_output` tool the plugin entry registers;
 *   - a {@link createNotificationQueue} whose `markNotified` persists the flag
 *     through the run store, seeded from recovered terminal records.
 *
 * `startRun` persists the script source, creates+persists a `running` record,
 * fires `run.run(source)` DETACHED, and returns `{ runId, scriptPath, name }`
 * IMMEDIATELY — the parent is never blocked. On settle the record is updated and
 * a terminal {@link TaskNotice} is pushed into the queue.
 *
 * Startup recovery: records left `running` by a dead process flip to
 * `error("interrupted by restart")` (children are NOT relaunched); terminal
 * records seed the notification queue and stay readable via `statusOf`.
 */

import { dirname, join } from "node:path";
import {
	type Clock,
	ConcurrencyManager,
	createIdGenerator,
	createNotificationQueue,
	createSessionRunner,
	createTaskStore,
	type EngineClient,
	type FsFacade,
	type IdGenerator,
	type NotificationQueue,
	resolveDataBaseDir,
	type SessionRunner,
	type TaskNotice,
	type TaskStore,
} from "@drawers/core";
import { createWorkflowRun, type WorkflowRun } from "../runtime/index";
import { parseScript } from "../runtime/meta";
import {
	createSchemaRegistry,
	type SchemaRegistry,
} from "../runtime/structured/registry";
import type {
	AgentDiagnostic,
	BudgetView,
	JournalEntry,
} from "../runtime/types";
import { createTokenBudget, type TokenBudget } from "./budget";
import { type ControlWatcher, createControlWatcher } from "./control";
import {
	createFeedWriter,
	type EnrichedProgressEvent,
	type FeedFs,
	type FeedReadFs,
	type FeedWriter,
	readFeedCounts,
} from "./feed";
import {
	type BunShell,
	type Checkpointer,
	createGitCheckpointer,
} from "./git-checkpoint";
import { BUILTIN_WORKFLOWS } from "./builtins";
import { createWorktreeManager, type WorktreeManager } from "./git-worktree";
import { createJournal, type Journal, type JournalFs } from "./journal";
import { createSourceResolver } from "./resolve-source";
import {
	type RunLookup,
	saveRunAsWorkflow,
} from "./tools/workflow-save";
import {
	createSessionStatsCollector,
	type SessionStatsCollector,
	type SessionStatsSnapshot,
	type SessionTokenSnapshot,
} from "./session-stats";

/** Structured logger surface — `client.app.log`-backed in the plugin entry. */
export interface EngineLogger {
	debug(msg: string, meta?: Record<string, unknown>): void;
	info(msg: string, meta?: Record<string, unknown>): void;
	warn(msg: string, meta?: Record<string, unknown>): void;
	error(msg: string, meta?: Record<string, unknown>): void;
}

/** Terminal-or-live status of a workflow run. */
export type RunStatus = "running" | "completed" | "error" | "cancelled";

/**
 * The per-agent rollup persisted on a {@link RunRecord} (Task 8.1.4). One entry
 * per `agent:end` the engine sees, accumulated at the choke point so a finished
 * run reconstructs CC's per-agent table (`model · tokens · tools · duration`)
 * from the record ALONE — no feed re-parsing. Cached entries (no session) carry
 * only `label`/`phase`/`status`; launched-and-ended entries carry the full stats.
 */
export interface AgentSummary {
	label: string;
	phase?: string;
	/** The child sessionID, present only for launched (non-cached) agents. */
	sessionID?: string;
	/** Resolved model, when one was known at launch. */
	model?: string;
	/** Resolved subagent type, when one was known at launch. */
	agentType?: string;
	/** The `agent:end` status word (`completed`/`error`/`cancelled`/`cached`/…). */
	status: string;
	/** The collector's final token snapshot — absent on cached entries. */
	tokens?: SessionTokenSnapshot;
	/** Terminal tool-call count — absent on cached entries. */
	toolCalls?: number;
	/** `agent:end.at − agent:launched.at` — absent on cached entries. */
	durationMs?: number;
	/** The degrade note (Task 7.2.1), when the call collapsed to null/empty. */
	note?: string;
}

/**
 * The launch metadata the choke point holds per live session (Task 8.1.4),
 * captured from `agent:launched` and consumed at the matching `agent:end` to
 * compute the duration and stamp model/agentType. Dropped at the agent's end.
 */
interface LaunchMeta {
	label: string;
	phase?: string;
	model?: string;
	agentType?: string;
	/** The engine-stamped `at` of the `agent:launched` event. */
	launchedAt: number;
}

/**
 * The persisted record of one workflow run. Stored through {@link createTaskStore},
 * whose validation only requires `id`/`parentSessionID`/`status` — the remaining
 * fields ride along verbatim (the store serializes the whole object). The store's
 * type is `BgTask`, so save/load cross ONE documented widening (see {@link RunStore}).
 */
export interface RunRecord {
	id: string;
	parentSessionID: string;
	status: RunStatus;
	description: string;
	createdAt: number;
	completedAt?: number;
	scriptPath: string;
	args?: unknown;
	returnValue?: unknown;
	error?: string;
	agentCount?: number;
	/** The prior runId this run was resumed from (spec §7); absent on fresh runs. */
	resumedFrom?: string;
	/** The token budget ceiling, when one was set (Task 4.3.1); absent otherwise. */
	budgetTotal?: number;
	/** Output tokens spent at settle, when a budget was set (Task 4.3.1). */
	budgetSpent?: number;
	/**
	 * Typed diagnostics for every `agent()` call that degraded to `null`/`""`
	 * (Task 7.2.1) — collected from the run's `onDiagnostic` hook and persisted at
	 * settle so a finished run is post-mortem-debuggable from the record alone.
	 * Absent when the run had no degraded calls.
	 */
	diagnostics?: AgentDiagnostic[];
	/**
	 * Per-agent rollup (Task 8.1.4): one {@link AgentSummary} per `agent:end` the
	 * run produced, accumulated at the engine choke point and persisted at every
	 * settle site (success, error, cancel) so the record alone reconstructs CC's
	 * per-agent table post-hoc. Absent when the run launched no agents.
	 */
	agents?: AgentSummary[];
}

/** In-memory handle for a run: live run (absent for recovered records), record, progress. */
export interface RunHandle {
	run?: WorkflowRun;
	record: RunRecord;
	/**
	 * Engine-stamped progress (Task 6.2.1): the runtime emits clock-free
	 * {@link ProgressEvent}s, the engine stamps each with `at = clock.now()` at its
	 * onProgress boundary. `workflow_status` reads `at` for per-agent elapsed. Live
	 * `agent:end` events are widened to {@link EnrichedProgressEvent} at the choke
	 * point (Task 8.1.4) — the same enrichment the feed file carries.
	 */
	progress: EnrichedProgressEvent[];
	/**
	 * A live wall-clock view for elapsed rendering (Task 6.2.1). The engine sets it
	 * to its injected `clock.now` for LIVE runs only — recovered runs (flipped to a
	 * terminal status on restart, with no in-memory clock) leave it absent, so the
	 * live-only elapsed/counts surfaces stay off and recovered runs render as today.
	 */
	now?: () => number;
	/**
	 * The live token budget view (Task 4.3.1), present only when this run was
	 * launched with `budgetTokens`. `workflow_status` reads it for LIVE spend
	 * while the run is in flight; the record's `budgetSpent` is the settled
	 * snapshot. Absent for recovered records (the accumulator died with the process).
	 */
	budget?: BudgetView;
	/**
	 * Resolves when the detached run settles (Task 4.3.2). `workflow_status`'s
	 * `wait_ms` affordance races this against a timeout so a single-turn/headless
	 * caller can block on completion in-process (the honest equivalent of CC's
	 * task-notification re-invocation, which `opencode run` lacks). Absent for
	 * recovered records (the run died with the prior process).
	 */
	settled?: Promise<void>;
}

/** Arguments to launch a run. */
export interface StartRunArgs {
	/**
	 * The script source. On a fresh run it is required; on a resume
	 * ({@link resumeFromRunId} set) it MAY be absent — the prior run's persisted
	 * script is read from disk instead. An explicit source always wins.
	 */
	source?: string;
	/**
	 * The invocation args. Explicit value wins; on a resume, an absent `args`
	 * inherits the prior run's persisted args.
	 */
	args?: unknown;
	parentSessionID: string;
	/**
	 * Resume from a prior run (spec §7): own runId + own journal, but seeded with
	 * the prior run's journal entries (replayed by key + occurrence — Task 7.3.1:
	 * each matching call key replays its frozen result, position-independent, so an
	 * edited item does not void unchanged siblings). Source and args default to the
	 * prior record's when absent.
	 */
	resumeFromRunId?: string;
	/**
	 * Token budget ceiling for the run (spec §6, Task 4.3.1). MUST already be a
	 * positive finite number — the workflow tool coerces (Number.isFinite gate)
	 * before passing it. Absent → no budget (the runtime's null-budget default).
	 */
	budgetTokens?: number;
}

/** What `startRun` returns synchronously (before the run settles). */
export interface StartRunResult {
	runId: string;
	scriptPath: string;
	name: string;
}

export interface CreateWorkflowEngineOptions {
	/** The engine's structural SDK surface (already wrapped with adaptSdkClient). */
	client: EngineClient;
	/** Project directory; saved-workflow lookup (`.opencode/workflows`) lands in 4.1.3. */
	directory: string;
	/**
	 * Persistence BASE dir. Resolution ({@link resolveDataBaseDir}): explicit
	 * `dataDir` → `$OPENCODE_DRAWERS_DATA_DIR` → XDG default. The plugin's
	 * `workflow-*` subdirs hang off it; ALWAYS resolves to a real path.
	 */
	dataDir?: string;
	/** Toast callback for terminal notices. */
	onNotify?: (notice: TaskNotice) => void;
	logger?: EngineLogger;
	/** Injectable fs facade for both stores + script files; tests pass in-memory. */
	fs?: FsFacade;
	/** Injectable clock; defaults to `Date.now`. */
	clock?: Clock;
	/** Injectable runId generator; defaults to a `wf_`-prefixed core generator. */
	ids?: IdGenerator;
	/**
	 * Poll cadence for the external control-channel watcher (Task 8.2.2), in ms.
	 * Defaults to 1000. The watcher scans `<dataDir>/workflow-control/` for
	 * `<runId>.cancel` sentinels and cancels the matching live run.
	 */
	controlPollMs?: number;
	/**
	 * Injectable interval arming for the control watcher; defaults to
	 * `globalThis.setInterval`. Tests pin the cadence and drive `tick()` directly.
	 */
	setIntervalFn?: (cb: () => void, ms: number) => unknown;
	/** Injectable interval clearing; defaults to `globalThis.clearInterval`. */
	clearIntervalFn?: (handle: unknown) => void;
	/**
	 * The host BunShell (Epic 2.1), captured verbatim from `PluginInput['$']` in the
	 * plugin entry — it already carries `.cwd(directory)`. Injectable like
	 * `fs`/`clock`/`ids`: the production path passes the real `$`; tests pass a fake
	 * or omit it. When ABSENT the per-agent git-checkpoint subsystem is not
	 * constructed at all and the feature no-ops (every existing test construction
	 * passes no shell, so this widening breaks nothing). NOT routed through
	 * `adaptSdkClient`/`EngineClient` — `$` is a host primitive, sibling to `client`.
	 */
	shell?: BunShell;
}

export interface WorkflowEngine {
	/** Live + recovered run handles, keyed by runId. */
	runs: Map<string, RunHandle>;
	/** The run-record persistence store. */
	runStore: RunStore;
	/** The per-parent terminal-notice queue. */
	queue: NotificationQueue;
	/** The ONE schema registry behind the global structured_output tool. */
	registry: SchemaRegistry;
	/** Resolves once startup recovery has been applied + the queue seeded. */
	ready(): Promise<void>;
	/** Persist the script, create the record, fire the run detached; returns immediately. */
	startRun(args: StartRunArgs): Promise<StartRunResult>;
	/** Abort a live run, flip its record to cancelled, queue a notice. */
	stopRun(runId: string): void;
	/** Snapshot of a run handle (record + progress), or undefined when unknown. */
	statusOf(runId: string): RunHandle | undefined;
	/**
	 * Live per-session stats for a tracked CHILD session (Task 8.1.5). The
	 * collector tracks a session only between its `agent:launched` and `agent:end`,
	 * so this returns numbers ONLY for in-flight agents and `undefined` otherwise.
	 * `workflow_status` reads it to fill the running rows of the CC-style tree (a
	 * settled agent's final stats live on `RunRecord.agents` / the enriched end).
	 */
	statsSnapshot(sessionID: string): SessionStatsSnapshot | undefined;
	/**
	 * Whether `sessionID` is a LIVE workflow worker — a child session spawned by a
	 * workflow agent that has emitted `agent:launched` but not yet `agent:end`
	 * (Epic 0.1). The deny hook (`tool.execute.before`) reads this to tell a
	 * worker's Bash call apart from the parent's: the host hook payload carries only
	 * `{ tool, sessionID, callID }`, no parent lineage. Pure membership, no I/O; the
	 * parent and unrelated sessions are always false.
	 */
	isWorkerSession(sessionID: string): boolean;
	/**
	 * Live (status `running`) run handles owned by a parent session (Task 6.2.4).
	 * The chat.message digest hook reads this to prepend a one-line digest per live
	 * run on the parent's next message. Recovered runs are never `running` (startup
	 * recovery flips them to error), so they are excluded by construction.
	 */
	liveRunsFor(parentSessionID: string): RunHandle[];
	/** Forward an SDK event to the runner's completion gate. */
	handleEvent(
		event: Parameters<SessionRunner["handleEvent"]>[0],
	): Promise<void>;
	/** Drain every store + the runner. Call before process exit. */
	dispose(): Promise<void>;
}

/**
 * The run-record store: a typed wrapper around a core {@link TaskStore}. The
 * single documented widening lives here — a {@link RunRecord} is NOT a `BgTask`,
 * but the store only validates id/parentSessionID/status (all present on a record)
 * and serializes the whole object, so the extra fields round-trip intact.
 */
interface RunStore {
	save(record: RunRecord): Promise<void>;
	load(): Promise<RunRecord[]>;
	dispose(): Promise<void>;
}

const RUN_PREFIX = "wf_";
const SUBDIR_TASKS = "workflow-tasks";
const SUBDIR_RUNS = "workflow-runs";
const SUBDIR_SCRIPTS = "workflow-scripts";
const SUBDIR_JOURNALS = "workflow-journals";
const SUBDIR_FEED = "workflow-feed";
// External control-channel sentinel dir (Task 8.2.1). Declared beside its sibling
// subdirs so the on-disk layout stays in one place; the control watcher (Task
// 8.2.2) resolves it via `subdir()` and polls it for `<runId>.cancel` sentinels.
const SUBDIR_CONTROL = "workflow-control";

/**
 * Minimum gap between throttled `agent:stats` feed lines for one session (Task
 * 8.1.3). `message.updated` fires per streamed token, so an unthrottled emit
 * would flood the feed; one line per session per window is plenty for a tailing
 * TUI viewer. The status tool reads collector snapshots directly, so it is never
 * throttle-bound.
 */
const STATS_THROTTLE_MS = 2000;

/**
 * Synthesize an append as read-modify-write over `readFile`/`writeFile` (ENOENT →
 * start empty), for an {@link FsFacade} that has no native `appendFile` — only the
 * in-memory test fs. This is O(n) per append (it rewrites the whole file), so it is
 * the FALLBACK only: a production facade backed by `node:fs/promises` exposes the
 * native O(1) `appendFile` and never lands here. Callers' own single-serial write
 * chain guarantees no two appends interleave for one file.
 */
function synthesizeAppend(
	fs: FsFacade,
): (path: string, data: string, enc: "utf-8") => Promise<void> {
	return async (path, data, enc) => {
		let prior = "";
		try {
			prior = await fs.readFile(path, enc);
		} catch (err) {
			if ((err as { code?: string }).code !== "ENOENT") {
				throw err;
			}
		}
		await fs.writeFile(path, prior + data, enc);
	};
}

/**
 * Adapt the engine's {@link FsFacade} to the {@link JournalFs} the journal needs.
 * Prefers the facade's native `appendFile` (the production `node:fs/promises` path,
 * O(1) per line); falls back to the read-modify-write {@link synthesizeAppend} only
 * for an in-memory test fs that lacks it. The journal's single-serial write chain
 * guarantees no two appends interleave for one file.
 */
function journalFsFromFacade(fs: FsFacade): JournalFs {
	const append = fs.appendFile?.bind(fs) ?? synthesizeAppend(fs);
	return {
		mkdir: (path, opts) => fs.mkdir(path, opts),
		readFile: (path, enc) => fs.readFile(path, enc),
		appendFile: append,
	};
}

/**
 * Adapt the engine's {@link FsFacade} to the {@link FeedFs} the live feed writer
 * needs (Task 8.1.2). The feed is the high-frequency observability bus (every
 * lifecycle event plus throttled stats lines), so it MUST use the native O(1)
 * `appendFile` the production facade exposes — read-modify-write would make the
 * feed-write path O(n²) in line count, quadratic IO precisely on the long runs the
 * feed exists to observe. The synthesized fallback is used only by the in-memory
 * test fs (tiny files). The writer's own dead-state fence absorbs any error this
 * raises — a broken disk drops feed lines but never breaks the run.
 */
function feedFsFromFacade(fs: FsFacade): FeedFs {
	const append = fs.appendFile?.bind(fs) ?? synthesizeAppend(fs);
	return {
		mkdir: (path, opts) => fs.mkdir(path, opts),
		appendFile: append,
	};
}

const defaultClock: Clock = { now: () => Date.now() };

/**
 * A node:fs/promises-backed {@link FsFacade} — the engine's production default when
 * no fs is injected. The plugin entry builds the engine without an fs, and the
 * engine's OWN paths (script persistence, journal writes, resume-read) are NOT the
 * stores' internal default fs — they need this concrete facade or they silently
 * no-op (the live-harness Scenario C bug: resume could not read the prior script,
 * "no fs configured"). `node:fs/promises` exposes mkdir/readdir/readFile/writeFile/
 * rename/rm with runtime-compatible signatures; the structural cast bridges the
 * minor optional-arg differences. Lazy-required so the in-memory test path that
 * injects its own fs never loads it.
 */
function nodeFsFacade(): FsFacade {
	return require("node:fs/promises") as FsFacade;
}

/** Cheap meta-name extraction: parse JUST for the name, fall back to "workflow". */
function extractName(source: string): string {
	try {
		return parseScript(source).meta.name;
	} catch {
		return "workflow";
	}
}

/**
 * The DECLARED phase titles from `meta.phases`, in order, for the `run:start` feed
 * line (Task 8.3.3) — so the viewer paints the whole pipeline upfront. Returns
 * `undefined` when no phases are declared or the script can't be parsed (the viewer
 * then derives phases from agents alone). Best-effort: a parse failure here never
 * blocks a run (the real parse/validation happens at execution).
 */
function extractDeclaredPhases(source: string): string[] | undefined {
	try {
		const phases = parseScript(source).meta.phases;
		if (phases === undefined || phases.length === 0) {
			return undefined;
		}
		return phases.map((p) => p.title);
	} catch {
		return undefined;
	}
}

/** The retrieval hint naming the workflow_status tool for a run. */
function runHint(runId: string): string {
	return `workflow_status run_id=${runId} for the result`;
}

/** Wrap a core TaskStore as a typed RunStore (the one documented widening). */
function createRunStore(opts: {
	baseDir?: string;
	fs?: FsFacade;
	clock: Clock;
	logger?: EngineLogger;
}): RunStore {
	const storeLogger = opts.logger
		? {
				debug: (msg: string, meta?: Record<string, unknown>) =>
					opts.logger?.debug(msg, meta),
				error: (msg: string, meta?: Record<string, unknown>) =>
					opts.logger?.error(msg, meta),
			}
		: undefined;
	const store: TaskStore = createTaskStore({
		baseDir: opts.baseDir,
		fs: opts.fs,
		clock: opts.clock,
		logger: storeLogger,
	});
	return {
		// RunRecord carries id/parentSessionID/status (the store's only validated
		// fields) plus extra fields the store serializes verbatim. Widen across the
		// BgTask-typed surface here, once.
		save: (record) =>
			store.save(record as unknown as Parameters<TaskStore["save"]>[0]),
		load: async () => (await store.load()) as unknown as RunRecord[],
		dispose: () => store.dispose(),
	};
}

export function createWorkflowEngine(
	opts: CreateWorkflowEngineOptions,
): WorkflowEngine {
	const clock = opts.clock ?? defaultClock;
	// Default to a real node facade when none is injected (the production plugin
	// path passes none). This fs backs script persistence, journal writes, resume
	// reads, AND sub-workflow source resolution — all of which silently no-op'd
	// before, breaking resume in production (live-harness Scenario C regression).
	const fs = opts.fs ?? nodeFsFacade();
	const logger = opts.logger;
	// The ONE canonical base, shared with the background-agents plugin. ALWAYS a
	// string (XDG default when no dataDir/env), so every subdir is a real path and
	// scripts/journals/runs/tasks always persist — even on a default install.
	const base = resolveDataBaseDir(opts.dataDir);
	const ids = opts.ids ?? createIdGenerator({ prefix: RUN_PREFIX });

	const subdir = (name: string) => join(base, name);
	const scriptsDir = subdir(SUBDIR_SCRIPTS);
	const journalsDir = subdir(SUBDIR_JOURNALS);
	const feedDir = subdir(SUBDIR_FEED);
	const controlDir = subdir(SUBDIR_CONTROL);

	// Sub-workflow source resolver (spec §8): maps a name/{scriptPath} to source
	// against the project directory. Threaded into every TOP-LEVEL run's
	// createWorkflowRun so its workflow() global can nest one level; a child run is
	// built (in the runtime) with resolveSubWorkflow undefined → depth-1 guard.
	const resolveSubWorkflow = createSourceResolver({
		directory: opts.directory,
		fs,
		builtins: BUILTIN_WORKFLOWS,
	});

	/** The journal file path for a runId (under the journals subdir). */
	const journalPath = (id: string) => join(journalsDir, `${id}.jsonl`);

	const journalFs = fs ? journalFsFromFacade(fs) : undefined;
	// The live feed writer's fs (Task 8.1.2): same read-modify-write synthesis as the
	// journal so the in-memory test fs works unchanged. ALWAYS present (fs always is).
	const feedFs = feedFsFromFacade(fs);
	// The feed READ fs (Phase 3.2.2): recovery re-reads a crashed run's feed to
	// rehydrate its per-agent rollup. The facade always exposes readFile.
	const feedReadFs: FeedReadFs = {
		readFile: (path, enc) => fs.readFile(path, enc),
	};
	const feedLogger = logger
		? {
				error: (msg: string, meta?: Record<string, unknown>) =>
					logger.error(msg, meta),
			}
		: undefined;
	const journalLogger = logger
		? {
				error: (msg: string, meta?: Record<string, unknown>) =>
					logger.error(msg, meta),
			}
		: undefined;

	const storeLogger = logger
		? {
				debug: (msg: string, meta?: Record<string, unknown>) =>
					logger.debug(msg, meta),
				error: (msg: string, meta?: Record<string, unknown>) =>
					logger.error(msg, meta),
			}
		: undefined;

	// (1) The child-task store + the unlimited runner (deviation e: the workflow
	// gate inside each run is authoritative, so the runner must NOT cap).
	const taskStore = createTaskStore({
		baseDir: subdir(SUBDIR_TASKS),
		fs,
		clock,
		logger: storeLogger,
	});
	const runner = createSessionRunner({
		client: opts.client,
		concurrency: new ConcurrencyManager({ defaultConcurrency: 0 }),
		ids: createIdGenerator(),
		clock,
		persist: (task) => taskStore.save(task),
		logger: storeLogger,
	});

	// Engine-owned per-agent git checkpointer (Epic 2.1). Constructed from the host
	// `$` bound to the project root; ABSENT shell → a documented no-op (the feature
	// simply does not run). The work-tree is probed ONCE here (in readyPromise) and
	// the verdict cached in `checkpointerAlive`; each run then gets its OWN per-run
	// checkpointer (so the operator baseline is RUN-SCOPED and two concurrent runs
	// never clobber each other's refuse-set) seeded with that probed verdict so it
	// neither re-probes nor re-warns. The engine is the privileged VCS actor — NOT a
	// worker session — so the deny hook never fires on its commits (the asymmetry).
	const probeCheckpointer: Checkpointer = createGitCheckpointer({
		shell: opts.shell,
		directory: opts.directory,
		...(logger !== undefined ? { logger } : {}),
		clock,
	});
	// The single probe verdict, set in readyPromise; until then a per-run checkpointer
	// would be premature (startRun awaits readyPromise first, so it is always set by
	// the time a run is created). `undefined` shell yields `false` (a no-op anyway).
	let checkpointerAlive = false;
	/** A fresh RUN-SCOPED checkpointer seeded with the one probe verdict (no re-warn). */
	const newRunCheckpointer = (): Checkpointer =>
		createGitCheckpointer({
			shell: opts.shell,
			directory: opts.directory,
			...(logger !== undefined ? { logger } : {}),
			clock,
			presumedAlive: checkpointerAlive,
		});

	// Engine-owned per-agent worktree manager (Epic H.1.6). Constructed ONCE from the
	// host `$` bound to the project root (sibling to the checkpointer's shared probe),
	// then threaded through every run's WorkflowRunDeps → AgentPrimitiveDeps so the
	// isolation mint-point (Epic H.1.2) calls it at the `isolation:'worktree'` seam. An ABSENT shell → a documented
	// no-op (`create` returns null), so isolation requests degrade-to-null on a
	// no-shell engine. The manager probes the work-tree lazily on first use (its own latch),
	// so no extra startup probe is needed here.
	const worktreeManager: WorktreeManager = createWorktreeManager({
		shell: opts.shell,
		directory: opts.directory,
		...(logger !== undefined ? { logger } : {}),
	});

	// (2) The run-record store + ONE shared registry.
	const runStore = createRunStore({
		baseDir: subdir(SUBDIR_RUNS),
		fs,
		clock,
		logger,
	});
	const registry = createSchemaRegistry();

	// (3) In-memory run handles, keyed by runId.
	const runs = new Map<string, RunHandle>();

	// Index of LIVE (status === "running") runs by their parentSessionID, so the
	// latency-sensitive `chat.message` digest path (engine.liveRunsFor) costs
	// O(this parent's live runs) instead of O(every run ever started in the session).
	// A runId joins on handle creation and is dropped the moment it settles (the single
	// settleRecord choke point) — terminal runs leave this index entirely.
	const liveRunsByParent = new Map<string, Set<string>>();
	const indexLiveRun = (parentSessionID: string, runId: string): void => {
		const set = liveRunsByParent.get(parentSessionID);
		if (set === undefined) {
			liveRunsByParent.set(parentSessionID, new Set([runId]));
		} else {
			set.add(runId);
		}
	};
	const unindexLiveRun = (parentSessionID: string, runId: string): void => {
		const set = liveRunsByParent.get(parentSessionID);
		if (set === undefined) {
			return;
		}
		set.delete(runId);
		if (set.size === 0) {
			liveRunsByParent.delete(parentSessionID);
		}
	};

	// Per-run live feed writers (Task 8.1.2), keyed by runId. Created in startRun,
	// reachable by stopRun for the cancel `run:end` line; dropped when the run
	// settles (the writer holds only a serialized promise chain, no live handle).
	const feeds = new Map<string, FeedWriter>();

	// ONE session-stats collector per engine (Task 8.1.3): handleEvent folds every
	// SDK event into the matching CHILD session's token/tool stats (unregistered
	// sessions are dropped at the first map lookup, so non-workflow traffic costs
	// one Map.has). Registered on the choke-point sighting of `agent:launched`,
	// unregistered on `agent:end`.
	const stats: SessionStatsCollector = createSessionStatsCollector({ clock });
	// Per-session binding for the throttled `agent:stats` feed line: which run's
	// feed to write to, the agent's display label, and the last emission time so a
	// stats change emits at most once per STATS_THROTTLE_MS window. Cleared on
	// `agent:end`.
	const statsBindings = new Map<
		string,
		{ runId: string; label: string; lastEmittedAt: number }
	>();
	// Live worker-session set (Epic 0.1): a child session's id between its
	// `agent:launched` and `agent:end`. The deny hook reads `isWorkerSession` to
	// distinguish a worker's destructive-git Bash call from the parent's. Lives and
	// dies on the same launched/end lifecycle as `statsBindings`, so it never leaks;
	// a crashed session that never emits `agent:end` leaves a harmless stale entry
	// (a dead session makes no tool calls), bounded by process lifetime.
	const workerSessions = new Set<string>();

	// External control channel (Task 8.2.2): a poll loop over `workflow-control/`
	// for `<runId>.cancel` sentinels. `stopRun` is the single cancel authority and
	// is safe to call unconditionally (its own `status !== "running"` guard makes
	// unknown/terminal ids no-ops); the `run:cancel-requested` feed line is appended
	// ONLY for a live run, BEFORE stopRun, so a viewer tailing the feed sees the
	// cancelling state ahead of the terminal `run:end`. The watcher reuses the engine
	// `FsFacade` (readdir/rm), so no new fs surface is introduced. Armed below once
	// the maps exist; stopped first thing in dispose().
	const control: ControlWatcher = createControlWatcher({
		dir: controlDir,
		fs,
		intervalMs: opts.controlPollMs ?? 1000,
		setIntervalFn: opts.setIntervalFn,
		clearIntervalFn: opts.clearIntervalFn,
		logger,
		onCancel: async (runId) => {
			const handle = runs.get(runId);
			if (handle?.record.status === "running") {
				feeds.get(runId)?.append({
					type: "run:cancel-requested",
					runId,
					at: clock.now(),
				});
			}
			stopRun(runId);
		},
		// Save the run's script as a named workflow (Epic 4.2). The TUI viewer drops
		// a `<runId>.save` sentinel whose body is the name; we reuse the same shared,
		// validated path as the `workflow_save_run` tool. The channel is one-way, so
		// the outcome is logged here (the viewer toasts optimistically on keypress).
		onSave: async (runId, name) => {
			const lookup: RunLookup = { statusOf: (id) => runs.get(id), runs };
			const result = await saveRunAsWorkflow(
				{ engine: lookup, fs, directory: opts.directory },
				{ runId, name },
			);
			if (result.ok) {
				logger?.info?.(`saved run ${runId} as workflow "${name}"`, {
					runId,
					path: result.path,
				});
			} else {
				logger?.warn?.(`save of run ${runId} as "${name}" refused`, {
					runId,
					reason: result.error,
				});
			}
		},
	});
	control.start();

	// (4) The terminal-notice queue. markNotified flips + re-persists the record.
	const queue = createNotificationQueue({
		onNotify: opts.onNotify,
		markNotified: async (runId) => {
			const handle = runs.get(runId);
			if (handle) {
				// `notified` is a BgTask-shaped flag the queue persists through; the
				// record round-trips it like any extra field.
				(handle.record as RunRecord & { notified?: boolean }).notified = true;
				await runStore.save(handle.record);
			}
		},
		logger: storeLogger,
		// A run notice points at workflow_status, not bg_output.
		renderHint: (task) => runHint(task.id),
	});

	function liveRunIds(): ReadonlySet<string> {
		return new Set(runs.keys());
	}

	/** Build the TaskNotice-bearing BgTask shim the queue needs from a record. */
	function noticePush(record: RunRecord): void {
		// The queue's push() reads id/parentSessionID/description/status/timestamps —
		// all present on a RunRecord. Cross the BgTask-typed surface once, here.
		queue.push(record as unknown as Parameters<NotificationQueue["push"]>[0]);
	}

	function persistRecord(record: RunRecord): void {
		void runStore.save(record).catch((err: unknown) => {
			logger?.error("run record persist failed", {
				runId: record.id,
				err: err instanceof Error ? err.message : String(err),
			});
		});
	}

	/** Settle a record from a finished run, persist, and queue the terminal notice. */
	function settleRecord(
		handle: RunHandle,
		patch: Partial<RunRecord> & { status: RunStatus },
	): void {
		Object.assign(handle.record, patch, { completedAt: clock.now() });
		// The run is now terminal — drop it from the live-run index so the digest path
		// never scans a settled run (and the index does not grow unbounded).
		unindexLiveRun(handle.record.parentSessionID, handle.record.id);
		persistRecord(handle.record);
		noticePush(handle.record);
	}

	/**
	 * Resolve the source + args + prior journal entries + `resumedFrom` for a run.
	 * Fresh run: explicit source required; entries empty. Resume: guards the prior
	 * run, reads its persisted script/args when the caller omits them, loads its
	 * journal (missing → empty + warn).
	 */
	async function resolveResume(args: StartRunArgs): Promise<{
		source: string;
		runArgs: unknown;
		entries: JournalEntry[];
		resumedFrom?: string;
	}> {
		const priorId = args.resumeFromRunId;
		if (priorId === undefined) {
			if (args.source === undefined) {
				throw new Error("startRun requires `source` for a fresh run");
			}
			return { source: args.source, runArgs: args.args, entries: [] };
		}

		// Guard: the prior run must be known.
		const prior = runs.get(priorId);
		if (prior === undefined) {
			const known = [...runs.keys()];
			const list = known.length > 0 ? known.join(", ") : "(none)";
			throw new Error(
				`unknown resume_from_run_id ${priorId}. Known runs: ${list}`,
			);
		}
		// Guard: a live run with that id must not still be running.
		if (prior.record.status === "running") {
			throw new Error(
				`run ${priorId} is still running — workflow_stop ${priorId} first.`,
			);
		}

		// Source: explicit wins; absent → read the prior record's persisted script.
		let source: string;
		if (args.source !== undefined) {
			source = args.source;
		} else if (fs) {
			try {
				source = await fs.readFile(prior.record.scriptPath, "utf-8");
			} catch (err) {
				throw new Error(
					`could not read prior script ${prior.record.scriptPath} for resume: ` +
						`${err instanceof Error ? err.message : String(err)}`,
				);
			}
		} else {
			throw new Error(
				`cannot read prior script for resume of ${priorId} (no fs configured)`,
			);
		}

		// Args: explicit wins; absent → prior record's args.
		const runArgs = "args" in args ? args.args : prior.record.args;

		// Journal: missing file → empty entries (+ warn) so resume still works.
		let entries: JournalEntry[] = [];
		if (journalFs) {
			const priorJournal = createJournal({
				path: journalPath(priorId),
				fs: journalFs,
				logger: journalLogger,
			});
			// Phase 3 load-boundary filter (the LOAD-BEARING guard): drop every
			// non-settled (intent) line before the runtime ever sees it. resolveResume
			// loads `entries` ONCE and threads the SAME array into BOTH the agent and
			// sub-workflow replay caches, so this one filter protects every consumer —
			// a crashed prior run's intent lines can never reach replay. The empty-check
			// tests the POST-filter length: an all-intent journal warns "running live"
			// (correct — there are no settled results to replay).
			entries = (await priorJournal.load()).filter((e) => e.status === "ok");
			if (entries.length === 0) {
				logger?.warn("resume found no prior journal — running live", {
					priorId,
					path: journalPath(priorId),
				});
			}
		}

		return { source, runArgs, entries, resumedFrom: priorId };
	}

	async function startRun(args: StartRunArgs): Promise<StartRunResult> {
		const resolved = await resolveResume(args);
		const runId = ids.next(liveRunIds());
		const name = extractName(resolved.source);
		const declaredPhases = extractDeclaredPhases(resolved.source);
		const scriptPath = join(scriptsDir, `${runId}.js`);

		// Persist the script source BEFORE execution (the spec's "persisted script
		// path"). On resume with no explicit source, this re-persists the prior
		// script under the NEW runId so the new run is fully self-describing.
		if (fs) {
			await fs.mkdir(dirname(scriptPath), { recursive: true });
			await fs.writeFile(scriptPath, resolved.source, "utf-8");
		}

		const record: RunRecord = {
			id: runId,
			parentSessionID: args.parentSessionID,
			status: "running",
			description: name,
			createdAt: clock.now(),
			scriptPath,
			args: resolved.runArgs,
			...(resolved.resumedFrom !== undefined
				? { resumedFrom: resolved.resumedFrom }
				: {}),
		};
		// Token budget (Task 4.3.1): only when budgetTokens was given (already
		// coerced to a positive finite number by the workflow tool). fetchMessages
		// closes over the SDK client; its `data` is a GateMessage[] that narrows
		// AWAY the assistant token metadata (audit row m), so widen through unknown
		// ONCE here — the same honest widening as background-agents' fetchSession-
		// Messages fork. The budget reads each message defensively.
		const budget: TokenBudget | undefined =
			args.budgetTokens !== undefined
				? createTokenBudget({
						total: args.budgetTokens,
						fetchMessages: async (sid) => {
							const res = await opts.client.session.messages({
								path: { id: sid },
							});
							return (res.data ?? []) as unknown[];
						},
						logger: logger
							? { warn: (msg, meta) => logger.warn(msg, meta) }
							: undefined,
					})
				: undefined;
		if (budget !== undefined) {
			record.budgetTotal = budget.total ?? undefined;
		}

		// `now` is the live clock view for elapsed rendering (Task 6.2.1) — present
		// only while this process owns the run. Recovered handles omit it.
		const handle: RunHandle = {
			record,
			progress: [],
			now: () => clock.now(),
			budget,
		};
		runs.set(runId, handle);
		// A freshly started run is live until settleRecord drops it from the index.
		indexLiveRun(record.parentSessionID, runId);
		persistRecord(record);

		// The live feed (Task 8.1.2): one writer per run, framed by run:start now and
		// run:end at settle. Every stamped progress event is appended in the onProgress
		// choke below, so the feed file and handle.progress carry the same stream. The
		// writer is fenced — a feed-write failure can never break the run.
		const feed = createFeedWriter({
			dir: feedDir,
			runId,
			fs: feedFs,
			logger: feedLogger,
		});
		feeds.set(runId, feed);
		feed.append({
			type: "run:start",
			runId,
			parentSessionID: args.parentSessionID,
			scriptPath,
			...(declaredPhases !== undefined ? { phases: declaredPhases } : {}),
			name,
			at: clock.now(),
		});

		// Every run gets its OWN journal (empty file). onRecord persists each settled
		// AND each re-recorded cached entry, so the new journal is self-contained.
		const journal: Journal | undefined = journalFs
			? createJournal({
					path: journalPath(runId),
					fs: journalFs,
					logger: journalLogger,
				})
			: undefined;

		// Track every journal append so the run's settle can DRAIN them before
		// resolving — a fire-and-forget append would otherwise race process teardown
		// (live-harness Scenario C: a single-turn `opencode run` exits the instant
		// the turn ends; an unflushed journal means a later resume replays nothing).
		const journalWrites: Promise<void>[] = [];

		// This run's OWN checkpointer (Epic 2.1). A per-run instance keeps the operator
		// baseline RUN-SCOPED: two concurrent runs each snapshot their own pre-existing
		// dirty set, so run B's baseline can never clobber run A's refuse-set (which a
		// shared engine-level instance did, sweeping the operator's work into a commit).
		// Seeded with the one probe verdict so it neither re-probes nor re-warns.
		const runCheckpointer = newRunCheckpointer();

		// Per-run serialized checkpoint chain (Task 2.1.5). Each LIVE completed
		// `agent:end` appends a commit onto this tail (fire-and-forget from the
		// synchronous onProgress), so commits NEVER interleave and always apply in
		// agent:end order. The pre-launch barrier below awaits this same tail so the
		// next agent's launch blocks until the prior agent's commit drains — making
		// commit-before-next-unit real, not just ordering. Settle drains it before
		// `run:end` so the terminal feed line follows the last checkpoint line. The
		// chain is fenced (each link swallows its own error) so a checkpoint failure
		// never poisons the tail or the barrier.
		let checkpointTail: Promise<void> = Promise.resolve();
		/** Append a checkpoint for a live completed agent, fenced, in agent:end order. */
		const enqueueCheckpoint = (meta: {
			label: string;
			sessionID: string;
			phase?: string;
		}): void => {
			checkpointTail = checkpointTail.then(async () => {
				try {
					const res = await runCheckpointer.checkpoint({
						runId,
						label: meta.label,
						sessionID: meta.sessionID,
						...(meta.phase !== undefined ? { phase: meta.phase } : {}),
					});
					if (res.committed) {
						feed.append({
							type: "agent:checkpoint",
							label: meta.label,
							sessionID: meta.sessionID,
							...(res.sha !== undefined ? { sha: res.sha } : {}),
							paths: res.paths ?? [],
							at: clock.now(),
						});
					}
				} catch (err) {
					logger?.error("workflow checkpoint failed", {
						runId,
						label: meta.label,
						err: err instanceof Error ? err.message : String(err),
					});
				}
			});
		};

		// Task 7.2.1: collect each null/empty agent diagnostic; persisted on the
		// record at settle so a finished run is debuggable without SQLite.
		const diagnostics: AgentDiagnostic[] = [];

		// Task 8.1.4 per-run choke-point state (dropped when this closure settles):
		//   - launchMeta: the launched session's label/phase/model/agentType + the
		//     stamped launch time, keyed by sessionID, consumed at agent:end to
		//     compute durationMs and stamp model/agentType;
		//   - startQueue: a FIFO of pending agent:start phases (label-matched) so a
		//     CACHED end (no sessionID, no agent:launched) recovers its phase — the
		//     cached path emits start+end synchronously and back-to-back.
		// The AgentSummary rollup accumulates directly onto `record.agents` (lazily
		// created) so it is reachable from BOTH the in-closure settle sites AND
		// stopRun, and persists for free wherever settleRecord saves the record.
		const launchMeta = new Map<string, LaunchMeta>();
		const startQueue: Array<{ label: string; phase?: string }> = [];

		/** Pull (and remove) the first pending start matching a label, for its phase. */
		const claimStartPhase = (label: string): string | undefined => {
			const i = startQueue.findIndex((s) => s.label === label);
			if (i === -1) {
				return undefined;
			}
			const [claimed] = startQueue.splice(i, 1);
			return claimed?.phase;
		};

		/** Append a per-agent summary onto the record (Task 8.1.4), lazily creating it. */
		const rollupAgent = (summary: AgentSummary): void => {
			if (record.agents === undefined) {
				record.agents = [];
			}
			record.agents.push(summary);
		};

		const run = createWorkflowRun({
			runner,
			parentSessionID: args.parentSessionID,
			runId,
			args: resolved.runArgs,
			registry,
			// Top-level run: its workflow() global can nest one level (spec §8).
			resolveSubWorkflow,
			// Epic H.1.6: the engine-owned worktree manager, threaded to every run so the
			// future isolation mint-point (H.1.2) reaches it. Inert today (no-shell → no-op).
			worktreeManager,
			...(budget !== undefined ? { budget } : {}),
			// Pre-launch checkpoint barrier (Task 2.1.5): the runtime awaits this opaque
			// thunk after gate.acquire and before runner.launch, so the next agent's
			// launch blocks until the prior agent's commit (queued on checkpointTail)
			// drains. Reads the LIVE tail at call time (it is reassigned per checkpoint).
			// Fenced both ends — never rejects.
			awaitCheckpointClear: () =>
				checkpointTail.then(
					() => undefined,
					() => undefined,
				),
			// Epic H.1.3: serialize an isolated agent's merge-back onto the SAME
			// checkpoint tail that orders per-unit commits, so a merge never interleaves
			// with a sibling's commit. Appends the task onto the live tail and resolves
			// with its result once that link drains. The tail itself is kept un-poisoned
			// (it only ever holds a resolved-or-swallowed link); the task's own result
			// and rejection are surfaced to the caller via a separate promise, and the
			// runtime fences that on its side (a thrown merge degrades, never detonates).
			serializeOnCheckpoint: <T>(task: () => Promise<T>): Promise<T> => {
				const run = checkpointTail.then(() => task());
				checkpointTail = run.then(
					() => undefined,
					() => undefined,
				);
				return run;
			},
			// Epic 4.1: supply the engine-computed real git diff (since run start) for a
			// `contextDiff:true` review from THIS run's OWN checkpointer (no cross-run
			// bleed — each run closes over its own runCheckpointer; the baseline is
			// captured at startRun before the detached run fires). On the no-shell / non
			// -git path the checkpointer is dead → diff() returns available:false, so the
			// runtime injects nothing and refuses nothing (emptiness is unprovable). The
			// diff rides a SYNTHETIC contextPart, never the prompt, so computeCallKey is
			// unchanged and the reviewer replays its verdict on resume.
			resolveContextDiff: () => runCheckpointer.diff(),
			// Epic 4.2: verify a settled agent's git/command post-condition against GIT
			// TRUTH (this run's checkpointer + the host shell), NEVER the opencode session
			// diff (a snapshot that survives an out-of-band git restore — see the Phase 4
			// probe verdict). `true`/`{}` → the working-tree diff vs baseline must be NON-
			// EMPTY (valid PRE-commit; no commit-ordering dance). `{check}` → run the
			// command via the repo-bound shell and assert exit 0. On the no-shell / non-git
			// path the checkpointer is dead and `opts.shell` is absent → available:false
			// (inert pass-through, NEVER a fabricated failure). Fenced — a thrown shell
			// degrades to available:false.
			verifyResult: async (v) => {
				const wantsCheck =
					typeof v.verifyDiff === "object" &&
					typeof v.verifyDiff.check === "string";
				if (wantsCheck) {
					const command = (v.verifyDiff as { check: string }).check;
					if (opts.shell === undefined) {
						return { passed: false, available: false };
					}
					try {
						// Epic H.1.3: an isolation:'worktree' agent's edits live in its
						// WORKTREE checkout, not the main tree — so re-root the verify shell
						// to the worktree dir when one is supplied (the runtime passes it for
						// an isolated agent). Absent → the engine-wide directory as today.
						const verifyDir = v.directory ?? opts.directory;
						// `.quiet()` is required: this runs an arbitrary user command
						// (tsc/eslint/…) and the plugin host shares fd 1/2 with the opencode
						// opentui renderer. Without it, the command's stdout/stderr echoes
						// raw onto the TUI alt-buffer and corrupts the screen. `.quiet()`
						// lives on the ShellPromise (not the namespace), so it is appended
						// AFTER the template. We only read exitCode, so buffering loses nothing.
						const res = await opts.shell
							.cwd(verifyDir)
							.nothrow()`${{ raw: command }}`.quiet();
						return { passed: res.exitCode === 0, available: true };
					} catch (err) {
						logger?.debug(
							"workflow verifyDiff check threw; treating as inert",
							{
								runId,
								command,
								err: err instanceof Error ? err.message : String(err),
							},
						);
						return { passed: false, available: false };
					}
				}
				// `true` or `{}` → git-diff-nonempty mode (the {} collapse).
				// Epic H.1.3: for an isolation:'worktree' agent the edits live in the
				// WORKTREE checkout, not the main tree, so the main checkpointer's
				// main-tree-bound diff is empty and would falsely fail the agent. When the
				// runtime supplies the worktree dir, re-root the diff to it: run `git diff`
				// (working tree vs HEAD — uncommitted edits, which is where a worktree
				// agent's work lives pre-merge) bound to the worktree via cwd. Fenced +
				// quieted (TTY safety, parity with the {check} branch). Absent v.directory
				// → the main-tree checkpointer diff as today.
				if (v.directory !== undefined && opts.shell !== undefined) {
					try {
						const res = await opts.shell
							.cwd(v.directory)
							.nothrow()`git diff`.quiet();
						const text = res.exitCode === 0 ? res.text() : "";
						return {
							passed: text.trim().length > 0,
							available: true,
						};
					} catch {
						// A thrown shell → emptiness is unprovable → inert (available:false),
						// never a fabricated failure (parity with the {check} branch).
						return { passed: false, available: false };
					}
				}
				const d = await runCheckpointer.diff();
				return { passed: !d.isEmpty, available: d.available };
			},
			onProgress: (e) => {
				// Stamp at the ENGINE boundary (Task 6.2.1): the runtime stays clock-free;
				// the timestamp comes from the engine's injected clock here. A LIVE
				// agent:end is then WIDENED into an enriched event (Task 8.1.4) so the
				// feed file and handle.progress carry one identical truth; every other
				// event rides through as the plain stamped event.
				const at = clock.now();
				let out: EnrichedProgressEvent = { ...e, at };
				if (e.type === "agent:start") {
					// Remember the phase so a later cached end can recover it (the cached
					// path never emits agent:launched and its end carries no sessionID).
					startQueue.push({ label: e.label, phase: e.phase });
				} else if (e.type === "agent:launched") {
					// Bind the session-stats collector at the choke point (Task 8.1.3): a
					// launched session starts being tracked the instant it exists. The
					// stats themselves are harvested from the SDK event stream (see
					// handleEvent), not from these lifecycle events.
					stats.register(e.sessionID, { runId, label: e.label });
					workerSessions.add(e.sessionID);
					statsBindings.set(e.sessionID, {
						runId,
						label: e.label,
						// Seed lastEmittedAt in the past so the first real stats change
						// emits immediately (no initial throttle penalty).
						lastEmittedAt: Number.NEGATIVE_INFINITY,
					});
					// Capture launch meta for the matching agent:end (Task 8.1.4); the
					// launched start is now live, so drop it from the cached-start queue.
					launchMeta.set(e.sessionID, {
						label: e.label,
						phase: e.phase,
						model: e.model,
						agentType: e.agentType,
						launchedAt: at,
					});
					claimStartPhase(e.label);
				} else if (e.type === "agent:end" && e.sessionID !== undefined) {
					// A LIVE agent ended: enrich the stamped end with the collector's
					// final snapshot + the launch-derived duration/model/agentType BEFORE
					// it is pushed/appended, then drop the per-session tracking. The
					// snapshot MUST be read before unregister clears the collector state.
					const meta = launchMeta.get(e.sessionID);
					const snap = stats.snapshot(e.sessionID);
					const durationMs =
						meta !== undefined ? at - meta.launchedAt : undefined;
					out = {
						...e,
						at,
						...(durationMs !== undefined ? { durationMs } : {}),
						...(snap !== undefined
							? { tokens: snap.tokens, toolCalls: snap.toolCalls }
							: {}),
						...(meta?.model !== undefined ? { model: meta.model } : {}),
						...(meta?.agentType !== undefined
							? { agentType: meta.agentType }
							: {}),
					};
					rollupAgent({
						label: e.label,
						...(meta?.phase !== undefined ? { phase: meta.phase } : {}),
						sessionID: e.sessionID,
						...(meta?.model !== undefined ? { model: meta.model } : {}),
						...(meta?.agentType !== undefined
							? { agentType: meta.agentType }
							: {}),
						status: e.status,
						...(snap !== undefined
							? { tokens: snap.tokens, toolCalls: snap.toolCalls }
							: {}),
						...(durationMs !== undefined ? { durationMs } : {}),
						...(e.note !== undefined ? { note: e.note } : {}),
					});
					// Task 2.1.5: a LIVE completed agent gets a per-unit checkpoint, queued
					// onto the serialized per-run chain (commit-and-continue). Cached and
					// degraded ends (no sessionID) never reach here, so no empty commits.
					enqueueCheckpoint({
						label: e.label,
						sessionID: e.sessionID,
						...(meta?.phase !== undefined ? { phase: meta.phase } : {}),
					});
					stats.unregister(e.sessionID);
					statsBindings.delete(e.sessionID);
					launchMeta.delete(e.sessionID);
					// The worker has settled (ok/error/cancelled all flow through this
					// sessionID-bearing end), so it is no longer a live worker.
					workerSessions.delete(e.sessionID);
				} else if (e.type === "agent:end") {
					// A CACHED agent ended (no sessionID): the stamped end rides through
					// untouched, and a stats-free summary carrying only label/phase/status
					// rolls up (the phase recovered from the matching pending start).
					const phase = claimStartPhase(e.label);
					rollupAgent({
						label: e.label,
						...(phase !== undefined ? { phase } : {}),
						status: e.status,
						...(e.note !== undefined ? { note: e.note } : {}),
					});
				}
				handle.progress.push(out);
				// Mirror onto the live feed (Task 8.1.2): one source of truth for the
				// status tool (handle.progress) and the TUI viewer (the feed file).
				feed.append(out);
				logger?.debug("workflow progress", { runId, event: e });
			},
			// Task 7.2.1: collect typed diagnostics for null/empty agent calls.
			onDiagnostic: (d) => {
				diagnostics.push(d);
				logger?.debug("workflow diagnostic", { runId, diagnostic: d });
			},
			replay: {
				entries: resolved.entries,
				onRecord: (e) => {
					if (journal !== undefined) {
						journalWrites.push(journal.record(e));
					}
				},
				// Phase 3: write-ahead the intent onto the SAME journalWrites drain so it
				// is durable by settle, AND return its promise so agent-call awaits it
				// before launch (a crash in the launch window then leaves a visible
				// intent with no matching ok). The append is awaited twice — inline
				// before launch and again at the settle drain — both resolve the same
				// fenced promise, which is harmless.
				onIntent: (e) => {
					if (journal !== undefined) {
						const w = journal.record(e);
						journalWrites.push(w);
						return w;
					}
					return Promise.resolve();
				},
			},
		});
		handle.run = run;

		/** Await all pending journal appends (fenced — a failed append must not throw). */
		const drainJournal = (): Promise<void> =>
			Promise.allSettled(journalWrites).then(() => undefined);

		/** Await the per-run checkpoint chain (Task 2.1.5), fenced — never rejects. */
		const drainCheckpoints = (): Promise<void> =>
			checkpointTail.then(
				() => undefined,
				() => undefined,
			);

		// Capture this run's OWN operator-safety baseline (Task 2.1.3) BEFORE firing the
		// detached run, so the pre-existing-dirty snapshot predates any agent edit and
		// stays scoped to THIS run (no cross-run clobber). Fenced (a dead/no-shell
		// checkpointer is a no-op); awaited so the snapshot is durable before the first
		// agent can launch.
		await runCheckpointer.baseline();

		// Fire DETACHED — never await the run. On settle, DRAIN the journal AND the
		// feed, then update the record. The settle promise is exposed on the handle so
		// workflow_status's wait_ms blocks until both are durable (resume-safe; the
		// viewer sees the run:end line).
		//
		// The feed's `run:end` is ALWAYS appended here, never in stopRun. The run()
		// promise resolves only once the workflow body's every `await agent()` has
		// unblocked — and on cancel, abort() flips the in-flight children terminal,
		// which is exactly what unblocks those awaits and flushes their `agent:end`
		// through onProgress FIRST. So writing `run:end` here keeps it the terminal
		// feed line on EVERY path (success, error, cancel): the framing invariant a
		// TUI viewer relies on. A cancel pre-flips the record to `cancelled`; the feed
		// then carries that terminal status, and the record is re-persisted so the
		// last in-flight agent's rollup (mutated after stopRun's settle) is durable.
		handle.settled = run
			.run(resolved.source)
			.then(async (result) => {
				await drainJournal();
				return result;
			})
			.then(async (result) => {
				// A stopRun() may have already flipped the record to cancelled. Do not
				// clobber it with the run's own (also-terminal) result — but still finalize
				// the feed and re-persist the record below, since the in-flight agents'
				// ends arrived (and rolled up) only after stopRun ran.
				if (handle.record.status === "running") {
					settleRecord(handle, {
						status: result.status,
						returnValue: result.returnValue,
						error: result.error,
						agentCount: result.agentCount,
						// Snapshot the budget spend at settle for status display (Task 4.3.1).
						...(budget !== undefined ? { budgetSpent: budget.spent() } : {}),
						// Persist diagnostics for any degraded calls (Task 7.2.1); omit the
						// field entirely on a clean run.
						...(diagnostics.length > 0 ? { diagnostics } : {}),
					});
				} else {
					// Cancelled by stopRun: re-persist so the final in-flight rollup lands on
					// disk (stopRun's settle ran before those ends arrived).
					persistRecord(handle.record);
				}
				// Drain the checkpoint chain (Task 2.1.5) BEFORE run:end so the terminal
				// feed line follows the last `agent:checkpoint` line — the framing
				// invariant a viewer relies on. On cancel, the aborted agents' ends have
				// already enqueued their checkpoints, so this drains those too.
				await drainCheckpoints();
				await finalizeFeed(handle, {
					...(result.agentCount !== undefined
						? { agentCount: result.agentCount }
						: {}),
					...(budget !== undefined ? { budgetSpent: budget.spent() } : {}),
				});
			})
			.catch(async (err: unknown) => {
				// createWorkflowRun.run() never rejects, but fence defensively.
				if (handle.record.status === "running") {
					settleRecord(handle, {
						status: "error",
						error: err instanceof Error ? err.message : String(err),
						// Carry any diagnostics collected before the throw (Task 7.2.1).
						...(diagnostics.length > 0 ? { diagnostics } : {}),
					});
				} else {
					persistRecord(handle.record);
				}
				// Drain the checkpoint chain before run:end on the error path too.
				await drainCheckpoints();
				await finalizeFeed(handle, {});
			});

		return { runId, scriptPath, name };
	}

	/**
	 * Write the feed's terminal `run:end` line, drain the writer, and drop it from
	 * the per-run map (Task 8.1.2). Always driven from the run's own settle branch,
	 * which resolves only after every in-flight `agent:end` has flushed — so `run:end`
	 * is the terminal feed line on success, error, AND cancel. The line carries the
	 * record's terminal status (a stopRun pre-flips it to `cancelled`). Idempotent by
	 * map presence; fenced — `settled()` never rejects, so a flush failure can't fail
	 * a run.
	 */
	async function finalizeFeed(
		handle: RunHandle,
		end: { agentCount?: number; budgetSpent?: number },
	): Promise<void> {
		const runId = handle.record.id;
		const feed = feeds.get(runId);
		if (feed === undefined) {
			return;
		}
		feeds.delete(runId);
		feed.append({
			type: "run:end",
			status: handle.record.status,
			...end,
			at: clock.now(),
		});
		await feed.settled();
	}

	function stopRun(runId: string): void {
		const handle = runs.get(runId);
		if (handle?.record.status !== "running") {
			return;
		}
		// Abort flips the in-flight children terminal (fire-and-forget) and flips the
		// record to cancelled. The feed's `run:end` is NOT written here: the detached
		// settle branch above writes it after the aborted children's `agent:end`
		// events drain, so `run:end` stays the terminal feed line on cancel too.
		handle.run?.abort();
		settleRecord(handle, { status: "cancelled" });
	}

	/**
	 * Fold one SDK event into per-agent stats (Task 8.1.3), maybe-emit a throttled
	 * `agent:stats` feed line, THEN forward to the runner's completion gate. The
	 * stats fold is fenced — a telemetry hiccup never blocks the gate forward, the
	 * sole load-bearing path. `agent:stats` is feed-only; it is NOT pushed to
	 * `handle.progress` (the status tool reads collector snapshots directly).
	 */
	async function handleEvent(
		event: Parameters<SessionRunner["handleEvent"]>[0],
	): Promise<void> {
		try {
			const sessionID = stats.handleEvent(event);
			if (sessionID !== undefined) {
				const binding = statsBindings.get(sessionID);
				const now = clock.now();
				if (
					binding !== undefined &&
					now - binding.lastEmittedAt >= STATS_THROTTLE_MS
				) {
					const snap = stats.snapshot(sessionID);
					const feed = feeds.get(binding.runId);
					if (snap !== undefined && feed !== undefined) {
						binding.lastEmittedAt = now;
						feed.append({
							type: "agent:stats",
							label: binding.label,
							sessionID,
							tokens: snap.tokens,
							toolCalls: snap.toolCalls,
							lastTools: snap.lastTools,
							at: now,
						});
					}
				}
			}
		} catch (err) {
			logger?.error("session stats fold failed", {
				err: err instanceof Error ? err.message : String(err),
			});
		}
		await runner.handleEvent(event);
	}

	function statusOf(runId: string): RunHandle | undefined {
		return runs.get(runId);
	}

	function statsSnapshot(sessionID: string): SessionStatsSnapshot | undefined {
		return stats.snapshot(sessionID);
	}

	function isWorkerSession(sessionID: string): boolean {
		return workerSessions.has(sessionID);
	}

	function liveRunsFor(parentSessionID: string): RunHandle[] {
		// O(this parent's live runs): the index holds only running runs (joined at
		// handle creation, dropped at settleRecord), so the digest hot path never scans
		// settled runs. The status === "running" recheck stays as a belt-and-braces guard.
		const ids = liveRunsByParent.get(parentSessionID);
		if (ids === undefined) {
			return [];
		}
		const out: RunHandle[] = [];
		for (const runId of ids) {
			const handle = runs.get(runId);
			if (handle !== undefined && handle.record.status === "running") {
				out.push(handle);
			}
		}
		return out;
	}

	// Startup recovery: load persisted records, flip stale `running` → error, seed
	// the queue from terminal records. Runs as a promise `ready()` awaits.
	const readyPromise = (async () => {
		// Probe the git work tree ONCE (Task 2.1.6): a non-repo warns exactly here
		// (one warn for the engine's whole lifetime), and the verdict is cached so each
		// per-run checkpointer adopts it without re-probing or re-warning — per-run
		// baseline/checkpoint stay silent no-ops on a non-repo. No-op when no shell.
		checkpointerAlive = await probeCheckpointer.ready();
		// Crash-safety sweep (Task H.1.5): prune orphan `wf/*` worktrees + branches a
		// PRIOR run left behind on a crash (the agent `finally` cleans its own worktree
		// on a clean exit, but a killed process leaks them). The manager's sweep is
		// itself fenced (non-repo/no-shell → no-op; every git command nothrow + exitCode-
		// inspected), but we wrap the call too so a thrown sweep can NEVER block engine
		// startup — best-effort, never gating a run. A preserved CONFLICT worktree of a
		// LIVE run is not a concern here: ready() runs once at engine construction,
		// before any run mints a worktree.
		try {
			await worktreeManager.sweep();
		} catch (err) {
			logger?.warn("worktree sweep failed at engine ready (non-blocking)", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
		const recovered = await runStore.load();
		const seed: RunRecord[] = [];
		for (const record of recovered) {
			if (record.status === "running") {
				record.status = "error";
				// Epic 1.4: warn that the working tree may carry agent edits the journal
				// does not record (per-agent data is persisted only at settle, never in
				// onProgress, so `record.agents` is empty on a real crash — any count
				// would be a lie). Surfacing the real pre-crash per-agent shape is Phase 3
				// (feed-rehydration), not here; this just points the operator at disk.
				record.error =
					"interrupted by restart — agents may have mutated the working tree " +
					"before the interrupt; inspect `git status` before resume or relaunch";
				record.completedAt = clock.now();
				// Phase 3.2.2: a real crash persists no per-agent data (rolled up only at
				// settle), so re-read the run's feed to recover the per-agent table the
				// operator needs. readFeedCounts is FENCED (never throws) — a missing/empty
				// feed degrades to today's 0/0, never poisoning startup for other runs.
				// We rehydrate the SAME fields the status render already reads
				// (record.agents / record.agentCount), so the recovered run renders its real
				// table with no change to workflow-status.ts. The 'interrupted by restart'
				// error string is left untouched (no count folded into the message).
				const counts = await readFeedCounts(
					join(feedDir, `${record.id}.jsonl`),
					feedReadFs,
				);
				if (counts.agentCount > 0) {
					record.agentCount = counts.agentCount;
				}
				if (counts.agents.length > 0) {
					record.agents = counts.agents;
				}
				persistRecord(record);
			}
			runs.set(record.id, { record, progress: [] });
			seed.push(record);
		}
		// seed() re-queues terminal && !notified records silently (no toast storm).
		queue.seed(seed as unknown as Parameters<NotificationQueue["seed"]>[0]);
		logger?.info("workflow engine recovered", { recovered: recovered.length });
	})();

	return {
		runs,
		runStore,
		queue,
		registry,
		ready: () => readyPromise,
		startRun: async (args) => {
			await readyPromise;
			return startRun(args);
		},
		stopRun,
		statusOf,
		statsSnapshot,
		isWorkerSession,
		liveRunsFor,
		handleEvent,
		dispose: async () => {
			// Stop the control poll loop before draining stores so no late tick races
			// a disposed engine.
			control.stop();
			await readyPromise;
			await runner.dispose();
			await taskStore.dispose();
			await runStore.dispose();
		},
	};
}
