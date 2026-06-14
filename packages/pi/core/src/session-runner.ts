/**
 * SessionRunner — pi-native launch path for background tasks.
 *
 * One {@link BgTask} == one long-lived `pi --mode rpc` child == one pi session.
 * The runner spawns a child per launch via an injected {@link RpcClientFactory}
 * (tests inject a fake that emits synthetic events), wires the child's events
 * and exit into the {@link CompletionFuser}, and tears the child down on every
 * terminal transition. A finished child is stopped; `resume()` spawns a FRESH
 * child against the SAME session id/dir so pi replays the transcript.
 *
 * The launch state machine, concurrency-slot accounting, restart recovery,
 * terminal-TTL eviction, and every cancel/resume race port from the opencode
 * runner verbatim in shape. The substitutions:
 *   - `client.session.create` + `promptAsync` → `factory.create(); rpc.start();
 *     rpc.prompt()`,
 *   - `client.session.abort` → `rpc.abort()`,
 *   - teardown adds `rpc.stop()`,
 *   - the 843-line completion GATE → the small terminal-signal FUSER.
 *
 * Construction is factory-DI: {@link createSessionRunner} takes only the
 * collaborators it needs; the `rpcFactory` is the seam tests fake.
 *
 * Node-safe: no Bun.* APIs.
 */

import {
	type CompletionFuser,
	createCompletionFuser,
	type TimerFactory,
} from "./completion";
import type { ConcurrencyManager } from "./concurrency";
import { WaiterCancelledError } from "./concurrency";
import type { IdGenerator } from "./ids";
import type {
	PiAgentMessage,
	PiAssistantMessage,
	PiToolResultMessage,
	PiUserMessage,
	RpcAgentEvent,
	RpcClientFactory,
	RpcClientLike,
	SessionTranscriptReader,
} from "./rpc-client";
import {
	type BgTask,
	type Clock,
	isTerminal,
	type LaunchRequest,
	type ReadOpts,
	type SessionRunner,
	type TaskOutput,
	type TaskOutputMessage,
	type TaskOutputPart,
	type TextPartInput,
} from "./types";

export type { TextPartInput } from "./types";

export type PersistFn = (task: BgTask) => Promise<void>;

export interface SessionRunnerLogger {
	debug?(msg: string, meta?: Record<string, unknown>): void;
	error?(msg: string, meta?: Record<string, unknown>): void;
}

export interface SessionRunnerConfig {
	maxDepth?: number;
	/**
	 * How long a TERMINAL task stays in the in-memory maps (ms) before the
	 * terminal-teardown sweep evicts it. Mirrors the on-disk task store's 24h TTL.
	 * Default 24h. `readOutput`/`list` keep working for recently-terminal tasks.
	 */
	terminalTtlMs?: number;
	/**
	 * Hard cap on terminal tasks held in memory; the sweep evicts oldest-first
	 * (by `completedAt`) beyond it, regardless of TTL. Default 500.
	 */
	maxTerminalTasks?: number;
	/** Bound for a queued resume slot re-acquire (ms). Default 45min. */
	resumeAcquireTimeoutMs?: number;
	/**
	 * Bound (ms) for the prompt watchdog: the max time a dispatched prompt may
	 * stay silent — no `agent_start` and no terminal `agent_end` — before the task
	 * is flipped to `error`. This is the safety net for pi's stock-client
	 * `prompt()` swallowing a preflight `success:false` (missing/invalid API key,
	 * no model selected, a throwing `before_agent_start` extension): without it the
	 * task hangs in `running` forever. The first `agent_start` (the run actually
	 * began) disarms it, so a long real turn is never misclassified. Default 90s.
	 * `<= 0` disables the watchdog.
	 */
	promptWatchdogMs?: number;
}

export interface SessionRunnerDeps {
	/** The pi RPC seam — spawns one `pi --mode rpc` child per task. */
	rpcFactory: RpcClientFactory;
	/** Reads a terminal/torn-down task's transcript from disk. */
	transcriptReader: SessionTranscriptReader;
	concurrency: ConcurrencyManager;
	ids: IdGenerator;
	clock: Clock;
	persist?: PersistFn;
	logger?: SessionRunnerLogger;
	config?: SessionRunnerConfig;
	/**
	 * The session storage dir passed to every child (`--session-dir`). Resume
	 * reconstructs identical args from this + the task's `sessionID`. Engine-wide
	 * (one dir for all tasks) rather than per-task; absent → pi's default dir.
	 */
	sessionDir?: string;
	/** Notification-layer hook, forwarded to the fuser. */
	onTaskComplete?: (task: BgTask) => void;
	/** Injected timer factory (tests pass a manual fake; defaults to setTimeout). */
	setTimer?: TimerFactory;
	/**
	 * Tasks recovered from persistence at restart. Registered into the live map
	 * on construction so `list`/`readOutput` see them immediately. Terminal tasks
	 * are registered as-is. Non-terminal recovered tasks CANNOT be re-attached to
	 * a live child (the original process's children died with it), so they are
	 * finalized as `error("lost during restart")` through the fuser. A
	 * sessionless non-terminal task is finalized the same way.
	 *
	 * Slot policy: recovered tasks occupy NO concurrency slot (the original
	 * process's slots died with it).
	 */
	recoveredTasks?: BgTask[];
}

const DEFAULT_MAX_DEPTH = 2;
/** Concurrency key seed when a request carries no model. */
const DEFAULT_MODEL_KEY = "default";
const DEFAULT_TERMINAL_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_TERMINAL_TASKS = 500;
const DEFAULT_RESUME_ACQUIRE_TIMEOUT_MS = 45 * 60 * 1000;
const DEFAULT_PROMPT_WATCHDOG_MS = 90 * 1000;

/** The recursion-guard tool map: every spawn/workflow tool disabled. */
const SPAWN_GUARD: Record<string, boolean> = {
	bg_task: false,
	bg_output: false,
	bg_cancel: false,
	bg_list: false,
	workflow: false,
	workflow_status: false,
	workflow_stop: false,
};

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Default one-shot timer factory backed by the host's `setTimeout`. */
const defaultTimer: TimerFactory = (cb, ms) => {
	const handle = setTimeout(cb, ms);
	return { clear: () => clearTimeout(handle) };
};

/** Per-task live-child bookkeeping: the RPC client + its event/exit unsubs. */
interface LiveChild {
	rpc: RpcClientLike;
	unsubscribe: () => void;
}

export function createSessionRunner(deps: SessionRunnerDeps): SessionRunner {
	const { rpcFactory, transcriptReader, concurrency, ids, clock } = deps;
	const persist = deps.persist;
	const maxDepth = deps.config?.maxDepth ?? DEFAULT_MAX_DEPTH;
	const terminalTtlMs = deps.config?.terminalTtlMs ?? DEFAULT_TERMINAL_TTL_MS;
	const maxTerminalTasks =
		deps.config?.maxTerminalTasks ?? DEFAULT_MAX_TERMINAL_TASKS;
	const resumeAcquireTimeoutMs =
		deps.config?.resumeAcquireTimeoutMs ?? DEFAULT_RESUME_ACQUIRE_TIMEOUT_MS;
	const promptWatchdogMs =
		deps.config?.promptWatchdogMs ?? DEFAULT_PROMPT_WATCHDOG_MS;
	const setTimerFn = deps.setTimer ?? defaultTimer;
	const sessionDir = deps.sessionDir;

	const tasks = new Map<string, BgTask>();
	// Per-task live child. Present only while a task holds a running RPC child;
	// removed at teardown. `readOutput` reads live messages when present, else
	// from disk.
	const liveChildren = new Map<string, LiveChild>();
	// While a task's acquire is in-flight, map taskId → (model, waiterId) so a
	// cancellation can reject the still-queued waiter by its id.
	const inflightAcquire = new Map<
		string,
		{ model: string; waiterId: string }
	>();
	// Tasks that hold a live concurrency slot → the model key to release.
	const heldSlots = new Map<string, string>();
	// Per-task resume guard: synchronous check-and-set at the top of resume().
	const resumesInFlight = new Set<string>();

	function evictTerminal(now: number): void {
		const terminal: BgTask[] = [];
		for (const t of tasks.values()) {
			if (isTerminal(t.status)) {
				terminal.push(t);
			}
		}
		const evict = (t: BgTask): void => {
			tasks.delete(t.id);
		};
		const completedOf = (t: BgTask): number => t.completedAt ?? t.createdAt;
		const survivors: BgTask[] = [];
		for (const t of terminal) {
			if (now - completedOf(t) >= terminalTtlMs) {
				evict(t);
			} else {
				survivors.push(t);
			}
		}
		if (survivors.length > maxTerminalTasks) {
			survivors.sort((a, b) => completedOf(a) - completedOf(b));
			for (const t of survivors.slice(0, survivors.length - maxTerminalTasks)) {
				evict(t);
			}
		}
	}

	// Release a slot recorded in `heldSlots` exactly once.
	function releaseHeldSlot(id: string): void {
		const held = heldSlots.get(id);
		if (held !== undefined) {
			heldSlots.delete(id);
			concurrency.release(held);
		}
	}

	function liveIds(): ReadonlySet<string> {
		return new Set(tasks.keys());
	}

	async function maybePersist(task: BgTask): Promise<void> {
		if (persist) {
			await persist(task);
		}
	}

	/** Detach a task's live child: unsubscribe its events + stop the process. */
	async function teardownChild(task: BgTask): Promise<void> {
		const live = liveChildren.get(task.id);
		if (!live) {
			return;
		}
		liveChildren.delete(task.id);
		try {
			live.unsubscribe();
		} catch {
			// best-effort
		}
		await live.rpc.stop();
	}

	// --- the completion fuser owns every terminal status transition ----------

	const fuser: CompletionFuser = createCompletionFuser({
		getTask: (id) => tasks.get(id),
		freeSlot: (task) => {
			// Slot held → release it. Else if the waiter is still queued → cancel it
			// (denies the launch acquire). Else nothing to free.
			const held = heldSlots.get(task.id);
			if (held !== undefined) {
				heldSlots.delete(task.id);
				concurrency.release(held);
				return;
			}
			const pending = inflightAcquire.get(task.id);
			if (pending) {
				concurrency.cancelWaiter(pending.model, pending.waiterId);
			}
		},
		teardownChild,
		clock,
		persist: maybePersist,
		onTaskComplete: (task) => {
			evictTerminal(clock.now());
			deps.onTaskComplete?.(task);
		},
		logger: deps.logger,
		setTimer: setTimerFn,
		promptWatchdogMs,
	});

	/**
	 * Restart recovery (synchronous register + finalize). Every recovered task is
	 * registered so `list`/`readOutput` see it immediately. A non-terminal
	 * recovered task cannot re-attach to a live child (its process died with the
	 * old one), so it is finalized as `error("lost during restart")` through the
	 * fuser. Recovered tasks hold NO concurrency slot.
	 */
	const recovered = deps.recoveredTasks;
	if (recovered && recovered.length > 0) {
		for (const task of recovered) {
			tasks.set(task.id, task);
			if (isTerminal(task.status)) {
				continue; // terminal: visible to list/readOutput.
			}
			// Non-terminal recovered task: no live child to re-attach. Finalize.
			fuser.tryComplete(task.id, "error", "lost during restart");
		}
	}

	/** Non-terminal status write (pending/running). Terminal flips go via fuser. */
	async function setIntermediate(
		task: BgTask,
		status: Extract<BgTask["status"], "pending" | "running">,
	): Promise<void> {
		task.status = status;
		await maybePersist(task);
	}

	/** Opaque status read (the fuser mutates status through a closure TS can't see). */
	function statusOf(taskId: string): BgTask["status"] | undefined {
		return tasks.get(taskId)?.status;
	}

	function buildTools(req: LaunchRequest): Record<string, boolean> {
		const guard = req.noSpawnTools === false ? {} : SPAWN_GUARD;
		return { ...guard, ...(req.toolsOverride ?? {}) };
	}

	/** Subscribe a live child's events + exit into the fuser, keyed by task id. */
	function wireChild(taskId: string, rpc: RpcClientLike): () => void {
		const offEvent = rpc.onEvent((event: RpcAgentEvent) => {
			fuser.onEvent(taskId, event);
		});
		const offExit = rpc.onExit((info) => {
			fuser.onExit(taskId, info);
		});
		return () => {
			offEvent();
			offExit();
		};
	}

	/**
	 * Compose the launch/resume prompt. The opencode runner sent `contextParts`
	 * first then the prompt as ordered SDK parts; pi's `prompt` takes a single
	 * string, so context parts are flattened ahead of the instruction. Order is
	 * load-bearing — the model reads the reference context before the instruction.
	 */
	function composePrompt(
		prompt: string,
		contextParts?: TextPartInput[],
	): string {
		if (!contextParts || contextParts.length === 0) {
			return prompt;
		}
		const ctx = contextParts.map((p) => p.text).join("\n\n");
		return `${ctx}\n\n${prompt}`;
	}

	/**
	 * Fire-and-forget prompt whose failure routes through the fuser (error flip
	 * releases the slot + tears the child down). Shared by launch and resume.
	 */
	function dispatchPrompt(
		task: BgTask,
		rpc: RpcClientLike,
		prompt: string,
		contextParts?: TextPartInput[],
	): void {
		// Arm the prompt watchdog BEFORE/around the dispatch. The stock pi client's
		// prompt() resolves on a preflight `success:false` frame WITHOUT rejecting,
		// so a missing key / no model / before_agent_start throw would otherwise
		// leave the task silently stuck in `running` (no agent_end ever fires). The
		// watchdog flips it to error if no `agent_start` arrives in time. A genuine
		// prompt REJECTION (process death) still routes through the .catch below.
		fuser.armPromptWatchdog(task.id);
		rpc.prompt(composePrompt(prompt, contextParts)).catch((err: unknown) => {
			deps.logger?.error?.("prompt failed", { id: task.id });
			fuser.tryComplete(task.id, "error", errorMessage(err));
		});
	}

	async function launch(req: LaunchRequest): Promise<BgTask> {
		// (1) depth guard — before any slot/registration.
		if (req.depth >= maxDepth) {
			throw new Error(
				`Background task depth ${req.depth} exceeds max depth ${maxDepth}`,
			);
		}

		const modelKey = req.model ?? DEFAULT_MODEL_KEY;
		const concurrencyKey = concurrency.keyFor(modelKey);

		// (2) register a pending task. The effective tools map is computed once and
		// STORED so resume() replays it (and it persists with the task).
		const id = ids.next(liveIds());
		const task: BgTask = {
			id,
			parentSessionID: req.parentSessionID,
			description: req.description,
			agent: req.agent,
			status: "pending",
			createdAt: clock.now(),
			depth: req.depth,
			concurrencyKey,
			model: req.model,
			tools: buildTools(req),
			// Persist the pi-native knobs so resume() re-applies them to the fresh
			// child (--append-system-prompt/--tools are per-invocation, not replayed
			// with the session). Stored only when present to keep pre-field tasks clean.
			...(req.appendSystemPrompt !== undefined
				? { appendSystemPrompt: req.appendSystemPrompt }
				: {}),
			...(req.tools !== undefined ? { agentTools: req.tools } : {}),
		};
		tasks.set(id, task);
		try {
			await maybePersist(task);
		} catch (err) {
			// Route through the fuser so a registered-but-slotless ghost lands
			// terminal (persist retried, waiters resolved, hook fired), then rethrow.
			fuser.tryComplete(id, "error", errorMessage(err));
			throw err;
		}

		// (3) acquire a slot. Hold the AcquireResult so a cancel mid-acquire can
		// cancel the waiter by id.
		const acquire = concurrency.acquire(modelKey);
		inflightAcquire.set(id, { model: modelKey, waiterId: acquire.id });
		try {
			await acquire;
		} catch (err) {
			inflightAcquire.delete(id);
			if (err instanceof WaiterCancelledError) {
				fuser.tryComplete(id, "cancelled");
				return task;
			}
			fuser.tryComplete(id, "error", errorMessage(err));
			throw err;
		}
		inflightAcquire.delete(id);
		heldSlots.set(id, modelKey);

		// (4) cancel-during-acquire that lost the race to the grant.
		if (statusOf(id) === "cancelled") {
			if (!fuser.tryComplete(id, "cancelled")) {
				releaseHeldSlot(id);
			}
			return task;
		}

		// (5) create the child = create the session. Mint the session id so we
		// control it from launch (resume reconstructs identical args). The cwd is
		// the per-launch worktree (LaunchRequest.directory).
		const sessionID = id; // minted: the task id doubles as the session id.
		const rpc = rpcFactory.create({
			cwd: req.directory,
			model: req.model,
			sessionId: sessionID,
			sessionDir,
			appendSystemPrompt: req.appendSystemPrompt,
			tools: req.tools,
		});
		// Wire events BEFORE start so no terminal agent_end is missed in the gap
		// between start and dispatch.
		const unsubscribe = wireChild(id, rpc);
		try {
			await rpc.start();
		} catch (err) {
			unsubscribe();
			try {
				await rpc.stop();
			} catch {
				// best-effort
			}
			fuser.tryComplete(id, "error", errorMessage(err));
			throw err;
		}
		liveChildren.set(id, { rpc, unsubscribe });

		// Capture the session file for the disk-read path (best-effort; a failure
		// just leaves readOutput to derive/degrade later).
		try {
			task.sessionFile = (await rpc.getState()).sessionFile;
		} catch (err) {
			deps.logger?.debug?.("getState after start failed", {
				id,
				err: errorMessage(err),
			});
		}

		// re-check cancellation across the start await. A cancel that fired before
		// the child existed flipped the task + freed the slot, but its teardown saw
		// no live child to stop. Stop the freshly-spawned orphan here.
		if (statusOf(id) === "cancelled") {
			task.sessionID = sessionID;
			if (!fuser.tryComplete(id, "cancelled")) {
				await teardownChild(task);
			}
			return task;
		}

		// (6) per-session registration hook. SYNCHRONOUS, between start resolving
		// and the prompt dispatch. A throw is a caller programming error and fails
		// the launch loudly — but the slot and the orphan child must still tear
		// down. The fuser's error flip releases the slot + stops the child.
		task.sessionID = sessionID;
		try {
			req.onSessionCreated?.(sessionID);
		} catch (err) {
			fuser.tryComplete(id, "error", errorMessage(err));
			throw err;
		}

		// (7) promote to running. A persist failure routes through the fuser's
		// error flip (releases the slot + stops the child), then rethrows.
		task.startedAt = clock.now();
		try {
			await setIntermediate(task, "running");
		} catch (err) {
			fuser.tryComplete(id, "error", errorMessage(err));
			throw err;
		}

		// (7b) terminal re-check across the persist await: a cancel/exit landing
		// during the persist already tore down. Skip dispatch.
		{
			const s = statusOf(id);
			if (s !== undefined && isTerminal(s)) {
				return task;
			}
		}

		// (8) fire-and-forget prompt. Failure routes through the fuser.
		dispatchPrompt(task, rpc, req.prompt, req.contextParts);

		// (9) resolve at running — never await completion.
		return task;
	}

	function list(parentSessionID?: string): BgTask[] {
		const all = [...tasks.values()];
		const filtered =
			parentSessionID === undefined
				? all
				: all.filter((t) => t.parentSessionID === parentSessionID);
		return filtered.sort((a, b) => a.createdAt - b.createdAt);
	}

	/**
	 * Cancel a task. Routes through the fuser's synchronous flip: `freeSlot`
	 * cancels a still-queued waiter or releases a held slot; teardown aborts the
	 * in-flight run (`rpc.abort`) — actually pi's abort still ends with an
	 * agent_end, but the fuser already flipped, so the late agent_end is a no-op —
	 * and stops the child. The returned promise JOINS the teardown.
	 */
	async function cancel(taskId: string): Promise<BgTask> {
		const task = tasks.get(taskId);
		if (!task) {
			throw new Error(`Unknown task: ${taskId}`);
		}
		// Best-effort abort the in-flight run BEFORE the flip so the child stops
		// working promptly; teardownChild's stop() then kills it.
		const live = liveChildren.get(taskId);
		if (live && !isTerminal(task.status)) {
			live.rpc.abort().catch((err: unknown) => {
				deps.logger?.debug?.("abort during cancel failed", {
					id: taskId,
					err: errorMessage(err),
				});
			});
		}
		fuser.tryComplete(taskId, "cancelled", "cancelled by user");
		// Cancel a queued RESUME acquire (the task is terminal, so the flip above
		// was denied and the fuser's freeSlot never ran).
		const pending = inflightAcquire.get(taskId);
		if (pending) {
			concurrency.cancelWaiter(pending.model, pending.waiterId);
		}
		return fuser.awaitCompletion(taskId);
	}

	/**
	 * Resume a terminal task with a new prompt on its existing session. A
	 * non-terminal task rejects with `taskStillRunning`; a CONCURRENT resume for
	 * the same task rejects with `resumeInFlight`. On success a FRESH child is
	 * spawned against the SAME session id/dir (pi replays the transcript), the
	 * task re-acquires its slot, resets to `running`, and the new prompt is
	 * dispatched.
	 */
	async function resume(taskId: string, prompt: string): Promise<BgTask> {
		const task = tasks.get(taskId);
		if (!task) {
			throw new Error(`Unknown task: ${taskId}`);
		}
		if (resumesInFlight.has(taskId)) {
			throw new Error(
				`resumeInFlight: a resume for ${taskId} is already in progress`,
			);
		}
		resumesInFlight.add(taskId);
		try {
			return await doResume(task, taskId, prompt);
		} finally {
			resumesInFlight.delete(taskId);
		}
	}

	async function doResume(
		task: BgTask,
		taskId: string,
		prompt: string,
	): Promise<BgTask> {
		if (!isTerminal(task.status)) {
			throw new Error(`taskStillRunning: ${taskId} is ${task.status}`);
		}
		// Fence on the terminal flip's DETACHED teardown so past this await no stale
		// teardown write (or child stop) can clobber the resumed task.
		await fuser.awaitCompletion(taskId);
		const sessionID = task.sessionID;
		if (!sessionID) {
			throw new Error(`sessionExpired: ${taskId} has no session`);
		}

		// Re-acquire the concurrency slot on the original model, with a BOUNDED
		// wait: a queued resume is invisible to anything else (the task is still
		// terminal), so an unbounded acquire could hang forever.
		const modelKey = task.model ?? DEFAULT_MODEL_KEY;
		const acquire = concurrency.acquire(modelKey);
		inflightAcquire.set(taskId, { model: modelKey, waiterId: acquire.id });
		let acquireTimedOut = false;
		const acquireTimer = setTimerFn(() => {
			acquireTimedOut = true;
			concurrency.cancelWaiter(modelKey, acquire.id);
		}, resumeAcquireTimeoutMs);
		try {
			await acquire;
		} catch (err) {
			inflightAcquire.delete(taskId);
			if (err instanceof WaiterCancelledError) {
				if (acquireTimedOut) {
					throw new Error(
						`resumeTimeout: ${taskId} did not acquire a concurrency slot ` +
							`within ${resumeAcquireTimeoutMs}ms (queue for ${modelKey} stayed saturated)`,
					);
				}
				// Cancelled mid-acquire (cancel() cancelled the queued resume waiter):
				// stays/returns terminal.
				fuser.tryComplete(taskId, "cancelled", "cancelled by user");
				return fuser.awaitCompletion(taskId);
			}
			throw err;
		} finally {
			acquireTimer.clear();
		}
		inflightAcquire.delete(taskId);
		heldSlots.set(taskId, modelKey);

		// Spawn a FRESH child against the SAME session id/dir — pi re-attaches and
		// replays the persisted transcript.
		const rpc = rpcFactory.create({
			model: task.model,
			sessionId: sessionID,
			sessionDir,
			// Re-apply the pi-native knobs the launch resolved (persisted on the
			// task): --append-system-prompt/--tools are per-invocation flags, NOT
			// part of the replayed session, so the fresh child needs them again.
			appendSystemPrompt: task.appendSystemPrompt,
			tools: task.agentTools,
		});
		const unsubscribe = wireChild(taskId, rpc);
		try {
			await rpc.start();
		} catch (err) {
			unsubscribe();
			try {
				await rpc.stop();
			} catch {
				// best-effort
			}
			fuser.tryComplete(taskId, "error", errorMessage(err));
			throw err;
		}
		liveChildren.set(taskId, { rpc, unsubscribe });

		// Refresh the session file (the replayed session may have rotated paths).
		try {
			task.sessionFile = (await rpc.getState()).sessionFile;
		} catch (err) {
			deps.logger?.debug?.("getState after resume start failed", {
				id: taskId,
				err: errorMessage(err),
			});
		}

		// Reset terminal bookkeeping and promote to running.
		task.startedAt = clock.now();
		task.completedAt = undefined;
		task.error = undefined;
		task.notified = undefined;
		try {
			await setIntermediate(task, "running");
		} catch (err) {
			fuser.tryComplete(taskId, "error", errorMessage(err));
			throw err;
		}

		// Terminal re-check across the persist await: a cancel landing during the
		// persist already tore down — skip dispatch.
		{
			const s = statusOf(taskId);
			if (s !== undefined && isTerminal(s)) {
				return task;
			}
		}

		// Clear the fuser's per-turn bookkeeping so a stale extension-error from the
		// previous turn can't taint the new one.
		fuser.resetForResume(task);

		// Dispatch the new prompt. The replayed transcript is pi's; the launch's
		// effective tools map is no longer dispatchable per-prompt (pi takes a bare
		// string), so tool config is the child's resolved `--tools`/launch defaults.
		dispatchPrompt(task, rpc, prompt);

		return task;
	}

	/**
	 * Read a task's output. A pending task (no session) returns an empty summary.
	 * A LIVE task reads `rpc.getMessages()`; a terminal/torn-down task reads the
	 * persisted transcript from disk. `summaryText` is the concatenated text of
	 * the LAST assistant message; `full: true` adds the filtered transcript. Any
	 * failure degrades to the task's recorded error/empty — never rejects.
	 */
	async function readOutput(
		taskId: string,
		opts?: ReadOpts,
	): Promise<TaskOutput> {
		const task = tasks.get(taskId);
		if (!task) {
			throw new Error(`Unknown task: ${taskId}`);
		}
		const sessionID = task.sessionID;
		if (!sessionID) {
			return { status: task.status, summaryText: "" };
		}

		let messages: PiAgentMessage[];
		try {
			const live = liveChildren.get(taskId);
			// A live task reads from the running child; a terminal/torn-down task reads
			// the persisted transcript from disk. NOTE (crash detection): if the child
			// died strictly between turns, getMessages() rejects with a process-death
			// error which the factory's observed() turns into an onExit → the fuser
			// flips the task to error synchronously. So this readOutput call doubles as
			// the discovery path for a between-turns crash; the catch below then reports
			// the freshly-flipped error status rather than a live transcript.
			messages = live
				? await live.rpc.getMessages()
				: await transcriptReader({
						sessionId: sessionID,
						sessionFile: task.sessionFile,
						sessionDir,
					});
		} catch {
			return { status: task.status, summaryText: task.error ?? "" };
		}

		try {
			const summaryText = lastAssistantText(messages);
			if (!opts?.full) {
				return { status: task.status, summaryText };
			}
			return {
				status: task.status,
				summaryText,
				messages: filterTranscript(messages),
			};
		} catch {
			return { status: task.status, summaryText: task.error ?? "" };
		}
	}

	return {
		launch,
		list,
		awaitCompletion: (taskId, timeoutMs) =>
			fuser.awaitCompletion(taskId, timeoutMs),
		cancel,
		resume,
		readOutput,
		dispose: async () => {
			await fuser.dispose();
			// Stop any children still alive (non-terminal tasks at shutdown).
			await Promise.allSettled(
				[...liveChildren.values()].map((c) => {
					try {
						c.unsubscribe();
					} catch {
						// best-effort
					}
					return c.rpc.stop();
				}),
			);
			liveChildren.clear();
		},
	};
}

// --- output reading helpers ------------------------------------------------

const TOOL_TEXT_CAP = 2000;
const ERROR_HEAD = 1200;
const ERROR_TAIL = 600;
const ERROR_PATTERN = /error|fail|exception|denied|timeout/i;

/** Concatenated text of the last assistant message (its text content only).
 *  Defensive on unvalidated wire data: a malformed message is skipped/empty. */
function lastAssistantText(messages: PiAgentMessage[]): string {
	if (!Array.isArray(messages)) {
		return "";
	}
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const m = messages[i];
		if (!m || (m as { role?: unknown }).role !== "assistant") {
			continue;
		}
		const content = (m as PiAssistantMessage).content;
		if (!Array.isArray(content)) {
			return "";
		}
		return content
			.filter(
				(c) =>
					c.type === "text" &&
					typeof (c as { text?: unknown }).text === "string",
			)
			.map((c) => (c as { text: string }).text)
			.join("");
	}
	return "";
}

/** Cap a tool result: plain truncation, except error-shaped results keep head +
 *  tail so the actual failure (often at the end) survives. */
function capToolText(text: string): string {
	if (text.length <= TOOL_TEXT_CAP) {
		return text;
	}
	if (ERROR_PATTERN.test(text)) {
		const dropped = text.length - ERROR_HEAD - ERROR_TAIL;
		return `${text.slice(0, ERROR_HEAD)}…[truncated ${dropped} chars]…${text.slice(text.length - ERROR_TAIL)}`;
	}
	return text.slice(0, TOOL_TEXT_CAP);
}

/** The displayable text of a content-part array (text parts joined). */
function contentText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter((c) => c && c.type === "text" && typeof c.text === "string")
		.map((c) => c.text as string)
		.join("");
}

/**
 * Filter a transcript for `readOutput({ full: true })`. Unlike opencode (tool
 * results nested inside assistant parts), pi puts tool RESULTS in separate
 * `toolResult` messages. We keep user + assistant text and FOLD each
 * `toolResult` into a capped tool part attached to the message stream as an
 * assistant-role tool part, preserving v1 parity of "what the model authored +
 * tool output". Messages left with no parts are dropped.
 */
function filterTranscript(messages: PiAgentMessage[]): TaskOutputMessage[] {
	if (!Array.isArray(messages)) {
		return [];
	}
	const out: TaskOutputMessage[] = [];
	for (const m of messages) {
		const role = (m as { role?: unknown }).role;
		if (role === "user") {
			const text = contentText((m as PiUserMessage).content);
			if (text) {
				out.push({ role: "user", parts: [{ type: "text", text }] });
			}
			continue;
		}
		if (role === "assistant") {
			const parts: TaskOutputPart[] = [];
			const content = (m as PiAssistantMessage).content;
			if (Array.isArray(content)) {
				const text = content
					.filter(
						(c) =>
							c.type === "text" &&
							typeof (c as { text?: unknown }).text === "string",
					)
					.map((c) => (c as { text: string }).text)
					.join("");
				if (text) {
					parts.push({ type: "text", text });
				}
			}
			if (parts.length > 0) {
				out.push({ role: "assistant", parts });
			}
			continue;
		}
		if (role === "toolResult") {
			const text = contentText((m as PiToolResultMessage).content);
			if (text) {
				// Tool results are model-visible context; attach as an assistant-role
				// tool part so consumers see the tool output in stream order.
				out.push({
					role: "assistant",
					parts: [{ type: "tool", text: capToolText(text) }],
				});
			}
		}
	}
	return out;
}
