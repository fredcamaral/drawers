import { describe, expect, test } from "bun:test";
import { WORKFLOW_DESCRIPTION } from "./workflow";

/**
 * Regression guard for the named-pattern catalogue (Task 1.1.3).
 *
 * WORKFLOW_DESCRIPTION is shipped behavior: it is injected into every
 * workflow-authoring context and shapes how the orchestrating model composes
 * scripts. Anthropic's canonical guidance is explicit that naming the pattern
 * is what sharpens the result — so a future edit silently dropping a pattern
 * name is a real regression. This test locks all seven canonical names.
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
	"review-against-disk-truth",
] as const;

describe("WORKFLOW_DESCRIPTION pattern catalogue", () => {
	const haystack = WORKFLOW_DESCRIPTION.toLowerCase();

	for (const pattern of CANONICAL_PATTERNS) {
		test(`names the "${pattern}" pattern`, () => {
			expect(haystack).toContain(pattern);
		});
	}

	test("documents all seven canonical patterns", () => {
		const missing = CANONICAL_PATTERNS.filter((p) => !haystack.includes(p));
		expect(missing).toEqual([]);
	});
});

describe("WORKFLOW_DESCRIPTION isolation/verify contracts (#13)", () => {
	test("documents the first-class {status:'conflict'} merge-back result", () => {
		expect(WORKFLOW_DESCRIPTION).toContain(
			"{status:'conflict', branch, files, baseRef}",
		);
	});

	test("documents that verifyDiff IMPLIES worktree isolation", () => {
		expect(WORKFLOW_DESCRIPTION).toContain("IMPLIES worktree isolation");
	});

	test("documents that verify GATES the merge and the preserved-branch recovery affordance", () => {
		expect(WORKFLOW_DESCRIPTION).toContain("VERIFY GATES THE MERGE");
		expect(WORKFLOW_DESCRIPTION).toContain("wf/<run_id>/<label>");
	});

	test("documents the worktree environment caveat (HEAD + edits + linked node_modules)", () => {
		expect(WORKFLOW_DESCRIPTION).toContain("WORKTREE ENVIRONMENT");
		expect(WORKFLOW_DESCRIPTION).toContain("node_modules");
		expect(WORKFLOW_DESCRIPTION).toContain(".env");
	});
});
