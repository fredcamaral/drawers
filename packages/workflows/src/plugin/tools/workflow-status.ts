/**
 * `workflow_status` — inspect a workflow run's progress and (when terminal) its
 * result.
 *
 * The model is told NOT to poll; this tool exists so it can deliberately read a
 * run's state — either while live (progress tree) or after the completion notice
 * (result/error). Built as a `tool()` factory closing over the engine so tests
 * inject a minimal fake.
 *
 * Render is a pure function of the run handle (record + progress). The progress
 * section is a FLAT chronological list faithful to event order: a phase header
 * is emitted whenever the phase changes (decision in Task 4.1.3 — simpler and
 * truer to emission order than a re-sorted tree). Per agent one marker line; the
 * status comes from the matching `agent:end` (a start with no end → running).
 */

import { type ToolContext, tool } from "@opencode-ai/plugin";
import type { ProgressEvent } from "../../runtime/types";
import type { RunHandle, RunRecord, WorkflowEngine } from "../engine";

/** Head-truncation ceiling for the rendered result JSON. */
const RESULT_MAX = 2000;
/** Group label for agents emitted without a phase. */
const NO_PHASE = "(no phase)";

/** Coerce a raw arg to string (opencode's raw path may hand a non-string). */
function coerceId(raw: unknown): string {
	return typeof raw === "string" ? raw : String(raw);
}

/** Map an `agent:end` status onto the rendered marker word. */
function endMarker(status: string): string {
	switch (status) {
		case "completed":
			return "done";
		case "cached":
			return "cached";
		default:
			// error / cancelled / anything unexpected.
			return "failed";
	}
}

/** The error string listing every known runId. */
function unknownText(engine: WorkflowEngine, runId: string): string {
	const known = [...engine.runs.keys()];
	const list = known.length > 0 ? known.join(", ") : "(none)";
	return `unknown run_id ${runId}. Known runs: ${list}`;
}

/** Truncate the result JSON at RESULT_MAX, appending a marker when cut. */
function renderResult(returnValue: unknown): string {
	const json = JSON.stringify(returnValue) ?? "undefined";
	if (json.length <= RESULT_MAX) {
		return `result: ${json}`;
	}
	return `result: ${json.slice(0, RESULT_MAX)} … (truncated)`;
}

/** A single chronological pass: phase headers on change + agent/log/warn lines. */
function renderProgress(progress: ProgressEvent[]): string[] {
	// First, resolve each agent label's end-status so a start line can render its
	// terminal marker in place (a start with no end → running).
	const endStatus = new Map<string, string>();
	for (const e of progress) {
		if (e.type === "agent:end") {
			endStatus.set(e.label, e.status);
		}
	}

	const lines: string[] = [];
	let currentPhase: string | undefined;
	let phaseEmitted = false;

	for (const e of progress) {
		switch (e.type) {
			case "agent:start": {
				const phase = e.phase ?? NO_PHASE;
				if (!phaseEmitted || phase !== currentPhase) {
					lines.push(`# ${phase}`);
					currentPhase = phase;
					phaseEmitted = true;
				}
				const end = endStatus.get(e.label);
				const marker = end !== undefined ? endMarker(end) : "running";
				lines.push(`  [${marker}] ${e.label}`);
				break;
			}
			case "agent:end":
				// Rendered in place at its start; ignored here to avoid duplicate lines.
				break;
			case "log":
				lines.push(`  log: ${e.message}`);
				break;
			case "warn":
				lines.push(`  warn: ${e.message}`);
				break;
		}
	}
	return lines;
}

/**
 * Tally the resume cache efficiency from progress: an `agent:end` with status
 * `cached` was replayed; every other terminal end was a live launch. Counted off
 * the same events the progress tree renders.
 */
function agentCallTally(progress: ProgressEvent[]): {
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

/** Render the full status text for one run handle. */
function render(handle: RunHandle): string {
	const record: RunRecord = handle.record;
	const terminal = record.status !== "running";

	let header = `${record.id} — ${record.description} — ${record.status}`;
	if (record.resumedFrom !== undefined) {
		header += ` — resumed from ${record.resumedFrom}`;
	}
	if (terminal && record.completedAt !== undefined) {
		header += ` (${record.completedAt - record.createdAt}ms)`;
	}

	const parts: string[] = [header];

	const progressLines = renderProgress(handle.progress);
	if (progressLines.length > 0) {
		parts.push("", ...progressLines);
	}

	const budget = budgetLine(handle);
	if (budget !== undefined) {
		parts.push("", budget);
	}

	if (record.status === "completed") {
		parts.push("", renderResult(record.returnValue));
	} else if (record.status === "error") {
		parts.push("", `error: ${record.error ?? "(no message)"}`);
	}

	// On a TERMINAL run, summarize the cache efficiency — how many agent() calls
	// replayed from the journal vs. ran live (spec §7's resume payoff).
	if (terminal) {
		const tally = agentCallTally(handle.progress);
		parts.push("", `${tally.cached} cached / ${tally.live} live agent calls`);
	}

	return parts.join("\n");
}

export function createWorkflowStatusTool(engine: WorkflowEngine) {
	return tool({
		description:
			"Inspect a workflow run by run_id: live progress (phase groups, agent " +
			"status, narrator lines) while running, or the result/error once it has " +
			"completed. You do NOT need to poll — you are notified on completion; use " +
			"this to read progress or the final result on demand.",
		args: {
			run_id: tool.schema
				.string()
				.describe("the wf_ run id returned by the workflow tool"),
		},
		async execute(args, _context: ToolContext) {
			const runId = coerceId(args.run_id);
			const handle = engine.statusOf(runId);
			if (handle === undefined) {
				return unknownText(engine, runId);
			}
			return render(handle);
		},
	});
}
