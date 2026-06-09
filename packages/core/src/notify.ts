/**
 * NotificationQueue — the passive-flush notice channel.
 *
 * Decision 1 of the plan: NO active parent-wake. A completed background task
 * does not interrupt the parent; instead its notice waits in a per-parent FIFO
 * until the Phase 2 plugin drains it into the parent's next message via the
 * `chat.message` hook. Core owns only the queue and the rendered hint strings —
 * it stays presentation-ignorant, with zero imports from plugin/TUI modules.
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

/** A rendered, terminal-only completion notice for a parent session. */
export interface TaskNotice {
	taskId: string;
	parentSessionID: string;
	description: string;
	status: TaskStatus; // terminal only
	durationMs?: number;
	hint: string; // rendered retrieval hint
}

export interface NotificationQueue {
	/** Enqueue a notice for a terminal task. Wired to the engine's onTaskComplete. */
	push(task: BgTask): void;
	/** Drain a parent's notices, oldest first. */
	flushFor(parentSessionID: string): TaskNotice[];
	/** Non-draining inspection. Omit the arg to inspect every parent. */
	pending(parentSessionID?: string): TaskNotice[];
	/** Restart re-queue: enqueue terminal && !notified tasks without toasting. */
	seed(tasks: BgTask[]): void;
}

export interface NotificationQueueLogger {
	debug?(msg: string, meta?: Record<string, unknown>): void;
	error?(msg: string, meta?: Record<string, unknown>): void;
}

export interface NotificationQueueOpts {
	/** Toast path. Host injects a TUI-backed impl; absent = no-op. */
	onNotify?: (notice: TaskNotice) => void;
	/**
	 * Persist the `notified` flag for a flushed task. Called fire-and-forget so
	 * `flushFor` stays synchronous for hook use; rejections are caught + logged.
	 */
	markNotified?: (taskId: string) => Promise<void>;
	/** Override the default retrieval-hint text. */
	renderHint?: (task: BgTask) => string;
	logger?: NotificationQueueLogger;
}

/** Stable dedup key: taskId + completedAt (so resume re-completion is distinct). */
function seenKey(task: BgTask): string {
	return `${task.id}:${task.completedAt ?? "?"}`;
}

/** Duration from start (or creation) to completion, when both are known. */
function durationOf(task: BgTask): number | undefined {
	if (task.completedAt === undefined) {
		return undefined;
	}
	const start = task.startedAt ?? task.createdAt;
	return task.completedAt - start;
}

/** Default retrieval hint: short id, description, status, and the call to make. */
function defaultHint(task: BgTask): string {
	return (
		`Background task ${task.id} (${task.description}) finished: ${task.status}. ` +
		`Call bg_output(task_id="${task.id}") for the full result.`
	);
}

export function createNotificationQueue(
	opts: NotificationQueueOpts,
): NotificationQueue {
	const { onNotify, markNotified, logger } = opts;
	const renderHint = opts.renderHint ?? defaultHint;

	/**
	 * Per-parent FIFO of pending notices. Each entry carries its dedup `key`
	 * alongside the notice so {@link flushFor} can prune the matching `seen` entry
	 * on drain — dedup only needs to cover the window between enqueue and flush.
	 */
	const queues = new Map<string, Array<{ notice: TaskNotice; key: string }>>();
	/** Dedup seen-set, keyed taskId+completedAt. Pruned on flush (see queues). */
	const seen = new Set<string>();

	function buildNotice(task: BgTask): TaskNotice {
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

	function enqueue(task: BgTask, key: string): TaskNotice {
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

	function push(task: BgTask): void {
		// Defensive: only terminal tasks produce notices.
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

	function seed(tasks: BgTask[]): void {
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
		// Prune the dedup keys for the drained notices: dedup only needs to span the
		// window between enqueue and flush, so retaining keys past the drain would
		// grow `seen` unbounded over the process lifetime.
		for (const { key } of list) {
			seen.delete(key);
		}
		// Persist the notified flag fire-and-forget; flush stays synchronous.
		if (markNotified) {
			for (const { notice } of list) {
				markNotified(notice.taskId).catch((err: unknown) => {
					logger?.error?.("markNotified failed", {
						id: notice.taskId,
						err: err instanceof Error ? err.message : String(err),
					});
				});
			}
		}
		return list.map((e) => e.notice); // already oldest-first (push order)
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

	return { push, flushFor, pending, seed };
}
