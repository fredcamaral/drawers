/**
 * Engine factory for the pi background-agents extension.
 *
 * `createEngine` assembles the core collaborators into one wired unit, the
 * pi-native analogue of the opencode engine:
 *   - {@link createTaskStore} (atomic per-task persistence) under the `tasks` leaf
 *     of the canonical base dir ({@link resolveDataBaseDir}: `dataDir` →
 *     `$PI_DRAWERS_DATA_DIR` → XDG);
 *   - `store.load()` → recovered tasks, fed to the runner (re-validated) and to
 *     the notification queue's `seed` (un-notified terminals re-queued silently);
 *   - a {@link ConcurrencyManager} (defaults);
 *   - {@link createIdGenerator} (mints `bg_` ids) + a `Date`-backed clock;
 *   - {@link createSessionRunner} wired to the pi RPC seam ({@link RpcClientFactory}
 *     + {@link SessionTranscriptReader} + `sessionDir`) — NOT an SDK client;
 *   - {@link createNotificationQueue} whose `markNotified` persists the `notified`
 *     flag, wired to the runner's `onTaskComplete` so each terminal transition
 *     pushes exactly one notice.
 *
 * The opencode engine fetched the parent transcript over the SDK
 * (`fetchSessionMessages`). In pi the parent transcript is in-process, so the
 * fork path reads it directly from `ctx.sessionManager` at the tool layer — the
 * engine does NOT expose a fetch seam.
 *
 * Node-safe: no Bun.* APIs.
 */

import { join } from "node:path";
import {
	type Clock,
	ConcurrencyManager,
	createIdGenerator,
	createNotificationQueue,
	createSessionRunner,
	createTaskStore,
	type NotificationQueue,
	type RpcClientFactory,
	resolveDataBaseDir,
	type SessionRunner,
	type SessionTranscriptReader,
	type TaskNotice,
	type TaskStore,
} from "@drawers/pi-core";

/** Structured logger surface — `ctx.ui`-backed in the extension entry. */
export interface EngineLogger {
	debug(msg: string, meta?: Record<string, unknown>): void;
	info(msg: string, meta?: Record<string, unknown>): void;
	warn(msg: string, meta?: Record<string, unknown>): void;
	error(msg: string, meta?: Record<string, unknown>): void;
}

export interface CreateEngineOptions {
	/** The pi RPC seam — spawns one `pi --mode rpc` child per task. */
	rpcFactory: RpcClientFactory;
	/** Reads a terminal/torn-down task's transcript from disk. */
	transcriptReader: SessionTranscriptReader;
	/** The engine-wide session storage dir passed to every child (`--session-dir`). */
	sessionDir?: string;
	/**
	 * Persistence BASE dir. Resolution order: explicit `dataDir` →
	 * `$PI_DRAWERS_DATA_DIR` → XDG default. Tasks live under its `tasks` leaf.
	 */
	dataDir?: string;
	/** Terminal-notice sink (toast/wake). Left injectable; the entry wires it. */
	onNotify?: (notice: TaskNotice) => void;
	logger?: EngineLogger;
}

export interface Engine {
	runner: SessionRunner;
	store: TaskStore;
	queue: NotificationQueue;
	/** Idempotent teardown: drains the runner's children + the store's writes. */
	dispose(): Promise<void>;
}

const clock: Clock = { now: () => Date.now() };

export async function createEngine(opts: CreateEngineOptions): Promise<Engine> {
	const { rpcFactory, transcriptReader, sessionDir, onNotify, logger } = opts;

	const storeLogger = logger
		? {
				debug: (msg: string, meta?: Record<string, unknown>) =>
					logger.debug(msg, meta),
				error: (msg: string, meta?: Record<string, unknown>) =>
					logger.error(msg, meta),
			}
		: undefined;

	// Task files live under the `tasks` leaf of the ONE canonical base dir, so the
	// env var (or explicit dataDir) is a BASE — never the task dir verbatim.
	const store = createTaskStore({
		baseDir: join(resolveDataBaseDir(opts.dataDir), "tasks"),
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
		rpcFactory,
		transcriptReader,
		sessionDir,
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

	return {
		runner,
		store,
		queue,
		dispose: async () => {
			// Stop all live children + drain the fuser, then drain pending writes.
			await runner.dispose();
			await store.dispose();
		},
	};
}
