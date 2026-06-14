/**
 * In-process completion notifier — the pi-native collapse of opencode's
 * `wake-notifier.ts` + `notify-hooks.ts`.
 *
 * In opencode the parent was a REMOTE session, so waking it required a status-map
 * read, a `promptAsync` over the SDK, an at-least-once retry loop, and a
 * per-parent in-flight guard (~18KB of crash-mitigation sprawl). In pi the
 * completing child's terminal transition fires INSIDE the parent process, in the
 * parent's own runner — so the whole apparatus collapses to:
 *
 *   - {@link createCompletionNotifier} builds the engine's `onTaskComplete` /
 *     `onNotify` sink. On each terminal notice it (1) surfaces a `ctx.ui.notify`
 *     toast and (2) ACTIVELY wakes the parent IF idle, via
 *     `pi.sendUserMessage(hint, { deliverAs: "followUp" })` — no network, no
 *     status read, no retry loop. A BUSY parent is left alone; its notices stay
 *     queued for the passive drain below (we do NOT wake a busy parent — the one
 *     constraint that survived opencode's active-wake reversal).
 *   - {@link createBeforeAgentStartDrain} is the passive fallback: on the
 *     parent's next prompt it drains `queue.flushFor(parentSessionID)` and injects
 *     the pending notices as a synthetic `before_agent_start` message, catching
 *     completions that landed while the parent was mid-turn (and so were not woken).
 *
 * Everything is fenced: a throwing `ui.notify`, a throwing `sendUserMessage`, or a
 * throwing queue drain must NEVER break completion teardown or the user's prompt.
 *
 * Node-safe: no Bun.* APIs.
 */

import type {
	NotificationQueue,
	TaskNotice,
	TaskStatus,
} from "@drawers/pi-core";
import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { EngineLogger } from "./engine";

/** Terminal status → notify level (pi `ctx.ui.notify` takes info|warning|error). */
type NotifyLevel = "info" | "warning" | "error";
const STATUS_LEVEL: Record<TaskStatus, NotifyLevel> = {
	pending: "info",
	running: "info",
	completed: "info",
	error: "error",
	cancelled: "warning",
};

/** Terminal status → summary emoji (visible toast prefix). */
const STATUS_EMOJI: Record<TaskStatus, string> = {
	pending: "⏳",
	running: "▶️",
	completed: "✅",
	error: "❌",
	cancelled: "🚫",
};

/** One compact human line for the visible toast. */
function toastText(notice: TaskNotice): string {
	const emoji = STATUS_EMOJI[notice.status] ?? "•";
	return `${emoji} ${notice.taskId} '${notice.description}' ${notice.status}`;
}

/** The demarcated wake text — names the retrieval tool, says it is automated. */
function buildWakeText(notices: readonly TaskNotice[]): string {
	const lines = notices.map((n) => n.hint).join("\n");
	return (
		"[task-notification]\n" +
		`${lines}\n` +
		"— automated notice, not the user; read the results with bg_output. " +
		"Do not reply to this notice."
	);
}

export interface CompletionNotifierDeps {
	pi: ExtensionAPI;
	/** The live parent session context (captured at session_start). */
	ctx: ExtensionContext;
	/** The parent session id this notifier wakes. */
	parentSessionID: string;
	/** The notice queue; the wake consumes exactly the snapshot it delivered. */
	queue: Pick<NotificationQueue, "pending" | "consume">;
	logger?: EngineLogger;
}

/**
 * Build the engine's `onNotify` sink: toast + active in-process wake (idle only).
 * Returned as a `(notice) => void` so it slots straight into
 * {@link CreateEngineOptions.onNotify}.
 */
export function createCompletionNotifier(
	deps: CompletionNotifierDeps,
): (notice: TaskNotice) => void {
	const { pi, ctx, parentSessionID, queue, logger } = deps;

	return (notice) => {
		// (1) Visible toast. Fully fenced — a throwing notify must not break the
		// queue push path that invoked us.
		try {
			if (ctx.hasUI) {
				ctx.ui.notify(toastText(notice), STATUS_LEVEL[notice.status] ?? "info");
			}
		} catch (err) {
			logger?.error("ui.notify threw", {
				id: notice.taskId,
				err: err instanceof Error ? err.message : String(err),
			});
		}

		// (2) Active wake — only when the parent is IDLE. A busy parent is left to
		// the passive drain (before_agent_start). The completion fired in THIS
		// process for THIS parent's runner, so the notice always targets us; the
		// parent-id guard is belt-and-suspenders against a future multiplexed runner.
		if (notice.parentSessionID !== parentSessionID) {
			return;
		}
		let idle: boolean;
		try {
			idle = ctx.isIdle();
		} catch {
			idle = false;
		}
		if (!idle) {
			return;
		}

		// Snapshot every pending notice for this parent (coalesce N completions into
		// one wake) and deliver them in a single follow-up message, then consume
		// exactly that snapshot. Notices arriving mid-flight stay queued for the
		// passive drain or the next completion's wake.
		const toSend = queue.pending(parentSessionID);
		if (toSend.length === 0) {
			return;
		}
		try {
			pi.sendUserMessage(buildWakeText(toSend), { deliverAs: "followUp" });
			queue.consume(parentSessionID, toSend);
		} catch (err) {
			// Leave the notices queued for the passive flush — do NOT consume.
			logger?.error("wake sendUserMessage threw, leaving notices queued", {
				parent: parentSessionID,
				err: err instanceof Error ? err.message : String(err),
			});
		}
	};
}

export interface BeforeAgentStartDrainDeps {
	parentSessionID: string;
	queue: Pick<NotificationQueue, "flushFor">;
	logger?: EngineLogger;
}

/**
 * Build the `before_agent_start` passive drain. On the parent's next prompt it
 * flushes the per-parent queue and injects the pending notices as a synthetic,
 * model-only message so the assistant knows to call `bg_output`. The user's
 * visible prompt is untouched. Fully fenced: a throw here would break the prompt,
 * so a queue/render failure logs and the turn proceeds untouched.
 *
 * Returns the `before_agent_start` handler's contribution: `{ message }` when
 * there are notices, else `undefined` (no change).
 */
export function createBeforeAgentStartDrain(deps: BeforeAgentStartDrainDeps) {
	const { parentSessionID, queue, logger } = deps;
	return (
		_event: BeforeAgentStartEvent,
		_ctx: ExtensionContext,
	):
		| { message: { customType: string; content: string; display: false } }
		| undefined => {
		try {
			const notices = queue.flushFor(parentSessionID);
			if (notices.length === 0) {
				return undefined;
			}
			const content = buildWakeText(notices);
			return {
				message: {
					customType: "bg_notification",
					content,
					display: false,
				},
			};
		} catch (err) {
			logger?.error("before_agent_start drain failed", {
				err: err instanceof Error ? err.message : String(err),
			});
			return undefined;
		}
	};
}
