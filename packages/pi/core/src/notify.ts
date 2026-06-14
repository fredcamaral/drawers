/**
 * NotificationQueue — the per-parent terminal-notice channel.
 *
 * A completed background task (or workflow run) enqueues a notice into a
 * per-parent FIFO. Two drains exist:
 *   - the PASSIVE flush ({@link NotificationQueue.flushFor}): the chat.message
 *     hook drains everything on the parent's next message;
 *   - the ACTIVE wake ({@link NotificationQueue.consume}): the wake notifier
 *     drains exactly the snapshot it delivered in a wake prompt, leaving
 *     anything that arrived mid-flight queued.
 * Core owns only the queue and the rendered hint strings — it stays
 * presentation-ignorant, with zero imports from plugin/TUI modules.
 *
 * The queue is GENERIC over the record type it renders notices from (review
 * finding #3): it reads only the {@link NoticeRecord} structural minimum, so the
 * workflows engine queues its RunRecord directly instead of lying through
 * `as unknown as BgTask` casts. The default record type is {@link BgTask}.
 *
 * Dedup is a plain seen-set, not better-async's priority machinery: the engine's
 * single-winner `tryComplete` fires `onTaskComplete` at most once per terminal
 * transition, so there is exactly one competing notifier. The one subtlety is
 * resume (Task 1.3.4): a resumed task legitimately completes its SAME taskId a
 * second time, with `notified` reset to `undefined` and a fresh `completedAt`.
 * Keying dedup on `taskId` alone would swallow that second, legitimate notice —
 * so the seen-set keys on `taskId + ":" + completedAt`. Two pushes of the same
 * completion are one notice; a re-completion after resume is a new notice.
 */

import type { BgTask, TaskStatus } from "./types";
import { isTerminal } from "./types";

/**
 * The structural minimum a record must carry to flow through the queue: the
 * identity/routing fields plus the timestamps the duration math reads. BgTask
 * satisfies it; so does the workflows engine's RunRecord.
 */
export interface NoticeRecord {
	id: string;
	parentSessionID: string;
	description: string;
	status: TaskStatus;
	createdAt: number;
	startedAt?: number;
	completedAt?: number;
	notified?: boolean;
}

/** A rendered, terminal-only completion notice for a parent session. */
export interface TaskNotice {
	taskId: string;
	parentSessionID: string;
	description: string;
	status: TaskStatus; // terminal only
	durationMs?: number;
	hint: string; // rendered retrieval hint
}

export interface NotificationQueue<T extends NoticeRecord = BgTask> {
	/** Enqueue a notice for a terminal record. Wired to the engine's onTaskComplete. */
	push(task: T): void;
	/** Drain a parent's notices, oldest first. */
	flushFor(parentSessionID: string): TaskNotice[];
	/**
	 * Drain EXACTLY the given notices, matched by object identity against what
	 * {@link pending} returned, leaving any other queued notices untouched. The
	 * wake notifier uses this to consume precisely the snapshot it delivered
	 * (review finding #4); notices not currently queued (e.g. already drained by
	 * the passive flush) are ignored, so a racing drain never double-marks.
	 * Runs the same markNotified + dedup-prune as {@link flushFor}.
	 */
	consume(parentSessionID: string, notices: readonly TaskNotice[]): void;
	/** Non-draining inspection. Omit the arg to inspect every parent. */
	pending(parentSessionID?: string): TaskNotice[];
	/** Restart re-queue: enqueue terminal && !notified records without toasting. */
	seed(tasks: T[]): void;
}

export interface NotificationQueueLogger {
	debug?(msg: string, meta?: Record<string, unknown>): void;
	error?(msg: string, meta?: Record<string, unknown>): void;
}

export interface NotificationQueueOpts<T extends NoticeRecord = BgTask> {
	/** Toast path. Host injects a TUI-backed impl; absent = no-op. */
	onNotify?: (notice: TaskNotice) => void;
	/**
	 * Persist the `notified` flag for a flushed task. Called fire-and-forget so
	 * `flushFor` stays synchronous for hook use; rejections are caught + logged.
	 */
	markNotified?: (taskId: string) => Promise<void>;
	/** Override the default retrieval-hint text. */
	renderHint?: (task: T) => string;
	logger?: NotificationQueueLogger;
}

/**
 * Stable dedup key: taskId + completedAt (so resume re-completion is distinct).
 * The `"?"` arm covers a terminal record with no `completedAt` stamped — near-
 * unreachable in practice (the engine stamps `completedAt` on every terminal
 * transition, and load-time validation rejects wrong-typed values), but the
 * types allow the absence, so the fallback keeps dedup total instead of minting
 * `"id:undefined"` keys by accident.
 */
function seenKey(task: NoticeRecord): string {
	return `${task.id}:${task.completedAt ?? "?"}`;
}

/** Duration from start (or creation) to completion, when both are known. */
function durationOf(task: NoticeRecord): number | undefined {
	if (task.completedAt === undefined) {
		return undefined;
	}
	const start = task.startedAt ?? task.createdAt;
	return task.completedAt - start;
}

/** Default retrieval hint: short id, description, status, and the call to make. */
function defaultHint(task: NoticeRecord): string {
	return (
		`Background task ${task.id} (${task.description}) finished: ${task.status}. ` +
		`Call bg_output(task_id="${task.id}") for the full result.`
	);
}

export function createNotificationQueue<T extends NoticeRecord = BgTask>(
	opts: NotificationQueueOpts<T>,
): NotificationQueue<T> {
	const { onNotify, markNotified, logger } = opts;
	const renderHint = opts.renderHint ?? defaultHint;

	/**
	 * Per-parent FIFO of pending notices. Each entry carries its dedup `key`
	 * alongside the notice so the drains can prune the matching `seen` entry —
	 * dedup only needs to cover the window between enqueue and drain.
	 */
	const queues = new Map<string, Array<{ notice: TaskNotice; key: string }>>();
	/** Dedup seen-set, keyed taskId+completedAt. Pruned on drain (see queues). */
	const seen = new Set<string>();

	function buildNotice(task: T): TaskNotice {
		const notice: TaskNotice = {
			taskId: task.id,
			parentSessionID: task.parentSessionID,
			description: task.description,
			status: task.status,
			hint: renderHint(task),
		};
		const duration = durationOf(task);
		if (duration !== undefined) {
			notice.durationMs = duration;
		}
		return notice;
	}

	function enqueue(task: T, key: string): TaskNotice {
		const notice = buildNotice(task);
		const entry = { notice, key };
		const list = queues.get(task.parentSessionID);
		if (list) {
			list.push(entry);
		} else {
			queues.set(task.parentSessionID, [entry]);
		}
		return notice;
	}

	/**
	 * Shared drain bookkeeping for {@link flushFor}/{@link consume}: prune the
	 * dedup keys (dedup only spans enqueue→drain; retaining keys past it would
	 * grow `seen` unbounded) and fire markNotified fire-and-forget per notice
	 * (rejections logged; the drain stays synchronous for hook use).
	 */
	function settleDrained(
		drained: Array<{ notice: TaskNotice; key: string }>,
	): void {
		for (const { key } of drained) {
			seen.delete(key);
		}
		if (markNotified) {
			for (const { notice } of drained) {
				markNotified(notice.taskId).catch((err: unknown) => {
					logger?.error?.("markNotified failed", {
						id: notice.taskId,
						err: err instanceof Error ? err.message : String(err),
					});
				});
			}
		}
	}

	function push(task: T): void {
		// Defensive: only terminal records produce notices.
		if (!isTerminal(task.status)) {
			return;
		}
		const key = seenKey(task);
		if (seen.has(key)) {
			return; // duplicate completion → no-op
		}
		seen.add(key);
		const notice = enqueue(task, key);
		if (onNotify) {
			try {
				onNotify(notice);
			} catch (err) {
				logger?.error?.("onNotify callback threw", {
					id: task.id,
					err: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	function seed(tasks: T[]): void {
		for (const task of tasks) {
			// Restart re-queue: terminal AND not yet flushed.
			if (!isTerminal(task.status) || task.notified === true) {
				continue;
			}
			const key = seenKey(task);
			if (seen.has(key)) {
				continue;
			}
			// Mark in the seen-set so a later live push of the same completion
			// no-ops (no double-enqueue across restart), then enqueue silently —
			// no onNotify, to avoid a toast storm on restart.
			seen.add(key);
			enqueue(task, key);
		}
	}

	function flushFor(parentSessionID: string): TaskNotice[] {
		const list = queues.get(parentSessionID);
		if (!list || list.length === 0) {
			return [];
		}
		queues.delete(parentSessionID);
		settleDrained(list);
		return list.map((e) => e.notice); // already oldest-first (push order)
	}

	function consume(
		parentSessionID: string,
		notices: readonly TaskNotice[],
	): void {
		const list = queues.get(parentSessionID);
		if (!list || list.length === 0) {
			return;
		}
		// Identity matching: pending() hands out the SAME notice objects the
		// entries hold, so the wake's snapshot maps 1:1 onto entries. An entry the
		// passive flush already drained is simply not found — no double-mark.
		const wanted = new Set(notices);
		const drained: Array<{ notice: TaskNotice; key: string }> = [];
		const kept: Array<{ notice: TaskNotice; key: string }> = [];
		for (const entry of list) {
			(wanted.has(entry.notice) ? drained : kept).push(entry);
		}
		if (drained.length === 0) {
			return;
		}
		if (kept.length === 0) {
			queues.delete(parentSessionID);
		} else {
			queues.set(parentSessionID, kept);
		}
		settleDrained(drained);
	}

	function pending(parentSessionID?: string): TaskNotice[] {
		if (parentSessionID !== undefined) {
			const list = queues.get(parentSessionID);
			return list ? list.map((e) => e.notice) : [];
		}
		const all: TaskNotice[] = [];
		for (const list of queues.values()) {
			for (const e of list) {
				all.push(e.notice);
			}
		}
		return all;
	}

	return { push, flushFor, consume, pending, seed };
}
