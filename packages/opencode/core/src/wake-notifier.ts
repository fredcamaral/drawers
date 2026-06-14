/**
 * WakeNotifier — active parent-wake on terminal completion (Epic 6.3, Task 6.3.1).
 *
 * Design decision 1 was REVERSED 2026-06-07 (CC parity). Active wake is now the
 * goal, but the original rationale survives as a CONSTRAINT: OpenCode does NOT
 * serialize concurrent session prompts, and oh-my-opencode's wake cost ~24 files
 * of crash-mitigation sprawl precisely because it woke busy parents. So the wake
 * fires ONLY when the parent is idle (or genuinely absent from the status map);
 * a busy/retry parent falls back to the existing passive flush
 * ({@link createChatMessageHook}). No retry timers, no polling — wakes are only
 * ever attempted while a completion notice's `notify()` call is being handled.
 *
 * DELIVERY SEMANTICS — AT-LEAST-ONCE, never silent loss (review finding #4):
 *   - a wake snapshots the parent's pending notices, sends them in ONE prompt,
 *     and on success consumes EXACTLY that snapshot (`queue.consume`) — a notice
 *     that arrived while the prompt was in flight is NOT drained by a wake whose
 *     text never contained it; it is delivered by a bounded follow-up wake round
 *     (up to {@link MAX_WAKE_ROUNDS} per `notify()` invocation) or stays queued
 *     for the passive flush;
 *   - duplicates ARE possible in two narrow races, both inherent to prompting
 *     over a network: (a) `promptAsync` fails locally AFTER the server applied
 *     it — the notices stay queued and the passive flush re-delivers; (b) the
 *     passive flush drains a notice while a wake carrying it is in flight —
 *     `consume` then finds nothing to drain (no double-mark), but the parent has
 *     seen the text twice. Exactly-once is NOT achievable here; what IS
 *     guaranteed is no loss and no unbounded re-delivery.
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
 * into ONE wake carrying all notices pending at snapshot time; a second concurrent
 * notify() for a parent already mid-wake is suppressed (its notice is picked up by
 * the in-flight invocation's follow-up round, or remains queued for the passive
 * flush). The guard is keyed per parent, so distinct parents wake independently.
 *
 * The status/prompt types are the SAME ones the engine client uses (review
 * finding #5): {@link WakeClient} is a structural subset of `EngineClient`, so
 * both plugins pass the one `adaptSdkClient`-wrapped client — no second adapter.
 */

import type { NotificationQueueLogger, TaskNotice } from "./notify";
import type {
	SessionPromptAsyncBody,
	SessionStatusMap,
} from "./session-runner";

/**
 * The minimal structural SDK surface the wake uses: the global `session.status`
 * map read (audit row f) and `session.promptAsync` (audit row b). A structural
 * SUBSET of `EngineClient` — the one `adaptSdkClient(client)` instance satisfies
 * it, so the plugins wire a single adapted client for both the engine and the
 * wake. `promptAsync` to the PARENT omits `agent` (the parent keeps its own;
 * `agent` is optional on the body — audit row b confirms it).
 */
export interface WakeClient {
	session: {
		status(): Promise<{ data?: SessionStatusMap | null }>;
		promptAsync(opts: {
			path: { id: string };
			body: SessionPromptAsyncBody;
		}): Promise<unknown>;
	};
}

/**
 * The queue surface the wake reads/drains: non-draining inspection plus the
 * snapshot-exact drain. Any `NotificationQueue<T>` satisfies it (these members
 * never mention the record type).
 */
export interface WakeQueue {
	pending(parentSessionID?: string): TaskNotice[];
	consume(parentSessionID: string, notices: readonly TaskNotice[]): void;
}

export interface WakeNotifierDeps {
	client: WakeClient;
	queue: WakeQueue;
	logger?: NotificationQueueLogger;
}

export interface WakeNotifier {
	/**
	 * Called on a terminal transition, alongside the toast, for the completing
	 * task's notice. Attempts to wake the notice's parent if idle/absent; coalesces
	 * all of that parent's pending notices into one prompt, with bounded follow-up
	 * rounds for notices that land mid-flight. Never throws.
	 */
	notify(notice: TaskNotice): Promise<void>;
}

/**
 * Upper bound on wake prompts per `notify()` invocation. Round 1 carries the
 * initial snapshot; later rounds carry notices that arrived while a prior round's
 * prompt was in flight. The bound stops a steady completion stream from turning
 * one notify() into an unbounded prompt loop — anything left when it is hit
 * stays queued for the passive flush (or the next completion's notify()).
 */
export const MAX_WAKE_ROUNDS = 3;

/** Build the demarcated, CC-style wake text from a parent's pending notices. */
function buildWakeText(notices: readonly TaskNotice[]): string {
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

		// Per-parent in-flight guard: a concurrent wake is already handling this
		// parent — its follow-up rounds will pick up any newly-queued notices.
		if (inFlight.has(parent)) {
			return;
		}

		// Early return (no status read) when the passive flush already consumed
		// everything; nothing to wake about.
		if (queue.pending(parent).length === 0) {
			return;
		}

		inFlight.add(parent);
		try {
			for (let round = 0; round < MAX_WAKE_ROUNDS; round += 1) {
				// (1) Snapshot the pending notices for THIS round. The wake text and
				// the post-success drain both use exactly this snapshot.
				const toSend = queue.pending(parent);
				if (toSend.length === 0) {
					return;
				}

				// (2) Status read, re-checked every round (the parent may have started
				// a turn between rounds). A THROW here is a FAILED read — fence, log,
				// leave queued (≠ the successful "absent" reading below).
				let statusMap: SessionStatusMap;
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

				// (3) Wake only on idle OR ABSENT (absent ≠ busy). busy/retry → leave
				// queued for the passive flush.
				const status = statusMap[parent];
				const shouldWake = status === undefined || status.type === "idle";
				if (!shouldWake) {
					return;
				}

				// (4) Wake. `agent` omitted — the parent keeps its own agent.
				await client.session.promptAsync({
					path: { id: parent },
					body: {
						parts: [{ type: "text", text: buildWakeText(toSend) }],
					},
				});

				// (5) Consume-on-success, SNAPSHOT-EXACT (finding #4): drain only the
				// notices this round's text actually carried. Notices that arrived
				// while the prompt was in flight stay queued and drive the next round;
				// entries a racing passive flush already drained are ignored by
				// consume (no double-mark).
				queue.consume(parent, toSend);
			}
			// Round budget exhausted: whatever queued during the final round stays
			// for the passive flush (or the next completion's notify()).
		} catch (err) {
			// promptAsync failed: do NOT consume — the notices remain queued for the
			// passive flush (the at-least-once direction when the server applied the
			// prompt before the failure surfaced).
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
