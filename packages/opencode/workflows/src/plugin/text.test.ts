import { describe, expect, test } from "bun:test";
import { oneLine } from "./text";

describe("oneLine", () => {
	test("collapses whitespace runs (incl. newlines) to single spaces and trims", () => {
		expect(oneLine("  a\n\nb\t c  ", 100)).toBe("a b c");
	});

	test("passes text within the cap through untouched", () => {
		expect(oneLine("short", 10)).toBe("short");
	});

	test("truncates with truncateLine arithmetic: slice(0, max - 1) + ellipsis", () => {
		const out = oneLine("abcdefghij", 5);
		expect(out).toBe("abcd…");
		expect(out).toHaveLength(5);
	});

	test("a string exactly at the cap is not truncated", () => {
		expect(oneLine("abcde", 5)).toBe("abcde");
	});
});
