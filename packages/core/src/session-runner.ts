/**
 * SessionRunner — the launch path for background tasks.
 *
 * This task (1.3.2) implements `launch()` + `list()` plus the skeleton needed
 * to satisfy the {@link SessionRunner} interface. Completion handling
 * (`awaitCompletion`, `handleEvent`, `tryComplete`), `cancel`, `resume`,
 * `readOutput`, and `dispose` land in Tasks 1.3.3/1.3.4 and currently throw.
 *
 * Construction is factory-DI: {@link createSessionRunner} takes only the
 * collaborators it needs, and the `client` is a minimal structural type
 * ({@link EngineClient}) covering exactly the SDK calls the launch path makes,
 * so tests inject a scripted fake without the full SDK client.
 */

import type { ConcurrencyManager } from "./concurrency";
import { WaiterCancelledError } from "./concurrency";
import type { IdGenerator } from "./ids";
import type { BgTask, Clock, LaunchRequest, SessionRunner } from "./types";

// --- minimal structural SDK surface (audit rows a/b/d) --------------------

export interface SessionCreateBody {
	parentID?: string;
	title?: string;
}

export interface PromptModel {
	providerID: string;
	modelID: string;
}

export interface TextPartInput {
	type: "text";
	text: string;
}

export interface SessionPromptAsyncBody {
	agent?: string;
	model?: PromptModel;
	tools?: Record<string, boolean>;
	parts: TextPartInput[];
}

/**
 * The only client calls the launch path uses. Structural on purpose: matches
 * the real SDK call shapes (audit rows a/b/d) without depending on the full
 * generated client type. Return shapes are narrowed to what we read.
 */
export interface EngineClient {
	session: {
		create(opts: {
			body?: SessionCreateBody;
		}): Promise<{ data?: { id: string } }>;
		promptAsync(opts: {
			path: { id: string };
			body: SessionPromptAsyncBody;
		}): Promise<unknown>;
		abort(opts: { path: { id: string } }): Promise<unknown>;
	};
}

export type PersistFn = (task: BgTask) => Promise<void>;

export interface SessionRunnerLogger {
	debug?(msg: string, meta?: Record<string, unknown>): void;
	error?(msg: string, meta?: Record<string, unknown>): void;
}

export interface SessionRunnerConfig {
	maxDepth?: number;
}

export interface SessionRunnerDeps {
	client: EngineClient;
	concurrency: ConcurrencyManager;
	ids: IdGenerator;
	clock: Clock;
	persist?: PersistFn;
	logger?: SessionRunnerLogger;
	config?: SessionRunnerConfig;
}

/**
 * Extends the public interface with a launch-path-only cancellation seam.
 * `markCancelled` is the minimal hook Task 1.3.2 needs so launch's re-checks
 * are testable; Task 1.3.3 replaces it with the real `cancel()` implementation.
 */
export interface SessionRunnerInternal extends SessionRunner {
	markCancelled(taskId: string): void;
}

const DEFAULT_MAX_DEPTH = 2;
/** Concurrency key seed when a request carries no model. */
const DEFAULT_MODEL_KEY = "default";

/** The recursion-guard tool map: every spawn/workflow tool disabled. */
const SPAWN_GUARD: Record<string, boolean> = {
	bg_task: false,
	bg_output: false,
	bg_cancel: false,
	bg_list: false,
	workflow: false,
	workflow_status: false,
	workflow_stop: false,
};

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Split a `provider/model` string into the SDK's prompt model shape. */
function toPromptModel(model: string): PromptModel {
	const slash = model.indexOf("/");
	if (slash === -1) {
		return { providerID: model, modelID: model };
	}
	return {
		providerID: model.slice(0, slash),
		modelID: model.slice(slash + 1),
	};
}

export function createSessionRunner(
	deps: SessionRunnerDeps,
): SessionRunnerInternal {
	const { client, concurrency, ids, clock } = deps;
	const persist = deps.persist;
	const maxDepth = deps.config?.maxDepth ?? DEFAULT_MAX_DEPTH;

	const tasks = new Map<string, BgTask>();
	// Tasks marked cancelled during launch (before/while in-flight). The launch
	// flow consults this to short-circuit. A minimal seam for Task 1.3.3.
	const cancelled = new Set<string>();
	// While a task's acquire is in-flight, map taskId → (model, waiterId) so
	// markCancelled can reject the still-queued waiter by its id.
	const inflightAcquire = new Map<
		string,
		{ model: string; waiterId: string }
	>();

	function liveIds(): ReadonlySet<string> {
		return new Set(tasks.keys());
	}

	async function maybePersist(task: BgTask): Promise<void> {
		if (persist) {
			await persist(task);
		}
	}

	/**
	 * The single status write path. Mutates the task in place to the given
	 * terminal/intermediate status, stamps `completedAt` for terminal states,
	 * records the error, and persists. Task 1.3.3 absorbs this into
	 * `tryComplete`.
	 */
	async function finalize(
		task: BgTask,
		status: BgTask["status"],
		error?: string,
	): Promise<void> {
		task.status = status;
		if (error !== undefined) {
			task.error = error;
		}
		if (
			status === "completed" ||
			status === "error" ||
			status === "cancelled"
		) {
			task.completedAt = clock.now();
		}
		await maybePersist(task);
	}

	function isCancelled(task: BgTask): boolean {
		return cancelled.has(task.id) || task.status === "cancelled";
	}

	function buildTools(req: LaunchRequest): Record<string, boolean> {
		const guard = req.noSpawnTools === false ? {} : SPAWN_GUARD;
		return { ...guard, ...(req.toolsOverride ?? {}) };
	}

	async function launch(req: LaunchRequest): Promise<BgTask> {
		// (1) depth guard — before any slot/registration.
		if (req.depth >= maxDepth) {
			throw new Error(
				`Background task depth ${req.depth} exceeds max depth ${maxDepth}`,
			);
		}

		const modelKey = req.model ?? DEFAULT_MODEL_KEY;
		const concurrencyKey = concurrency.keyFor(modelKey);

		// (2) register a pending task.
		const id = ids.next(liveIds());
		const task: BgTask = {
			id,
			parentSessionID: req.parentSessionID,
			description: req.description,
			agent: req.agent,
			status: "pending",
			createdAt: clock.now(),
			depth: req.depth,
			concurrencyKey,
		};
		tasks.set(id, task);
		await maybePersist(task);

		// (3) acquire a slot. Hold the AcquireResult so a cancel mid-acquire can
		// cancel the waiter by id.
		const acquire = concurrency.acquire(modelKey);
		inflightAcquire.set(id, { model: modelKey, waiterId: acquire.id });
		try {
			await acquire;
		} catch (err) {
			inflightAcquire.delete(id);
			// Waiter cancelled mid-acquire → no slot held, no session created.
			if (err instanceof WaiterCancelledError) {
				await finalize(task, "cancelled");
				return task;
			}
			await finalize(task, "error", errorMessage(err));
			throw err;
		}
		inflightAcquire.delete(id);

		// (4) cancel-during-acquire that lost the race to the grant: a slot is now
		// held; release it and finalize cancelled. No session created.
		if (isCancelled(task)) {
			concurrency.release(modelKey);
			await finalize(task, "cancelled");
			return task;
		}

		// (5) create the child session.
		let sessionID: string;
		try {
			const created = await client.session.create({
				body: { parentID: req.parentSessionID, title: req.description },
			});
			const newID = created.data?.id;
			if (!newID) {
				throw new Error("session.create returned no session id");
			}
			sessionID = newID;
		} catch (err) {
			concurrency.release(modelKey);
			await finalize(task, "error", errorMessage(err));
			throw err;
		}

		// re-check cancellation across the create await: abort the orphan.
		if (isCancelled(task)) {
			await client.session.abort({ path: { id: sessionID } });
			concurrency.release(modelKey);
			await finalize(task, "cancelled");
			return task;
		}

		// (6) promote to running.
		task.sessionID = sessionID;
		task.startedAt = clock.now();
		await finalize(task, "running");

		// (7) fire-and-forget prompt. Failure finalizes error + releases slot.
		client.session
			.promptAsync({
				path: { id: sessionID },
				body: {
					agent: req.agent,
					...(req.model ? { model: toPromptModel(req.model) } : {}),
					tools: buildTools(req),
					parts: [{ type: "text", text: req.prompt }],
				},
			})
			.catch((err: unknown) => {
				deps.logger?.error?.("promptAsync failed", { id: task.id });
				concurrency.release(modelKey);
				void finalize(task, "error", errorMessage(err));
			});

		// (8) resolve at running — never await completion.
		return task;
	}

	function list(parentSessionID?: string): BgTask[] {
		const all = [...tasks.values()];
		const filtered =
			parentSessionID === undefined
				? all
				: all.filter((t) => t.parentSessionID === parentSessionID);
		return filtered.sort((a, b) => a.createdAt - b.createdAt);
	}

	function markCancelled(taskId: string): void {
		cancelled.add(taskId);
		// If the task's acquire is still queued, reject that waiter by its id so
		// the launch flow unwinds via WaiterCancelledError without creating a
		// session. (No-op if already granted/settled.)
		const pending = inflightAcquire.get(taskId);
		if (pending) {
			concurrency.cancelWaiter(pending.model, pending.waiterId);
		}
	}

	return {
		launch,
		list,
		markCancelled,
		awaitCompletion(): Promise<BgTask> {
			throw new Error("not implemented");
		},
		cancel(): Promise<BgTask> {
			throw new Error("not implemented");
		},
		resume(): Promise<BgTask> {
			throw new Error("not implemented");
		},
		readOutput(): Promise<never> {
			throw new Error("not implemented");
		},
		handleEvent(): Promise<void> {
			throw new Error("not implemented");
		},
		dispose(): Promise<void> {
			throw new Error("not implemented");
		},
	};
}
