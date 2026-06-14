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

/**
 * Format a CC-style compact relative age — the `· 3m` segment the run header shows
 * for how long ago a run started. Both timestamps are PARAMS (the reducer/format
 * layer holds no system clock; the route passes a ticked `nowMs` signal), so this
 * stays pure and testable. `delta = nowMs - thenMs`. A negative delta (clock skew /
 * a future stamp) or a non-finite input degrades to `"just now"` — a display path
 * never shows a backwards or `NaN` age. Otherwise a SINGLE floored unit, no spaces:
 * `<60s → "Ns"`, `<60m → "Nm"`, `<24h → "Nh"`, else `"Nd"`. Distinct on purpose from
 * {@link formatDuration}'s multi-unit `"1h 1m 1s"` form — a header age is one glance.
 */
export function formatRelativeTime(thenMs: number, nowMs: number): string {
	if (!Number.isFinite(thenMs) || !Number.isFinite(nowMs)) {
		return "just now";
	}
	const delta = nowMs - thenMs;
	if (delta < 0) {
		return "just now";
	}
	const seconds = Math.floor(delta / 1000);
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours}h`;
	}
	return `${Math.floor(hours / 24)}d`;
}

/**
 * Sum every token field into the one number {@link formatTokens} renders. Each
 * field is coerced defensively (the Phase 2 NaN lesson, mirroring `budget.ts`):
 * this is fed from feed-parsed data whose per-variant fields are NOT validated by
 * `parseFeedLine`, so a partial `tokens` object missing e.g. `cacheWrite` must
 * contribute 0 rather than poison the whole sum into `NaN`.
 */
export function totalTokens(t: SessionTokenSnapshot): number {
	const n = (v: unknown): number => (typeof v === "number" ? v : 0);
	return (
		n(t.input) + n(t.output) + n(t.reasoning) + n(t.cacheRead) + n(t.cacheWrite)
	);
}

/**
 * Render the input vs output token split as `<input>→<output+reasoning>` (Epic 1.3,
 * #8). A single flattened total reads as "millions of output" when it is mostly
 * repeated context-LOADING (input) — the split makes that legible. Reasoning folds
 * into the output side (it is output-priced, matching the budget line's "output
 * tokens" semantics); cache.read/write are excluded (they are neither produced work
 * nor the operator's concern at a glance). Each side runs through {@link formatTokens}
 * so the bands match the rest of the tree. {@link totalTokens} stays the canonical
 * sum for any consumer wanting one number.
 */
export function formatTokenSplit(t: SessionTokenSnapshot): string {
	return `${formatTokens(t.input)}→${formatTokens(t.output + t.reasoning)}`;
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

/**
 * Truncate `text` to at most `width` columns, marking a cut with a trailing `…`
 * (Task 8.3.3 beautify). The tree pane renders ONE line per row — long agent rows
 * that would otherwise word-wrap into a ragged second line (the `· 40 tools` /
 * dangling `tools` artifact) are clipped instead, and the selected row's full stats
 * stay readable in the Detail pane. `width ≤ 0` yields the empty string; `width === 1`
 * yields the bare ellipsis; text already within `width` passes through untouched.
 * Column width is approximated by code-unit length — fine for the ASCII-plus-glyph
 * row vocabulary the tree uses (markers, model ids, compact stat numbers).
 */
export function truncateLine(text: string, width: number): string {
	if (width <= 0) {
		return "";
	}
	if (text.length <= width) {
		return text;
	}
	if (width === 1) {
		return "…";
	}
	return `${text.slice(0, width - 1)}…`;
}

/** The CC-style per-status marker for an agent row and phase header. */
export const MARK_DONE = "✓";
export const MARK_FAIL = "✗";
export const MARK_RUNNING = "…";
/** A DECLARED-but-not-yet-started phase (no agents launched into it yet). */
export const MARK_PENDING = "·";

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
