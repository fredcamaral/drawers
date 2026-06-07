/**
 * `workflow_status` — inspect a workflow run's progress and (when terminal) its
 * result.
 *
 * The model is told NOT to poll; this tool exists so it can deliberately read a
 * run's state — either while live (progress tree) or after the completion notice
 * (result/error). Built as a `tool()` factory closing over the engine so tests
 * inject a minimal fake.
 *
 * Render is a pure function of the run handle (record + progress) plus the
 * engine's live stats snapshots. The progress section is a CC-style PHASE TREE
 * (Task 8.1.5): agents are grouped by `phase` (a single `(no phase)` group for
 * the rest), each phase header carrying a `<done>/<total>` counter and a status
 * marker, and each agent rendered as one row `<marker> <label>  <model>
 * <tokens> tok · <tools> tools · <duration>`. A LIVE run builds its rows by
 * pairing `agent:start`/`agent:launched`/`agent:end` from `handle.progress`
 * (running rows pull live numbers from {@link WorkflowEngine.statsSnapshot}); a
 * SETTLED/recovered run renders purely from {@link RunRecord.agents}, so the same
 * view works after a restart. Narrator `log`/`warn` lines follow the tree.
 */

import { type ToolContext, tool } from "@opencode-ai/plugin";
import {
	formatDuration,
	formatTokens,
	phaseMarker,
	shortModel,
	statusMarker,
	totalTokens,
} from "../../tui/format";
import type {
	AgentSummary,
	RunHandle,
	RunRecord,
	WorkflowEngine,
} from "../engine";
import type { EnrichedProgressEvent } from "../feed";
import { humanizeDuration } from "../format";
import type {
	SessionStatsSnapshot,
	SessionTokenSnapshot,
} from "../session-stats";

// Re-export the CC-tree formatting helpers from their shared home (Task 8.3.1).
// They moved to `src/tui/format.ts` so the textual tool and the native TUI reducer
// format identically; the names stay importable from here for existing consumers.
export { formatDuration, formatTokens } from "../../tui/format";

/**
 * The engine's live per-session stats lookup, narrowed to the tool's needs (Task
 * 8.1.5). Returns the current token/tool snapshot for a tracked CHILD session, or
 * `undefined` once the agent has settled (the collector drops it at `agent:end`).
 */
type StatsSnapshotFn = (sessionID: string) => SessionStatsSnapshot | undefined;

/** Head-truncation ceiling for the rendered result JSON (default, no-`full` view). */
const RESULT_MAX = 2000;
/**
 * Hard ceiling on the `full:true` result JSON (Task 7.2.2). Only a pathological
 * size triggers it; the cut is NEVER silent — a trailer names the on-disk path.
 */
const FULL_RESULT_MAX = 200_000;
/** Group label for agents emitted without a phase. */
const NO_PHASE = "(no phase)";

/** Upper bound on `wait_ms` — two minutes, matching the run-spawn ceiling. */
const WAIT_MS_CAP = 120_000;

/** Cadence of the live-title refresh while a wait blocks (Task 6.2.3). */
const TITLE_TICK_MS = 1_000;

/**
 * Injectable interval scheduler (Task 6.2.3). Defaults to the globals; tests pass
 * deterministic fakes so the ~1s title tick fires on demand rather than on a real
 * wall clock. This is a TEST SEAM, not a user-facing config knob — it carries no
 * default behavior change and is invisible to the tool's args/description.
 */
export interface WorkflowStatusTimers {
	setIntervalFn: (cb: () => void, ms: number) => unknown;
	clearIntervalFn: (handle: unknown) => void;
}

/** Coerce a raw arg to string (opencode's raw path may hand a non-string). */
function coerceId(raw: unknown): string {
	return typeof raw === "string" ? raw : String(raw);
}

/**
 * Coerce `wait_ms` to a non-negative integer capped at {@link WAIT_MS_CAP}, or 0
 * (no wait). opencode's raw execute path applies no Zod coercion, so the arg may
 * arrive as a number, a numeric string, an empty string, NaN, or absent — every
 * non-positive/garbage value collapses to 0 (Phase 2 NaN lesson).
 */
function coerceWaitMs(raw: unknown): number {
	if (raw === undefined || raw === null) {
		return 0;
	}
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) {
		return 0;
	}
	return Math.min(Math.floor(n), WAIT_MS_CAP);
}

/**
 * Coerce `full` to a boolean (Task 7.2.2). opencode's raw execute path applies no
 * Zod coercion, so the arg may arrive as a real boolean, the string `"true"`/
 * `"false"`, or absent — `true`/`"true"`/`"1"` are truthy, everything else false.
 */
function coerceFull(raw: unknown): boolean {
	if (raw === true) {
		return true;
	}
	if (typeof raw === "string") {
		const v = raw.trim().toLowerCase();
		return v === "true" || v === "1";
	}
	return false;
}

/** Resolve after `ms`, never rejecting — the loser of the settle race. */
function timeout(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/**
 * The enriched `agent:end` view (Task 8.1.4): a stamped end carrying the engine-
 * computed per-agent stats. `EnrichedProgressEvent`'s end member is a UNION of a
 * plain stamped end and this enriched one, so a `type === "agent:end"` narrow
 * keeps both arms; reading the enriched fields requires this widened view. Every
 * extra field is optional — a cached end (no session) carries none.
 */
type EnrichedAgentEnd = Extract<
	EnrichedProgressEvent,
	{ type: "agent:end" }
> & {
	model?: string;
	tokens?: SessionTokenSnapshot;
	toolCalls?: number;
	durationMs?: number;
};

/**
 * One agent occurrence as the CC tree renders it (Task 8.1.5). Built from a LIVE
 * run's paired progress events (running rows fill `tokens`/`toolCalls` from the
 * collector snapshot) or directly from a settled run's {@link AgentSummary}.
 * `status` is `undefined` only for a still-running agent (no `agent:end` yet).
 */
interface AgentRow {
	label: string;
	phase?: string;
	status?: string;
	model?: string;
	/**
	 * The child sessionID bound at `agent:launched` (Task 8.1.5). Carried on the row
	 * so a still-running occurrence pulls ITS OWN live snapshot — critical for
	 * concurrent same-label agents, where one shared head row would otherwise show
	 * the last-launched session's stats for every sibling.
	 */
	sessionID?: string;
	/** Total tokens (already summed); absent on cached / un-tracked agents. */
	tokens?: number;
	toolCalls?: number;
	durationMs?: number;
	note?: string;
}

/** The error string listing every known runId. */
function unknownText(engine: WorkflowEngine, runId: string): string {
	const known = [...engine.runs.keys()];
	const list = known.length > 0 ? known.join(", ") : "(none)";
	return `unknown run_id ${runId}. Known runs: ${list}`;
}

/**
 * Derive the on-disk run-record path from the record's `scriptPath` (Task 7.2.2).
 * The engine builds both under the same data dir — `workflow-scripts/<id>.js` and
 * `workflow-runs/<id>.json` — so the runs path is the script path with the subdir
 * and extension swapped. Truthful when the swap pattern holds; otherwise falls
 * back to the generic on-disk description the spec sanctions.
 */
function runsPathFor(record: RunRecord): string {
	const swapped = record.scriptPath
		.replace("/workflow-scripts/", "/workflow-runs/")
		.replace(/\.js$/, ".json");
	if (swapped !== record.scriptPath && swapped.endsWith(`${record.id}.json`)) {
		return swapped;
	}
	// Couldn't derive truthfully — name the shape without lying about the dir.
	return "the run record on disk (workflow-runs/<id>.json under the drawers data dir)";
}

/**
 * Render the completed run's result. Default view: a 2000-char head preview with a
 * `(truncated)` marker (Task 4.1.3). `full:true` (Task 7.2.2): the COMPLETE JSON,
 * with a 200k safety ceiling whose cut is NEVER silent — a trailer names the
 * on-disk path so the full value is always recoverable.
 */
function renderResult(record: RunRecord, full: boolean): string {
	const json = JSON.stringify(record.returnValue) ?? "undefined";
	if (!full) {
		if (json.length <= RESULT_MAX) {
			return `result: ${json}`;
		}
		return `result: ${json.slice(0, RESULT_MAX)} … (truncated)`;
	}
	if (json.length <= FULL_RESULT_MAX) {
		return `result: ${json}`;
	}
	// Pathological size: cut at the ceiling but say so explicitly and point at disk.
	return (
		`result: ${json.slice(0, FULL_RESULT_MAX)} … (result exceeds 200k chars; ` +
		`full JSON at ${runsPathFor(record)})`
	);
}

/**
 * Render the persisted per-agent diagnostics block (Task 7.2.1/7.2.2), shown only
 * under `full:true`. One line per diagnostic: reason, label, index, child session,
 * and the captured raw text (already capped at capture time). Returns an empty
 * array when the record carries no diagnostics.
 */
function renderDiagnostics(record: RunRecord): string[] {
	const diags = record.diagnostics;
	if (diags === undefined || diags.length === 0) {
		return [];
	}
	const lines: string[] = ["", "diagnostics:"];
	for (const d of diags) {
		const session =
			d.childSessionID !== undefined ? ` session=${d.childSessionID}` : "";
		lines.push(`  [${d.reason}] ${d.label} (#${d.index})${session}`);
		if (d.rawText !== undefined) {
			lines.push(`    raw: ${d.rawText}`);
		}
	}
	return lines;
}

/**
 * Pair each `agent:start` with its matching `agent:end` by first-unmatched-start
 * per label (Task 6.2.1). Labels may repeat, so a strict label→last-end map would
 * mis-attribute status and duration; chronological pairing (consume the earliest
 * still-open start when an end arrives) is the documented approximation. Returns,
 * per start event index, the matched end's status (undefined → still running) and
 * the elapsed `end.at − start.at` (undefined when unmatched).
 */
function pairStartsToEnds(
	progress: EnrichedProgressEvent[],
): Map<number, { status?: string; elapsedMs?: number; note?: string }> {
	const result = new Map<
		number,
		{ status?: string; elapsedMs?: number; note?: string }
	>();
	// Per label: a FIFO of open start indices awaiting an end.
	const open = new Map<string, number[]>();
	progress.forEach((e, i) => {
		if (e.type === "agent:start") {
			result.set(i, {});
			const queue = open.get(e.label) ?? [];
			queue.push(i);
			open.set(e.label, queue);
		} else if (e.type === "agent:end") {
			const queue = open.get(e.label);
			const startIdx = queue?.shift();
			if (startIdx !== undefined) {
				const start = progress[startIdx];
				result.set(startIdx, {
					status: e.status,
					elapsedMs: start !== undefined ? e.at - start.at : undefined,
					// Task 7.2.1: carry the diagnostic note so the render can show WHY a
					// call degraded, right under its marker line.
					...(e.note !== undefined ? { note: e.note } : {}),
				});
			}
		}
	});
	return result;
}

/**
 * Build the CC-style agent rows for a LIVE run by walking its enriched progress
 * (Task 8.1.5). Each `agent:start` opens an occurrence; the matching
 * `agent:launched` (FIFO by label) binds its sessionID/model, and the matching
 * `agent:end` (also FIFO by label) carries the final status + enriched
 * tokens/toolCalls/durationMs/model. A start with no end is still running: its
 * tokens/toolCalls are pulled LIVE from the engine's collector snapshot via the
 * bound sessionID. Cached ends (no sessionID) yield a `cached` row with no stats.
 * Rows preserve start order so the phase grouping reads chronologically.
 */
function liveAgentRows(
	progress: EnrichedProgressEvent[],
	statsSnapshot: StatsSnapshotFn,
): AgentRow[] {
	const rows: AgentRow[] = [];
	// Per label: a FIFO of open row indices awaiting launch/end binding.
	const open = new Map<string, number[]>();
	const enqueue = (label: string, idx: number): void => {
		const queue = open.get(label) ?? [];
		queue.push(idx);
		open.set(label, queue);
	};
	const dequeue = (label: string): number | undefined =>
		open.get(label)?.shift();
	/** Remove a specific open index for a label (the sessionID-matched end path). */
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

	for (const e of progress) {
		if (e.type === "agent:start") {
			const row: AgentRow = {
				label: e.label,
				...(e.phase !== undefined ? { phase: e.phase } : {}),
			};
			rows.push(row);
			enqueue(e.label, rows.length - 1);
		} else if (e.type === "agent:launched") {
			// Bind launch metadata onto the first still-open occurrence for this label
			// whose session is not yet bound — NOT the FIFO head. With N concurrent
			// same-label agents, every `agent:launched` would otherwise stamp the same
			// head row (last-writer-wins), leaving the siblings model-less and stat-less
			// until their end. Claiming the first UNBOUND open row gives each launch its
			// own occurrence, mirroring the engine's per-sessionID disambiguation.
			const queue = open.get(e.label);
			const idx = queue?.find((i) => rows[i]?.sessionID === undefined);
			const row = idx !== undefined ? rows[idx] : undefined;
			if (row !== undefined) {
				row.sessionID = e.sessionID;
				if (e.model !== undefined) {
					row.model = e.model;
				}
				// Pull THIS row's own live snapshot (by its bound session) so a still-
				// running occurrence shows its own current stats, not a sibling's.
				const snap = statsSnapshot(e.sessionID);
				if (snap !== undefined) {
					row.tokens = totalTokens(snap.tokens);
					row.toolCalls = snap.toolCalls;
				}
			}
		} else if (e.type === "agent:end") {
			// A launched end carries its own sessionID — pair it to the row that bound
			// that exact session (correct under concurrent same-label agents, whose ends
			// arrive in completion, not launch, order). A cached/sessionless end falls
			// back to the FIFO head (the documented chronological approximation).
			let idx: number | undefined;
			if (e.sessionID !== undefined) {
				idx = rows.findIndex((r) => r.sessionID === e.sessionID);
				if (idx === -1) {
					idx = undefined;
				} else {
					dropOpen(e.label, idx);
				}
			}
			if (idx === undefined) {
				idx = dequeue(e.label);
			}
			const row = idx !== undefined ? rows[idx] : undefined;
			if (row !== undefined) {
				// The enriched fields (model/tokens/toolCalls/durationMs) are optional on
				// the union; read them through the enriched view (an engine-side LIVE end
				// always carries them, a cached end carries none).
				const end = e as EnrichedAgentEnd;
				row.status = end.status;
				if (end.note !== undefined) {
					row.note = end.note;
				}
				if (end.model !== undefined) {
					row.model = end.model;
				}
				if (end.tokens !== undefined) {
					row.tokens = totalTokens(end.tokens);
				}
				if (end.toolCalls !== undefined) {
					row.toolCalls = end.toolCalls;
				}
				if (end.durationMs !== undefined) {
					row.durationMs = end.durationMs;
				}
			}
		}
	}
	return rows;
}

/** Map the settled {@link RunRecord.agents} rollup onto CC-style rows (Task 8.1.5). */
function settledAgentRows(agents: AgentSummary[]): AgentRow[] {
	return agents.map((a) => ({
		label: a.label,
		...(a.phase !== undefined ? { phase: a.phase } : {}),
		status: a.status,
		...(a.model !== undefined ? { model: a.model } : {}),
		...(a.tokens !== undefined ? { tokens: totalTokens(a.tokens) } : {}),
		...(a.toolCalls !== undefined ? { toolCalls: a.toolCalls } : {}),
		...(a.durationMs !== undefined ? { durationMs: a.durationMs } : {}),
		...(a.note !== undefined ? { note: a.note } : {}),
	}));
}

/** The narrator `log`/`warn` lines, in emission order (Task 8.1.5 keeps them below the tree). */
function narratorLines(progress: EnrichedProgressEvent[]): string[] {
	const lines: string[] = [];
	for (const e of progress) {
		if (e.type === "log") {
			lines.push(`  log: ${e.message}`);
		} else if (e.type === "warn") {
			lines.push(`  warn: ${e.message}`);
		}
	}
	return lines;
}

/** The trailing `<tokens> tok · <tools> tools · <duration>` stats segment for a row. */
function statsSegment(row: AgentRow): string {
	// Cached (or otherwise un-tracked) agents carry no stats — CC prints `cached`.
	if (row.status === "cached") {
		return "cached";
	}
	const segments: string[] = [];
	if (row.tokens !== undefined) {
		segments.push(`${formatTokens(row.tokens)} tok`);
	}
	if (row.toolCalls !== undefined) {
		segments.push(`${row.toolCalls} tools`);
	}
	if (row.durationMs !== undefined) {
		segments.push(formatDuration(row.durationMs));
	}
	return segments.join(" · ");
}

/** Render one agent row: `<marker> <label>  <model>  <stats>` + an optional note line. */
function renderAgentRow(row: AgentRow): string[] {
	const parts = [`  ${statusMarker(row.status)} ${row.label}`];
	if (row.model !== undefined) {
		parts.push(shortModel(row.model));
	}
	const stats = statsSegment(row);
	if (stats.length > 0) {
		parts.push(stats);
	}
	const lines = [parts.join("  ")];
	// Task 7.2.1 note carries through under the row — empty-output gets the ⚠ form.
	if (row.note !== undefined) {
		lines.push(
			row.note === "empty output" ? "    ⚠ empty output" : `    ${row.note}`,
		);
	}
	return lines;
}

/**
 * Render the CC-style phase tree (Task 8.1.5): agents grouped by `phase` (a single
 * `(no phase)` group for the rest) in first-appearance order, each header carrying
 * a marker and a `<done>/<total>` counter, each agent as one stat row. `done`
 * counts terminal occurrences (status defined); a running occurrence is not done.
 */
function renderAgentTree(rows: AgentRow[]): string[] {
	if (rows.length === 0) {
		return [];
	}
	// Preserve first-appearance phase order.
	const order: string[] = [];
	const groups = new Map<string, AgentRow[]>();
	for (const row of rows) {
		const phase = row.phase ?? NO_PHASE;
		let group = groups.get(phase);
		if (group === undefined) {
			group = [];
			groups.set(phase, group);
			order.push(phase);
		}
		group.push(row);
	}

	const lines: string[] = [];
	for (const phase of order) {
		const group = groups.get(phase) ?? [];
		const done = group.filter((r) => r.status !== undefined).length;
		lines.push(`${phaseMarker(group)} ${phase} ${done}/${group.length}`);
		for (const row of group) {
			lines.push(...renderAgentRow(row));
		}
	}
	return lines;
}

/**
 * Render the progress section (Task 8.1.5): the CC-style phase tree followed by
 * any narrator `log`/`warn` lines. A SETTLED/recovered run renders from
 * {@link RunRecord.agents} (so the view survives a restart with no live events);
 * a LIVE run pairs its enriched progress and pulls running rows' stats from the
 * engine's collector snapshot.
 */
function renderProgress(
	handle: RunHandle,
	statsSnapshot: StatsSnapshotFn,
): string[] {
	const record = handle.record;
	const terminal = record.status !== "running";
	const rows =
		terminal && record.agents !== undefined
			? settledAgentRows(record.agents)
			: liveAgentRows(handle.progress, statsSnapshot);
	return [...renderAgentTree(rows), ...narratorLines(handle.progress)];
}

/**
 * Live per-state tally (Task 6.2.1), counted off the same paired starts/ends as
 * the progress tree: a start with no matched end is `running`; a matched end maps
 * `cached`→cached, `completed`→done, anything else→failed.
 */
export interface LiveCounts {
	running: number;
	done: number;
	failed: number;
	cached: number;
}

/** Tally live per-state counts from stamped progress (Task 6.2.1 / reused by 6.2.3/6.2.4). */
export function liveCounts(progress: EnrichedProgressEvent[]): LiveCounts {
	const paired = pairStartsToEnds(progress);
	const counts: LiveCounts = { running: 0, done: 0, failed: 0, cached: 0 };
	// Walk starts by index to read each one's paired result.
	progress.forEach((e, i) => {
		if (e.type !== "agent:start") {
			return;
		}
		const match = paired.get(i);
		if (match?.status === undefined) {
			counts.running += 1;
		} else if (match.status === "cached") {
			counts.cached += 1;
		} else if (match.status === "completed") {
			counts.done += 1;
		} else {
			counts.failed += 1;
		}
	});
	return counts;
}

/**
 * Tally the resume cache efficiency from progress: an `agent:end` with status
 * `cached` was replayed; every other terminal end was a live launch. Counted off
 * the same events the progress tree renders.
 */
function agentCallTally(progress: EnrichedProgressEvent[]): {
	cached: number;
	live: number;
} {
	let cached = 0;
	let live = 0;
	for (const e of progress) {
		if (e.type !== "agent:end") {
			continue;
		}
		if (e.status === "cached") {
			cached += 1;
		} else {
			live += 1;
		}
	}
	return { cached, live };
}

/**
 * The budget line, when the run carries a budget (Task 4.3.1). A LIVE run reads
 * spend from the handle's budget view (so the line tracks real-time consumption);
 * a terminal/recovered run reads the settled `budgetSpent` snapshot off the
 * record (the view's accumulator died with the process). Reasoning tokens are
 * folded into output spend (output-priced) — hence "output tokens".
 */
function budgetLine(handle: RunHandle): string | undefined {
	const total = handle.record.budgetTotal;
	if (total === undefined) {
		return undefined;
	}
	const spent =
		handle.budget !== undefined
			? handle.budget.spent()
			: (handle.record.budgetSpent ?? 0);
	return `budget: ${spent}/${total} output tokens`;
}

/** The phase of the most recent `agent:start` (the run's current focus), or undefined. */
function currentPhase(progress: EnrichedProgressEvent[]): string | undefined {
	for (let i = progress.length - 1; i >= 0; i -= 1) {
		const e = progress[i];
		if (e !== undefined && e.type === "agent:start") {
			return e.phase ?? NO_PHASE;
		}
	}
	return undefined;
}

/**
 * The compact live TUI title (Task 6.2.3): `<name> · <phase> · <done>/<seen>
 * agents · <elapsed>ms`. `done` = settled agents (done+failed+cached), `seen` =
 * every started agent; counts come from the same {@link liveCounts} tally as the
 * status render. The phase segment is omitted when no agent has started yet.
 */
function liveTitle(handle: RunHandle, nowMs: number): string {
	const c = liveCounts(handle.progress);
	const done = c.done + c.failed + c.cached;
	const seen = done + c.running;
	const phase = currentPhase(handle.progress);
	const elapsed = nowMs - handle.record.createdAt;
	const segments = [handle.record.description];
	if (phase !== undefined) {
		segments.push(phase);
	}
	segments.push(`${done}/${seen} agents`, humanizeDuration(elapsed));
	return segments.join(" · ");
}

/** Render the full status text for one run handle. `full` (Task 7.2.2) → the
 * complete untruncated result + per-agent diagnostics. `statsSnapshot` (Task
 * 8.1.5) supplies live token/tool numbers for the running rows of the CC tree. */
function render(
	handle: RunHandle,
	full: boolean,
	statsSnapshot: StatsSnapshotFn,
): string {
	const record: RunRecord = handle.record;
	const terminal = record.status !== "running";

	let header = `${record.id} — ${record.description} — ${record.status}`;
	if (record.resumedFrom !== undefined) {
		header += ` — resumed from ${record.resumedFrom}`;
	}
	if (terminal && record.completedAt !== undefined) {
		header += ` (${humanizeDuration(record.completedAt - record.createdAt)})`;
	}
	// LIVE total-elapsed (Task 6.2.1): a running run with a live clock view appends
	// the elapsed in parens after the status word — `— running (<elapsed>)`
	// (clock.now() − createdAt). Recovered runs carry no `now` view (and are
	// terminal anyway), so this surface stays off for them.
	if (!terminal && handle.now !== undefined) {
		header += ` (${humanizeDuration(handle.now() - record.createdAt)})`;
	}

	const parts: string[] = [header];

	const progressLines = renderProgress(handle, statsSnapshot);
	if (progressLines.length > 0) {
		parts.push("", ...progressLines);
	}

	// LIVE counts line (Task 6.2.1): only while running with a live clock view.
	if (!terminal && handle.now !== undefined) {
		const c = liveCounts(handle.progress);
		parts.push(
			"",
			`${c.running} running / ${c.done} done / ${c.failed} failed / ${c.cached} cached`,
		);
	}

	const budget = budgetLine(handle);
	if (budget !== undefined) {
		parts.push("", budget);
	}

	if (record.status === "completed") {
		parts.push("", renderResult(record, full));
		// Task 7.2.2: under `full`, append the persisted per-agent diagnostics so the
		// whole post-mortem is readable through the tool — no shell access required.
		if (full) {
			parts.push(...renderDiagnostics(record));
		}
	} else if (record.status === "error") {
		parts.push("", `error: ${record.error ?? "(no message)"}`);
		if (full) {
			parts.push(...renderDiagnostics(record));
		}
	}

	// On a TERMINAL run, summarize the cache efficiency — how many agent() calls
	// replayed from the journal vs. ran live (spec §7's resume payoff).
	if (terminal) {
		const tally = agentCallTally(handle.progress);
		parts.push("", `${tally.cached} cached / ${tally.live} live agent calls`);
	}

	return parts.join("\n");
}

export function createWorkflowStatusTool(
	engine: WorkflowEngine,
	timers?: WorkflowStatusTimers,
) {
	const setIntervalFn =
		timers?.setIntervalFn ??
		((cb: () => void, ms: number) => setInterval(cb, ms));
	const clearIntervalFn =
		timers?.clearIntervalFn ??
		((handle: unknown) =>
			clearInterval(handle as ReturnType<typeof setInterval>));
	return tool({
		description:
			"Inspect a workflow run by run_id: live progress (phase groups, agent " +
			"status, narrator lines) while running, or the result/error once it has " +
			"completed. You do NOT need to poll — you are notified on completion; use " +
			"this to read progress or the final result on demand. Optionally pass " +
			"`wait_ms` to BLOCK (up to 120000ms) until the run settles before " +
			"rendering — useful in a single-turn/headless context where there is no " +
			"completion notification to re-invoke you. Pass `full: true` to get the " +
			"COMPLETE, untruncated result (plus per-agent diagnostics) instead of the " +
			"2000-char preview — no shell access to the run files needed.",
		args: {
			run_id: tool.schema
				.string()
				.describe("the wf_ run id returned by the workflow tool"),
			wait_ms: tool.schema
				.number()
				.optional()
				.describe(
					"Block up to this many ms (capped at 120000) for a LIVE run to settle " +
						"before rendering. Omit or 0 to read the current snapshot immediately.",
				),
			full: tool.schema
				.boolean()
				.optional()
				.describe(
					"Return the COMPLETE returnValue JSON (and per-agent diagnostics) " +
						"untruncated, instead of the default 2000-char preview.",
				),
		},
		async execute(args, context: ToolContext) {
			const runId = coerceId(args.run_id);
			const handle = engine.statusOf(runId);
			if (handle === undefined) {
				return unknownText(engine, runId);
			}

			// wait_ms affordance (Task 4.3.2): on a LIVE run with a settle promise,
			// race it against the (capped) timeout so a single-turn caller can block
			// in-process. A timeout simply renders the still-running snapshot — never
			// throws. Terminal runs short-circuit (nothing to wait for).
			const waitMs = coerceWaitMs(args.wait_ms);
			if (
				waitMs > 0 &&
				handle.record.status === "running" &&
				handle.settled !== undefined
			) {
				// Live TUI title (Task 6.2.3): while blocked, push a compact title on a
				// ~1s interval — the ONLY live-display channel a plugin gets. `metadata`
				// is best-effort (a host may not implement it), so every call is fenced;
				// the interval is ALWAYS cleared in `finally` so the timer never leaks.
				// Only when `now` is present (a live, in-this-process run) — recovered
				// runs have no clock view and would render a meaningless elapsed.
				const setTitle = (): void => {
					if (handle.now === undefined) {
						return;
					}
					try {
						context.metadata({ title: liveTitle(handle, handle.now()) });
					} catch {
						// Host has no metadata channel (or it threw) — never propagate.
					}
				};
				const ticker = setIntervalFn(setTitle, TITLE_TICK_MS);
				try {
					// Paint once immediately so the title reflects state before the first
					// tick, then race settle vs timeout as before.
					setTitle();
					await Promise.race([handle.settled, timeout(waitMs)]);
				} finally {
					clearIntervalFn(ticker);
				}
			}
			return render(handle, coerceFull(args.full), (sessionID) =>
				engine.statsSnapshot(sessionID),
			);
		},
	});
}
