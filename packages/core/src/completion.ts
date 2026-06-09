/**
 * CompletionGate — the race-correctness core of the engine.
 *
 * Every terminal status transition in the system funnels through
 * {@link CompletionGate.tryComplete}. The check-and-flip is SYNCHRONOUS and
 * runs before any await: JS single-threadedness is the mutex, so exactly one
 * caller can win the flip from `pending`/`running` to a terminal state. All
 * teardown (slot release, session abort, persistence, waiter resolution,
 * notification callback) happens asynchronously *after* the flip has been won,
 * so concurrent idle / poll / cancel / stale sources can never double-tear-down.
 *
 * Three completion sources funnel in:
 *  - {@link CompletionGate.handleEvent} on `session.idle` (min-idle grace +
 *    output validation), and `session.error`.
 *  - the safety poll (missed-idle fallback, session-gone detection, stale
 *    timeout), started via {@link CompletionGate.start}.
 *  - external callers (e.g. the launch path's cancellations, `cancel()`).
 *
 * The gate is presentation-ignorant: it knows nothing about TUI/toasts. The
 * notification layer subscribes via the injected `onTaskComplete` callback.
 *
 * Collaborators are injected (factory-DI) so tests drive timing with manual
 * timers and deferred promises — no real sleeps, no wall-clock timers.
 */

import type { Event } from "@opencode-ai/sdk";
import type { BgTask, Clock } from "./types";
import { isTerminal } from "./types";

export type TerminalStatus = "completed" | "error" | "cancelled";

/** One-shot timer handle (injected; tests use a manual fake). */
export interface TimerHandle {
	clear(): void;
}
/** Recurring interval handle. `unref` is best-effort (Node/Bun only). */
export interface IntervalHandle {
	clear(): void;
	unref?(): void;
}

export type TimerFactory = (cb: () => void, ms: number) => TimerHandle;
export type IntervalFactory = (cb: () => void, ms: number) => IntervalHandle;

/**
 * A part as returned inside `session.messages` (audit row c). Narrowed to the
 * fields the gate (`type`/`text`) and `readOutput` (`synthetic`, tool `state`)
 * actually read; everything else on the real SDK `Part` is ignored.
 */
export interface GatePart {
	type: string;
	text?: string;
	synthetic?: boolean;
	state?: { status: string; output?: string; error?: string };
}

/**
 * A message as returned by `session.messages` (audit row c), narrowed.
 *
 * `info.time.created` is the message-creation epoch ms. `info.time.completed` is
 * the turn-completion epoch ms — present ONLY on `AssistantMessage` and ONLY once
 * its turn has finished. Both are typed in the SDK `types.gen.d.ts`
 * (`UserMessage.time: { created }`, `AssistantMessage.time: { created; completed? }`),
 * so the turn watermark (Task 6.1.1) and the turn-liveness veto (Task 7.1.1) can
 * read them without any `as any`. A post-watermark assistant message that LACKS
 * `completed` is mid-flight → the turn is still live (Task 7.1.1).
 */
export interface GateMessage {
	info: {
		role: "user" | "assistant";
		time: { created: number; completed?: number };
	};
	parts: GatePart[];
}

export interface CompletionConfig {
	/** Minimum idle/quiet time before a task may complete (ms). Default 5000. */
	minIdleMs?: number;
	/** Safety poll period (ms). Default 5000. */
	pollMs?: number;
	/** No-activity window before a task is force-cancelled (ms). Default 45min. */
	staleTimeoutMs?: number;
	/** Consecutive `session.get` failures before declaring the session gone. */
	maxGetMisses?: number;
}

export interface CompletionGateDeps {
	/** Look up a task by id (the runner's live map). */
	getTask(taskId: string): BgTask | undefined;
	/** Tasks currently `pending`/`running` (the poll's candidate set). */
	runningTasks(): BgTask[];
	/**
	 * Look up the task owning a session id in O(1) (the runner's sessionID index).
	 * Returns any task carrying that sessionID regardless of status; the gate
	 * filters to non-terminal itself. Replaces the per-event linear scan over
	 * {@link runningTasks} that ran on every SDK event of an active turn.
	 */
	getBySession(sessionID: string): BgTask | undefined;
	/**
	 * Release the concurrency resource the task holds. The runner decides
	 * release-vs-cancelWaiter; the gate just signals "this task is done with its
	 * slot". Synchronous and idempotent-safe from the gate's perspective (the
	 * gate calls it at most once per task, guaranteed by the mutex).
	 */
	freeSlot(task: BgTask): void;
	/** Abort the underlying session (awaited; failures are caught + logged). */
	abortSession(sessionID: string): Promise<void>;
	/** Fetch a session's messages for output validation (audit row c). */
	fetchMessages(sessionID: string): Promise<GateMessage[]>;
	/**
	 * Read a session's turn-liveness status (Task 7.1.1, audit row f). Resolves to
	 * the session's entry in the global `session.status` map narrowed to one of:
	 *   - `"busy"` / `"retry"` → the turn is LIVE (working or mid-retry-backoff),
	 *   - `"idle"` → not working,
	 *   - `undefined` → ABSENT from the map = idle-equivalent (the same semantics
	 *     the wake notifier uses: a reachable-but-not-busy parent).
	 * A `busy`/`retry` verdict — or a read that THROWS — vetoes completion: quiet
	 * time alone is NOT proof a turn ended (silent windows >5s are normal mid-turn
	 * on first-token latency / API retry backoff). A throw blocks conservatively —
	 * better to wait for the next poll tick than risk a mid-turn completion.
	 */
	fetchStatus(
		sessionID: string,
	): Promise<"busy" | "retry" | "idle" | undefined>;
	/** Resolve if the session exists; reject/throw if gone (audit row e). */
	sessionExists(sessionID: string): Promise<void>;
	clock: Clock;
	/** Persist the task after a terminal flip. */
	persist(task: BgTask): Promise<void>;
	/** Notification-layer hook, invoked once per completed task. */
	onTaskComplete?: (task: BgTask) => void;
	logger?: {
		debug?(msg: string, meta?: Record<string, unknown>): void;
		error?(msg: string, meta?: Record<string, unknown>): void;
	};
	setTimer: TimerFactory;
	setIntervalFn: IntervalFactory;
	config?: CompletionConfig;
}

const DEFAULT_MIN_IDLE_MS = 5000;
const DEFAULT_POLL_MS = 5000;
const DEFAULT_STALE_MS = 45 * 60 * 1000;
const DEFAULT_MAX_GET_MISSES = 3;

const STALE_CANCEL_REASON =
	"Task went stale and was cancelled (no activity past the timeout). " +
	"Do NOT create a replacement task; report the timeout to the user.";

export interface CompletionGate {
	/**
	 * Synchronously flip a task to a terminal status (the mutex), then run async
	 * teardown. Returns true iff this call won the flip. SYNCHRONOUS up to the
	 * flip — the returned boolean reflects the flip, teardown runs detached.
	 */
	tryComplete(
		taskId: string,
		terminal: TerminalStatus,
		reason?: string,
	): boolean;
	handleEvent(event: Event): Promise<void>;
	awaitCompletion(taskId: string, timeoutMs?: number): Promise<BgTask>;
	/**
	 * Reset per-turn completion bookkeeping for a task being resumed: clears
	 * get-miss and defer-timer state and restarts the idle/stale activity clock at
	 * `now`. Call AFTER the task is back to `running` with a fresh `startedAt`,
	 * before the new prompt is dispatched. (Task 7.1.1 removed the per-session
	 * validity cache, so there is no longer any cached positive to evict here — the
	 * turn watermark alone fences stale previous-turn output.)
	 */
	resetForResume(task: BgTask): void;
	/**
	 * Stamp the turn watermark for a task: the moment its current turn was
	 * dispatched (`clock.now()`). Output validation accepts only assistant
	 * messages created at/after this watermark, so a resumed turn (Task 6.1.1)
	 * is never completed by the PREVIOUS turn's output still in the transcript.
	 * Call at every dispatch — launch's first prompt AND resume's re-prompt —
	 * AFTER {@link CompletionGate.resetForResume} on the resume path.
	 */
	markTurnDispatched(task: BgTask): void;
	/** Begin the safety poll. Idempotent. */
	start(): void;
	dispose(): Promise<void>;
}

interface Waiter {
	resolve: (task: BgTask) => void;
	reject: (err: Error) => void;
	timer?: TimerHandle;
}

function errorText(err: unknown): string {
	if (err instanceof Error) {
		return err.message;
	}
	return String(err);
}

/** Best-effort message extraction from a `session.error` payload. */
function sessionErrorMessage(
	event: Extract<Event, { type: "session.error" }>,
): string {
	const err = event.properties.error;
	if (!err) {
		return "session error";
	}
	const data = (err as { data?: { message?: string } }).data;
	if (data?.message) {
		return data.message;
	}
	const name = (err as { name?: string }).name;
	return name ?? "session error";
}

/**
 * A session has valid THIS-TURN output iff ≥1 assistant message created at/after
 * `watermark` has non-empty text/tool parts. The watermark is the current turn's
 * dispatch time (Task 6.1.1): messages from earlier turns (created before it)
 * are ignored, so the previous turn's output can't complete a resumed turn.
 */
function hasValidOutput(messages: GateMessage[], watermark: number): boolean {
	for (const m of messages) {
		if (m.info.role !== "assistant") {
			continue;
		}
		if (m.info.time.created < watermark) {
			continue; // stale: from a turn dispatched before this one
		}
		for (const p of m.parts) {
			if (p.type === "text" && p.text && p.text.trim().length > 0) {
				return true;
			}
			if (p.type === "tool") {
				return true;
			}
		}
	}
	return false;
}

/**
 * The turn is mid-flight (LIVE) iff the NEWEST post-watermark assistant message
 * lacks `time.completed` (Task 7.1.1). `completed` is stamped only when a turn
 * finishes, so its absence on the latest in-turn assistant message means the model
 * is still producing — even if some text/tool part already exists (the in-flight
 * message had `time.created` but no `time.completed` yet in the field forensics).
 *
 * "Newest" is by `time.created` among assistant messages created at/after the
 * watermark; messages from earlier turns are ignored (same fence as
 * {@link hasValidOutput}). With NO post-watermark assistant message, there is no
 * in-flight message to veto on — return false (this turn's liveness is decided by
 * the status veto / validity check instead, and `assessTurn` only consults this
 * once validity already holds, i.e. such a message exists).
 */
function messageTurnIsLive(
	messages: GateMessage[],
	watermark: number,
): boolean {
	let newest: GateMessage | undefined;
	for (const m of messages) {
		if (m.info.role !== "assistant") {
			continue;
		}
		if (m.info.time.created < watermark) {
			continue; // stale: from a turn dispatched before this one
		}
		if (!newest || m.info.time.created >= newest.info.time.created) {
			newest = m;
		}
	}
	if (!newest) {
		return false;
	}
	return newest.info.time.completed === undefined;
}

export function createCompletionGate(deps: CompletionGateDeps): CompletionGate {
	const {
		getTask,
		runningTasks,
		getBySession,
		freeSlot,
		abortSession,
		fetchMessages,
		fetchStatus,
		sessionExists,
		clock,
		persist,
		onTaskComplete,
		logger,
		setTimer,
		setIntervalFn,
	} = deps;

	const minIdleMs = deps.config?.minIdleMs ?? DEFAULT_MIN_IDLE_MS;
	const pollMs = deps.config?.pollMs ?? DEFAULT_POLL_MS;
	const staleTimeoutMs = deps.config?.staleTimeoutMs ?? DEFAULT_STALE_MS;
	const maxGetMisses = deps.config?.maxGetMisses ?? DEFAULT_MAX_GET_MISSES;

	/** awaitCompletion registry, keyed by task id. */
	const waiters = new Map<string, Set<Waiter>>();
	/** Last-activity timestamp per task id, for quiet/stale detection. */
	const lastActivity = new Map<string, number>();
	/** Consecutive `session.get` miss counts per task id. */
	const getMisses = new Map<string, number>();
	/**
	 * Per-task turn watermark (epoch ms): the dispatch moment of the current
	 * turn. Output validation accepts only assistant messages created at/after
	 * this value, so a resumed turn is never satisfied by the previous turn's
	 * output. Absent → fall back to the task's turn boundary (`startedAt`).
	 */
	const turnWatermark = new Map<string, number>();
	/** Pending deferred-idle timers per task id (so dispose can clear them). */
	const deferTimers = new Map<string, TimerHandle>();

	let pollHandle: IntervalHandle | undefined;
	let polling = false;
	let disposed = false;

	function activityOf(task: BgTask): number {
		return lastActivity.get(task.id) ?? task.startedAt ?? task.createdAt;
	}

	function graceElapsed(task: BgTask): boolean {
		return clock.now() - activityOf(task) >= minIdleMs;
	}

	function resolveWaiters(task: BgTask): void {
		const set = waiters.get(task.id);
		if (!set) {
			return;
		}
		waiters.delete(task.id);
		for (const w of set) {
			w.timer?.clear();
			w.resolve(task);
		}
	}

	/**
	 * The single status write path. SYNCHRONOUS check-and-flip (the mutex),
	 * then detached async teardown. Returns the flip result.
	 */
	function tryComplete(
		taskId: string,
		terminal: TerminalStatus,
		reason?: string,
	): boolean {
		const task = getTask(taskId);
		if (!task) {
			return false;
		}
		// --- THE MUTEX: synchronous check + flip, no await in between. ---
		if (task.status !== "pending" && task.status !== "running") {
			return false;
		}
		task.status = terminal;
		// (stale=cancelled needs abort; completed/error of a live session do not)

		// Detached teardown. Errors here must never reject the caller's flow.
		void teardown(task, terminal, reason);
		return true;
	}

	async function teardown(
		task: BgTask,
		terminal: TerminalStatus,
		reason?: string,
	): Promise<void> {
		// (1) release the concurrency slot first (leak guard).
		try {
			freeSlot(task);
		} catch (err) {
			logger?.error?.("freeSlot failed", { id: task.id, err: errorText(err) });
		}

		// (2) abort the session when cancelled/stale. AWAIT it — dangling teardown
		//     promises are a known Bun crash source. Catch + log, never rethrow.
		if (terminal === "cancelled" && task.sessionID) {
			try {
				await abortSession(task.sessionID);
			} catch (err) {
				logger?.error?.("abort failed during teardown", {
					id: task.id,
					err: errorText(err),
				});
			}
		}

		// (3) stamp completion, set error text, persist.
		task.completedAt = clock.now();
		if (reason !== undefined) {
			task.error = reason;
		}
		// drop per-task bookkeeping now that it is terminal.
		lastActivity.delete(task.id);
		getMisses.delete(task.id);
		turnWatermark.delete(task.id);
		const dt = deferTimers.get(task.id);
		if (dt) {
			dt.clear();
			deferTimers.delete(task.id);
		}
		try {
			await persist(task);
		} catch (err) {
			logger?.error?.("persist failed during teardown", {
				id: task.id,
				err: errorText(err),
			});
		}

		// (4) resolve awaitCompletion waiters.
		resolveWaiters(task);

		// (5) notification-layer hook.
		try {
			onTaskComplete?.(task);
		} catch (err) {
			logger?.error?.("onTaskComplete callback threw", {
				id: task.id,
				err: errorText(err),
			});
		}
	}

	/** The current turn's watermark for a task: its stamped dispatch time, or the
	 *  turn boundary (`startedAt ?? createdAt`) when no dispatch has been stamped. */
	function watermarkOf(task: BgTask): number {
		return turnWatermark.get(task.id) ?? task.startedAt ?? task.createdAt;
	}

	/**
	 * Assess a tracked running session's turn before completion (Task 7.1.1). The
	 * single choke point both completion paths (deferred-idle fire + poll quiet
	 * branch) run AFTER grace and BEFORE `tryComplete`. A turn may complete iff it
	 * is `{ valid: true, live: false }`.
	 *
	 * Two authoritative liveness signals, status checked FIRST (cheapest, and a
	 * `busy` verdict short-circuits the message fetch entirely):
	 *  1. STATUS VETO — `fetchStatus` returns `busy`/`retry` → live; a read that
	 *     THROWS also blocks (conservative: wait for the next poll tick rather than
	 *     risk a mid-turn completion). Quiet time alone is NOT proof of turn end:
	 *     silent windows >5s are normal mid-turn (first-token latency on large
	 *     prompts; API ECONNRESET retry backoff).
	 *  2. MESSAGE VETO — the newest post-watermark assistant message lacks
	 *     `time.completed` → the turn is mid-flight ({@link messageTurnIsLive}).
	 *
	 * Validity (post-watermark output exists, {@link hasValidOutput}) and the message
	 * liveness signal share ONE `fetchMessages` call — never fetched twice. Only
	 * assistant messages created at/after the task's turn watermark count (Task
	 * 6.1.1), so stale previous-turn output neither validates nor de-livens a
	 * resumed turn. NOTHING is cached: validity could be cached (output existence is
	 * monotonic per turn) but liveness is point-in-time and must be re-read on every
	 * attempt — and since liveness needs the fetch anyway, a validity cache would
	 * save only the in-memory scan, not the fetch, so it was removed rather than
	 * kept as dead structure (Task 7.1.1).
	 */
	async function assessTurn(
		task: BgTask,
		sessionID: string,
	): Promise<{ valid: boolean; live: boolean }> {
		// (1) Status veto FIRST — cheapest, and a live verdict makes the message
		//     fetch unnecessary (short-circuit). A THROW is a FAILED read → block.
		try {
			const status = await fetchStatus(sessionID);
			if (status === "busy" || status === "retry") {
				return { valid: false, live: true };
			}
		} catch (err) {
			logger?.debug?.("fetchStatus failed during assessment — blocking", {
				sessionID,
				err: errorText(err),
			});
			return { valid: false, live: true };
		}

		// (2) One message fetch serves BOTH validity and message-liveness.
		let messages: GateMessage[];
		try {
			messages = await fetchMessages(sessionID);
		} catch (err) {
			logger?.debug?.("fetchMessages failed during assessment", {
				sessionID,
				err: errorText(err),
			});
			return { valid: false, live: false };
		}
		const watermark = watermarkOf(task);
		return {
			valid: hasValidOutput(messages, watermark),
			live: messageTurnIsLive(messages, watermark),
		};
	}

	/**
	 * Find the tracked running/pending task owning a session id. O(1) via the
	 * runner's sessionID index; terminal tasks are filtered out so this keeps the
	 * exact "pending/running owner" semantics of the former linear scan.
	 */
	function trackedBySession(sessionID: string): BgTask | undefined {
		const t = getBySession(sessionID);
		if (!t || isTerminal(t.status)) {
			return undefined;
		}
		return t;
	}

	/** Extract a sessionID from any event that carries one (for activity tracking). */
	function sessionIdOf(event: Event): string | undefined {
		const props = (event as { properties?: Record<string, unknown> })
			.properties;
		if (!props) {
			return undefined;
		}
		if (typeof props.sessionID === "string") {
			return props.sessionID;
		}
		const info = props.info as { sessionID?: unknown } | undefined;
		if (info && typeof info.sessionID === "string") {
			return info.sessionID;
		}
		return undefined;
	}

	async function onIdle(sessionID: string): Promise<void> {
		const task = trackedBySession(sessionID);
		if (!task) {
			return; // untracked or already terminal
		}
		if (!graceElapsed(task)) {
			scheduleDeferredIdle(task, sessionID);
			return;
		}
		await maybeCompleteOnOutput(task, sessionID);
	}

	/** Re-check status when the deferred timer fires (task may have been cancelled). */
	function scheduleDeferredIdle(task: BgTask, sessionID: string): void {
		// Replace any existing defer timer for this task (latest idle wins).
		deferTimers.get(task.id)?.clear();
		const remaining = minIdleMs - (clock.now() - activityOf(task));
		const handle = setTimer(
			() => {
				deferTimers.delete(task.id);
				const live = getTask(task.id);
				if (live?.status !== "running") {
					return; // cancelled/completed during the wait — no-op
				}
				if (!graceElapsed(live)) {
					// activity advanced again — defer once more.
					scheduleDeferredIdle(live, sessionID);
					return;
				}
				void maybeCompleteOnOutput(live, sessionID);
			},
			Math.max(0, remaining),
		);
		deferTimers.set(task.id, handle);
	}

	async function maybeCompleteOnOutput(
		task: BgTask,
		sessionID: string,
	): Promise<void> {
		// Re-read status: between scheduling and here it may have flipped.
		const liveTask = getTask(task.id);
		if (liveTask?.status !== "running") {
			return;
		}
		// One liveness+validity assessment after grace, before the flip (Task 7.1.1).
		const { valid, live } = await assessTurn(liveTask, sessionID);
		if (valid && !live) {
			tryComplete(task.id, "completed");
		}
		// invalid OR still-live → do not complete; the model may still be mid-flight
		// (quiet time is not proof of turn end). Safety nets (poll / stale) will
		// catch a truly-finished session later.
	}

	async function handleEvent(event: Event): Promise<void> {
		if (disposed) {
			return;
		}
		// Track activity for any event mentioning a tracked session — EXCEPT
		// `session.idle` itself: idle is the turn-done boundary, not progress, so
		// counting it as activity would perpetually reset the min-idle grace.
		if (event.type !== "session.idle") {
			const sid = sessionIdOf(event);
			if (sid) {
				const owner = trackedBySession(sid);
				if (owner) {
					lastActivity.set(owner.id, clock.now());
				}
			}
		}

		switch (event.type) {
			case "session.idle":
				await onIdle(event.properties.sessionID);
				return;
			case "session.error": {
				const errSid = event.properties.sessionID;
				if (!errSid) {
					return;
				}
				const task = trackedBySession(errSid);
				if (task) {
					tryComplete(task.id, "error", sessionErrorMessage(event));
				}
				return;
			}
			default:
				return; // untracked/unknown events ignored silently
		}
	}

	function start(): void {
		if (pollHandle || disposed) {
			return;
		}
		pollHandle = setIntervalFn(() => {
			void runPoll();
		}, pollMs);
		pollHandle.unref?.();
	}

	async function runPoll(): Promise<void> {
		if (polling || disposed) {
			return; // re-entrancy guard
		}
		polling = true;
		try {
			const now = clock.now();
			for (const task of runningTasks()) {
				// Only examine sessions that have gone quiet (no recent activity).
				if (now - activityOf(task) < pollMs) {
					continue;
				}
				await pollTask(task, now);
			}
		} finally {
			polling = false;
		}
	}

	async function pollTask(task: BgTask, now: number): Promise<void> {
		// Stale timeout: force-cancel with an anti-replacement instruction.
		if (now - activityOf(task) >= staleTimeoutMs) {
			tryComplete(task.id, "cancelled", STALE_CANCEL_REASON);
			return;
		}
		const sessionID = task.sessionID;
		if (!sessionID) {
			return; // no session yet (still in launch acquire) — nothing to poll
		}

		// Existence check: N consecutive misses → session gone.
		try {
			await sessionExists(sessionID);
			getMisses.delete(task.id);
		} catch {
			const misses = (getMisses.get(task.id) ?? 0) + 1;
			getMisses.set(task.id, misses);
			if (misses >= maxGetMisses) {
				tryComplete(task.id, "error", "session gone");
			}
			return;
		}

		// Session exists and is quiet: the fallback for a missed idle event. Run the
		// SAME liveness+validity assessment the idle path uses (Task 7.1.1) — quiet
		// time alone is not enough; the turn must be provably not live.
		if (graceElapsed(task)) {
			const { valid, live } = await assessTurn(task, sessionID);
			if (valid && !live) {
				tryComplete(task.id, "completed");
			}
		}
	}

	function awaitCompletion(
		taskId: string,
		timeoutMs?: number,
	): Promise<BgTask> {
		const task = getTask(taskId);
		if (task && isTerminal(task.status)) {
			return Promise.resolve(task);
		}
		return new Promise<BgTask>((resolve, reject) => {
			if (!task) {
				reject(new Error(`Unknown task: ${taskId}`));
				return;
			}
			const waiter: Waiter = { resolve, reject };
			let set = waiters.get(taskId);
			if (!set) {
				set = new Set();
				waiters.set(taskId, set);
			}
			set.add(waiter);

			if (timeoutMs !== undefined) {
				waiter.timer = setTimer(() => {
					// Timeout does NOT complete the task — caller decides next.
					const s = waiters.get(taskId);
					if (s) {
						s.delete(waiter);
						if (s.size === 0) {
							waiters.delete(taskId);
						}
					}
					reject(
						new Error(
							`awaitCompletion timeout after ${timeoutMs}ms: ${taskId}`,
						),
					);
				}, timeoutMs);
			}
		});
	}

	function resetForResume(task: BgTask): void {
		getMisses.delete(task.id);
		const dt = deferTimers.get(task.id);
		if (dt) {
			dt.clear();
			deferTimers.delete(task.id);
		}
		// Restart the grace/stale clock so a stale idle from the previous turn
		// can't instantly complete the new one.
		lastActivity.set(task.id, clock.now());
	}

	function markTurnDispatched(task: BgTask): void {
		// Watermark = dispatch moment. Output created before this is a prior turn's
		// and must not validate this turn (Task 6.1.1). The watermark alone fences
		// stale output now that nothing is cached (Task 7.1.1 removed the per-session
		// validity cache), so this is the single bookkeeping write at dispatch.
		turnWatermark.set(task.id, clock.now());
	}

	async function dispose(): Promise<void> {
		disposed = true;
		pollHandle?.clear();
		pollHandle = undefined;
		for (const handle of deferTimers.values()) {
			handle.clear();
		}
		deferTimers.clear();
		// Reject pending waiters; no status mutation.
		for (const [, set] of waiters) {
			for (const w of set) {
				w.timer?.clear();
				w.reject(new Error("CompletionGate disposed"));
			}
		}
		waiters.clear();
	}

	return {
		tryComplete,
		handleEvent,
		awaitCompletion,
		resetForResume,
		markTurnDispatched,
		start,
		dispose,
	};
}
