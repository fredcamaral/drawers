/**
 * Engine factory for the background-agents plugin.
 *
 * `createEngine` assembles the core collaborators into one wired unit:
 *   - {@link createTaskStore} (atomic per-task persistence) under the `tasks` leaf
 *     of the canonical base dir ({@link resolveDataBaseDir}: `dataDir` →
 *     `$OPENCODE_DRAWERS_DATA_DIR` → XDG), shared with the workflows plugin;
 *   - `store.load()` → recovered tasks, fed to the runner (re-validated) and to
 *     the notification queue's `seed` (un-notified terminals re-queued silently);
 *   - a {@link ConcurrencyManager} (defaults now; config-driven later);
 *   - {@link createIdGenerator} + a `Date`-backed clock;
 *   - {@link createSessionRunner} with `persist: store.save`;
 *   - {@link createNotificationQueue} whose `markNotified` persists the
 *     `notified` flag through the store, wired to the runner's `onTaskComplete`
 *     seam ({@link SessionRunnerDeps.onTaskComplete}) so each terminal transition
 *     pushes exactly one notice into the queue.
 *
 * `onNotify` (the toast path) is left injectable — Epic 2.2 fills it. Returns the
 * trio the plugin entry wires: `{ runner, store, queue }`.
 */

import { join } from "node:path";
import {
	type Clock,
	ConcurrencyManager,
	createIdGenerator,
	createNotificationQueue,
	createSessionRunner,
	createTaskStore,
	type EngineClient,
	type FsFacade,
	type NotificationQueue,
	resolveDataBaseDir,
	type SessionRunner,
	type TaskNotice,
	type TaskStore,
} from "@drawers/core";
import type { ForkMessage } from "./fork/transcript";

/** Structured logger surface — `client.app.log`-backed in the plugin entry. */
export interface EngineLogger {
	debug(msg: string, meta?: Record<string, unknown>): void;
	info(msg: string, meta?: Record<string, unknown>): void;
	warn(msg: string, meta?: Record<string, unknown>): void;
	error(msg: string, meta?: Record<string, unknown>): void;
}

export interface CreateEngineOptions {
	/** The engine's structural SDK surface (wrap a real client with adaptSdkClient). */
	client: EngineClient;
	/**
	 * Persistence BASE dir. Resolution order: explicit `dataDir` →
	 * `$OPENCODE_DRAWERS_DATA_DIR` → XDG default. Tasks live under its `tasks` leaf.
	 */
	dataDir?: string;
	/** Toast callback, left injectable for Epic 2.2 (TUI toasts). */
	onNotify?: (notice: TaskNotice) => void;
	logger?: EngineLogger;
	/** Injectable fs facade for the store; tests pass an in-memory one. */
	fs?: FsFacade;
}

export interface Engine {
	runner: SessionRunner;
	store: TaskStore;
	queue: NotificationQueue;
	/**
	 * Fetch a session's messages in the {@link ForkMessage} shape the fork
	 * transcript builder consumes. Built on the same adapted client the runner
	 * uses (`session.messages`). The engine's `EngineClient` statically narrows
	 * the part/message fields the runner reads, but the live objects still carry
	 * `info.summary` / `parts[].tool` / compaction parts at runtime — so the
	 * result is widened to `ForkMessage[]` here (the single honest widening point,
	 * matching where the adapter narrowed). A genuinely empty session resolves to
	 * `[]`; a failed fetch (SDK/network error) THROWS so an explicitly requested
	 * `fork` is never silently downgraded to a non-forked launch.
	 */
	fetchSessionMessages(sessionID: string): Promise<ForkMessage[]>;
}

const clock: Clock = { now: () => Date.now() };

export async function createEngine(opts: CreateEngineOptions): Promise<Engine> {
	const { client, onNotify, logger } = opts;

	const storeLogger = logger
		? {
				debug: (msg: string, meta?: Record<string, unknown>) =>
					logger.debug(msg, meta),
				error: (msg: string, meta?: Record<string, unknown>) =>
					logger.error(msg, meta),
			}
		: undefined;

	// Task files live under the `tasks` leaf of the ONE canonical base dir, so the
	// env var (or explicit dataDir) is a BASE, shared with the workflows plugin —
	// never the task dir verbatim.
	const store = createTaskStore({
		baseDir: join(resolveDataBaseDir(opts.dataDir), "tasks"),
		fs: opts.fs,
		clock,
		logger: storeLogger,
	});

	const recoveredTasks = await store.load();
	logger?.info("store loaded", { recoveredCount: recoveredTasks.length });

	// markNotified must find the live task object to flip + persist its `notified`
	// flag. Recovered tasks are indexed up front; live (post-launch) tasks are
	// found via the runner's list. Both share the object identity the gate mutates.
	const recoveredById = new Map(recoveredTasks.map((t) => [t.id, t]));
	let runnerRef: SessionRunner | undefined;
	const findTask = (taskId: string) =>
		recoveredById.get(taskId) ?? runnerRef?.list().find((t) => t.id === taskId);

	// The runner's onTaskComplete pushes into this queue; `seed` (below) re-queues
	// the un-notified terminal tasks recovered above (silent — no toast storm).
	const queue = createNotificationQueue({
		onNotify,
		markNotified: async (taskId) => {
			const task = findTask(taskId);
			if (task) {
				task.notified = true;
				await store.save(task);
			}
		},
		logger: storeLogger,
	});

	const runner = createSessionRunner({
		client,
		concurrency: new ConcurrencyManager(),
		ids: createIdGenerator(),
		clock,
		persist: (task) => store.save(task),
		recoveredTasks,
		onTaskComplete: (task) => queue.push(task),
		logger: storeLogger,
	});
	runnerRef = runner;

	queue.seed(recoveredTasks);

	const fetchSessionMessages = async (
		sessionID: string,
	): Promise<ForkMessage[]> => {
		try {
			const res = await client.session.messages({ path: { id: sessionID } });
			// The adapter narrows away `info.summary`/`parts[].tool`/compaction
			// parts that the fork builder reads, but the runtime objects still carry
			// them. Widen through `unknown` — the one honest widening point.
			return (res.data ?? []) as unknown as ForkMessage[];
		} catch (err) {
			// A failed fetch is NOT an empty session. Returning `[]` here would make
			// a transient SDK/network failure indistinguishable from a genuinely
			// empty parent, and an explicitly requested `fork` would launch blind
			// with no context and no signal. Surface it so `bg_task` can refuse.
			const message = err instanceof Error ? err.message : String(err);
			logger?.warn("fetchSessionMessages failed", {
				sessionID,
				error: message,
			});
			throw new Error(`fetchSessionMessages: ${message}`);
		}
	};

	return { runner, store, queue, fetchSessionMessages };
}
