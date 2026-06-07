/**
 * WakeNotifier — active parent-wake on terminal completion (Epic 6.3, Task 6.3.1).
 *
 * Design decision 1 was REVERSED 2026-06-07 (CC parity). Active wake is now the
 * goal, but the original rationale survives as a CONSTRAINT: OpenCode does NOT
 * serialize concurrent session prompts, and oh-my-opencode's wake cost ~24 files
 * of crash-mitigation sprawl precisely because it woke busy parents. So the wake
 * fires ONLY when the parent is idle (or genuinely absent from the status map);
 * a busy/retry parent falls back to the existing passive flush
 * ({@link createChatMessageHook}). No retry timers, no polling — a wake is only
 * ever attempted the moment a completion notice arrives.
 *
 * EXACTLY-ONCE falls out of the SAME queue this shares with the passive flush:
 *   - the wake reads pending notices with `queue.pending(parent)` (non-draining),
 *   - on a SUCCESSFUL promptAsync it consumes them with `queue.flushFor(parent)`
 *     (the identical drain+markNotified the chat.message hook uses),
 *   - on ANY failure (busy parent / status() throw / promptAsync throw) it does
 *     NOT call flushFor, so the notices stay queued for the passive layer.
 * Whichever path drains first wins; the other sees an empty list. There is no
 * bespoke "woken" flag — the queue's drain semantics ARE the exactly-once gate.
 *
 * status() throw vs. absent — a deliberate asymmetry:
 *   - ABSENT (a successful read with no entry for the parent) → WAKE. The failure
 *     mode 6.x fixes is silence; an absent entry means the parent is reachable but
 *     not busy, so waking is correct.
 *   - status() THROWING (a FAILED read) → DO NOT WAKE. We will not prompt-inject a
 *     parent whose state we could not read; the passive flush remains the
 *     guaranteed fallback. The throw is fenced and logged, never propagated.
 *
 * Coalescing + per-parent in-flight guard: N completions for one parent collapse
 * into ONE wake carrying all currently-pending notices; a second concurrent
 * notify() for a parent already mid-wake is suppressed (its notice is picked up by
 * the in-flight wake's flush, or remains queued for the next trigger / passive
 * flush). The guard is keyed per parent, so distinct parents wake independently.
 */

import type {
	NotificationQueue,
	NotificationQueueLogger,
	TaskNotice,
} from "./notify";
import type { Clock } from "./types";

/**
 * `SessionStatus` per docs/sdk-surface-audit.md row f: the GLOBAL `/session/status`
 * response is a map keyed by session id; each value is one of these variants.
 */
export type WakeSessionStatus =
	| { type: "idle" }
	| { type: "retry"; attempt: number; message: string; next: number }
	| { type: "busy" };

/** The global status map: `{ [sessionID]: SessionStatus }` (audit row f). */
export type WakeSessionStatusMap = Record<string, WakeSessionStatus>;

/**
 * The minimal structural SDK surface the wake uses: the global `session.status`
 * map read (audit row f) and `session.promptAsync` (audit row b). Both typed; no
 * `as any`. `promptAsync` to the PARENT omits `agent` (the parent keeps its own;
 * `agent` is optional on the body — audit row b confirms it).
 */
export interface WakeClient {
	session: {
		status(): Promise<{ data?: WakeSessionStatusMap | null }>;
		promptAsync(opts: {
			path: { id: string };
			body: {
				agent?: string;
				parts: Array<{ type: "text"; text: string }>;
			};
		}): Promise<unknown>;
	};
}

export interface WakeNotifierDeps {
	client: WakeClient;
	queue: NotificationQueue;
	/**
	 * Reserved for the factory contract (callers pass a Clock alongside the other
	 * collaborators). The wake itself is event-driven and clock-free — duration is
	 * already carried on each {@link TaskNotice} — so it is intentionally unused
	 * here rather than invented into the wake text.
	 */
	clock: Clock;
	logger?: NotificationQueueLogger;
}

export interface WakeNotifier {
	/**
	 * Called on a terminal transition, alongside the toast, for the completing
	 * task's notice. Attempts to wake the notice's parent if idle/absent; coalesces
	 * all of that parent's pending notices into one prompt. Never throws.
	 */
	notify(notice: TaskNotice): Promise<void>;
}

/** Build the demarcated, CC-style wake text from a parent's pending notices. */
function buildWakeText(notices: TaskNotice[]): string {
	const lines = notices.map((n) => n.hint).join("\n");
	return (
		"[task-notification]\n" +
		`${lines}\n` +
		"— automated notice, not the user; read the results with the matching " +
		"status tool. Do not reply to this notice."
	);
}

export function createWakeNotifier(deps: WakeNotifierDeps): WakeNotifier {
	const { client, queue, logger } = deps;
	// Per-parent in-flight guard: a parent with a wake in flight is in this set.
	const inFlight = new Set<string>();

	async function notify(notice: TaskNotice): Promise<void> {
		const parent = notice.parentSessionID;

		// Per-parent in-flight guard: a concurrent wake is already coalescing this
		// parent's notices — its flush will include any newly-queued ones.
		if (inFlight.has(parent)) {
			return;
		}

		// Read (non-draining) the parent's currently-pending notices. If none, the
		// passive flush already consumed them; nothing to wake about.
		const pending = queue.pending(parent);
		if (pending.length === 0) {
			return;
		}

		inFlight.add(parent);
		try {
			// (1) Status read. A THROW here is a FAILED read — fence, log, leave
			// queued (≠ the successful "absent" reading below).
			let statusMap: WakeSessionStatusMap;
			try {
				const res = await client.session.status();
				statusMap = res.data ?? {};
			} catch (err) {
				logger?.error?.(
					"wake: session.status() failed, leaving notices queued",
					{
						parent,
						err: err instanceof Error ? err.message : String(err),
					},
				);
				return;
			}

			// (2) Wake only on idle OR ABSENT (absent ≠ busy). busy/retry → leave
			// queued for the passive flush.
			const status = statusMap[parent];
			const shouldWake = status === undefined || status.type === "idle";
			if (!shouldWake) {
				return;
			}

			// (3) Re-snapshot pending at send time (more may have arrived since the
			// status await) and coalesce into ONE prompt.
			const toSend = queue.pending(parent);
			if (toSend.length === 0) {
				return;
			}

			// (4) Wake. `agent` omitted — the parent keeps its own agent.
			await client.session.promptAsync({
				path: { id: parent },
				body: {
					parts: [{ type: "text", text: buildWakeText(toSend) }],
				},
			});

			// (5) Consume-on-success ONLY: drain + markNotified via the SAME
			// flushFor the passive hook uses. A throw above skips this → notices
			// remain queued (exactly-once preserved against the flush).
			queue.flushFor(parent);
		} catch (err) {
			// promptAsync (or anything past the status read) failed: do NOT consume.
			// Notices remain queued for the passive flush.
			logger?.error?.("wake: promptAsync failed, leaving notices queued", {
				parent,
				err: err instanceof Error ? err.message : String(err),
			});
		} finally {
			inFlight.delete(parent);
		}
	}

	return { notify };
}
