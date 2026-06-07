/**
 * Shared CC-tree formatting helpers (Task 8.3.1).
 *
 * These are the ONE implementation of the `/workflows` phase-tree formatting,
 * used by BOTH the textual `workflow_status` tool (which reduces the in-memory
 * run handle) and the native TUI reducer/route (which reduces the on-disk feed).
 * Extracted verbatim out of `plugin/tools/workflow-status.ts` so the live and
 * server views can never drift on how a token total, a duration, a model id, or
 * a status glyph renders — a pure move, no behavior change.
 *
 * Distinct from `plugin/format.ts`'s `humanizeDuration` (the compact `7m8s`/
 * `1h03m` band the status header and live title use); the agent tree mirrors
 * CC's spaced `7m 8s` form, which is what {@link formatDuration} below produces.
 */

import type { SessionTokenSnapshot } from "../plugin/session-stats";

/**
 * Format a token total the way CC's `/workflows` tree shows it — ONE human number
 * (Task 8.1.5). Below 1k → the bare integer (`999`); 1k–1M → one decimal of
 * thousands (`112_700 → "112.7k"`); ≥1M → one decimal of millions (`1_234_567 →
 * "1.2M"`). Negative/non-finite inputs clamp to `0` (a display path never shows
 * `NaN`). The input is the SUM of every token field — input + output + reasoning
 * + cache.read + cache.write — so it mirrors the single number CC prints.
 */
export function formatTokens(total: number): string {
	if (!Number.isFinite(total) || total <= 0) {
		return "0";
	}
	if (total < 1000) {
		return String(Math.round(total));
	}
	if (total < 1_000_000) {
		return `${(total / 1000).toFixed(1)}k`;
	}
	return `${(total / 1_000_000).toFixed(1)}M`;
}

/**
 * Format a duration the way CC's tree shows it — spaced h/m/s with leading zero
 * units dropped (Task 8.1.5): `428_000ms → "7m 8s"`, `8_000 → "8s"`, `120_000 →
 * "2m"`, `3_661_000 → "1h 1m 1s"`. Floors to whole seconds; negative/non-finite
 * inputs clamp to `0s`.
 */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) {
		return "0s";
	}
	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const parts: string[] = [];
	if (hours > 0) {
		parts.push(`${hours}h`);
	}
	if (minutes > 0) {
		parts.push(`${minutes}m`);
	}
	// Show seconds unless a larger unit already carries the value (e.g. `2m`, `1h`).
	if (seconds > 0 || parts.length === 0) {
		parts.push(`${seconds}s`);
	}
	return parts.join(" ");
}

/** Sum every token field into the one number {@link formatTokens} renders. */
export function totalTokens(t: SessionTokenSnapshot): number {
	return t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite;
}

/**
 * Strip the provider prefix from a model id for the CC-style short form (Task
 * 8.1.5): `anthropic/claude-opus-4-8 → "opus-4-8"`. CC drops the provider AND the
 * vendor's `claude-`/`gpt-`-style family prefix, keeping the human-recognizable
 * tail. We drop the provider (everything up to and including the last `/`) and a
 * leading `claude-` if present; everything else passes through verbatim.
 */
export function shortModel(model: string): string {
	const afterSlash = model.slice(model.lastIndexOf("/") + 1);
	return afterSlash.startsWith("claude-")
		? afterSlash.slice("claude-".length)
		: afterSlash;
}

/** The CC-style per-status marker for an agent row and phase header. */
export const MARK_DONE = "✓";
export const MARK_FAIL = "✗";
export const MARK_RUNNING = "…";

/** Map an agent's status word onto its row marker. `undefined` → still running. */
export function statusMarker(status: string | undefined): string {
	if (status === undefined) {
		return MARK_RUNNING;
	}
	if (status === "completed" || status === "cached") {
		return MARK_DONE;
	}
	return MARK_FAIL;
}

/**
 * The phase-header marker over a group of occurrences (Task 8.1.5): ✗ if any
 * failed (a defined status that is neither `completed` nor `cached`), … if any is
 * still running (undefined status), ✓ otherwise. Generic over any row carrying an
 * optional `status` so both the status tool's `AgentRow` and the reducer's
 * `AgentView` reuse the one derivation.
 */
export function phaseMarker(rows: { status?: string }[]): string {
	const anyFailed = rows.some(
		(r) =>
			r.status !== undefined &&
			r.status !== "completed" &&
			r.status !== "cached",
	);
	if (anyFailed) {
		return MARK_FAIL;
	}
	const anyRunning = rows.some((r) => r.status === undefined);
	return anyRunning ? MARK_RUNNING : MARK_DONE;
}
