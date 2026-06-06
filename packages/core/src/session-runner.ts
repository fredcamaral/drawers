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

import {
	type CompletionConfig,
	type CompletionGate,
	createCompletionGate,
	type GateMessage,
	type IntervalFactory,
	type TimerFactory,
} from "./completion";
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
		// Completion-gate surfaces (audit rows c/e).
		messages(opts: { path: { id: string } }): Promise<{ data?: GateMessage[] }>;
		get(opts: { path: { id: string } }): Promise<unknown>;
	};
}

export type PersistFn = (task: BgTask) => Promise<void>;

export interface SessionRunnerLogger {
	debug?(msg: string, meta?: Record<string, unknown>): void;
	error?(msg: string, meta?: Record<string, unknown>): void;
}

export interface SessionRunnerConfig extends CompletionConfig {
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
	/** Notification-layer hook, forwarded to the completion gate. */
	onTaskComplete?: (task: BgTask) => void;
	/** Injected timer factory (tests pass a manual fake; defaults to setTimeout). */
	setTimer?: TimerFactory;
	/** Injected interval factory (defaults to setInterval + unref). */
	setIntervalFn?: IntervalFactory;
	/** Auto-start the safety poll on construction. Default true. */
	startPoll?: boolean;
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

/** Default one-shot timer factory backed by the host's `setTimeout`. */
const defaultTimer: TimerFactory = (cb, ms) => {
	const handle = setTimeout(cb, ms);
	return { clear: () => clearTimeout(handle) };
};

/** Default interval factory backed by the host's `setInterval`, `unref`'d. */
const defaultInterval: IntervalFactory = (cb, ms) => {
	const handle = setInterval(cb, ms);
	return {
		clear: () => clearInterval(handle),
		unref: () => {
			(handle as { unref?: () => void }).unref?.();
		},
	};
};

export function createSessionRunner(
	deps: SessionRunnerDeps,
): SessionRunnerInternal {
	const { client, concurrency, ids, clock } = deps;
	const persist = deps.persist;
	const maxDepth = deps.config?.maxDepth ?? DEFAULT_MAX_DEPTH;

	const tasks = new Map<string, BgTask>();
	// While a task's acquire is in-flight, map taskId → (model, waiterId) so a
	// cancellation can reject the still-queued waiter by its id.
	const inflightAcquire = new Map<
		string,
		{ model: string; waiterId: string }
	>();
	// Tasks that hold a live concurrency slot → the model key to release. Set
	// only after a successful acquire; the completion gate's `freeSlot` consults
	// it to release exactly once (or cancel the still-queued waiter instead).
	const heldSlots = new Map<string, string>();

	function liveIds(): ReadonlySet<string> {
		return new Set(tasks.keys());
	}

	async function maybePersist(task: BgTask): Promise<void> {
		if (persist) {
			await persist(task);
		}
	}

	// --- the completion gate owns every terminal status transition ----------

	const gate: CompletionGate = createCompletionGate({
		getTask: (id) => tasks.get(id),
		runningTasks: () =>
			[...tasks.values()].filter(
				(t) => t.status === "running" || t.status === "pending",
			),
		freeSlot: (task) => {
			// Slot held → release it. Else if the waiter is still queued → cancel
			// it (denies the launch acquire). Else nothing to free.
			const held = heldSlots.get(task.id);
			if (held !== undefined) {
				heldSlots.delete(task.id);
				concurrency.release(held);
				return;
			}
			const pending = inflightAcquire.get(task.id);
			if (pending) {
				concurrency.cancelWaiter(pending.model, pending.waiterId);
			}
		},
		abortSession: async (sessionID) => {
			await client.session.abort({ path: { id: sessionID } });
		},
		fetchMessages: async (sessionID) => {
			const res = await client.session.messages({ path: { id: sessionID } });
			return res.data ?? [];
		},
		sessionExists: async (sessionID) => {
			await client.session.get({ path: { id: sessionID } });
		},
		clock,
		persist: maybePersist,
		onTaskComplete: deps.onTaskComplete,
		logger: deps.logger,
		setTimer: deps.setTimer ?? defaultTimer,
		setIntervalFn: deps.setIntervalFn ?? defaultInterval,
		config: deps.config,
	});

	if (deps.startPoll !== false) {
		gate.start();
	}

	/** Non-terminal status write (pending/running). Terminal flips go via the gate. */
	async function setIntermediate(
		task: BgTask,
		status: Extract<BgTask["status"], "pending" | "running">,
	): Promise<void> {
		task.status = status;
		await maybePersist(task);
	}

	/**
	 * Read a task's status without TS narrowing it to the launch-path-local
	 * value. `gate.tryComplete` mutates `task.status` through a closure the
	 * compiler can't see, so the launch-path cancellation re-checks need an
	 * opaque read to stay type-correct.
	 */
	function statusOf(taskId: string): BgTask["status"] | undefined {
		return tasks.get(taskId)?.status;
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
				gate.tryComplete(id, "cancelled");
				return task;
			}
			gate.tryComplete(id, "error", errorMessage(err));
			throw err;
		}
		inflightAcquire.delete(id);
		// Slot is now held; record it so the gate releases it on completion.
		heldSlots.set(id, modelKey);

		// (4) cancel-during-acquire that lost the race to the grant: a slot is
		// now held; the gate releases it on the cancelled flip. No session.
		if (statusOf(id) === "cancelled") {
			gate.tryComplete(id, "cancelled");
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
			gate.tryComplete(id, "error", errorMessage(err));
			throw err;
		}

		// re-check cancellation across the create await. The task may already be
		// cancelled (the gate flipped it + released the slot when the cancel fired
		// before this session existed), so the gate's teardown could not abort a
		// session that did not yet exist. Abort the freshly-created orphan here.
		// `tryComplete` is a no-op flip in that case (already terminal); if the
		// cancel races in right now, it wins the flip and the gate aborts.
		if (statusOf(id) === "cancelled") {
			task.sessionID = sessionID;
			if (!gate.tryComplete(id, "cancelled")) {
				try {
					await client.session.abort({ path: { id: sessionID } });
				} catch (err) {
					deps.logger?.error?.("orphan abort failed", {
						id,
						err: errorMessage(err),
					});
				}
			}
			return task;
		}

		// (6) promote to running.
		task.sessionID = sessionID;
		task.startedAt = clock.now();
		await setIntermediate(task, "running");

		// (7) fire-and-forget prompt. Failure routes through the gate (error flip
		// releases the slot).
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
				gate.tryComplete(id, "error", errorMessage(err));
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

	/**
	 * Launch-path cancellation seam. Routes through the gate's synchronous flip:
	 * the gate's `freeSlot` cancels a still-queued waiter (so the launch acquire
	 * rejects with `WaiterCancelledError`) or releases a held slot. The launch
	 * flow's re-checks then see `task.status === "cancelled"`.
	 */
	function markCancelled(taskId: string): void {
		gate.tryComplete(taskId, "cancelled");
	}

	return {
		launch,
		list,
		markCancelled,
		awaitCompletion: (taskId, timeoutMs) =>
			gate.awaitCompletion(taskId, timeoutMs),
		cancel(): Promise<BgTask> {
			throw new Error("not implemented");
		},
		resume(): Promise<BgTask> {
			throw new Error("not implemented");
		},
		readOutput(): Promise<never> {
			throw new Error("not implemented");
		},
		handleEvent: (event) => gate.handleEvent(event),
		dispose: () => gate.dispose(),
	};
}
