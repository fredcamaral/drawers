import { describe, expect, test } from "bun:test";
import { parseScript } from "../runtime/meta";
import { BUILTIN_WORKFLOWS, lookupBuiltin } from "./builtins";

/**
 * Built-in workflows ship as string sources in the bundle (Epic 2.2/3.1). They
 * are never type-checked as code, so a syntax slip (e.g. a botched `\\n` escape)
 * would only surface at run time. parseScript runs acorn over the WHOLE source
 * plus validates the meta block — so these tests are the shipped-validity guard:
 * every built-in must parse and its meta.name must match its registry key.
 */
describe("built-in workflows", () => {
	test("deep-research is registered and parses with the expected phases", () => {
		const source = lookupBuiltin("deep-research");
		expect(source).toBeDefined();
		const parsed = parseScript(source as string);
		expect(parsed.meta.name).toBe("deep-research");
		expect(parsed.meta.phases?.map((p) => p.title)).toEqual([
			"Plan",
			"Search",
			"Verify",
			"Synthesize",
		]);
	});

	test("every built-in parses and its meta.name matches its registry key", () => {
		for (const [name, source] of Object.entries(BUILTIN_WORKFLOWS)) {
			const parsed = parseScript(source);
			expect(parsed.meta.name).toBe(name);
		}
	});
});
