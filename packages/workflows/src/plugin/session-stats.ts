/**
 * Per-session stats collector — live token + tool-call accounting from the SDK
 * event bus (Task 8.1.3).
 *
 * The plugin's `event` hook forwards EVERY SDK event to the engine, including the
 * `message.updated` / `message.part.updated` events for workflow CHILD sessions.
 * Those carry per-agent telemetry core's completion gate deliberately strips
 * (`GateMessage` narrows away `AssistantMessage.tokens` and tool-part inputs), so
 * the only place to harvest live per-agent stats without widening core's gate is
 * the raw event stream the engine already routes. This collector taps it.
 *
 * Scope guard: only sessions explicitly {@link SessionStatsCollector.register}ed
 * are tracked — every other event is dropped at the FIRST map lookup, so a
 * non-workflow session costs one `Map.has` per event and nothing else (the hook
 * is hot). The engine registers on the choke-point sighting of `agent:launched`
 * and unregisters at the agent's `agent:end`.
 *
 * Token accounting (audit row m: `AssistantMessage.tokens = { input, output,
 * reasoning, cache { read, write } }`): `message.updated` fires REPEATEDLY for one
 * message as it streams, so the latest `tokens` REPLACES the prior value per
 * messageID; the snapshot SUMS the per-message latest values. This avoids
 * double-counting a streaming message while still rolling up multi-message turns.
 *
 * Tool accounting: a tool part is counted ONCE, on the first sighting of a
 * terminal `state.status` (`completed`|`error`), keyed by part id (pending/running
 * never count, and a re-emitted terminal part does not re-count). A 3-deep ring
 * keeps `toolName(inputPreview≤60chars)` labels for the status-tool's `lastTools`.
 *
 * Reads are DEFENSIVE throughout (the Phase 2 NaN lesson): every token field is
 * coerced, a missing number contributes 0, and a malformed event is ignored. A
 * telemetry hiccup must never perturb a live run.
 */

import type { Clock, SessionRunner } from "@drawers/core";

/**
 * The SDK event union the engine forwards, derived from the runner's `handleEvent`
 * signature — the same idiom the engine uses to type its own `handleEvent`. The
 * workflows package never depends on `@opencode-ai/sdk` directly (it rides on
 * `@opencode-ai/plugin` at runtime); this keeps the dependency surface unchanged.
 */
type Event = Parameters<SessionRunner["handleEvent"]>[0];

/** What the engine binds to a session when it registers it for tracking. */
export interface SessionStatsRegistration {
	runId: string;
	label: string;
}

/** The rolled-up per-session token totals (one human-facing number per field). */
export interface SessionTokenSnapshot {
	input: number;
	output: number;
	reasoning: number;
	cacheRead: number;
	cacheWrite: number;
}

/** A point-in-time view of one tracked session's stats. */
export interface SessionStatsSnapshot {
	tokens: SessionTokenSnapshot;
	/** Count of terminal (completed|error) tool parts seen, each counted once. */
	toolCalls: number;
	/** The last ≤3 `toolName(inputPreview≤60chars)` labels, oldest → newest. */
	lastTools: string[];
	/** Wall-clock (engine clock) of the last stats change, or registration time. */
	updatedAt: number;
}

export interface SessionStatsCollector {
	/** Begin tracking a child session. Idempotent — re-register resets nothing. */
	register(sessionID: string, reg: SessionStatsRegistration): void;
	/** Stop tracking a session and drop its accumulated state. */
	unregister(sessionID: string): void;
	/** Snapshot of a tracked session, or `undefined` when not registered. */
	snapshot(sessionID: string): SessionStatsSnapshot | undefined;
	/**
	 * Fold one SDK event into the matching session's stats. Returns the affected
	 * `sessionID` when a REGISTERED session's stats actually changed (so the engine
	 * can decide whether to emit a throttled `agent:stats` feed line), `undefined`
	 * otherwise (unregistered session, non-stats event, or a no-op update).
	 */
	handleEvent(event: Event): string | undefined;
}

const TOOL_RING_DEPTH = 3;
const INPUT_PREVIEW_MAX = 60;

interface SessionState {
	/** Latest token reading per messageID — replaced per message, summed for snapshot. */
	tokensByMessage: Map<string, SessionTokenSnapshot>;
	/** Part ids already counted (terminal sighting), so each tool counts once. */
	countedParts: Set<string>;
	toolCalls: number;
	lastTools: string[];
	updatedAt: number;
}

/** Coerce a possibly-missing numeric field to a finite number, else 0. */
function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** The structural slice of an assistant message's tokens the collector reads. */
interface RawTokens {
	input?: unknown;
	output?: unknown;
	reasoning?: unknown;
	cache?: { read?: unknown; write?: unknown };
}

function readTokens(raw: RawTokens): SessionTokenSnapshot {
	return {
		input: num(raw.input),
		output: num(raw.output),
		reasoning: num(raw.reasoning),
		cacheRead: num(raw.cache?.read),
		cacheWrite: num(raw.cache?.write),
	};
}

/** Build the `toolName(inputPreview≤60chars)` ring label from a tool part. */
function toolLabel(tool: string, input: unknown): string {
	let preview = "";
	try {
		preview = JSON.stringify(input ?? {});
	} catch {
		// A non-serializable input (cycles, etc.) still yields a usable label.
		preview = "";
	}
	if (preview.length > INPUT_PREVIEW_MAX) {
		preview = preview.slice(0, INPUT_PREVIEW_MAX);
	}
	return `${tool}(${preview})`;
}

export function createSessionStatsCollector(opts: {
	clock: Clock;
}): SessionStatsCollector {
	const clock = opts.clock;
	const sessions = new Map<string, SessionState>();

	function freshState(): SessionState {
		return {
			tokensByMessage: new Map(),
			countedParts: new Set(),
			toolCalls: 0,
			lastTools: [],
			updatedAt: clock.now(),
		};
	}

	function register(sessionID: string, _reg: SessionStatsRegistration): void {
		if (!sessions.has(sessionID)) {
			sessions.set(sessionID, freshState());
		}
	}

	function unregister(sessionID: string): void {
		sessions.delete(sessionID);
	}

	function snapshot(sessionID: string): SessionStatsSnapshot | undefined {
		const state = sessions.get(sessionID);
		if (state === undefined) {
			return undefined;
		}
		const totals: SessionTokenSnapshot = {
			input: 0,
			output: 0,
			reasoning: 0,
			cacheRead: 0,
			cacheWrite: 0,
		};
		for (const t of state.tokensByMessage.values()) {
			totals.input += t.input;
			totals.output += t.output;
			totals.reasoning += t.reasoning;
			totals.cacheRead += t.cacheRead;
			totals.cacheWrite += t.cacheWrite;
		}
		return {
			tokens: totals,
			toolCalls: state.toolCalls,
			lastTools: [...state.lastTools],
			updatedAt: state.updatedAt,
		};
	}

	/** Fold a `message.updated` for a tracked session; true iff tokens changed. */
	function applyMessageUpdated(state: SessionState, event: Event): boolean {
		const info = (
			event as {
				properties?: {
					info?: { id?: unknown; role?: unknown; tokens?: RawTokens };
				};
			}
		).properties?.info;
		if (info?.role !== "assistant" || typeof info.id !== "string") {
			return false;
		}
		if (info.tokens === undefined) {
			return false;
		}
		// Latest reading REPLACES per message; the snapshot sums across messages.
		state.tokensByMessage.set(info.id, readTokens(info.tokens));
		return true;
	}

	/** Fold a `message.part.updated` for a tracked session; true iff a tool counted. */
	function applyPartUpdated(state: SessionState, event: Event): boolean {
		const part = (
			event as {
				properties?: {
					part?: {
						id?: unknown;
						type?: unknown;
						tool?: unknown;
						state?: { status?: unknown; input?: unknown };
					};
				};
			}
		).properties?.part;
		if (
			part?.type !== "tool" ||
			typeof part.id !== "string" ||
			typeof part.tool !== "string"
		) {
			return false;
		}
		const status = part.state?.status;
		// Count once, on the FIRST terminal sighting, keyed by part id.
		if (status !== "completed" && status !== "error") {
			return false;
		}
		if (state.countedParts.has(part.id)) {
			return false;
		}
		state.countedParts.add(part.id);
		state.toolCalls += 1;
		state.lastTools.push(toolLabel(part.tool, part.state?.input));
		if (state.lastTools.length > TOOL_RING_DEPTH) {
			state.lastTools.shift();
		}
		return true;
	}

	function handleEvent(event: Event): string | undefined {
		// Drop at the first key check: only message.updated / message.part.updated
		// carry stats, and only registered sessions are tracked.
		if (
			event.type !== "message.updated" &&
			event.type !== "message.part.updated"
		) {
			return undefined;
		}
		const sessionID =
			event.type === "message.updated"
				? (event as { properties?: { info?: { sessionID?: unknown } } })
						.properties?.info?.sessionID
				: (event as { properties?: { part?: { sessionID?: unknown } } })
						.properties?.part?.sessionID;
		if (typeof sessionID !== "string") {
			return undefined;
		}
		const state = sessions.get(sessionID);
		if (state === undefined) {
			return undefined;
		}
		const changed =
			event.type === "message.updated"
				? applyMessageUpdated(state, event)
				: applyPartUpdated(state, event);
		if (!changed) {
			return undefined;
		}
		state.updatedAt = clock.now();
		return sessionID;
	}

	return { register, unregister, snapshot, handleEvent };
}
