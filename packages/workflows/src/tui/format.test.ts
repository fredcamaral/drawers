import { describe, expect, test } from "bun:test";
import type { SessionTokenSnapshot } from "../plugin/session-stats";
import {
	formatDuration,
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
