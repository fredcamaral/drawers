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
	type GatePart,
	type IntervalFactory,
	type TimerFactory,
} from "./completion";
import type { ConcurrencyManager } from "./concurrency";
import { WaiterCancelledError } from "./concurrency";
import type { IdGenerator } from "./ids";
import {
	type BgTask,
	type Clock,
	isTerminal,
	type LaunchRequest,
	type ReadOpts,
	type SessionRunner,
	type TaskOutput,
	type TaskOutputMessage,
	type TaskOutputPart,
} from "./types";

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
	/**
	 * Tasks recovered from persistence at restart. Registered into the live map on
	 * construction so `list`/`readOutput` see them immediately. Terminal tasks are
	 * registered as-is. Non-terminal tasks are verified against the engine
	 * asynchronously (see {@link createSessionRunner}'s recovery routine): a live
	 * session is re-tracked as `running`; a gone/sessionless task is finalized as
	 * `error("lost during restart")` through the gate.
	 *
	 * Slot policy: recovered running tasks occupy NO concurrency slot. The original
	 * process's slots died with it; re-acquiring here could deadlock startup if the
	 * recovered running set exceeds the concurrency limit (acquire would queue with
	 * nothing to release it). They are tracked for completion/stale handling only.
	 */
	recoveredTasks?: BgTask[];
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

export function createSessionRunner(deps: SessionRunnerDeps): SessionRunner {
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

	/**
	 * Restart recovery. Synchronous part runs now (register every recovered task
	 * into the live map so `list`/`readOutput` see them immediately, terminal or
	 * not); the async part (session verification for non-terminal tasks) is kicked
	 * off detached and tracked in {@link recovery} so `dispose` can await it.
	 *
	 * Slot policy: a recovered RUNNING task takes NO concurrency slot (see
	 * {@link SessionRunnerDeps.recoveredTasks}). It is registered so the gate's
	 * safety poll/idle path can complete it; its `freeSlot` at terminal time is a
	 * clean no-op (no held slot, no queued waiter).
	 */
	let recovery: Promise<void> = Promise.resolve();
	const recovered = deps.recoveredTasks;
	if (recovered && recovered.length > 0) {
		const pending: Promise<void>[] = [];
		for (const task of recovered) {
			// Register as-is regardless of status. The gate reads activity from
			// `startedAt ?? createdAt` (both preserved), so stale-timeout applies to
			// recovered running tasks without any extra wiring.
			tasks.set(task.id, task);

			if (isTerminal(task.status)) {
				continue; // terminal: visible to list/readOutput, no session check.
			}

			// Non-terminal: a recovered running/pending task must be re-validated.
			const sessionID = task.sessionID;
			if (!sessionID) {
				// No session ever created → it cannot be resumed or verified.
				gate.tryComplete(task.id, "error", "lost during restart");
				continue;
			}
			pending.push(
				client.session.get({ path: { id: sessionID } }).then(
					() => {
						// Alive: ensure it sits at `running` so the gate tracks it.
						// Do NOT route through setIntermediate's persist on every
						// recovery; persist via the gate only on terminal flips. A
						// pending recovered task is promoted to running here.
						const live = tasks.get(task.id);
						if (live && !isTerminal(live.status)) {
							live.status = "running";
						}
					},
					() => {
						// Gone: finalize through the gate (releases nothing, persists
						// the error, fires onTaskComplete).
						gate.tryComplete(task.id, "error", "lost during restart");
					},
				),
			);
		}
		recovery = Promise.all(pending).then(() => undefined);
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

	/**
	 * Fire-and-forget `promptAsync` whose failure routes through the gate (error
	 * flip releases the slot). Shared by launch step (7) and resume so both apply
	 * the same recursion-guard tools logic and the same `.catch` → error+release.
	 */
	function dispatchPrompt(
		task: BgTask,
		sessionID: string,
		prompt: string,
		tools: Record<string, boolean>,
	): void {
		client.session
			.promptAsync({
				path: { id: sessionID },
				body: {
					agent: task.agent,
					...(task.model ? { model: toPromptModel(task.model) } : {}),
					tools,
					parts: [{ type: "text", text: prompt }],
				},
			})
			.catch((err: unknown) => {
				deps.logger?.error?.("promptAsync failed", { id: task.id });
				gate.tryComplete(task.id, "error", errorMessage(err));
			});
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
			model: req.model,
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
		dispatchPrompt(task, sessionID, req.prompt, buildTools(req));

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
	 * Cancel a task. Routes through the gate's synchronous flip (the single
	 * terminal-transition path): the gate's `freeSlot` cancels a still-queued
	 * waiter (so the launch acquire rejects with `WaiterCancelledError`) or
	 * releases a held slot, and aborts a live session in detached teardown.
	 *
	 * Already-terminal → no-op: resolve with the current state (never reject, no
	 * second teardown — the gate's mutex denies the flip). Otherwise join the
	 * detached teardown via `awaitCompletion` so the caller observes the released
	 * slot and persisted state at resolve time (the 1.3.3 sharp edge).
	 */
	async function cancel(taskId: string): Promise<BgTask> {
		const task = tasks.get(taskId);
		if (!task) {
			throw new Error(`Unknown task: ${taskId}`);
		}
		// Won the flip → join teardown. Lost it (already terminal) → no-op; the
		// task is already torn down, so awaitCompletion resolves immediately.
		gate.tryComplete(taskId, "cancelled", "cancelled by user");
		return gate.awaitCompletion(taskId);
	}

	/**
	 * Resume a terminal task with a new prompt on its existing session. No
	 * pending-resume queue in v1: a non-terminal task rejects with
	 * `taskStillRunning`. A missing session rejects with `sessionExpired` and the
	 * task stays terminal. On success the task re-acquires its concurrency slot,
	 * resets to `running` (fresh `startedAt`, cleared error/completedAt/notified),
	 * and the completion machinery picks it up like any running task.
	 */
	async function resume(taskId: string, prompt: string): Promise<BgTask> {
		const task = tasks.get(taskId);
		if (!task) {
			throw new Error(`Unknown task: ${taskId}`);
		}
		if (!isTerminal(task.status)) {
			throw new Error(`taskStillRunning: ${taskId} is ${task.status}`);
		}
		const sessionID = task.sessionID;
		if (!sessionID) {
			throw new Error(`sessionExpired: ${taskId} has no session`);
		}
		// Verify the session still exists before touching any slot/state.
		try {
			await client.session.get({ path: { id: sessionID } });
		} catch {
			throw new Error(`sessionExpired: ${taskId} session ${sessionID} is gone`);
		}

		// Re-acquire the concurrency slot on the original model (same derivation as
		// launch). Mirror launch's cancel-during-acquire handling.
		const modelKey = task.model ?? DEFAULT_MODEL_KEY;
		const acquire = concurrency.acquire(modelKey);
		inflightAcquire.set(taskId, { model: modelKey, waiterId: acquire.id });
		try {
			await acquire;
		} catch (err) {
			inflightAcquire.delete(taskId);
			if (err instanceof WaiterCancelledError) {
				// Cancelled mid-acquire: stays/returns terminal. The task is already
				// terminal from before resume, so flip is a no-op; ensure cancelled.
				gate.tryComplete(taskId, "cancelled", "cancelled by user");
				return gate.awaitCompletion(taskId);
			}
			throw err;
		}
		inflightAcquire.delete(taskId);
		heldSlots.set(taskId, modelKey);

		// Reset terminal bookkeeping and promote to running via the constrained
		// intermediate setter (NOT a new status write path).
		task.startedAt = clock.now();
		task.completedAt = undefined;
		task.error = undefined;
		task.notified = undefined;
		await setIntermediate(task, "running");

		// Invalidate the gate's per-turn caches so a stale idle / cached positive
		// from the previous turn can't instantly complete the new one.
		gate.resetForResume(task);

		// Dispatch the new prompt with the same recursion-guard logic as launch.
		dispatchPrompt(task, sessionID, prompt, { ...SPAWN_GUARD });

		return task;
	}

	/**
	 * Read a task's output. Pending (no session) returns an empty summary without
	 * calling the client. `summaryText` is the concatenated text of the LAST
	 * assistant message. `full: true` adds the filtered transcript (synthetic
	 * parts dropped, tool results capped). A terminal task whose session is gone
	 * degrades gracefully to the task's recorded error/empty — never rejects.
	 */
	async function readOutput(
		taskId: string,
		opts?: ReadOpts,
	): Promise<TaskOutput> {
		const task = tasks.get(taskId);
		if (!task) {
			throw new Error(`Unknown task: ${taskId}`);
		}
		const sessionID = task.sessionID;
		if (!sessionID) {
			// No session yet (pending) — nothing to fetch.
			return { status: task.status, summaryText: "" };
		}

		let messages: GateMessage[];
		try {
			const res = await client.session.messages({ path: { id: sessionID } });
			messages = res.data ?? [];
		} catch {
			// Unreachable session (e.g. expired terminal) — degrade gracefully.
			return { status: task.status, summaryText: task.error ?? "" };
		}

		const summaryText = lastAssistantText(messages);
		if (!opts?.full) {
			return { status: task.status, summaryText };
		}
		return {
			status: task.status,
			summaryText,
			messages: filterTranscript(messages),
		};
	}

	return {
		launch,
		list,
		awaitCompletion: (taskId, timeoutMs) =>
			gate.awaitCompletion(taskId, timeoutMs),
		cancel,
		resume,
		readOutput,
		handleEvent: (event) => gate.handleEvent(event),
		dispose: async () => {
			// Drain in-flight recovery verification before tearing the gate down so
			// a recovered task's error/running resolution is never lost mid-restart.
			await recovery;
			await gate.dispose();
		},
	};
}

// --- output reading helpers ------------------------------------------------

const TOOL_TEXT_CAP = 2000;
const ERROR_HEAD = 1200;
const ERROR_TAIL = 600;
const ERROR_PATTERN = /error|fail|exception|denied|timeout/i;

/** Concatenated text of the last assistant message (its text parts only). */
function lastAssistantText(messages: GateMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const m = messages[i];
		if (m?.info.role !== "assistant") {
			continue;
		}
		return m.parts
			.filter((p) => p.type === "text" && !p.synthetic && p.text)
			.map((p) => p.text ?? "")
			.join("");
	}
	return "";
}

/** Extract the displayable text of a tool part (completed output / error). */
function toolText(part: GatePart): string {
	const state = part.state;
	if (!state) {
		return "";
	}
	return state.output ?? state.error ?? "";
}

/**
 * Cap a tool result. Plain truncation at {@link TOOL_TEXT_CAP}, except results
 * matching {@link ERROR_PATTERN}, which keep head + tail with a marker so the
 * actual failure (often at the end) survives.
 */
function capToolText(text: string): string {
	if (text.length <= TOOL_TEXT_CAP) {
		return text;
	}
	if (ERROR_PATTERN.test(text)) {
		const dropped = text.length - ERROR_HEAD - ERROR_TAIL;
		return `${text.slice(0, ERROR_HEAD)}…[truncated ${dropped} chars]…${text.slice(text.length - ERROR_TAIL)}`;
	}
	return text.slice(0, TOOL_TEXT_CAP);
}

/**
 * Filter a transcript for `readOutput({ full: true })`: drop synthetic parts,
 * keep user/assistant text and tool parts, cap tool-result text. Messages left
 * with no parts after filtering are dropped.
 */
function filterTranscript(messages: GateMessage[]): TaskOutputMessage[] {
	const out: TaskOutputMessage[] = [];
	for (const m of messages) {
		const parts: TaskOutputPart[] = [];
		for (const p of m.parts) {
			if (p.synthetic) {
				continue;
			}
			if (p.type === "text" && p.text) {
				parts.push({ type: "text", text: p.text });
			} else if (p.type === "tool") {
				parts.push({ type: "tool", text: capToolText(toolText(p)) });
			}
		}
		if (parts.length > 0) {
			out.push({ role: m.info.role, parts });
		}
	}
	return out;
}
