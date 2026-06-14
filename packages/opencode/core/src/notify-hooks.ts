/**
 * `chat.message` flush hook + TUI toast notifier — the passive presentation
 * layer over {@link NotificationQueue} / {@link TaskNotice}.
 *
 * Decision 1 of the plan: background-task (and, from Phase 4, workflow)
 * completions never actively wake the parent. They wait in the per-parent
 * {@link NotificationQueue} until the parent sends its NEXT message, at which
 * point opencode invokes the `chat.message` hook — the passive drain point.
 * This module owns that drain. It is generic over the queue/notice types and
 * carries nothing task-domain-specific in code: the only domain-flavored bits
 * (the visible summary wording and the synthetic-hint framing) are factored out
 * as an optional {@link NotifyRenderOptions}, defaulting to the original
 * background-agents text so existing call sites stay bit-identical.
 *
 * CRITICAL: `chat.message` runs inside the prompt pipeline. A THROW here kills
 * the user's message before it reaches the model. So the entire hook body is
 * fenced in try/catch and never propagates — a queue or render failure logs and
 * the message proceeds untouched. Logging is `client.app.log`-backed (injected
 * as {@link NotificationQueueLogger}); never `console`.
 *
 * On a non-empty flush the hook pushes EXACTLY two parts onto `output.parts`
 * (mutated in place — never reassigned, per the hook contract):
 *   1. ONE visible {@link TextPart}: one human-readable line per notice
 *      (`✅ bg_abc12345 'description' completed in 32s`);
 *   2. ONE `synthetic: true` {@link TextPart}: the model-only retrieval hints,
 *      one per notice, so the assistant knows to call the retrieval tool.
 *
 * Visible-first, synthetic-second: the human reads the summary; the model reads
 * both but acts on the synthetic instruction.
 */

import type { Hooks } from "@opencode-ai/plugin";
import { humanizeDuration } from "./format";
import type { NotificationQueueLogger, TaskNotice } from "./notify";
import type { TaskStatus } from "./types";
import type { WakeNotifier } from "./wake-notifier";

/**
 * The hook output's `parts` element type, derived from the plugin's own `Hooks`
 * surface. `@opencode-ai/plugin` does not re-export `Part`/`TextPart`, so we lift
 * the rendered part type straight from the `chat.message` signature rather than
 * reaching into `@opencode-ai/sdk`.
 */
type ChatMessageHook = NonNullable<Hooks["chat.message"]>;
type ChatMessageOutput = Parameters<ChatMessageHook>[1];
type Part = ChatMessageOutput["parts"][number];
type TextPart = Extract<Part, { type: "text" }>;

/** Terminal status → summary emoji. */
const STATUS_EMOJI: Record<TaskStatus, string> = {
	pending: "⏳",
	running: "▶️",
	completed: "✅",
	error: "❌",
	cancelled: "🚫",
};

/** Terminal status → toast variant (SDK `TuiShowToastData.body.variant`). */
type ToastVariant = "info" | "success" | "warning" | "error";
const STATUS_VARIANT: Record<TaskStatus, ToastVariant> = {
	pending: "info",
	running: "info",
	completed: "success",
	error: "error",
	cancelled: "info",
};

/**
 * Domain-flavored rendering hooks. Every field defaults to the original
 * background-agents wording, so a call site that passes nothing renders
 * bit-identically. A different domain (e.g. the workflows plugin) overrides only
 * the strings it wants to reword without re-implementing the layout.
 */
export interface NotifyRenderOptions {
	/** Visible toast title, given a terminal notice. Default: `Background task <status>`. */
	toastTitle?: (notice: TaskNotice) => string;
}

/** One compact human line for the visible summary part. */
function visibleLine(notice: TaskNotice): string {
	const emoji = STATUS_EMOJI[notice.status] ?? "•";
	const base = `${emoji} ${notice.taskId} '${notice.description}' ${notice.status}`;
	return notice.durationMs !== undefined
		? `${base} in ${humanizeDuration(notice.durationMs)}`
		: base;
}

/** Default toast title: `Background task <status>`. */
function defaultToastTitle(notice: TaskNotice): string {
	return `Background task ${notice.status}`;
}

/**
 * Build a full {@link TextPart}. The hook output is `Part[]` (the rendered SDK
 * type), not `TextPartInput` — so `id`/`sessionID`/`messageID` are required.
 * Source session/message from `output.message`; ids are deterministic per
 * message so a double-fire would collide rather than duplicate silently.
 */
function makeTextPart(opts: {
	id: string;
	sessionID: string;
	messageID: string;
	text: string;
	synthetic?: boolean;
}): TextPart {
	const part: TextPart = {
		id: opts.id,
		sessionID: opts.sessionID,
		messageID: opts.messageID,
		type: "text",
		text: opts.text,
	};
	if (opts.synthetic) {
		part.synthetic = true;
	}
	return part;
}

/**
 * Build the `chat.message` hook bound to a notification queue.
 *
 * @param queue  the per-parent notice queue; `flushFor` drains oldest-first and
 *               fires `markNotified` internally. Typed structurally at the ONE
 *               member the hook uses, so any `NotificationQueue<T>` (BgTask or
 *               the workflows RunRecord) passes without casts (finding #3).
 * @param logger optional structured logger for swallowed-failure reporting.
 */
export function createChatMessageHook(
	queue: { flushFor(parentSessionID: string): TaskNotice[] },
	logger?: NotificationQueueLogger,
): NonNullable<Hooks["chat.message"]> {
	return async (input, output) => {
		try {
			const notices = queue.flushFor(input.sessionID);
			if (notices.length === 0) {
				return;
			}

			const sessionID = output.message.sessionID;
			const messageID = output.message.id;

			const visibleText = notices.map(visibleLine).join("\n");
			const syntheticText = notices.map((n) => n.hint).join("\n");

			// Mutate in place — push, never reassign output.parts. TextPart is a
			// member of the Part union, so no cast is needed.
			output.parts.push(
				makeTextPart({
					id: `prt_bgnotify_${messageID}_visible`,
					sessionID,
					messageID,
					text: visibleText,
				}),
			);
			output.parts.push(
				makeTextPart({
					id: `prt_bgnotify_${messageID}_synthetic`,
					sessionID,
					messageID,
					text: syntheticText,
					synthetic: true,
				}),
			);
		} catch (err) {
			// chat.message is prompt-pipeline: a throw kills the user's message.
			// Swallow + log; the message proceeds without notices.
			logger?.error?.("chat.message flush hook failed", {
				err: err instanceof Error ? err.message : String(err),
			});
		}
	};
}

/** Minimal structural surface of `client.tui.showToast` (audit row h). */
export type ShowToast = (data: {
	body?: {
		title?: string;
		message: string;
		variant: ToastVariant;
		duration?: number;
	};
}) => Promise<unknown>;

/**
 * Build the `onNotify` callback for the engine: render each terminal notice as
 * a TUI toast. Toast failures (sync throw OR rejected promise) are swallowed and
 * logged — a toast must NEVER break completion teardown.
 *
 * @param showToast the TUI toast sink (structural `client.tui.showToast`).
 * @param logger    optional structured logger for swallowed-failure reporting.
 * @param render    optional domain wording overrides; defaults reproduce the
 *                  original background-agents text bit-for-bit.
 */
export function createToastNotifier(
	showToast: ShowToast,
	logger?: NotificationQueueLogger,
	render?: NotifyRenderOptions,
): (notice: TaskNotice) => void {
	const toastTitle = render?.toastTitle ?? defaultToastTitle;
	return (notice) => {
		// EVERYTHING inside the fence (finding #8): `toastTitle` is user-supplied,
		// so its render runs under the same try as the toast call — a throwing
		// override must not escape the notifier any more than a throwing toast.
		try {
			const variant = STATUS_VARIANT[notice.status] ?? "info";
			const title = toastTitle(notice);
			const message =
				notice.durationMs !== undefined
					? `${notice.taskId} '${notice.description}' in ${humanizeDuration(notice.durationMs)}`
					: `${notice.taskId} '${notice.description}'`;
			const result = showToast({ body: { title, message, variant } });
			if (result && typeof result.then === "function") {
				result.catch((err: unknown) => {
					logger?.error?.("tui.showToast rejected", {
						id: notice.taskId,
						err: err instanceof Error ? err.message : String(err),
					});
				});
			}
		} catch (err) {
			logger?.error?.("tui.showToast threw", {
				id: notice.taskId,
				err: err instanceof Error ? err.message : String(err),
			});
		}
	};
}

/**
 * Compose the engine's `onNotify` seam to fire BOTH the existing toast AND the
 * active wake (Task 6.3.2) on every terminal notice.
 *
 * The toast fires first (synchronous, visual). The wake is fire-and-forget: its
 * own body is fully fenced and never rejects, but we still `.catch` to honor the
 * "no ignored errors" rule belt-and-suspenders. The passive flush remains the
 * fallback for busy/failed wakes — this only ADDS the wake; it changes nothing
 * about the toast or the queue.
 *
 * The wake is resolved through `getWake` rather than passed directly because of a
 * construction-order cycle: the wake notifier needs the engine's queue, but the
 * engine needs this `onNotify` at construction time. The entry builds the engine
 * first, then assigns the wake; the getter closes that loop. `onNotify` is only
 * ever invoked at runtime (on completions, long after wiring), so the wake is
 * always present by then.
 */
export function createWakeOnNotify(
	toast: (notice: TaskNotice) => void,
	getWake: () => WakeNotifier | undefined,
	logger?: NotificationQueueLogger,
): (notice: TaskNotice) => void {
	return (notice) => {
		// Fence the toast (finding #8): it is a user-supplied callback invoked on
		// the queue's push path — a throw here must not break the enqueue, and must
		// not suppress the wake.
		try {
			toast(notice);
		} catch (err) {
			logger?.error?.("toast callback threw", {
				id: notice.taskId,
				err: err instanceof Error ? err.message : String(err),
			});
		}
		const wake = getWake();
		if (!wake) {
			return;
		}
		void wake.notify(notice).catch((err: unknown) => {
			logger?.error?.("wake notifier threw", {
				id: notice.taskId,
				err: err instanceof Error ? err.message : String(err),
			});
		});
	};
}
