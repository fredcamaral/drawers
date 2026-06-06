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

/** A message as returned by `session.messages` (audit row c), narrowed. */
export interface GateMessage {
	info: { role: "user" | "assistant" };
	parts: Array<{ type: string; text?: string }>;
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

/** A session has valid output iff ≥1 assistant message has non-empty text/tool parts. */
function hasValidOutput(messages: GateMessage[]): boolean {
	for (const m of messages) {
		if (m.info.role !== "assistant") {
			continue;
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

export function createCompletionGate(deps: CompletionGateDeps): CompletionGate {
	const {
		getTask,
		runningTasks,
		freeSlot,
		abortSession,
		fetchMessages,
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
	/** Sessions whose output has been validated once (no need to refetch). */
	const validatedSessions = new Set<string>();
	/** Consecutive `session.get` miss counts per task id. */
	const getMisses = new Map<string, number>();
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
		const dt = deferTimers.get(task.id);
		if (dt) {
			dt.clear();
			deferTimers.delete(task.id);
		}
		if (task.sessionID) {
			validatedSessions.delete(task.sessionID);
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

	/** Validate output for a tracked running session; cache positive results. */
	async function outputIsValid(sessionID: string): Promise<boolean> {
		if (validatedSessions.has(sessionID)) {
			return true;
		}
		let messages: GateMessage[];
		try {
			messages = await fetchMessages(sessionID);
		} catch (err) {
			logger?.debug?.("fetchMessages failed during validation", {
				sessionID,
				err: errorText(err),
			});
			return false;
		}
		if (hasValidOutput(messages)) {
			validatedSessions.add(sessionID);
			return true;
		}
		return false;
	}

	/** Find the tracked running/pending task owning a session id. */
	function trackedBySession(sessionID: string): BgTask | undefined {
		for (const t of runningTasks()) {
			if (t.sessionID === sessionID) {
				return t;
			}
		}
		return undefined;
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
		const live = getTask(task.id);
		if (live?.status !== "running") {
			return;
		}
		if (await outputIsValid(sessionID)) {
			tryComplete(task.id, "completed");
		}
		// invalid → do not complete; the model may still be mid-flight. Safety
		// nets (poll / stale) will catch a truly-finished session later.
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

		// Session exists and is quiet: the fallback for a missed idle event.
		if (graceElapsed(task) && (await outputIsValid(sessionID))) {
			tryComplete(task.id, "completed");
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

	return { tryComplete, handleEvent, awaitCompletion, start, dispose };
}
