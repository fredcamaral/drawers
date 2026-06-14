import { describe, expect, test } from "bun:test";
import { computeCallKey, computeWorkflowKey, stableStringify } from "./keys";

/**
 * Tests for the runtime key module (Task 4.3.2). computeCallKey/stableStringify
 * moved here from plugin/journal.ts (which now re-exports them); computeWorkflowKey
 * is new — the synthetic boundary identity for sub-workflows.
 */

describe("stableStringify — order-independent objects", () => {
	test("key order does not affect the string", () => {
		expect(stableStringify({ a: 1, b: 2 })).toBe(
			stableStringify({ b: 2, a: 1 }),
		);
	});

	test("array order IS significant", () => {
		expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
	});

	test("undefined members are dropped", () => {
		expect(stableStringify({ a: 1, b: undefined })).toBe(
			stableStringify({ a: 1 }),
		);
	});
});

describe("computeWorkflowKey — boundary identity", () => {
	test("prefixed with 'workflow:'", () => {
		expect(computeWorkflowKey("src", { x: 1 })).toStartWith("workflow:");
	});

	test("same source + same args → same key", () => {
		expect(computeWorkflowKey("const meta = {}", { a: 1, b: 2 })).toBe(
			computeWorkflowKey("const meta = {}", { b: 2, a: 1 }),
		);
	});

	test("different child source → different key (an edit voids the boundary)", () => {
		expect(computeWorkflowKey("v1", { x: 1 })).not.toBe(
			computeWorkflowKey("v2", { x: 1 }),
		);
	});

	test("different args → different key", () => {
		expect(computeWorkflowKey("src", { x: 1 })).not.toBe(
			computeWorkflowKey("src", { x: 2 }),
		);
	});

	test("never collides with an agent key namespace", () => {
		const agentKey = computeCallKey({ prompt: "src" });
		expect(computeWorkflowKey("src", undefined)).not.toBe(agentKey);
	});
});
