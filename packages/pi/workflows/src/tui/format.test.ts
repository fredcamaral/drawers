import { describe, expect, test } from "bun:test";
import type { SessionTokenSnapshot } from "../plugin/session-stats";
import {
	formatDuration,
	formatRelativeTime,
	formatTokenSplit,
	formatTokens,
	shortModel,
	statusMarker,
	totalTokens,
	truncateLine,
} from "./format";

/**
 * Tests for the shared CC-tree formatting helpers (Task 8.3.1). These were
 * extracted verbatim from `workflow-status.ts` into `src/tui/format.ts` so both
 * the textual `workflow_status` tool and the native TUI reducer/render format
 * identically — one source of truth, no divergence. The behavior under test is
 * exactly what `workflow-status.test.ts` already asserts for the tool; this file
 * pins it at the shared module.
 */

describe("formatTokens", () => {
	test("formats the way CC's tree shows a single human number", () => {
		expect(formatTokens(999)).toBe("999");
		expect(formatTokens(112_700)).toBe("112.7k");
		expect(formatTokens(1_234_567)).toBe("1.2M");
		expect(formatTokens(0)).toBe("0");
		expect(formatTokens(1000)).toBe("1.0k");
		expect(formatTokens(1_000_000)).toBe("1.0M");
	});

	test("clamps negative/non-finite to 0", () => {
		expect(formatTokens(-1)).toBe("0");
		expect(formatTokens(Number.NaN)).toBe("0");
	});
});

describe("formatDuration", () => {
	test("formats spaced h/m/s with zero units dropped", () => {
		expect(formatDuration(428_000)).toBe("7m 8s");
		expect(formatDuration(8_000)).toBe("8s");
		expect(formatDuration(120_000)).toBe("2m");
		expect(formatDuration(3_661_000)).toBe("1h 1m 1s");
	});

	test("clamps negative/non-finite to 0s", () => {
		expect(formatDuration(-1)).toBe("0s");
		expect(formatDuration(Number.NaN)).toBe("0s");
	});
});

describe("formatRelativeTime", () => {
	test("renders a single floored unit, no spaces (distinct from formatDuration)", () => {
		// Sub-minute → seconds.
		expect(formatRelativeTime(0, 1000)).toBe("1s");
		expect(formatRelativeTime(0, 59_000)).toBe("59s");
		// Minute band → floored whole minutes (90s floors to 1m, not "1m 30s").
		expect(formatRelativeTime(0, 90_000)).toBe("1m");
		expect(formatRelativeTime(0, 59 * 60_000)).toBe("59m");
		// Hour band.
		expect(formatRelativeTime(0, 3 * 3_600_000)).toBe("3h");
		expect(formatRelativeTime(0, 23 * 3_600_000)).toBe("23h");
		// Day band.
		expect(formatRelativeTime(0, 2 * 86_400_000)).toBe("2d");
		// Single-unit, no spaces — explicitly NOT formatDuration's multi-unit form.
		expect(formatRelativeTime(0, 3_661_000)).toBe("1h");
		expect(formatDuration(3_661_000)).toBe("1h 1m 1s");
	});

	test("pins the exact band rollovers (the strict `< 60`/`< 24` edges)", () => {
		// The s→m, m→h, h→d boundaries are the off-by-one risk a `<`→`<=` refactor
		// would silently break — lock them at the exact rollover input.
		expect(formatRelativeTime(0, 60_000)).toBe("1m");
		expect(formatRelativeTime(0, 3_600_000)).toBe("1h");
		expect(formatRelativeTime(0, 86_400_000)).toBe("1d");
	});

	test("sub-second floors to 0s", () => {
		expect(formatRelativeTime(0, 500)).toBe("0s");
		expect(formatRelativeTime(0, 0)).toBe("0s");
	});

	test("negative and non-finite deltas degrade to 'just now'", () => {
		// nowMs < thenMs (clock skew / a future stamp).
		expect(formatRelativeTime(1000, 0)).toBe("just now");
		expect(formatRelativeTime(0, Number.NaN)).toBe("just now");
		expect(formatRelativeTime(Number.NaN, 1000)).toBe("just now");
		expect(formatRelativeTime(0, Number.POSITIVE_INFINITY)).toBe("just now");
	});
});

describe("shortModel", () => {
	test("strips provider prefix and leading claude-", () => {
		expect(shortModel("anthropic/claude-opus-4-8")).toBe("opus-4-8");
		expect(shortModel("openai/gpt-5")).toBe("gpt-5");
		expect(shortModel("opus-4-8")).toBe("opus-4-8");
	});
});

describe("totalTokens", () => {
	test("sums every token field into the one number formatTokens renders", () => {
		const t: SessionTokenSnapshot = {
			input: 100,
			output: 20,
			reasoning: 3,
			cacheRead: 4,
			cacheWrite: 5,
		};
		expect(totalTokens(t)).toBe(132);
	});
});

describe("formatTokenSplit", () => {
	test("renders input → output+reasoning, each via formatTokens (Epic 1.3)", () => {
		const t: SessionTokenSnapshot = {
			input: 112_700,
			output: 8_000,
			reasoning: 2_000,
			cacheRead: 50_000,
			cacheWrite: 1_000,
		};
		// Output side folds reasoning into output (output-priced), mirroring budget.
		expect(formatTokenSplit(t)).toBe("112.7k→10.0k");
	});

	test("zero/small values use the bare-integer band", () => {
		const t: SessionTokenSnapshot = {
			input: 0,
			output: 0,
			reasoning: 0,
			cacheRead: 0,
			cacheWrite: 0,
		};
		expect(formatTokenSplit(t)).toBe("0→0");
	});
});

describe("statusMarker", () => {
	test("maps a status word onto its glyph", () => {
		expect(statusMarker(undefined)).toBe("…");
		expect(statusMarker("completed")).toBe("✓");
		expect(statusMarker("cached")).toBe("✓");
		expect(statusMarker("error")).toBe("✗");
		expect(statusMarker("cancelled")).toBe("✗");
	});
});

describe("truncateLine", () => {
	test("passes through text within the width untouched", () => {
		expect(truncateLine("✓ Plan Sanity", 20)).toBe("✓ Plan Sanity");
		expect(truncateLine("exact", 5)).toBe("exact");
	});

	test("clips with a trailing ellipsis when over the width", () => {
		expect(truncateLine("P1 Frontend QA  291.9k tok · 6 tools", 12)).toBe(
			"P1 Frontend…",
		);
		// The result is exactly `width` columns (ellipsis included).
		expect(truncateLine("0123456789", 4)).toHaveLength(4);
		expect(truncateLine("0123456789", 4)).toBe("012…");
	});

	test("degenerate widths: ≤0 → empty, 1 → bare ellipsis", () => {
		expect(truncateLine("anything", 0)).toBe("");
		expect(truncateLine("anything", -3)).toBe("");
		expect(truncateLine("anything", 1)).toBe("…");
	});
});
