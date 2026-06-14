/**
 * Engine factory for the workflows plugin (pi port).
 *
 * `createWorkflowEngine` assembles the collaborators a workflow host needs into
 * one wired unit, the pi-native analogue of the opencode engine:
 *   - a core {@link SessionRunner} over the pi RPC seam ({@link RpcClientFactory} +
 *     {@link SessionTranscriptReader} + `sessionDir`) — NOT an SDK client. The
 *     per-run workflow gate inside {@link createWorkflowRun} is the authoritative
 *     limiter (elaboration deviation e), so the runner is built with an UNLIMITED
 *     {@link ConcurrencyManager} (`defaultConcurrency: 0` → unlimited);
 *   - a {@link createTaskStore} for the runner's child tasks at
 *     `<dataDir>/workflow-tasks`;
 *   - a SECOND {@link createTaskStore} for {@link RunRecord}s at
 *     `<dataDir>/workflow-runs`, typed at RunRecord with an honest load-time
 *     validator (the core store is generic);
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
 * pi-native deltas from opencode:
 *   - NO SDK event pump. pi has no shared event bus and the runner self-reports
 *     completion through its fuser, so the opencode `handleEvent` method and the
 *     `event`-hook pump that drove it are DELETED. The internal lifecycle events
 *     (`agent:launched` / `agent:end`) emitted by agent-call AROUND its own
 *     `runner.awaitCompletion` still flow through `onProgress` exactly as before —
 *     that is the choke point the feed/journal/checkpoint/stats orchestration
 *     hangs off.
 *   - per-agent token + tool stats are DERIVED at `agent:end` from the child's
 *     settled transcript (`transcriptReader`), not from a live token stream. There
 *     are no live mid-flight stats for an in-flight agent (`statsSnapshot` →
 *     `undefined`); final stats live on the enriched `agent:end` / the record.
 *   - the budget reads the SAME transcript for its output-token accounting.
 *   - agent NAMES resolve to pi child knobs via `resolveAgentKnobs` (pi has no
 *     `--agent` flag); the engine supplies it from the bg-agents agent resolver.
 *   - structured output is read back from the child's transcript via
 *     `readStructured` (the child is a subprocess, not a shared in-process tool).
 *
 * Startup recovery: records left `running` by a dead process flip to
 * `error("interrupted by restart")` (children are NOT relaunched); terminal
 * records seed the notification queue and stay readable via `statusOf`.
 *
 * Node-safe: no Bun.* APIs.
 */

import {
	mkdir as nodeMkdir,
	readdir as nodeReaddir,
	readFile as nodeReadFile,
	rm as nodeRm,
	writeFile as nodeWriteFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	type Clock,
	ConcurrencyManager,
	createIdGenerator,
	createNotificationQueue,
	createSessionRunner,
	createTaskStore,
	type IdGenerator,
	type NotificationQueue,
	nodeFsFacade,
	type PiAgentMessage,
	type RpcClientFactory,
	resolveDataBaseDir,
	type SessionTranscriptReader,
	type TaskNotice,
} from "@drawers/pi-core";
import type { ReadStructured, ResolveAgentKnobs } from "../runtime/agent-call";
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
	WorktreeManagerSeam,
} from "../runtime/types";
import { createTokenBudget, type TokenBudget } from "./budget";
import { BUILTIN_WORKFLOWS } from "./builtins";
import { classifyPath, type SourceDiagnostic } from "./classify-path";
import { type ControlWatcher, createControlWatcher } from "./control";
import {
	createFeedWriter,
	type EnrichedProgressEvent,
	type FeedWriter,
	readFeedCounts,
} from "./feed";
import {
	type BunShell,
	type Checkpointer,
	createGitCheckpointer,
	parsePorcelain,
} from "./git-checkpoint";
import { createWorktreeManager, type WorktreeManager } from "./git-worktree";
import { createJournal, type Journal } from "./journal";
import { createSourceResolver } from "./resolve-source";
import { renderRunDigest } from "./run-digest";
import {
	deriveSessionStats,
	type SessionStatsSnapshot,
	type SessionTokenSnapshot,
} from "./session-stats";
import { resolveSkillParts } from "./skill-resolver";
import { type RunLookup, saveRunAsWorkflow } from "./tools/workflow-save";

/** Structured logger surface — `ctx.ui`-backed in the plugin entry. */
export interface EngineLogger {
	debug(msg: string, meta?: Record<string, unknown>): void;
	info(msg: string, meta?: Record<string, unknown>): void;
	warn(msg: string, meta?: Record<string, unknown>): void;
	error(msg: string, meta?: Record<string, unknown>): void;
}

/** Terminal-or-live status of a workflow run. */
export type RunStatus = "running" | "completed" | "error" | "cancelled";

/**
 * The per-agent rollup persisted on a {@link RunRecord}. One entry per `agent:end`
 * the engine sees, accumulated at the choke point so a finished run reconstructs
 * the per-agent table (`model · tokens · tools · duration`) from the record ALONE —
 * no feed re-parsing. Cached entries (no session) carry only `label`/`phase`/
 * `status`; launched-and-ended entries carry the full stats.
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
	/** The derived final token snapshot — absent on cached entries. */
	tokens?: SessionTokenSnapshot;
	/** Terminal tool-call count — absent on cached entries. */
	toolCalls?: number;
	/** `agent:end.at − agent:launched.at` — absent on cached entries. */
	durationMs?: number;
	/** The degrade note (Task 7.2.1), when the call collapsed to null/empty. */
	note?: string;
	/**
	 * The conclusion preview the agent passed forward — its structured result (as
	 * compact JSON) or final text, from `agent:end.result`. Absent on a degraded call
	 * (which carries {@link note} instead). The settle-time per-agent digest renders
	 * it so the parent reads what each agent concluded without pulling the feed.
	 */
	result?: string;
}

/**
 * The engine-computed git truth for ONE committed checkpoint (Epic 2.1). One
 * entry per `agent:checkpoint` the engine emits, accumulated on the
 * {@link RunRecord} at the settle choke point so a finished run reports which
 * files actually changed (the de-duplicated union of every `paths`) and which
 * commits a run created — independent of whatever the synthesis agent claimed in
 * `returnValue`. `sha` is absent when the rev-parse read-back failed (the commit
 * still landed; `paths` are still real). `modeFlips` (Epic 2.3) tags committed
 * paths whose file mode flipped between two live modes (a chmod).
 */
export interface CheckpointRecord {
	/** The checkpoint commit sha; absent when the rev-parse read-back failed. */
	sha?: string;
	/** The exact pathspecs committed (workflow-touched, baseline-excluded). */
	paths: string[];
	/** The committing agent's display label. */
	label: string;
	/** The active progress phase, when one was known. */
	phase?: string;
	/** Mode flips (Epic 2.3): path → `"<oldmode>→<newmode>"`; absent on none. */
	modeFlips?: Record<string, string>;
	/**
	 * The checkpoint committed while OTHER unisolated agents were still live
	 * (parallel() on one shared tree). Attribution is then HONESTLY APPROXIMATE:
	 * the commit may carry a still-running sibling's half-written files under this
	 * entry's `label` — the checkpointer cannot tell whose bytes are whose without
	 * isolation. Absent (the common case) when no sibling was in flight.
	 */
	shared?: boolean;
}

/**
 * The launch metadata the choke point holds per live session, captured from
 * `agent:launched` and consumed at the matching `agent:end` to compute the
 * duration and stamp model/agentType. Dropped at the agent's end.
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
 * The persisted record of one workflow run. Stored through a RunRecord-typed
 * {@link createTaskStore} with {@link isValidRunRecord} as its load-time
 * validator; the optional payload fields ride along verbatim (the store
 * serializes the whole object).
 */
export interface RunRecord {
	id: string;
	parentSessionID: string;
	status: RunStatus;
	description: string;
	createdAt: number;
	completedAt?: number;
	/**
	 * Notification-queue flush state (parity with `BgTask.notified`): set by the
	 * queue's `markNotified` once a terminal notice is drained, so a restart does
	 * not re-queue an already-delivered notice. Declared (not cast in) so the
	 * record honestly satisfies core's `NoticeRecord`.
	 */
	notified?: boolean;
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
	 * settle site (success, error, cancel) so the record alone reconstructs the
	 * per-agent table post-hoc. Absent when the run launched no agents.
	 */
	agents?: AgentSummary[];
	/**
	 * Engine-computed checkpoint git truth (Epic 2.1/2.2): one {@link CheckpointRecord}
	 * per committed checkpoint, accumulated at the choke point and persisted at every
	 * settle site. The de-duplicated union of every entry's `paths` is the
	 * engine-computed `filesChanged` surface; the array itself is the per-commit
	 * ledger (`sha`/`paths`/`label`/`phase`). Absent on a run with no committed
	 * checkpoints. Source of truth, not agent self-report.
	 */
	checkpoints?: CheckpointRecord[];
	/**
	 * Run-scoped source-path classification (Issue 6): the engine classifies the run's
	 * EXPLICITLY declared `spec_path` and records only the operator-relevant verdicts
	 * (`ignored`/`missing`) so an ignored ghost (e.g. a `docs/plans/…md` matched by
	 * `.gitignore`) is surfaced rather than silently trusted. Absent when no
	 * `spec_path` was declared, or it classified `tracked`/`untracked`.
	 */
	sourceDiagnostics?: SourceDiagnostic[];
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
	 * caller can block on completion in-process. Absent for recovered records.
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
	/**
	 * The run's declared source-of-truth file (Issue 6), repo-relative or absolute.
	 * EXPLICIT — replaces the prior heuristic `.md` arg-scan. When provided, the
	 * engine classifies it (tracked/untracked/ignored/missing) and (a) attaches the
	 * operator-relevant verdict to {@link RunRecord.sourceDiagnostics}, and (b) when
	 * untracked/ignored, registers it with the worktree manager so isolated agents
	 * get it copied into their fresh checkout. Absent → no classification, no copy.
	 */
	specPath?: string;
}

/** What `startRun` returns synchronously (before the run settles). */
export interface StartRunResult {
	runId: string;
	scriptPath: string;
	name: string;
}

export interface CreateWorkflowEngineOptions {
	/** The pi RPC seam — spawns one `pi --mode rpc` child per task. */
	rpcFactory: RpcClientFactory;
	/** Reads a terminal/torn-down task's transcript from disk. */
	transcriptReader: SessionTranscriptReader;
	/** The engine-wide session storage dir passed to every child (`--session-dir`). */
	sessionDir?: string;
	/** Project directory; saved-workflow lookup (`.pi/workflows`) roots here. */
	directory: string;
	/**
	 * Persistence BASE dir. Resolution ({@link resolveDataBaseDir}): explicit
	 * `dataDir` → `$PI_DRAWERS_DATA_DIR` → XDG default. The plugin's `workflow-*`
	 * subdirs hang off it; ALWAYS resolves to a real path.
	 */
	dataDir?: string;
	/** Toast callback for terminal notices. */
	onNotify?: (notice: TaskNotice) => void;
	logger?: EngineLogger;
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
	 * Resolve a pi agent NAME → pi-native child knobs (system prompt / tools /
	 * model). pi has NO `--agent` flag; the plugin entry supplies the bg-agents
	 * agent resolver bound to the project cwd. ABSENT → every child runs pi's
	 * default coding assistant (the standalone behavior).
	 */
	resolveAgentKnobs?: ResolveAgentKnobs;
	/**
	 * The host BunShell (Epic 2.1), a Node-`child_process`-backed adapter the plugin
	 * entry builds (pi has no Bun `$`). It carries `.cwd(directory)`/`.nothrow()`. NOT
	 * routed through the RPC seam — `$` is a host primitive, sibling to `rpcFactory`.
	 * When ABSENT the per-agent git-checkpoint/worktree subsystem is not constructed
	 * and the feature no-ops (every existing test construction passes no shell, so
	 * this widening breaks nothing).
	 */
	shell?: BunShell;
}

export interface WorkflowEngine {
	/** Live + recovered run handles, keyed by runId. */
	runs: Map<string, RunHandle>;
	/** The run-record persistence store. */
	runStore: RunStore;
	/** The per-parent terminal-notice queue, typed at the record it carries. */
	queue: NotificationQueue<RunRecord>;
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
	 * Live per-session stats for a tracked CHILD session. pi has no live per-token
	 * stream to the parent (only `agent_start` / `agent_end`), so stats are derived
	 * ONCE at `agent:end` from the settled transcript — there are NO numbers for an
	 * IN-FLIGHT agent. This therefore ALWAYS returns `undefined`; a settled agent's
	 * final stats live on `RunRecord.agents` / the enriched end. Kept on the
	 * interface so `workflow_status` reads through one seam regardless of harness.
	 */
	statsSnapshot(sessionID: string): SessionStatsSnapshot | undefined;
	/**
	 * Whether `sessionID` is a LIVE workflow worker — a child session spawned by a
	 * workflow agent that has emitted `agent:launched` but not yet `agent:end`
	 * (Epic 0.1). Pure membership, no I/O; the parent and unrelated sessions are
	 * always false. NOTE (pi): the git-deny hook fires INSIDE each worker child (its
	 * own pi process loads this extension), so the deny path no longer needs this to
	 * discriminate a worker's Bash from the parent's — it is retained for the status
	 * tool's worker-liveness read.
	 */
	isWorkerSession(sessionID: string): boolean;
	/**
	 * Live (status `running`) run handles owned by a parent session (Task 6.2.4).
	 * The before_agent_start digest reads this to prepend a one-line digest per live
	 * run. Recovered runs are never `running` (startup recovery flips them to error),
	 * so they are excluded by construction.
	 */
	liveRunsFor(parentSessionID: string): RunHandle[];
	/** Drain every store + the runner. Call before process exit. */
	dispose(): Promise<void>;
}

/**
 * The run-record store: a core {@link createTaskStore} typed at {@link RunRecord}
 * with an honest run-record validator.
 */
interface RunStore {
	save(record: RunRecord): Promise<void>;
	load(): Promise<RunRecord[]>;
	dispose(): Promise<void>;
}

/**
 * Load-time validation for a persisted {@link RunRecord}: every REQUIRED field
 * of the interface, plus type checks on the optionals the engine's recovery and
 * notification paths read (`completedAt`, `notified`). The remaining optional
 * payload fields (returnValue/agents/checkpoints/…) ride along verbatim — they
 * are display data, never control flow, so they are not gated here.
 */
function isValidRunRecord(value: unknown): value is RunRecord {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const v = value as Record<string, unknown>;
	if (typeof v.id !== "string" || v.id.length === 0) {
		return false;
	}
	if (typeof v.parentSessionID !== "string") {
		return false;
	}
	if (
		v.status !== "running" &&
		v.status !== "completed" &&
		v.status !== "error" &&
		v.status !== "cancelled"
	) {
		return false;
	}
	if (typeof v.description !== "string") {
		return false;
	}
	if (typeof v.createdAt !== "number" || !Number.isFinite(v.createdAt)) {
		return false;
	}
	if (typeof v.scriptPath !== "string") {
		return false;
	}
	if (v.completedAt !== undefined && typeof v.completedAt !== "number") {
		return false;
	}
	if (v.notified !== undefined && typeof v.notified !== "boolean") {
		return false;
	}
	return true;
}

const RUN_PREFIX = "wf_";
const SUBDIR_TASKS = "workflow-tasks";
const SUBDIR_RUNS = "workflow-runs";
const SUBDIR_SCRIPTS = "workflow-scripts";
const SUBDIR_JOURNALS = "workflow-journals";
const SUBDIR_FEED = "workflow-feed";
// External control-channel sentinel dir (Task 8.2.1). Declared beside its sibling
// subdirs so the on-disk layout stays in one place; the control watcher resolves
// it via `subdir()` and polls it for `<runId>.cancel` sentinels.
const SUBDIR_CONTROL = "workflow-control";

const defaultClock: Clock = { now: () => Date.now() };

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

/** Build the RunRecord-typed core store (honest validator, no casts). */
function createRunStore(opts: {
	baseDir?: string;
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
	return createTaskStore<RunRecord>({
		baseDir: opts.baseDir,
		clock: opts.clock,
		logger: storeLogger,
		validate: isValidRunRecord,
	});
}

/** A node:fs/promises {@link ControlFs} for the control watcher (FsFacade has no `rm`). */
const controlFs = {
	readdir: (path: string) => nodeReaddir(path),
	rm: (path: string, opts: { force: true }) => nodeRm(path, opts),
	readFile: (path: string, enc: "utf-8") => nodeReadFile(path, enc),
};

export function createWorkflowEngine(
	opts: CreateWorkflowEngineOptions,
): WorkflowEngine {
	const clock = opts.clock ?? defaultClock;
	const logger = opts.logger;
	const transcriptReader = opts.transcriptReader;
	const sessionDir = opts.sessionDir;
	/**
	 * Fenced on-disk probe (Epic 2.4): `"file" | "dir" | "missing"`. Uses
	 * `node:fs/promises` stat directly (the engine no longer threads an injectable
	 * fs facade for this — script/journal/feed all default to node fs in pi).
	 */
	const probePath = async (
		absPath: string,
	): Promise<"file" | "dir" | "missing"> => {
		try {
			const { stat } = await import("node:fs/promises");
			const st = await stat(absPath);
			return st.isDirectory() ? "dir" : "file";
		} catch {
			return "missing";
		}
	};
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
		fs: nodeFsFacadeForSource(),
		builtins: BUILTIN_WORKFLOWS,
	});

	/** The journal file path for a runId (under the journals subdir). */
	const journalPath = (id: string) => join(journalsDir, `${id}.jsonl`);

	const storeLogger = logger
		? {
				debug: (msg: string, meta?: Record<string, unknown>) =>
					logger.debug(msg, meta),
				error: (msg: string, meta?: Record<string, unknown>) =>
					logger.error(msg, meta),
			}
		: undefined;
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

	// (1) The child-task store + the unlimited runner (deviation e: the workflow
	// gate inside each run is authoritative, so the runner must NOT cap). pi-core's
	// ConcurrencyManager treats defaultConcurrency 0 as unlimited.
	const taskStore = createTaskStore({
		baseDir: subdir(SUBDIR_TASKS),
		clock,
		logger: storeLogger,
	});
	const runner = createSessionRunner({
		rpcFactory: opts.rpcFactory,
		transcriptReader,
		...(sessionDir !== undefined ? { sessionDir } : {}),
		concurrency: new ConcurrencyManager({ defaultConcurrency: 0 }),
		ids: createIdGenerator(),
		clock,
		persist: (task) => taskStore.save(task),
		logger: storeLogger,
	});

	// Engine-owned per-agent git checkpointer (Epic 2.1). Constructed from the host
	// `$` bound to the project root; ABSENT shell → a documented no-op. The work-tree
	// is probed ONCE here (in readyPromise) and the verdict cached in
	// `checkpointerAlive`; each run then gets its OWN per-run checkpointer seeded with
	// that verdict so it neither re-probes nor re-warns. The engine is the privileged
	// VCS actor — NOT a worker session — so the deny hook never fires on its commits.
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
	// host `$` bound to the project root, then threaded through every run's
	// WorkflowRunDeps → AgentPrimitiveDeps so the isolation mint-point calls it at the
	// `isolation:'worktree'` seam. An ABSENT shell → a documented no-op.
	const worktreeManager: WorktreeManager = createWorktreeManager({
		shell: opts.shell,
		directory: opts.directory,
		...(logger !== undefined ? { logger } : {}),
	});

	// (2) The run-record store + ONE shared registry.
	const runStore = createRunStore({
		baseDir: subdir(SUBDIR_RUNS),
		clock,
		logger,
	});
	const registry = createSchemaRegistry();

	// (3) In-memory run handles, keyed by runId.
	const runs = new Map<string, RunHandle>();

	// Index of LIVE (status === "running") runs by their parentSessionID, so the
	// latency-sensitive before_agent_start digest path (engine.liveRunsFor) costs
	// O(this parent's live runs) instead of O(every run ever started in the session).
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

	// Live worker-session set (Epic 0.1): a child session's id between its
	// `agent:launched` and `agent:end`. Retained for the status tool's worker-
	// liveness read (the pi git-deny hook fires in-child, so it no longer needs this
	// to discriminate). Lives and dies on the same launched/end lifecycle as
	// `launchMeta`, so it never leaks; a crashed session that never emits `agent:end`
	// leaves a harmless stale entry, bounded by process lifetime.
	const workerSessions = new Set<string>();

	// External control channel (Task 8.2.2): a poll loop over `workflow-control/`
	// for `<runId>.cancel` sentinels. `stopRun` is the single cancel authority and
	// is safe to call unconditionally; the `run:cancel-requested` feed line is
	// appended ONLY for a live run, BEFORE stopRun, so a viewer tailing the feed sees
	// the cancelling state ahead of the terminal `run:end`. Armed below once the maps
	// exist; stopped first thing in dispose().
	const control: ControlWatcher = createControlWatcher({
		dir: controlDir,
		fs: controlFs,
		intervalMs: opts.controlPollMs ?? 1000,
		...(opts.setIntervalFn !== undefined
			? { setIntervalFn: opts.setIntervalFn }
			: {}),
		...(opts.clearIntervalFn !== undefined
			? { clearIntervalFn: opts.clearIntervalFn }
			: {}),
		...(logger !== undefined ? { logger } : {}),
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
		// validated path as the `workflow_save_run` tool.
		onSave: async (runId, name) => {
			const lookup: RunLookup = {
				statusOf: (id: string) => runs.get(id),
				runs,
			};
			const result = await saveRunAsWorkflow(
				{
					engine: lookup,
					fs: nodeFsFacadeForSource(),
					directory: opts.directory,
				},
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

	// (4) The terminal-notice queue, typed at RunRecord. markNotified flips +
	// re-persists the record.
	const queue = createNotificationQueue<RunRecord>({
		...(opts.onNotify !== undefined ? { onNotify: opts.onNotify } : {}),
		markNotified: async (runId) => {
			const handle = runs.get(runId);
			if (handle) {
				handle.record.notified = true;
				await runStore.save(handle.record);
			}
		},
		logger: storeLogger,
		// The synthetic notice part carries a per-agent digest, not a bare pointer —
		// the record IS the settled RunRecord, whose `agents[]` is fully rolled up by
		// push time. The digest appends the workflow_status pointer.
		renderHint: (record) => renderRunDigest(record),
	});

	function liveRunIds(): ReadonlySet<string> {
		return new Set(runs.keys());
	}

	/** Push a settled record's terminal notice (the queue is RunRecord-typed). */
	function noticePush(record: RunRecord): void {
		queue.push(record);
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
		// Drop any registered spec-copy intent so the manager's map does not grow
		// unbounded across a long-lived engine (no-op when none was registered).
		worktreeManager.unregisterSpec(handle.record.id);
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
		} else {
			try {
				source = await nodeReadFile(prior.record.scriptPath, "utf-8");
			} catch (err) {
				throw new Error(
					`could not read prior script ${prior.record.scriptPath} for resume: ` +
						`${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		// Args: explicit wins; absent → prior record's args.
		const runArgs = "args" in args ? args.args : prior.record.args;

		// Journal: missing file → empty entries (+ warn) so resume still works.
		const priorJournal = createJournal({
			path: journalPath(priorId),
			logger: journalLogger,
		});
		// Phase 3 load-boundary filter (the LOAD-BEARING guard): drop every
		// non-settled (intent) line before the runtime ever sees it. resolveResume
		// loads `entries` ONCE and threads the SAME array into BOTH the agent and
		// sub-workflow replay caches, so this one filter protects every consumer.
		const entries = (await priorJournal.load()).filter(
			(e) => e.status === "ok",
		);
		if (entries.length === 0) {
			logger?.warn("resume found no prior journal — running live", {
				priorId,
				path: journalPath(priorId),
			});
		}

		return { source, runArgs, entries, resumedFrom: priorId };
	}

	/**
	 * Read a completed structured child's echoed value off its transcript — the
	 * `readStructured` seam wired into the runtime (the parent read-back redesign).
	 * The child's `structured_output` tool echoes the raw JSON value as its LAST
	 * tool-result `content` text with `terminate:true`; we locate the last
	 * `toolResult` whose `toolName === "structured_output"` and return its
	 * concatenated text content UNCAPPED (NOT `runner.readOutput({full:true})`, whose
	 * `filterTranscript` caps tool results at 2000 chars and would corrupt a large
	 * payload). FENCED — a read failure resolves `undefined`. Returns `undefined` when
	 * the child never called the tool (→ schema_no_call).
	 */
	const readStructured: ReadStructured = async (taskId, _sessionId) => {
		const task = runner.list().find((t) => t.id === taskId);
		if (task?.sessionID === undefined) {
			return undefined;
		}
		let messages: PiAgentMessage[];
		try {
			messages = await transcriptReader({
				sessionId: task.sessionID,
				...(task.sessionFile !== undefined
					? { sessionFile: task.sessionFile }
					: {}),
				...(sessionDir !== undefined ? { sessionDir } : {}),
			});
		} catch {
			return undefined;
		}
		// Scan from the END for the last structured_output tool result.
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i] as {
				role?: string;
				toolName?: string;
				content?: unknown;
			};
			if (msg.role === "toolResult" && msg.toolName === "structured_output") {
				return extractTextContent(msg.content);
			}
		}
		return undefined;
	};

	async function startRun(args: StartRunArgs): Promise<StartRunResult> {
		const resolved = await resolveResume(args);
		const runId = ids.next(liveRunIds());
		const name = extractName(resolved.source);
		const declaredPhases = extractDeclaredPhases(resolved.source);
		const scriptPath = join(scriptsDir, `${runId}.js`);

		// Persist the script source BEFORE execution (the spec's "persisted script
		// path"). On resume with no explicit source, this re-persists the prior
		// script under the NEW runId so the new run is fully self-describing.
		await nodeMkdir(dirname(scriptPath), { recursive: true });
		await nodeWriteFile(scriptPath, resolved.source, "utf-8");

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
		// Token budget (Task 4.3.1): only when budgetTokens was given (already coerced
		// to a positive finite number by the workflow tool). fetchMessages reads the
		// child's RAW transcript (the runner's narrowed readOutput strips `usage`), so
		// the budget sums the assistant messages' output tokens off the transcript.
		const budget: TokenBudget | undefined =
			args.budgetTokens !== undefined
				? createTokenBudget({
						total: args.budgetTokens,
						fetchMessages: (sid) => fetchSessionMessages(sid),
						...(logger
							? { logger: { warn: (msg, meta) => logger.warn(msg, meta) } }
							: {}),
					})
				: undefined;
		if (budget !== undefined) {
			record.budgetTotal = budget.total ?? undefined;
		}

		// Source-path diagnostic (Issue 6): classify the run's EXPLICITLY declared
		// `spec_path` so an ignored ghost is surfaced rather than silently trusted, AND
		// so an untracked/ignored spec gets copied into worktree-isolated agents. The
		// whole block is fenced — a classification failure NEVER blocks startRun. No
		// `spec_path` → no classification, no diagnostic, no copy.
		let registeredSpecPath: string | undefined;
		if (args.specPath !== undefined) {
			try {
				const rawSpec = args.specPath;
				const root = resolve(opts.directory);
				const absSpec = isAbsolute(rawSpec)
					? resolve(rawSpec)
					: resolve(root, rawSpec);
				if (absSpec !== root && !absSpec.startsWith(root + sep)) {
					logger?.warn(
						"declared spec_path resolves OUTSIDE the project directory — " +
							"ignored (no classification, no worktree copy)",
						{ runId, specPath: rawSpec, resolved: absSpec },
					);
				} else {
					const specPath = relative(root, absSpec);
					const probe = await probePath(absSpec);
					if (probe === "dir" || specPath.length === 0) {
						record.sourceDiagnostics = [
							{ path: specPath || ".", classification: "directory" },
						];
					} else {
						const verdict = await classifyPath(
							opts.shell,
							opts.directory,
							specPath,
							probe === "file",
						);
						if (
							verdict.classification === "ignored" ||
							verdict.classification === "missing"
						) {
							record.sourceDiagnostics = [verdict];
						}
						if (
							verdict.classification === "untracked" ||
							verdict.classification === "ignored"
						) {
							worktreeManager.registerSpec(runId, specPath, (message) => {
								const at = clock.now();
								runs.get(runId)?.progress.push({ type: "warn", message, at });
								feeds.get(runId)?.append({ type: "warn", message, at });
								logger?.warn(message, { runId });
							});
							registeredSpecPath = specPath;
						}
					}
				}
			} catch (err) {
				logger?.warn("source-path classification failed (non-blocking)", {
					runId,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		// `now` is the live clock view for elapsed rendering (Task 6.2.1) — present
		// only while this process owns the run. Recovered handles omit it.
		const handle: RunHandle = {
			record,
			progress: [],
			now: () => clock.now(),
			...(budget !== undefined ? { budget } : {}),
		};
		runs.set(runId, handle);
		indexLiveRun(record.parentSessionID, runId);
		persistRecord(record);

		// The live feed (Task 8.1.2): one writer per run, framed by run:start now and
		// run:end at settle. Every stamped progress event is appended in the onProgress
		// choke below. The writer is fenced — a feed-write failure can never break the run.
		const feed = createFeedWriter({
			dir: feedDir,
			runId,
			...(feedLogger !== undefined ? { logger: feedLogger } : {}),
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
		const journal: Journal = createJournal({
			path: journalPath(runId),
			logger: journalLogger,
		});

		// Track every journal append so the run's settle can DRAIN them before
		// resolving — a fire-and-forget append would otherwise race process teardown.
		const journalWrites: Promise<void>[] = [];

		// Per-run ORDERED progress tail. The runtime emits progress SYNCHRONOUSLY, but a
		// LIVE `agent:end` needs an ASYNC transcript read to derive per-agent token/tool
		// stats (pi has no live per-token stream — see session-stats.ts). To keep both
		// `handle.progress` and the feed file in emit order AND carry the derived stats on
		// the SAME `agent:end` line (the feed is append-only — it cannot be patched after
		// the fact), every event's push+append+rollup runs as a serialized step on this
		// tail; the LIVE-end step awaits its transcript read inline before appending. The
		// settle drains the tail before the final persist so the record carries real
		// per-agent numbers. Fenced — a read/append failure never poisons the tail.
		let progressTail: Promise<void> = Promise.resolve();

		// This run's OWN checkpointer (Epic 2.1). A per-run instance keeps the operator
		// baseline RUN-SCOPED. Seeded with the one probe verdict so it neither re-probes
		// nor re-warns.
		const runCheckpointer = newRunCheckpointer();

		// Per-run serialized checkpoint chain (Task 2.1.5). Each LIVE completed
		// `agent:end` appends a commit onto this tail (fire-and-forget from the
		// synchronous onProgress), so commits NEVER interleave and always apply in
		// agent:end order. The chain is fenced so a checkpoint failure never poisons
		// the tail or the barrier.
		let checkpointTail: Promise<void> = Promise.resolve();
		/** Append a checkpoint for a live completed agent, fenced, in agent:end order. */
		const enqueueCheckpoint = (meta: {
			label: string;
			sessionID: string;
			phase?: string;
		}): void => {
			checkpointTail = checkpointTail.then(async () => {
				try {
					const shared = launchMeta.size > 0;
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
							...(meta.phase !== undefined ? { phase: meta.phase } : {}),
							...(res.modeFlips !== undefined
								? { modeFlips: res.modeFlips }
								: {}),
							...(shared ? { shared: true } : {}),
							at: clock.now(),
						});
						recordCheckpoint({
							...(res.sha !== undefined ? { sha: res.sha } : {}),
							paths: res.paths ?? [],
							label: meta.label,
							...(meta.phase !== undefined ? { phase: meta.phase } : {}),
							...(res.modeFlips !== undefined
								? { modeFlips: res.modeFlips }
								: {}),
							...(shared ? { shared: true } : {}),
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
		// record at settle so a finished run is debuggable.
		const diagnostics: AgentDiagnostic[] = [];

		// Per-run choke-point state (dropped when this closure settles).
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

		/** Append one checkpoint's git truth onto the record (Epic 2.1), lazily creating it. */
		const recordCheckpoint = (cp: CheckpointRecord): void => {
			if (record.checkpoints === undefined) {
				record.checkpoints = [];
			}
			record.checkpoints.push(cp);
		};

		// Ledger truth for ISOLATED agents: after a successful merge-back the main tree
		// is CLEAN, so the per-unit checkpointer commits nothing. This per-run view of
		// the engine-wide manager intercepts mergeBack and records the merge commit
		// (sha + paths) as a CheckpointRecord + `agent:checkpoint` feed line, attributed
		// to the agent label parsed from the scratch branch. Everything else passes
		// through untouched.
		const runWorktreeManager: WorktreeManagerSeam = {
			create: (key) => worktreeManager.create(key),
			isUnchanged: (dir) => worktreeManager.isUnchanged(dir),
			cleanup: (dir, branch) => worktreeManager.cleanup(dir, branch),
			sweep: () => worktreeManager.sweep(),
			mergeBack: async (dir, branch) => {
				const res = await worktreeManager.mergeBack(dir, branch);
				if (
					"merged" in res &&
					(res.sha !== undefined || (res.paths?.length ?? 0) > 0)
				) {
					const prefix = `wf/${runId}/`;
					const label = branch.startsWith(prefix)
						? branch.slice(prefix.length)
						: branch;
					feed.append({
						type: "agent:checkpoint",
						label,
						...(res.sha !== undefined ? { sha: res.sha } : {}),
						paths: res.paths ?? [],
						at: clock.now(),
					});
					recordCheckpoint({
						...(res.sha !== undefined ? { sha: res.sha } : {}),
						paths: res.paths ?? [],
						label,
					});
				}
				return res;
			},
		};

		const run = createWorkflowRun({
			runner,
			parentSessionID: args.parentSessionID,
			runId,
			args: resolved.runArgs,
			registry,
			// Top-level run: its workflow() global can nest one level (spec §8).
			resolveSubWorkflow,
			// pi: resolve a pi agent NAME → child knobs (the agent() → LaunchRequest
			// seam, since pi has no --agent flag). Engine-supplied; inherited by child runs.
			...(opts.resolveAgentKnobs !== undefined
				? { resolveAgentKnobs: opts.resolveAgentKnobs }
				: {}),
			// pi: read a completed structured child's echoed value off its transcript
			// (the parent read-back redesign). Engine-supplied; inherited by child runs.
			readStructured,
			// Epic H.1.6: the engine-owned worktree manager — wrapped per-run.
			worktreeManager: runWorktreeManager,
			// The shell() primitive's seam: run a deterministic command via the repo-
			// bound host shell so a gate like `make test` costs no agent. `.quiet()` is
			// REQUIRED for TTY safety. A script-supplied `cwd` resolves against the
			// project root. No shell threaded (no-shell engine / tests) or a thrown spawn
			// → available:false (an honest unavailable result, NEVER a fabricated pass).
			runShell: async (command, shellOpts) => {
				if (opts.shell === undefined) {
					return { exitCode: -1, stdout: "", stderr: "", available: false };
				}
				const dir =
					shellOpts.cwd === undefined
						? opts.directory
						: isAbsolute(shellOpts.cwd)
							? shellOpts.cwd
							: join(opts.directory, shellOpts.cwd);
				try {
					const res = await opts.shell
						.cwd(dir)
						.nothrow()`${{ raw: command }}`.quiet();
					const stdout =
						res.stdout != null
							? res.stdout.toString()
							: typeof res.text === "function"
								? res.text()
								: "";
					const stderr = res.stderr != null ? res.stderr.toString() : "";
					return { exitCode: res.exitCode, stdout, stderr, available: true };
				} catch (err) {
					logger?.debug("workflow shell() threw; returning available:false", {
						runId,
						command,
						err: err instanceof Error ? err.message : String(err),
					});
					return { exitCode: -1, stdout: "", stderr: "", available: false };
				}
			},
			...(budget !== undefined ? { budget } : {}),
			// Pre-launch checkpoint barrier (Task 2.1.5): the runtime awaits this opaque
			// thunk after gate.acquire and before runner.launch. Fenced both ends.
			awaitCheckpointClear: () =>
				checkpointTail.then(
					() => undefined,
					() => undefined,
				),
			// Epic H.1.3: serialize an isolated agent's merge-back onto the SAME
			// checkpoint tail that orders per-unit commits.
			serializeOnCheckpoint: <T>(task: () => Promise<T>): Promise<T> => {
				const r = checkpointTail.then(() => task());
				checkpointTail = r.then(
					() => undefined,
					() => undefined,
				);
				return r;
			},
			// Epic 4.1: supply the engine-computed real git diff (since run start) for a
			// `contextDiff:true` review from THIS run's OWN checkpointer.
			resolveContextDiff: () => runCheckpointer.diff(),
			// Epic 2.2: resolve an `agent({ skills })` step's canonical names to synthetic
			// contextParts off disk (`.pi/skill` under the project + user roots).
			resolveSkills: (names) =>
				resolveSkillParts(names, {
					directory: opts.directory,
					fs: nodeFsFacadeForSource(),
				}),
			// Epic 4.2: verify a settled agent's git/command post-condition against GIT
			// TRUTH (this run's checkpointer + the host shell).
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
						const verifyDir = v.directory ?? opts.directory;
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
				// `true` or `{}` → git-nonempty-delta mode.
				if (v.directory !== undefined && opts.shell !== undefined) {
					try {
						const res = await opts.shell
							.cwd(v.directory)
							.nothrow()`git -c core.quotePath=false status --porcelain`.quiet();
						if (res.exitCode !== 0) {
							return { passed: false, available: false };
						}
						const agentWork = parsePorcelain(res.text()).filter((p) => {
							const normalized = p.endsWith("/") ? p.slice(0, -1) : p;
							return (
								normalized !== "node_modules" &&
								normalized !== registeredSpecPath
							);
						});
						if (agentWork.length > 0) {
							return { passed: true, available: true };
						}
						const baseRef = worktreeManager.baseOf(v.directory);
						if (baseRef !== undefined) {
							const ahead = await opts.shell
								.cwd(v.directory)
								.nothrow()`git rev-list --count ${baseRef}..HEAD`.quiet();
							if (ahead.exitCode === 0) {
								const n = Number.parseInt(ahead.text().trim(), 10);
								return {
									passed: Number.isFinite(n) && n > 0,
									available: true,
								};
							}
						}
						return { passed: false, available: true };
					} catch {
						return { passed: false, available: false };
					}
				}
				const d = await runCheckpointer.diff();
				return { passed: !d.isEmpty, available: d.available };
			},
			onProgress: (e) => {
				// Stamp at the ENGINE boundary (Task 6.2.1). The whole per-event handling
				// (state bookkeeping → enrich → push → feed.append → rollup) is serialized
				// onto `progressTail` in EMIT order so a LIVE `agent:end`'s async transcript
				// read (the only async step) cannot reorder events or write a stats-free
				// feed line. Synchronous events resolve their tail step immediately, so the
				// ordering cost is negligible. Fenced — a thrown step never poisons the tail.
				const at = clock.now();
				progressTail = progressTail.then(async () => {
					try {
						let out: EnrichedProgressEvent = { ...e, at };
						if (e.type === "agent:start") {
							startQueue.push({
								label: e.label,
								...(e.phase !== undefined ? { phase: e.phase } : {}),
							});
						} else if (e.type === "agent:launched") {
							// Bind the worker session + launch meta at the choke point. Stats
							// are not harvested from a live event stream (pi has none) — they
							// are DERIVED at agent:end from the child's transcript (located by
							// sessionID), so launch only records the meta + launch time.
							workerSessions.add(e.sessionID);
							launchMeta.set(e.sessionID, {
								label: e.label,
								...(e.phase !== undefined ? { phase: e.phase } : {}),
								...(e.model !== undefined ? { model: e.model } : {}),
								...(e.agentType !== undefined
									? { agentType: e.agentType }
									: {}),
								launchedAt: at,
							});
							claimStartPhase(e.label);
						} else if (e.type === "agent:end" && e.sessionID !== undefined) {
							// A LIVE agent ended: derive the final stats from its on-disk
							// transcript (the child stopped, so the transcript is durable) and
							// enrich the stamped end with them + the launch-derived
							// duration/model/agentType BEFORE it is pushed/appended.
							const meta = launchMeta.get(e.sessionID);
							const snap = await deriveStatsForSession(e.sessionID, at);
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
								...(e.result !== undefined ? { result: e.result } : {}),
							});
							// Task 2.1.5: a LIVE completed agent gets a per-unit checkpoint,
							// queued onto the serialized per-run chain (commit-and-continue).
							enqueueCheckpoint({
								label: e.label,
								sessionID: e.sessionID,
								...(meta?.phase !== undefined ? { phase: meta.phase } : {}),
							});
							launchMeta.delete(e.sessionID);
							workerSessions.delete(e.sessionID);
							// Budget is NOT charged here: agent-call already awaits
							// `budget.recordTask(sessionId)` before the call resolves (agent-call.ts
							// step 8b), so the next sequential call's pre-check already sees this
							// child's spend. Charging again here would DOUBLE-COUNT every child.
						} else if (e.type === "agent:end") {
							// A CACHED agent ended (no sessionID): the stamped end rides through
							// untouched, and a stats-free summary carrying only
							// label/phase/status rolls up (phase from the matching start).
							const phase = claimStartPhase(e.label);
							rollupAgent({
								label: e.label,
								...(phase !== undefined ? { phase } : {}),
								status: e.status,
								...(e.note !== undefined ? { note: e.note } : {}),
								...(e.result !== undefined ? { result: e.result } : {}),
							});
						}
						handle.progress.push(out);
						// Mirror onto the live feed (Task 8.1.2): one source of truth for the
						// status tool (handle.progress) and the TUI viewer (the feed file).
						feed.append(out);
						logger?.debug("workflow progress", { runId, event: e });
					} catch (err) {
						logger?.error("workflow progress step failed", {
							runId,
							err: err instanceof Error ? err.message : String(err),
						});
					}
				});
			},
			// Task 7.2.1: collect typed diagnostics for null/empty agent calls.
			onDiagnostic: (d) => {
				diagnostics.push(d);
				logger?.debug("workflow diagnostic", { runId, diagnostic: d });
			},
			replay: {
				entries: resolved.entries,
				onRecord: (e) => {
					journalWrites.push(journal.record(e));
				},
				// Phase 3: write-ahead the intent onto the SAME journalWrites drain so it
				// is durable by settle, AND return its promise so agent-call awaits it
				// before launch.
				onIntent: (e) => {
					const w = journal.record(e);
					journalWrites.push(w);
					return w;
				},
			},
		});
		handle.run = run;

		/**
		 * Await the ordered progress tail (fenced — never rejects). Drained FIRST at
		 * settle so every `agent:end`'s async stats derivation, rollup, and per-unit
		 * checkpoint enqueue have completed before the record is read/persisted and
		 * before the checkpoint chain is drained.
		 */
		const drainProgress = (): Promise<void> =>
			progressTail.then(
				() => undefined,
				() => undefined,
			);

		/** Await all pending journal appends (fenced — a failed append must not throw). */
		const drainJournal = (): Promise<void> =>
			Promise.allSettled(journalWrites).then(() => undefined);

		/** Await the per-run checkpoint chain (Task 2.1.5), fenced — never rejects. */
		const drainCheckpoints = (): Promise<void> =>
			checkpointTail.then(
				() => undefined,
				() => undefined,
			);

		/**
		 * Promote (success) or discard (abandoned) this run's checkpoint commits (Epic
		 * 4.1). Fenced — a ref-op failure must never fail the run or block run:end.
		 */
		const settleCheckpoints = (terminalStatus: string): Promise<void> =>
			(terminalStatus === "completed"
				? runCheckpointer.promote()
				: runCheckpointer.discard()
			).then(
				() => undefined,
				() => undefined,
			);

		// Capture this run's OWN operator-safety baseline (Task 2.1.3) BEFORE firing the
		// detached run. Fenced (a dead/no-shell checkpointer is a no-op); awaited so the
		// snapshot is durable before the first agent can launch.
		await runCheckpointer.baseline();

		// Fire DETACHED — never await the run. On settle, DRAIN the journal AND the
		// feed, then update the record. The settle promise is exposed on the handle so
		// workflow_status's wait_ms blocks until both are durable.
		handle.settled = run
			.run(resolved.source)
			.then(async (result) => {
				// Drain the ordered progress tail FIRST: every agent:end's async stats
				// read, rollup, and checkpoint enqueue must complete before the record is
				// read for settle and before the checkpoint chain drains.
				await drainProgress();
				await drainJournal();
				return result;
			})
			.then(async (result) => {
				if (handle.record.status === "running") {
					settleRecord(handle, {
						status: result.status,
						returnValue: result.returnValue,
						error: result.error,
						agentCount: result.agentCount,
						...(budget !== undefined ? { budgetSpent: budget.spent() } : {}),
						...(diagnostics.length > 0 ? { diagnostics } : {}),
					});
				} else {
					// Cancelled by stopRun: re-persist so the final in-flight rollup lands.
					persistRecord(handle.record);
				}
				await drainCheckpoints();
				persistRecord(handle.record);
				await settleCheckpoints(handle.record.status);
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
						...(diagnostics.length > 0 ? { diagnostics } : {}),
					});
				} else {
					persistRecord(handle.record);
				}
				await drainCheckpoints();
				persistRecord(handle.record);
				await settleCheckpoints("error");
				await finalizeFeed(handle, {});
			});

		return { runId, scriptPath, name };
	}

	/**
	 * Write the feed's terminal `run:end` line, drain the writer, and drop it from
	 * the per-run map (Task 8.1.2). Idempotent by map presence; fenced.
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

	function statusOf(runId: string): RunHandle | undefined {
		return runs.get(runId);
	}

	// pi: no live mid-flight stats for in-flight agents (no per-token stream to the
	// parent). Final stats are derived at agent:end and live on the record.
	function statsSnapshot(_sessionID: string): SessionStatsSnapshot | undefined {
		return undefined;
	}

	function isWorkerSession(sessionID: string): boolean {
		return workerSessions.has(sessionID);
	}

	function liveRunsFor(parentSessionID: string): RunHandle[] {
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

	/**
	 * Read a child task's RAW transcript via the runner's transcript reader — the
	 * source for both budget accounting and per-agent stats. The runner's narrowed
	 * `readOutput` strips `usage`/tool metadata; the transcript reader returns the
	 * full `PiAgentMessage[]`. Resolves to `[]` on any failure or an unknown task.
	 */
	async function fetchSessionMessages(
		sessionID: string,
	): Promise<PiAgentMessage[]> {
		const task = runner.list().find((t) => t.sessionID === sessionID);
		if (task === undefined) {
			return [];
		}
		try {
			return await transcriptReader({
				sessionId: sessionID,
				...(task.sessionFile !== undefined
					? { sessionFile: task.sessionFile }
					: {}),
				...(sessionDir !== undefined ? { sessionDir } : {}),
			});
		} catch {
			return [];
		}
	}

	/**
	 * Derive a settled child's final stats from its on-disk transcript (token usage +
	 * tool-result count), keyed by sessionID — the pi-native replacement for opencode's
	 * live SDK-stream collector. Called from the ORDERED progress tail at `agent:end`
	 * (the child has stopped, so its transcript is durable), so the awaited read does
	 * not reorder events or write a stats-free feed line. FENCED — a read failure
	 * resolves `undefined` (the agent rolls up stats-free, an honest "unknown").
	 */
	async function deriveStatsForSession(
		sessionID: string,
		at: number,
	): Promise<SessionStatsSnapshot | undefined> {
		const messages = await fetchSessionMessages(sessionID);
		if (messages.length === 0) {
			return undefined;
		}
		return deriveSessionStats(messages, at);
	}

	// Startup recovery: load persisted records, flip stale `running` → error, seed
	// the queue from terminal records. Runs as a promise `ready()` awaits.
	const readyPromise = (async () => {
		// Probe the git work tree ONCE (Task 2.1.6): a non-repo warns exactly here, and
		// the verdict is cached so each per-run checkpointer adopts it without re-probing.
		checkpointerAlive = await probeCheckpointer.ready();
		// Crash-safety sweep (Task H.1.5): prune orphan `wf/*` worktrees + branches a
		// PRIOR run left behind on a crash. The manager's sweep is itself fenced.
		try {
			await worktreeManager.sweep();
		} catch (err) {
			logger?.warn("worktree sweep failed at engine ready (non-blocking)", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
		// Stale-marker sweep: a run that crashed between checkpoint and terminal never
		// ran promote()/discard(), so its marker GC-pins its checkpoint commits forever.
		try {
			await probeCheckpointer.sweepMarkers();
		} catch (err) {
			logger?.warn(
				"checkpoint marker sweep failed at engine ready (non-blocking)",
				{ error: err instanceof Error ? err.message : String(err) },
			);
		}
		const recovered = await runStore.load();
		const seed: RunRecord[] = [];
		for (const record of recovered) {
			if (record.status === "running") {
				record.status = "error";
				record.error =
					"interrupted by restart — agents may have mutated the working tree " +
					"before the interrupt; inspect `git status` before resume or relaunch";
				record.completedAt = clock.now();
				// Phase 3.2.2: a real crash persists no per-agent data, so re-read the
				// run's feed to recover the per-agent table. readFeedCounts is FENCED.
				const counts = await readFeedCounts(
					join(feedDir, `${record.id}.jsonl`),
				);
				if (counts.agentCount > 0) {
					record.agentCount = counts.agentCount;
				}
				if (counts.agents.length > 0) {
					record.agents = counts.agents;
				}
				if (counts.checkpoints.length > 0) {
					record.checkpoints = counts.checkpoints;
				}
				persistRecord(record);
			}
			runs.set(record.id, { record, progress: [] });
			seed.push(record);
		}
		// seed() re-queues terminal && !notified records silently (no toast storm).
		queue.seed(seed);
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
		dispose: async () => {
			// Stop the control poll loop before draining stores so no late tick races
			// a disposed engine. Each run's ordered progress tail is drained by its own
			// settle path; disposing the runner aborts any live children, which unblocks
			// those settles. No engine-level stats queue to drain (per-run, closure-scoped).
			control.stop();
			await readyPromise;
			await runner.dispose();
			await taskStore.dispose();
			await runStore.dispose();
		},
	};
}

/**
 * The package's node:fs/promises {@link FsFacade} for the source resolver / skill
 * resolver / save tool. A thin builder so the engine never threads an injectable fs
 * facade (pi's feed/journal/control default to node fs directly). Pure — no side
 * effects — so it is safe to mint per call site.
 */
function nodeFsFacadeForSource() {
	return nodeFsFacade();
}

/** Concatenate a pi tool-result message's text content parts into one string. */
function extractTextContent(content: unknown): string | undefined {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return undefined;
	}
	const texts: string[] = [];
	for (const part of content) {
		const p = part as { type?: string; text?: unknown };
		if (p.type === "text" && typeof p.text === "string") {
			texts.push(p.text);
		}
	}
	return texts.length > 0 ? texts.join("") : undefined;
}
