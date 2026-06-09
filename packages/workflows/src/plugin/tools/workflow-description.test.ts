import { describe, expect, test } from "bun:test";
import { WORKFLOW_DESCRIPTION } from "./workflow";

/**
 * Regression guard for the named-pattern catalogue (Task 1.1.3).
 *
 * WORKFLOW_DESCRIPTION is shipped behavior: it is injected into every
 * workflow-authoring context and shapes how the orchestrating model composes
 * scripts. Anthropic's canonical guidance is explicit that naming the pattern
 * is what sharpens the result — so a future edit silently dropping a pattern
 * name is a real regression. This test locks all six canonical names.
 *
 * To add a future pattern, add its canonical hyphenated token here AND to the
 * description's `## Patterns` section — a one-line change in each place.
 */
const CANONICAL_PATTERNS = [
	"classify-and-act",
	"fan-out-and-synthesize",
	"adversarial-verification",
	"generate-and-filter",
	"tournament",
	"loop-until-done",
] as const;

describe("WORKFLOW_DESCRIPTION pattern catalogue", () => {
	const haystack = WORKFLOW_DESCRIPTION.toLowerCase();

	for (const pattern of CANONICAL_PATTERNS) {
		test(`names the "${pattern}" pattern`, () => {
			expect(haystack).toContain(pattern);
		});
	}

	test("documents all six canonical patterns", () => {
		const missing = CANONICAL_PATTERNS.filter((p) => !haystack.includes(p));
		expect(missing).toEqual([]);
	});
});
