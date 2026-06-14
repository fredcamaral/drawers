/**
 * Cadence engine — the ONE orchestrator behind both `loop` and `goal`.
 *
 * Two independent re-prompt mechanisms share this engine but NEVER cross-wire:
 *   - loop  → INTERVAL-driven. {@link CadenceEngine.start} arms an unref'd timer;
 *     each tick re-injects the instruction into the session. A loop never reads
 *     session.idle.
 *   - goal  → IDLE-driven. {@link CadenceEngine.handleEvent} reacts to
 *     `session.idle`; a goal never arms a timer.
 *
 * Both gate completion on the same sentinel — `GOAL_COMPLETE` in the last
 * assistant message — but each owns its own trigger. Every re-prompt is
 * fire-and-forget through the SDK client (`.catch` + log on failure); a busy
 * session simply queues the prompt, so a tick/idle that lands mid-turn does not
 * throw — see the residual-risk note in the package README.
 *
 * State is an in-memory map mirrored to the injectable store. `recover()` (once
 * at plugin init) rehydrates the map and re-arms ACTIVE loop timers; goals need
 * no re-arm because their trigger (idle) is event-driven, not timer-driven.
 */

import type { CadenceStore, Directive } from "./store";

export type { Directive } from "./store";

/** The completion sentinel both mechanisms look for in the last assistant turn. */
export const GOAL_COMPLETE = "GOAL_COMPLETE";

/** Floor for loop cadence: a sub-second interval would hammer the session. */
const MIN_INTERVAL_MS = 1000;

/** Default safety cap when a tool omits `max_iterations`. */
export const DEFAULT_MAX_ITERATIONS = 10;

/** A timer handle the engine can clear; the default wraps `setInterval`+`unref`. */
export interface IntervalHandle {
	clear(): void;
}

/** The minimal SDK surface the engine drives — re-prompt + read last reply. */
export interface CadenceClient {
	session: {
		promptAsync(args: {
			path: { id: string };
			body: { parts: Array<{ type: "text"; text: string }> };
		}): Promise<unknown>;
		messages(args: { path: { id: string } }): Promise<{
			data?: Array<{
				info: { role: string };
				parts: Array<{ type: string; text?: string }>;
			}>;
		}>;
	};
}

export interface CadenceEngineLogger {
	debug?(msg: string, meta?: Record<string, unknown>): void;
	info?(msg: string, meta?: Record<string, unknown>): void;
	warn?(msg: string, meta?: Record<string, unknown>): void;
	error?(msg: string, meta?: Record<string, unknown>): void;
}

/** Args to start a directive; `id`/`iterations`/`status`/`createdAt` are derived. */
export interface CadenceSpec {
	sessionID: string;
	kind: Directive["kind"];
	instruction: string;
	intervalMs?: number;
	until?: string;
	maxIterations?: number;
}

export interface CadenceEngineDeps {
	client: CadenceClient;
	store: CadenceStore;
	/** Arm a repeating timer; default real `setInterval` with `unref()`. */
	setIntervalFn?: (cb: () => void, ms: number) => IntervalHandle;
	/** Injectable clock; default `Date.now`. */
	clock?: { now(): number };
	logger?: CadenceEngineLogger;
}

export interface CadenceEngine {
	start(spec: CadenceSpec): Promise<Directive>;
	/** Stop directive `id`, but only if it belongs to `sessionID`. */
	stop(id: string, sessionID: string): Promise<Directive | undefined>;
	stopForSession(sessionID: string): Promise<Directive[]>;
	list(sessionID?: string): Directive[];
	handleEvent(event: unknown): Promise<void>;
	recover(): Promise<void>;
	dispose(): void;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** The default unref'd timer: never holds the event loop open on its own. */
function defaultSetInterval(cb: () => void, ms: number): IntervalHandle {
	const handle = setInterval(cb, ms);
	(handle as { unref?: () => void }).unref?.();
	return { clear: () => clearInterval(handle) };
}

/** The sentinel ask appended when a directive must self-report completion. */
function sentinelAsk(): string {
	return (
		`When the objective is fully met, reply with exactly ${GOAL_COMPLETE} on ` +
		`its own line. Otherwise keep working.`
	);
}

/**
 * Completion is declared ONLY by the sentinel on a line of its own — not as a
 * substring. This stops an assistant that merely MENTIONS the sentinel ("do not
 * output GOAL_COMPLETE yet") from prematurely satisfying the directive.
 */
function hasCompletionSentinel(text: string): boolean {
	return text.split(/\r?\n/).some((line) => line.trim() === GOAL_COMPLETE);
}

export function createCadenceEngine(deps: CadenceEngineDeps): CadenceEngine {
	const setIntervalFn = deps.setIntervalFn ?? defaultSetInterval;
	const clock = deps.clock ?? { now: () => Date.now() };
	const logger = deps.logger;

	const directives = new Map<string, Directive>();
	const timers = new Map<string, IntervalHandle>();
	// Ids currently being processed (mid-await in loopTick or goal handling). A
	// `messages` fetch slower than the interval would otherwise let two ticks both
	// pass the pre-await guard and double-increment / double-prompt. While an id is
	// here, a fresh tick/idle for it returns immediately.
	const inFlight = new Set<string>();
	// Set once by dispose(). An in-flight tick/idle that is mid-await when teardown
	// runs re-reads this after each await and bails before any re-prompt or save, so
	// a prompt is never injected (and no file written) after the plugin is disposed.
	let disposed = false;
	let counter = 0;

	function nextId(): string {
		counter += 1;
		return `cadence_${clock.now()}_${counter}`;
	}

	/** Concatenate the text parts of the LAST assistant entry; "" when none. */
	async function lastAssistantText(sessionID: string): Promise<string> {
		try {
			const res = await deps.client.session.messages({
				path: { id: sessionID },
			});
			const data = res.data ?? [];
			for (let i = data.length - 1; i >= 0; i -= 1) {
				const entry = data[i];
				if (entry?.info.role !== "assistant") {
					continue;
				}
				return entry.parts
					.filter((p) => p.type === "text" && typeof p.text === "string")
					.map((p) => p.text ?? "")
					.join("");
			}
			return "";
		} catch (err) {
			logger?.warn?.("messages fetch failed", {
				sessionID,
				err: errorText(err),
			});
			return "";
		}
	}

	/**
	 * Re-prompt the session and report delivery. Returns true when `promptAsync`
	 * resolved, false when it threw (logged, never rethrown). Iteration progress is
	 * counted ON DELIVERY — a failed re-prompt does NOT advance the count, so the
	 * directive simply retries on the next tick/idle rather than burning a slot.
	 */
	async function reprompt(sessionID: string, text: string): Promise<boolean> {
		try {
			await deps.client.session.promptAsync({
				path: { id: sessionID },
				body: { parts: [{ type: "text", text }] },
			});
			return true;
		} catch (err) {
			logger?.error?.("reprompt failed", {
				sessionID,
				err: errorText(err),
			});
			return false;
		}
	}

	function clearTimer(id: string): void {
		const handle = timers.get(id);
		if (handle !== undefined) {
			handle.clear();
			timers.delete(id);
		}
	}

	/**
	 * Transition a directive to a terminal state and reclaim its resources: clear
	 * any timer, drop the persisted file, and evict it from the in-memory map so
	 * neither grows unbounded across a long-lived process. The status is set first
	 * for any caller still holding the reference.
	 */
	async function finalize(
		directive: Directive,
		status: "done" | "stopped",
	): Promise<void> {
		directive.status = status;
		clearTimer(directive.id);
		directives.delete(directive.id);
		await deps.store.delete(directive.id);
	}

	/**
	 * The re-prompt text. A goal ALWAYS carries the sentinel ask (its trigger is
	 * idle and completion is sentinel-gated). A loop carries it only when an
	 * `until` predicate is set — a bare interval loop just re-injects the
	 * instruction with no completion contract.
	 */
	function promptText(directive: Directive): string {
		if (directive.kind === "goal") {
			return `${directive.instruction}\n\n${sentinelAsk()}`;
		}
		if (directive.until !== undefined && directive.until.length > 0) {
			return `${directive.instruction}\n\n${directive.until}\n\n${sentinelAsk()}`;
		}
		return directive.instruction;
	}

	/**
	 * One loop tick. Guarded against re-entrancy: if a prior tick for this id is
	 * still mid-await it is skipped. Every state check is RE-READ after each await
	 * (the messages fetch, the re-prompt) so a stop/completion that landed during the
	 * await is honored before any mutation. A dispose() during an await is honored via
	 * the `disposed` flag checked in those same re-reads (it does not mutate the map).
	 */
	async function loopTick(id: string): Promise<void> {
		if (inFlight.has(id)) {
			return;
		}
		const pre = directives.get(id);
		if (pre === undefined || pre.status !== "active") {
			clearTimer(id);
			return;
		}
		inFlight.add(id);
		try {
			// Arming baseline: a sentinel can only satisfy the directive AFTER it has
			// re-prompted at least once. Without this, a stale GOAL_COMPLETE left in the
			// session by a prior, unrelated turn would finalize a freshly-armed loop on
			// tick 1 having done zero work. `iterations` counts delivered re-prompts.
			if (
				pre.until !== undefined &&
				pre.until.length > 0 &&
				pre.iterations > 0
			) {
				const text = await lastAssistantText(pre.sessionID);
				// Re-check: the directive may have been stopped/disposed during the fetch.
				const afterFetch = directives.get(id);
				if (
					afterFetch === undefined ||
					afterFetch.status !== "active" ||
					disposed
				) {
					clearTimer(id);
					return;
				}
				if (hasCompletionSentinel(text)) {
					await finalize(afterFetch, "done");
					logger?.info?.("loop satisfied (sentinel)", { id });
					return;
				}
			}

			const current = directives.get(id);
			if (current === undefined || current.status !== "active") {
				clearTimer(id);
				return;
			}
			if (current.iterations >= current.maxIterations) {
				await finalize(current, "done");
				logger?.info?.("loop hit max iterations", { id });
				return;
			}

			const delivered = await reprompt(current.sessionID, promptText(current));
			// Re-check after the re-prompt await; only count progress on delivery. A
			// dispose that landed during the await must NOT mutate/persist post-teardown.
			const afterPrompt = directives.get(id);
			if (
				afterPrompt === undefined ||
				afterPrompt.status !== "active" ||
				disposed
			) {
				return;
			}
			if (!delivered) {
				logger?.warn?.("loop re-prompt not delivered — will retry", { id });
				return;
			}
			afterPrompt.iterations += 1;
			await deps.store.save(afterPrompt);
		} finally {
			inFlight.delete(id);
		}
	}

	function armLoop(id: string, intervalMs: number): void {
		const handle = setIntervalFn(() => {
			void loopTick(id);
		}, intervalMs);
		timers.set(id, handle);
	}

	async function start(spec: CadenceSpec): Promise<Directive> {
		// Clamp the loop cadence BEFORE persisting so the stored record carries the
		// effective interval (a sub-second value would hammer the session).
		const intervalMs =
			spec.kind === "loop"
				? Math.max(MIN_INTERVAL_MS, spec.intervalMs ?? MIN_INTERVAL_MS)
				: spec.intervalMs;
		const directive: Directive = {
			id: nextId(),
			sessionID: spec.sessionID,
			kind: spec.kind,
			instruction: spec.instruction,
			intervalMs,
			until: spec.until,
			iterations: 0,
			maxIterations: spec.maxIterations ?? DEFAULT_MAX_ITERATIONS,
			status: "active",
			createdAt: clock.now(),
		};
		directives.set(directive.id, directive);
		await deps.store.save(directive);

		if (directive.kind === "loop") {
			armLoop(directive.id, intervalMs ?? MIN_INTERVAL_MS);
		}
		return directive;
	}

	/**
	 * Stop one directive — but only if it belongs to `sessionID`. A caller can
	 * never halt another session's loop/goal by guessing its id; a foreign or
	 * unknown id returns undefined (the tool reports "no such directive").
	 */
	async function stop(
		id: string,
		sessionID: string,
	): Promise<Directive | undefined> {
		const directive = directives.get(id);
		if (directive === undefined || directive.sessionID !== sessionID) {
			return undefined;
		}
		await finalize(directive, "stopped");
		return directive;
	}

	async function stopForSession(sessionID: string): Promise<Directive[]> {
		// Snapshot before finalize() mutates the map mid-iteration.
		const targets = [...directives.values()].filter(
			(d) => d.sessionID === sessionID && d.status === "active",
		);
		for (const directive of targets) {
			await finalize(directive, "stopped");
		}
		return targets;
	}

	function list(sessionID?: string): Directive[] {
		const out: Directive[] = [];
		for (const directive of directives.values()) {
			if (directive.status !== "active") {
				continue;
			}
			if (sessionID !== undefined && directive.sessionID !== sessionID) {
				continue;
			}
			out.push(directive);
		}
		return out;
	}

	/** Narrow the event union to a `session.idle` carrying a sessionID. */
	function idleSessionID(event: unknown): string | undefined {
		if (typeof event !== "object" || event === null) {
			return undefined;
		}
		const e = event as { type?: unknown; properties?: unknown };
		if (e.type !== "session.idle") {
			return undefined;
		}
		const props = e.properties as { sessionID?: unknown } | undefined;
		if (props === undefined || typeof props.sessionID !== "string") {
			return undefined;
		}
		return props.sessionID;
	}

	/**
	 * Handle one active goal on idle. Same discipline as {@link loopTick}: an
	 * in-flight guard against overlapping idle events for the same goal, and a
	 * re-read of state (including the `disposed` flag) after every await so a
	 * stop/dispose/completion during the fetch or re-prompt is honored before any
	 * mutation. Progress counts on delivery only.
	 */
	async function handleGoalIdle(id: string, sessionID: string): Promise<void> {
		if (inFlight.has(id)) {
			return;
		}
		inFlight.add(id);
		try {
			const text = await lastAssistantText(sessionID);
			const afterFetch = directives.get(id);
			if (
				afterFetch === undefined ||
				afterFetch.status !== "active" ||
				disposed
			) {
				return;
			}
			// Arming baseline: honor the completion sentinel only AFTER the goal has
			// re-prompted at least once. Otherwise a stale GOAL_COMPLETE left by a prior,
			// unrelated turn would satisfy a freshly-armed goal on the first idle having
			// done zero work. `iterations` counts delivered re-prompts.
			if (afterFetch.iterations > 0 && hasCompletionSentinel(text)) {
				await finalize(afterFetch, "done");
				logger?.info?.("goal satisfied", { id });
				return;
			}
			if (afterFetch.iterations >= afterFetch.maxIterations) {
				await finalize(afterFetch, "done");
				logger?.warn?.("goal gave up at max iterations", { id });
				return;
			}

			const delivered = await reprompt(sessionID, promptText(afterFetch));
			const afterPrompt = directives.get(id);
			if (
				afterPrompt === undefined ||
				afterPrompt.status !== "active" ||
				disposed
			) {
				return;
			}
			if (!delivered) {
				logger?.warn?.("goal re-prompt not delivered — will retry", { id });
				return;
			}
			afterPrompt.iterations += 1;
			await deps.store.save(afterPrompt);
		} finally {
			inFlight.delete(id);
		}
	}

	async function handleEvent(event: unknown): Promise<void> {
		const sessionID = idleSessionID(event);
		if (sessionID === undefined) {
			return;
		}
		// Snapshot the matching goals first; handleGoalIdle may finalize (mutating
		// the map) mid-loop. IDLE drives GOALS only — loops are never touched here.
		const goals = [...directives.values()].filter(
			(d) =>
				d.kind === "goal" && d.status === "active" && d.sessionID === sessionID,
		);
		for (const goal of goals) {
			await handleGoalIdle(goal.id, sessionID);
		}
	}

	async function recover(): Promise<void> {
		const loaded = await deps.store.load();
		for (const directive of loaded) {
			directives.set(directive.id, directive);
			if (directive.kind === "loop" && directive.status === "active") {
				const intervalMs = Math.max(
					MIN_INTERVAL_MS,
					directive.intervalMs ?? MIN_INTERVAL_MS,
				);
				armLoop(directive.id, intervalMs);
			}
		}
		logger?.info?.("cadence recovered", { count: loaded.length });
	}

	function dispose(): void {
		disposed = true;
		for (const handle of timers.values()) {
			handle.clear();
		}
		timers.clear();
	}

	return {
		start,
		stop,
		stopForSession,
		list,
		handleEvent,
		recover,
		dispose,
	};
}
