import { describe, expect, test } from "bun:test";
import { humanizeDuration } from "./format";

describe("humanizeDuration — bands", () => {
	test("< 1s renders whole milliseconds", () => {
		expect(humanizeDuration(800)).toBe("800ms");
		expect(humanizeDuration(1)).toBe("1ms");
		expect(humanizeDuration(999)).toBe("999ms");
	});

	test("< 60s renders seconds with one decimal", () => {
		expect(humanizeDuration(1_000)).toBe("1.0s");
		expect(humanizeDuration(4_200)).toBe("4.2s");
		expect(humanizeDuration(32_000)).toBe("32.0s");
		expect(humanizeDuration(59_900)).toBe("59.9s");
	});

	test("minute band renders m+s, dropping a zero-second remainder", () => {
		expect(humanizeDuration(60_000)).toBe("1m");
		expect(humanizeDuration(102_000)).toBe("1m42s");
		expect(humanizeDuration(59 * 60_000 + 59_000)).toBe("59m59s");
	});

	test("exact minute renders without a seconds suffix", () => {
		expect(humanizeDuration(5 * 60_000)).toBe("5m");
	});

	test("hour band renders h + zero-padded minutes, dropping a zero remainder", () => {
		expect(humanizeDuration(3_600_000)).toBe("1h");
		expect(humanizeDuration(3_600_000 + 3 * 60_000)).toBe("1h03m");
		expect(humanizeDuration(2 * 3_600_000 + 45 * 60_000)).toBe("2h45m");
	});

	test("negative and non-finite inputs clamp to 0ms", () => {
		expect(humanizeDuration(-1)).toBe("0ms");
		expect(humanizeDuration(-50_000)).toBe("0ms");
		expect(humanizeDuration(Number.NaN)).toBe("0ms");
		expect(humanizeDuration(Number.POSITIVE_INFINITY)).toBe("0ms");
		expect(humanizeDuration(Number.NEGATIVE_INFINITY)).toBe("0ms");
		expect(humanizeDuration(0)).toBe("0ms");
	});
});
