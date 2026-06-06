import { describe, expect, test } from "bun:test";
import * as entry from "./index";

/**
 * The opencode loader calls EVERY export of the registered entry module as a
 * function. The workflows plugin entry must therefore expose EXACTLY ONE export,
 * and it must be a function (the {@link Plugin} factory). Library helpers live in
 * `../index.ts` (the package's `./lib` export), never here.
 */
describe("workflows plugin entry module", () => {
	test("exposes exactly one export", () => {
		expect(Object.keys(entry)).toHaveLength(1);
	});

	test("the single export is a function (the Plugin factory)", () => {
		const values = Object.values(entry);
		expect(typeof values[0]).toBe("function");
	});
});
