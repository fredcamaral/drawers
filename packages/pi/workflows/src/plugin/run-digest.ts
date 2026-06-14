/**
 * Settle-time per-agent run digest — the chewed summary the orchestrating parent
 * receives when a workflow finishes.
 *
 * The terminal-notice path injects a model-only synthetic message carrying
 * `notice.hint` on the parent's next turn (the pi notifier's wake/drain). This
 * module renders that hint into a real digest: a header (status, duration, agent
 * tally, total tokens) followed by every agent grouped by phase, each with its
 * stats, the CONCLUSION it passed forward, and its degrade note when it failed.
 *
 * Pure + clock-free: it reads only the {@link RunRecord} (whose `agents[]` is fully
 * rolled up by the time the engine pushes the notice at settle), so it is unit-testable
 * under plain `bun test`. It reuses the ONE formatting source (`../tui/format`) the tree
 * and status tool already share, so a token total or duration renders identically across
 * the viewer, the status tool, and this digest. The retrieval pointer is appended last,
 * so the digest never loses the "go inspect" affordance the old hint carried.
 */

import {
	formatDuration,
	formatTokens,
	statusMarker,
	totalTokens,
} from "../tui/format";
import type { AgentSummary, RunRecord } from "./engine";
import { oneLine } from "./text";

/** Group label for agents emitted without a phase (matches the reducer/status tool). */
const NO_PHASE = "(no phase)";

/**
 * Per-agent conclusion cap in the digest. The feed already caps a result preview at
 * 2000 chars; the digest re-truncates SHORTER so a many-agent run stays scannable in
 * one synthetic part — the full conclusion stays in the feed / `workflow_status`.
 */
const DIGEST_CONCLUSION_CAP = 400;

/** The compact `X tok · N tools · Ds` tail for an agent, or a `cached` marker. */
function statsTail(a: AgentSummary): string {
	const parts: string[] = [];
	if (a.tokens !== undefined) {
		parts.push(`${formatTokens(totalTokens(a.tokens))} tok`);
	}
	if (a.toolCalls !== undefined) {
		parts.push(`${a.toolCalls} tools`);
	}
	if (a.durationMs !== undefined) {
		parts.push(formatDuration(a.durationMs));
	}
	if (parts.length > 0) {
		return `  ${parts.join(" · ")}`;
	}
	// A cached entry carries no stats; name its replayed nature instead of a blank tail.
	return a.status === "cached" ? "  cached" : "";
}

/** The lines for one agent: a `marker label stats` row, then conclusion/note rows. */
function agentLines(a: AgentSummary): string[] {
	const lines = [`  ${statusMarker(a.status)} ${a.label}${statsTail(a)}`];
	if (a.result !== undefined) {
		lines.push(`    → ${oneLine(a.result, DIGEST_CONCLUSION_CAP)}`);
	}
	// A failed/degraded agent carries no result; surface its note as the conclusion.
	if (a.note !== undefined) {
		lines.push(`    ! ${oneLine(a.note, DIGEST_CONCLUSION_CAP)}`);
	}
	return lines;
}

/** Group agents by phase, preserving first-appearance order (rollup = completion order). */
function groupByPhase(
	agents: AgentSummary[],
): Array<{ phase: string; agents: AgentSummary[] }> {
	const order: string[] = [];
	const groups = new Map<string, AgentSummary[]>();
	for (const a of agents) {
		const phase = a.phase ?? NO_PHASE;
		let group = groups.get(phase);
		if (group === undefined) {
			group = [];
			groups.set(phase, group);
			order.push(phase);
		}
		group.push(a);
	}
	return order.map((phase) => ({ phase, agents: groups.get(phase) ?? [] }));
}

/** The one-line header: identity, status, duration, agent tally, and total tokens. */
function headerLine(record: RunRecord): string {
	const agents = record.agents ?? [];
	const completed = agents.filter((a) => a.status === "completed").length;
	const cached = agents.filter((a) => a.status === "cached").length;
	const failed = agents.length - completed - cached;
	const tally: string[] = [];
	if (completed > 0) tally.push(`${completed} completed`);
	if (cached > 0) tally.push(`${cached} cached`);
	if (failed > 0) tally.push(`${failed} failed`);
	const agentSeg =
		agents.length === 0
			? "no agents"
			: `${agents.length} agent${agents.length === 1 ? "" : "s"} (${tally.join(", ")})`;

	const tokenTotal = agents.reduce(
		(sum, a) => sum + (a.tokens !== undefined ? totalTokens(a.tokens) : 0),
		0,
	);
	const tokenSeg = tokenTotal > 0 ? ` · ${formatTokens(tokenTotal)} tok` : "";

	// Defensive against a stale on-disk record (the persistence layer validates
	// only id/parentSessionID/status — same posture `totalTokens` already takes):
	// a missing description or non-finite timestamp renders honestly, never
	// `'undefined'` or `in NaN`.
	const description =
		typeof record.description === "string" ? record.description : "(unknown)";
	const duration =
		typeof record.completedAt === "number" &&
		Number.isFinite(record.completedAt) &&
		Number.isFinite(record.createdAt)
			? ` in ${formatDuration(record.completedAt - record.createdAt)}`
			: "";

	return `Workflow ${record.id} '${description}' ${record.status}${duration} — ${agentSeg}${tokenSeg}`;
}

/**
 * Render the per-agent digest for a settled run (the synthetic notice hint). The header
 * always renders; per-phase agent blocks render when the run launched agents; the
 * `workflow_status` retrieval pointer is always appended so the affordance survives.
 */
export function renderRunDigest(record: RunRecord): string {
	const lines = [headerLine(record)];
	const agents = record.agents ?? [];
	if (agents.length > 0) {
		lines.push("");
		for (const { phase, agents: group } of groupByPhase(agents)) {
			lines.push(`${phase}:`);
			for (const a of group) {
				lines.push(...agentLines(a));
			}
		}
	}
	lines.push("");
	lines.push(`Inspect with workflow_status run_id=${record.id}.`);
	return lines.join("\n");
}
