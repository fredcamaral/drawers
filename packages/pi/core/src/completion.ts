/**
 * CompletionFuser — the exactly-once terminal-transition core for the pi-native
 * runner.
 *
 * This replaces the opencode 843-line CompletionGate. pi gives us FIRST-HAND
 * terminal signals per child, so completion is a small fuser, not a poll-and-
 * validate gate. It fuses three inputs into one terminal transition per task:
 *
 *   1. a terminal `agent_end` event — `willRetry === false` — classified by the
 *      last assistant message's `stopReason`:
 *        - "stop" | "length" | "toolUse" → completed
 *        - "error"                        → error (errorMessage as reason)
 *        - "aborted"                      → cancelled
 *   2. child process exit/error (crash/kill) → error or cancelled.
 *   3. external callers (`cancel()`, prompt-dispatch failure, launch races) via
 *      {@link CompletionFuser.tryComplete}.
 *
 * `willRetry === true` is NON-terminal (pi will auto-retry; another `agent_end`
 * follows). `auto_retry_*` are transient. `extension_error` is recorded as a
 * pending error string but is not itself terminal — a turn that hit an extension
 * error still concludes with an `agent_end`.
 *
 * THE PROMPT WATCHDOG (CRITICAL): pi's stock `RpcClient.prompt()` resolves on ANY
 * `response` frame for the request and does NOT inspect `success` — only the
 * unused `getData` path checks it. So a prompt that fails pi's PREFLIGHT (no API
 * key / expired OAuth, no model selected, a throwing `before_agent_start`
 * extension, a concurrent-prompt rejection) emits `{type:"response",
 * success:false}` which resolves `prompt()` cleanly — yet NO agent run starts, so
 * NO `agent_end` ever fires and the child stays a healthy idle process. Without a
 * guard the task hangs in `running` forever (verified against pi 0.79.3
 * rpc-client.js:135-137,385-389 + rpc-mode.js:294-316). The watchdog converts that
 * silent infinite hang into a diagnosable `error`: {@link armPromptWatchdog} starts
 * a bounded timer on dispatch; the FIRST `agent_start` (the run truly began →
 * preflight succeeded) or any terminal flip disarms it; expiry flips the task to
 * `error`. A real run that exceeds the window is already covered — its `agent_start`
 * disarms the watchdog long before, so only a preflight that never starts a run
 * trips it.
 *
 * THE MUTEX: {@link tryComplete} flips `pending`/`running` → terminal
 * SYNCHRONOUSLY before any await — JS single-threadedness guarantees exactly one
 * winner. All teardown (slot release, child stop, persist, waiter resolution,
 * notification hook) runs detached AFTER the flip, tracked per task so
 * `awaitCompletion`/`resume`/`dispose` can JOIN it.
 *
 * The fuser is presentation-ignorant and timer-light: there is no safety poll,
 * because a live child reports its own terminus. The only timer is the optional
 * per-`awaitCompletion` timeout. Collaborators are injected (factory-DI) so
 * tests drive teardown with deferred promises and no wall-clock sleeps.
 */

import type {
	PiAgentMessage,
	PiAssistantMessage,
	RpcAgentEvent,
} from "./rpc-client";
import type { BgTask, Clock } from "./types";
import { isTerminal } from "./types";

export type TerminalStatus = "completed" | "error" | "cancelled";

/** One-shot timer handle (injected; tests use a manual fake). */
export interface TimerHandle {
	clear(): void;
}

export type TimerFactory = (cb: () => void, ms: number) => TimerHandle;

export interface CompletionFuserDeps {
	/** Look up a task by id (the runner's live map). */
	getTask(taskId: string): BgTask | undefined;
	/**
	 * Release the concurrency resource the task holds. The runner decides
	 * release-vs-cancelWaiter; the fuser signals "done with the slot".
	 * Synchronous; the fuser calls it at most once per task (mutex-guaranteed).
	 */
	freeSlot(task: BgTask): void;
	/**
	 * Tear down the task's live child, if any (SIGTERM → SIGKILL). Awaited;
	 * failures are caught + logged, never rethrown. A torn-down/never-spawned
	 * task is a no-op. The runner also detaches event subscriptions here.
	 */
	teardownChild(task: BgTask): Promise<void>;
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
	/**
	 * Bound (ms) for the prompt watchdog: max time a dispatched prompt may stay
	 * silent (no `agent_start`, no terminal `agent_end`) before the fuser flips the
	 * task to error. Guards the stock-client `success:false` swallow (see the file
	 * header). `<= 0` or absent disables the watchdog. Default disabled — the runner
	 * passes a concrete value.
	 */
	promptWatchdogMs?: number;
}

export interface CompletionFuser {
	/**
	 * Synchronously flip a task to a terminal status (the mutex), then run async
	 * teardown. Returns true iff this call won the flip. The boolean reflects the
	 * flip; teardown runs detached.
	 */
	tryComplete(
		taskId: string,
		terminal: TerminalStatus,
		reason?: string,
	): boolean;
	/**
	 * Feed one child event for a task. Classifies a terminal `agent_end`
	 * (willRetry:false) and funnels it into {@link tryComplete}; records an
	 * `extension_error` as a pending reason; ignores everything else.
	 */
	onEvent(taskId: string, event: RpcAgentEvent): void;
	/** Feed a child exit/error for a task → error (crash) / unchanged (clean). */
	onExit(taskId: string, info: { code: number | null; error?: Error }): void;
	/**
	 * Arm the prompt watchdog for a task whose prompt was just dispatched. A no-op
	 * when {@link CompletionFuserDeps.promptWatchdogMs} is unset/`<= 0`. Idempotent
	 * per task: a re-arm replaces any prior timer (the prior run already concluded
	 * if we are re-dispatching). The timer is cleared by the first `agent_start` /
	 * terminal flip, or fires an `error` flip on expiry.
	 */
	armPromptWatchdog(taskId: string): void;
	awaitCompletion(taskId: string, timeoutMs?: number): Promise<BgTask>;
	/**
	 * Reset per-turn bookkeeping for a task being resumed: clears the pending
	 * extension-error reason. Call AFTER the task is back to `running`, before the
	 * new prompt is dispatched.
	 */
	resetForResume(task: BgTask): void;
	dispose(): Promise<void>;
}

interface Waiter {
	resolve: (task: BgTask) => void;
	reject: (err: Error) => void;
	timer?: TimerHandle;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** The last assistant message in a transcript (defensive on wire data). */
function lastAssistant(
	messages: PiAgentMessage[] | undefined,
): PiAssistantMessage | undefined {
	if (!Array.isArray(messages)) {
		return undefined;
	}
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const m = messages[i];
		if (m && (m as { role?: unknown }).role === "assistant") {
			return m as PiAssistantMessage;
		}
	}
	return undefined;
}

/** Bottom default error reason when no message and no extension error exist. */
export const DEFAULT_ERROR_REASON = "agent error";

/**
 * Classify a terminal `agent_end` by its last assistant message's `stopReason`.
 * No assistant message / unknown stopReason → completed (the run ended without
 * an error or abort signal; treat a benign terminus as success).
 *
 * For an `error` terminus, `reason` carries the assistant's RAW `errorMessage`,
 * which may be `undefined`. The caller (the fuser's `onEvent`) owns the fallback
 * chain — `errorMessage` → recorded `extension_error` → {@link DEFAULT_ERROR_REASON}
 * — so the precedence lives in one place and an extension error is not masked by a
 * baked-in default here.
 */
export function classifyAgentEnd(messages: PiAgentMessage[] | undefined): {
	terminal: TerminalStatus;
	reason?: string;
} {
	const assistant = lastAssistant(messages);
	const stopReason = assistant?.stopReason;
	if (stopReason === "error") {
		return { terminal: "error", reason: assistant?.errorMessage };
	}
	if (stopReason === "aborted") {
		return { terminal: "cancelled", reason: "aborted" };
	}
	return { terminal: "completed" };
}

export function createCompletionFuser(
	deps: CompletionFuserDeps,
): CompletionFuser {
	const {
		getTask,
		freeSlot,
		teardownChild,
		clock,
		persist,
		onTaskComplete,
		logger,
		setTimer,
		promptWatchdogMs,
	} = deps;

	/** awaitCompletion registry, keyed by task id. */
	const waiters = new Map<string, Set<Waiter>>();
	/**
	 * Latest out-of-band extension-error reason per task, used as the error
	 * string if a terminal agent_end with an error stopReason carries none.
	 */
	const pendingExtError = new Map<string, string>();
	/**
	 * In-flight detached teardown per task id. `tryComplete` flips synchronously
	 * and schedules teardown detached; anything that must observe the COMPLETED
	 * teardown (released slot, stopped child, stamped `completedAt`, persisted
	 * state) joins this promise. Removed once it settles (teardown never rejects).
	 */
	const teardowns = new Map<string, Promise<void>>();
	/**
	 * Per-task prompt watchdog timer. Armed on `armPromptWatchdog`, cleared by the
	 * first `agent_start`/terminal flip, fires an `error` flip on expiry. See the
	 * file header (the stock-client `success:false` swallow).
	 */
	const watchdogs = new Map<string, TimerHandle>();
	let disposed = false;

	/** Clear and forget a task's prompt watchdog timer, if armed. */
	function disarmWatchdog(taskId: string): void {
		const t = watchdogs.get(taskId);
		if (t) {
			watchdogs.delete(taskId);
			t.clear();
		}
	}

	function armPromptWatchdog(taskId: string): void {
		if (disposed || promptWatchdogMs === undefined || promptWatchdogMs <= 0) {
			return;
		}
		// Re-arm replaces any prior timer (the prior turn has concluded if we are
		// re-dispatching).
		disarmWatchdog(taskId);
		const handle = setTimer(() => {
			watchdogs.delete(taskId);
			// Only the silent-preflight case survives to here: a started run emitted
			// agent_start (disarm) and a concluded run flipped terminal (disarm). A
			// still pending/running task at expiry never produced an agent_start →
			// the prompt was almost certainly rejected by preflight (no key / no
			// model / extension throw) and pi's stock prompt() swallowed the
			// success:false response. Flip to a diagnosable error.
			tryComplete(
				taskId,
				"error",
				`prompt produced no agent activity within ${promptWatchdogMs}ms ` +
					`(likely a preflight rejection — missing/invalid API key, no model ` +
					`selected, or a before_agent_start extension error)`,
			);
		}, promptWatchdogMs);
		watchdogs.set(taskId, handle);
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
		// A terminal flip ends any outstanding prompt — drop its watchdog.
		disarmWatchdog(task.id);
		const inflight = teardown(task, reason).finally(() => {
			teardowns.delete(task.id);
		});
		teardowns.set(task.id, inflight);
		return true;
	}

	async function teardown(task: BgTask, reason?: string): Promise<void> {
		// (1) release the concurrency slot first (leak guard).
		try {
			freeSlot(task);
		} catch (err) {
			logger?.error?.("freeSlot failed", { id: task.id, err: errorText(err) });
		}

		// (2) tear down the live child (kills the pi process / detaches events).
		//     AWAIT it — a dangling teardown promise is a crash source. Catch + log.
		try {
			await teardownChild(task);
		} catch (err) {
			logger?.error?.("teardownChild failed", {
				id: task.id,
				err: errorText(err),
			});
		}

		// (3) stamp completion, set error text, persist.
		task.completedAt = clock.now();
		if (reason !== undefined) {
			task.error = reason;
		}
		pendingExtError.delete(task.id);
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

	function onEvent(taskId: string, event: RpcAgentEvent): void {
		if (disposed) {
			return;
		}
		if (event.type === "agent_start") {
			// The run actually began → preflight succeeded. Disarm the watchdog; a
			// long-running real turn must not be misclassified as a silent prompt.
			disarmWatchdog(taskId);
			return;
		}
		if (event.type === "extension_error") {
			// Out-of-band; record but do NOT complete. A terminal agent_end follows.
			const e = event as Extract<RpcAgentEvent, { type: "extension_error" }>;
			pendingExtError.set(
				taskId,
				`extension error (${e.extensionPath}): ${e.error}`,
			);
			return;
		}
		if (event.type !== "agent_end") {
			return; // auto_retry_*, turn_*, message_*, etc. — non-terminal
		}
		const end = event as Extract<RpcAgentEvent, { type: "agent_end" }>;
		// willRetry:true → pi will auto-retry this prompt; another agent_end
		// follows. NON-terminal — ignore.
		if (end.willRetry === true) {
			return;
		}
		const { terminal, reason } = classifyAgentEnd(end.messages);
		// Error-reason precedence: the assistant's own errorMessage wins; else the
		// out-of-band extension error recorded this turn; else the bottom default.
		const effectiveReason =
			terminal === "error"
				? (reason ?? pendingExtError.get(taskId) ?? DEFAULT_ERROR_REASON)
				: reason;
		tryComplete(taskId, terminal, effectiveReason);
	}

	function onExit(
		taskId: string,
		info: { code: number | null; error?: Error },
	): void {
		if (disposed) {
			return;
		}
		const task = getTask(taskId);
		if (!task || isTerminal(task.status)) {
			// Clean exit AFTER a terminal agent_end already completed the task is the
			// normal teardown path (stop() kills the child) — nothing to do.
			return;
		}
		// The child died while the task was still live: a crash/kill between or
		// mid-turn that no agent_end will ever close. Flip to error.
		const reason = info.error
			? `pi process error: ${info.error.message}`
			: `pi process exited (code=${info.code})`;
		tryComplete(taskId, "error", reason);
	}

	function awaitCompletion(
		taskId: string,
		timeoutMs?: number,
	): Promise<BgTask> {
		const task = getTask(taskId);
		if (task && isTerminal(task.status)) {
			// Already terminal — join any in-flight detached teardown so the caller
			// observes the released slot, stopped child, stamped completedAt, and
			// persisted state at resolve time.
			const inflight = teardowns.get(taskId);
			return inflight ? inflight.then(() => task) : Promise.resolve(task);
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
		pendingExtError.delete(task.id);
	}

	async function dispose(): Promise<void> {
		disposed = true;
		// Drop every armed prompt watchdog (their tasks are being torn down).
		for (const [, t] of watchdogs) {
			t.clear();
		}
		watchdogs.clear();
		// Drain live detached teardowns FIRST: they resolve their own waiters and
		// persist terminal state — rejecting those waiters here would race the
		// teardown's resolution, and dropping them would lose persists.
		await Promise.allSettled([...teardowns.values()]);
		for (const [, set] of waiters) {
			for (const w of set) {
				w.timer?.clear();
				w.reject(new Error("CompletionFuser disposed"));
			}
		}
		waiters.clear();
	}

	return {
		tryComplete,
		onEvent,
		onExit,
		armPromptWatchdog,
		awaitCompletion,
		resetForResume,
		dispose,
	};
}
