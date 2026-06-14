/**
 * Feed parser + run-state reducer (Task 8.3.1) — the pure core of the native TUI
 * viewer's `./tui` surface.
 *
 * The feed file (`<dataDir>/workflow-feed/<runId>.jsonl`) is the viewer's ONLY
 * data source (Phase 8 binding decision): one `FeedEvent` per line. This module
 * turns those lines into a phases/agents/stats model structurally equivalent to
 * what `workflow_status` renders from the live engine handle — but reduced from
 * disk, with NO clock, NO io, and NO opentui/solid imports, so it is unit-testable
 * under plain `bun test` and reused by both the route and the sidebar.
 *
 * The reduction rules MIRROR `plugin/tools/workflow-status.ts`'s `liveAgentRows`
 * pairing exactly (FIFO open occurrences per label, sessionID-matched ends, first-
 * unbound-occurrence launch binding) so the live TUI and the server tool agree —
 * including the concurrent-same-label case where one shared head row would smear
 * the last-launched session's stats over every sibling.
 *
 * `FeedEvent` is RE-EXPORTED from `plugin/feed.ts` (one source of truth for the
 * wire shape); the formatting glyph/marker helpers live in the shared
 * `./format.ts`, imported by both this reducer and the status tool.
 */

import type { RunStatus } from "../plugin/engine";
import type { EnrichedProgressEvent, FeedEvent } from "../plugin/feed";
import type { SessionTokenSnapshot } from "../plugin/session-stats";
import { MARK_PENDING, phaseMarker, totalTokens } from "./format";

export type { FeedEvent } from "../plugin/feed";

/** Group label for agents emitted without a phase (matches `workflow-status.ts`). */
const NO_PHASE = "(no phase)";

/** The known `FeedEvent` discriminants — anything else is dropped by the parser. */
const KNOWN_TYPES: ReadonlySet<string> = new Set([
	"run:start",
	"run:cancel-requested",
	"run:end",
	"agent:start",
	"agent:launched",
	"agent:end",
	"agent:stats",
	"log",
	"warn",
]);

/**
 * Parse one feed line into a typed {@link FeedEvent}, or `undefined` (Task 8.3.1).
 *
 * `JSON.parse` is wrapped in try/catch so a truncated trailing line during a live
 * tail returns `undefined` instead of throwing — append-only writes mean a partial
 * line is only ever a not-yet-flushed tail. A parsed value must be a non-array
 * object whose `type` is a known `FeedEvent` discriminant; everything else
 * (non-JSON, a JSON scalar, `null`, an unknown/missing `type`) returns `undefined`.
 * The wire shape is NOT deeply validated — the reducer tolerates partial fields,
 * and the feed is engine-authored, not adversarial.
 */
export function parseFeedLine(line: string): FeedEvent | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return undefined;
	}
	const type = (parsed as { type?: unknown }).type;
	if (typeof type !== "string" || !KNOWN_TYPES.has(type)) {
		return undefined;
	}
	return parsed as FeedEvent;
}

/** The enriched `agent:end` view — its stats fields are optional on the union. */
type EnrichedAgentEnd = Extract<
	EnrichedProgressEvent,
	{ type: "agent:end" }
> & {
	model?: string;
	tokens?: SessionTokenSnapshot;
	toolCalls?: number;
	durationMs?: number;
	result?: string;
};

/**
 * One agent occurrence in a phase group. `status` is `undefined` only while the
 * occurrence is still running (no `agent:end` yet). Live `tokens` come from the
 * throttled `agent:stats` line; terminal `tokens` come from the enriched end.
 */
export interface AgentView {
	label: string;
	phase?: string;
	sessionID?: string;
	status?: string;
	model?: string;
	agentType?: string;
	/** Truncated user-prompt preview from `agent:start` (for the Detail pane). */
	prompt?: string;
	/** Total tokens (already summed); absent on cached / un-tracked agents. */
	tokens?: number;
	toolCalls?: number;
	/** The ≤3-deep ring of `toolName(inputPreview)` labels from the last stats line. */
	lastTools?: string[];
	durationMs?: number;
	note?: string;
	/**
	 * The conclusion the agent passed forward — a preview of its settled result
	 * (structured JSON or final text), from the `agent:end` line. Absent while running
	 * and on a degraded call (which carries {@link note} instead). The Detail pane
	 * surfaces it as the step's conclusion once it settles.
	 */
	result?: string;
	/** Engine `at` of this occurrence's `agent:start`. */
	startedAt?: number;
	/** Engine `at` of the last `agent:stats`/`agent:end` touching this occurrence. */
	updatedAt?: number;
}

/** One phase group, in first-appearance order. */
export interface PhaseView {
	name: string;
	/** Terminal occurrences (status defined). */
	done: number;
	total: number;
	/** ✗ if any failed, … if any running, ✓ otherwise. */
	marker: string;
	agents: AgentView[];
}

/**
 * The reduced run view. `status` is `running` until a terminal `run:end`, with
 * `cancelling` interposed on a `run:cancel-requested` line (until the terminal
 * status arrives). Phases preserve first-appearance order.
 */
export interface RunViewState {
	runId?: string;
	/**
	 * The workflow's human name from the `run:start` line (`meta.name`). The view
	 * renders it as the run's identity in the header, falling back to {@link runId}
	 * when it is absent — which happens for OLD feeds written before the engine
	 * stamped `name`. A clean degrade, not an error.
	 */
	name?: string;
	status: "running" | "cancelling" | RunStatus;
	startedAt?: number;
	endedAt?: number;
	phases: PhaseView[];
}

export interface RunStateReducer {
	/** Fold one parsed feed event into the state, in file order. */
	apply(event: FeedEvent): void;
	/** The current reduced view (recomputed phase markers/counts included). */
	state(): RunViewState;
}

/**
 * The one-line glance the `sidebar_content` slot renders per active run (Task
 * 8.3.4). `doneAgents`/`totalAgents` aggregate the phase done/total off a
 * {@link RunViewState} — the leading number is the COMPLETED count, matching CC's
 * `34/35 agents` parity convention (34 of 35 finished). `status` is the run's
 * top-level status; `elapsedMs` is the run's wall-clock age.
 */
export interface RunSummary {
	runId?: string;
	/** Terminal occurrences (an `agent:end` seen) across all phases — CC's leading number. */
	doneAgents: number;
	/** Total agent occurrences across all phases. */
	totalAgents: number;
	/** Run age in ms: settled → `endedAt - startedAt`; live → `now - startedAt`. */
	elapsedMs: number;
	status: RunViewState["status"];
}

/**
 * Collapse a {@link RunViewState} into the sidebar's one-line {@link RunSummary}
 * (Task 8.3.4). Sums each phase's `done`/`total` into `doneAgents` (terminal) and
 * `totalAgents` — `doneAgents` is the COMPLETED count so the sidebar renders the
 * CC-style `done/total` glance (the leading number is "how many finished", e.g.
 * `34/35`). `elapsedMs` derives from the run stamps: a settled run uses its
 * feed-stamped `endedAt - startedAt` (clock-free, stable after a restart); a live
 * run uses the caller-supplied `now - startedAt` (the reducer holds NO clock, so the
 * sidebar passes `Date.now()`). A run with no `startedAt` stamp (an empty or
 * not-yet-started feed) has `elapsedMs: 0`; negatives clamp to 0 so a glance never
 * shows a backwards duration.
 */
export function summarize(state: RunViewState, now: number): RunSummary {
	let doneAgents = 0;
	let totalAgents = 0;
	for (const phase of state.phases) {
		totalAgents += phase.total;
		doneAgents += phase.done;
	}
	let elapsedMs = 0;
	if (state.startedAt !== undefined) {
		const end = state.endedAt ?? now;
		elapsedMs = Math.max(0, end - state.startedAt);
	}
	return {
		...(state.runId !== undefined ? { runId: state.runId } : {}),
		doneAgents,
		totalAgents,
		elapsedMs,
		status: state.status,
	};
}

/**
 * Build a reducer that folds `FeedEvent`s in file order into a {@link RunViewState}.
 * Holds NO clock and NO io — a test feeds a hand-built `FeedEvent[]` and asserts
 * the model. Phase markers/counts are derived on `state()` from the live agents.
 */
export function createRunStateReducer(): RunStateReducer {
	let runId: string | undefined;
	let name: string | undefined;
	let status: RunViewState["status"] = "running";
	let startedAt: number | undefined;
	let endedAt: number | undefined;
	// DECLARED phase titles from `run:start` (meta.phases), in order. Seeds the phase
	// list so the WHOLE pipeline shows as pending headers before any agent launches into
	// a later phase; agents (created imperatively as execution reaches each phase) then
	// overlay their occurrences. Empty when the script declared no phases (derive-from-
	// agents, the prior behavior).
	let declaredPhases: string[] = [];

	// Agents in start order across all phases (preserves chronology for grouping);
	// phase grouping happens at `state()` time off this flat list.
	const agents: AgentView[] = [];
	// Per label: a FIFO of open agent-array indices awaiting launch/end binding.
	const open = new Map<string, number[]>();

	const enqueue = (label: string, idx: number): void => {
		const queue = open.get(label) ?? [];
		queue.push(idx);
		open.set(label, queue);
	};
	const dequeue = (label: string): number | undefined =>
		open.get(label)?.shift();
	const dropOpen = (label: string, idx: number): void => {
		const queue = open.get(label);
		if (queue === undefined) {
			return;
		}
		const at = queue.indexOf(idx);
		if (at !== -1) {
			queue.splice(at, 1);
		}
	};

	function applyStart(e: Extract<FeedEvent, { type: "agent:start" }>): void {
		const row: AgentView = {
			label: e.label,
			startedAt: e.at,
			...(e.phase !== undefined ? { phase: e.phase } : {}),
			...(e.promptPreview !== undefined ? { prompt: e.promptPreview } : {}),
		};
		agents.push(row);
		enqueue(e.label, agents.length - 1);
	}

	function applyLaunched(
		e: Extract<FeedEvent, { type: "agent:launched" }>,
	): void {
		// Bind launch metadata onto the FIRST still-open occurrence for this label
		// whose session is not yet bound — NOT the FIFO head. With N concurrent
		// same-label agents, every `agent:launched` would otherwise stamp the same
		// head row (last-writer-wins). Claiming the first UNBOUND open row gives each
		// launch its own occurrence (mirrors the engine's per-sessionID disambiguation).
		const queue = open.get(e.label);
		const idx = queue?.find((i) => agents[i]?.sessionID === undefined);
		const row = idx !== undefined ? agents[idx] : undefined;
		if (row === undefined) {
			return;
		}
		row.sessionID = e.sessionID;
		if (e.model !== undefined) {
			row.model = e.model;
		}
		if (e.agentType !== undefined) {
			row.agentType = e.agentType;
		}
	}

	function applyStats(e: Extract<FeedEvent, { type: "agent:stats" }>): void {
		// Stats are keyed BY sessionID so concurrent same-label occurrences each
		// accumulate their own live numbers (the bug `workflow-status.ts:233` documents).
		const row = agents.find((a) => a.sessionID === e.sessionID);
		if (row === undefined) {
			return;
		}
		// `tokens` is REQUIRED on the wire type, but `parseFeedLine` casts without
		// validating per-variant fields — a format-drifted / hand-edited `agent:stats`
		// line may omit it. Guard the dereference the same way `applyEnd` guards its
		// optional `tokens`, so a tokens-less line is a no-op, not a crash.
		if (e.tokens === undefined) {
			return;
		}
		row.tokens = totalTokens({
			input: e.tokens.input,
			output: e.tokens.output,
			reasoning: e.tokens.reasoning,
			cacheRead: e.tokens.cacheRead,
			cacheWrite: e.tokens.cacheWrite,
		});
		row.toolCalls = e.toolCalls;
		row.lastTools = e.lastTools;
		row.updatedAt = e.at;
	}

	function applyEnd(e: EnrichedAgentEnd): void {
		// A launched end carries its own sessionID — pair it to the row that bound
		// that exact session (correct under concurrent same-label agents, whose ends
		// arrive in completion, not launch, order). A cached/sessionless end falls
		// back to the FIFO head (the documented chronological approximation).
		let idx: number | undefined;
		if (e.sessionID !== undefined) {
			const found = agents.findIndex((r) => r.sessionID === e.sessionID);
			if (found !== -1) {
				idx = found;
				dropOpen(e.label, found);
			}
		}
		if (idx === undefined) {
			idx = dequeue(e.label);
		}
		const row = idx !== undefined ? agents[idx] : undefined;
		if (row === undefined) {
			return;
		}
		row.status = e.status;
		row.updatedAt = e.at;
		if (e.sessionID !== undefined) {
			row.sessionID = e.sessionID;
		}
		if (e.note !== undefined) {
			row.note = e.note;
		}
		if (e.result !== undefined) {
			row.result = e.result;
		}
		if (e.model !== undefined) {
			row.model = e.model;
		}
		// `agentType` is bound at `agent:launched`; the enriched end doesn't surface
		// it (the `Extract` over the union collapses to the common end shape), and it
		// never changes between launch and end — so the launch binding is the source.
		if (e.tokens !== undefined) {
			row.tokens = totalTokens(e.tokens);
		}
		if (e.toolCalls !== undefined) {
			row.toolCalls = e.toolCalls;
		}
		if (e.durationMs !== undefined) {
			row.durationMs = e.durationMs;
		}
	}

	function apply(event: FeedEvent): void {
		switch (event.type) {
			case "run:start":
				runId = event.runId;
				name = event.name;
				startedAt = event.at;
				if (event.phases !== undefined) {
					declaredPhases = event.phases;
				}
				break;
			case "run:cancel-requested":
				// Only interpose `cancelling` while still running; a terminal status wins.
				if (status === "running") {
					status = "cancelling";
				}
				break;
			case "run:end":
				status = event.status as RunStatus;
				endedAt = event.at;
				break;
			case "agent:start":
				applyStart(event);
				break;
			case "agent:launched":
				applyLaunched(event);
				break;
			case "agent:stats":
				applyStats(event);
				break;
			case "agent:end":
				applyEnd(event as EnrichedAgentEnd);
				break;
			default:
				// `log`/`warn` carry no run-state — ignored by the reducer (the route
				// renders narrator lines separately if it ever needs them).
				break;
		}
	}

	function state(): RunViewState {
		// Group by phase in first-appearance order, deriving each phase's marker and
		// done/total off the live occurrences (same derivation as the status tool).
		// Each row is SHALLOW-COPIED into the group: the reducer mutates occurrences in
		// place internally, but `state()` must expose immutable snapshots so the route's
		// <For> (which memoizes per item REFERENCE) re-renders a row whose stats/status
		// changed — a stable identity would freeze the live row. This mirrors how the
		// PhaseView objects below are rebuilt fresh on every call.
		// Seed the order with the DECLARED phases (the full pipeline, pending), then
		// append any phase an agent reported that wasn't declared (e.g. NO_PHASE, or a
		// phase string the script used without listing in meta.phases). A declared phase
		// with no agents yet renders as a pending header (✗/…/✓ derivation only applies
		// once it has occurrences).
		const order: string[] = [];
		const seen = new Set<string>();
		for (const name of declaredPhases) {
			if (!seen.has(name)) {
				order.push(name);
				seen.add(name);
			}
		}
		const groups = new Map<string, AgentView[]>();
		for (const row of agents) {
			const phase = row.phase ?? NO_PHASE;
			let group = groups.get(phase);
			if (group === undefined) {
				group = [];
				groups.set(phase, group);
				if (!seen.has(phase)) {
					order.push(phase);
					seen.add(phase);
				}
			}
			group.push({ ...row });
		}
		const phases: PhaseView[] = order.map((name) => {
			const group = groups.get(name) ?? [];
			const done = group.filter((r) => r.status !== undefined).length;
			return {
				name,
				done,
				total: group.length,
				// A declared-but-not-started phase (no occurrences) is pending, not done —
				// `phaseMarker([])` would read ✓ (vacuously no failures/running).
				marker: group.length === 0 ? MARK_PENDING : phaseMarker(group),
				agents: group,
			};
		});
		return {
			...(runId !== undefined ? { runId } : {}),
			...(name !== undefined ? { name } : {}),
			status,
			...(startedAt !== undefined ? { startedAt } : {}),
			...(endedAt !== undefined ? { endedAt } : {}),
			phases,
		};
	}

	return { apply, state };
}
