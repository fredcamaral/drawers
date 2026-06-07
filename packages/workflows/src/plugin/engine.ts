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
	StampedProgressEvent,
} from "../runtime/types";
import { createTokenBudget, type TokenBudget } from "./budget";
import { createJournal, type Journal, type JournalFs } from "./journal";
import { createSourceResolver } from "./resolve-source";

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
}

/** In-memory handle for a run: live run (absent for recovered records), record, progress. */
export interface RunHandle {
	run?: WorkflowRun;
	record: RunRecord;
	/**
	 * Engine-stamped progress (Task 6.2.1): the runtime emits clock-free
	 * {@link ProgressEvent}s, the engine stamps each with `at = clock.now()` at its
	 * onProgress boundary. `workflow_status` reads `at` for per-agent elapsed.
	 */
	progress: StampedProgressEvent[];
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
	 * the prior run's journal entries (longest unchanged prefix replays). Source
	 * and args default to the prior record's when absent.
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

/**
 * Adapt the engine's {@link FsFacade} to the {@link JournalFs} the journal needs.
 * `FsFacade` has no `appendFile`, so it is synthesized as read-modify-write over
 * `readFile`/`writeFile` (ENOENT → start empty). This keeps the in-memory test
 * fs unchanged — it already exposes `readFile`/`writeFile`. The journal's own
 * single-serial write chain guarantees no two appends interleave for one file.
 */
function journalFsFromFacade(fs: FsFacade): JournalFs {
	return {
		mkdir: (path, opts) => fs.mkdir(path, opts),
		readFile: (path, enc) => fs.readFile(path, enc),
		appendFile: async (path, data, enc) => {
			let prior = "";
			try {
				prior = await fs.readFile(path, enc);
			} catch (err) {
				if ((err as { code?: string }).code !== "ENOENT") {
					throw err;
				}
			}
			await fs.writeFile(path, prior + data, enc);
		},
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

	// Sub-workflow source resolver (spec §8): maps a name/{scriptPath} to source
	// against the project directory. Threaded into every TOP-LEVEL run's
	// createWorkflowRun so its workflow() global can nest one level; a child run is
	// built (in the runtime) with resolveSubWorkflow undefined → depth-1 guard.
	const resolveSubWorkflow = createSourceResolver({
		directory: opts.directory,
		fs,
	});

	/** The journal file path for a runId (under the journals subdir). */
	const journalPath = (id: string) => join(journalsDir, `${id}.jsonl`);

	const journalFs = fs ? journalFsFromFacade(fs) : undefined;
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
			entries = await priorJournal.load();
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
		persistRecord(record);

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

		// Task 7.2.1: collect each null/empty agent diagnostic; persisted on the
		// record at settle so a finished run is debuggable without SQLite.
		const diagnostics: AgentDiagnostic[] = [];

		const run = createWorkflowRun({
			runner,
			parentSessionID: args.parentSessionID,
			runId,
			args: resolved.runArgs,
			registry,
			// Top-level run: its workflow() global can nest one level (spec §8).
			resolveSubWorkflow,
			...(budget !== undefined ? { budget } : {}),
			onProgress: (e) => {
				// Stamp at the ENGINE boundary (Task 6.2.1): the runtime stays clock-free;
				// the timestamp comes from the engine's injected clock here.
				handle.progress.push({ ...e, at: clock.now() });
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
			},
		});
		handle.run = run;

		/** Await all pending journal appends (fenced — a failed append must not throw). */
		const drainJournal = (): Promise<void> =>
			Promise.allSettled(journalWrites).then(() => undefined);

		// Fire DETACHED — never await the run. On settle, DRAIN the journal, then
		// update the record. The settle promise is exposed on the handle so
		// workflow_status's wait_ms blocks until the journal is durable (resume-safe).
		handle.settled = run
			.run(resolved.source)
			.then(async (result) => {
				await drainJournal();
				return result;
			})
			.then((result) => {
				// A stopRun() may have already flipped the record to cancelled; do not
				// clobber a terminal record with the run's own (also-terminal) result.
				if (handle.record.status !== "running") {
					return;
				}
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
			})
			.catch((err: unknown) => {
				// createWorkflowRun.run() never rejects, but fence defensively.
				if (handle.record.status !== "running") {
					return;
				}
				settleRecord(handle, {
					status: "error",
					error: err instanceof Error ? err.message : String(err),
					// Carry any diagnostics collected before the throw (Task 7.2.1).
					...(diagnostics.length > 0 ? { diagnostics } : {}),
				});
			});

		return { runId, scriptPath, name };
	}

	function stopRun(runId: string): void {
		const handle = runs.get(runId);
		if (handle?.record.status !== "running") {
			return;
		}
		handle.run?.abort();
		settleRecord(handle, { status: "cancelled" });
	}

	function statusOf(runId: string): RunHandle | undefined {
		return runs.get(runId);
	}

	function liveRunsFor(parentSessionID: string): RunHandle[] {
		const out: RunHandle[] = [];
		for (const handle of runs.values()) {
			if (
				handle.record.status === "running" &&
				handle.record.parentSessionID === parentSessionID
			) {
				out.push(handle);
			}
		}
		return out;
	}

	// Startup recovery: load persisted records, flip stale `running` → error, seed
	// the queue from terminal records. Runs as a promise `ready()` awaits.
	const readyPromise = (async () => {
		const recovered = await runStore.load();
		const seed: RunRecord[] = [];
		for (const record of recovered) {
			if (record.status === "running") {
				record.status = "error";
				record.error = "interrupted by restart";
				record.completedAt = clock.now();
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
		liveRunsFor,
		handleEvent: (event) => runner.handleEvent(event),
		dispose: async () => {
			await readyPromise;
			await runner.dispose();
			await taskStore.dispose();
			await runStore.dispose();
		},
	};
}
