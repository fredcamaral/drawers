import { describe, expect, test } from "bun:test";
import { humanizeDuration } from "./format";

/**
 * The ONE shared duration formatter every workflow display surface routes through
 * (Task 6.2 polish). These pin the band boundaries and the example forms from the
 * agreed spec so a future tweak to one surface can't silently diverge the others.
 */
describe("humanizeDuration — bands", () => {
	test("< 1s → whole milliseconds", () => {
		expect(humanizeDuration(800)).toBe("800ms");
		expect(humanizeDuration(1)).toBe("1ms");
		expect(humanizeDuration(999)).toBe("999ms");
	});

	test("< 60s → seconds with one decimal", () => {
		expect(humanizeDuration(1_000)).toBe("1.0s");
		expect(humanizeDuration(4_200)).toBe("4.2s");
		expect(humanizeDuration(2_500)).toBe("2.5s");
		expect(humanizeDuration(59_900)).toBe("59.9s");
	});

	test("< 60m → whole minutes + seconds (m only when 0s)", () => {
		expect(humanizeDuration(60_000)).toBe("1m");
		expect(humanizeDuration(102_000)).toBe("1m42s");
		expect(humanizeDuration(3_599_000)).toBe("59m59s");
	});

	test("≥ 1h → hours + zero-padded minutes (h only when 0m)", () => {
		expect(humanizeDuration(3_600_000)).toBe("1h");
		expect(humanizeDuration(3_780_000)).toBe("1h03m"); // 1h 3m
		expect(humanizeDuration(7_320_000)).toBe("2h02m");
	});

	test("non-finite / non-positive clamp to 0ms (never NaNms or negative)", () => {
		expect(humanizeDuration(0)).toBe("0ms");
		expect(humanizeDuration(-500)).toBe("0ms");
		expect(humanizeDuration(Number.NaN)).toBe("0ms");
		expect(humanizeDuration(Number.POSITIVE_INFINITY)).toBe("0ms");
	});
});
