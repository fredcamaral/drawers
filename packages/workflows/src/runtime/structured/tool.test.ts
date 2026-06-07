import { describe, expect, test } from "bun:test";
import type { ToolContext } from "@opencode-ai/plugin";
import { createSchemaRegistry } from "./registry";
import { createStructuredOutputTool } from "./tool";
import { compileSchema } from "./validate";

/**
 * Unit suite for the `structured_output` tool factory (Task 3.3.2). The tool is
 * driven directly via its `execute({ result }, context)`; the registry is the
 * real one. We assert the four model-facing outcomes (miss / parse fail /
 * validation fail / accept) plus the defensive non-string coercion.
 */

const SCHEMA = {
	type: "object",
	properties: { n: { type: "number" } },
	required: ["n"],
	additionalProperties: false,
} as const;

function ctx(sessionID: string): ToolContext {
	return { sessionID } as unknown as ToolContext;
}

describe("createStructuredOutputTool", () => {
	test("registry miss returns the no-expectation error string", async () => {
		const registry = createSchemaRegistry();
		const t = createStructuredOutputTool(registry);
		const out = await t.execute({ result: '{"n":1}' }, ctx("ses_unknown"));
		expect(out).toBe("no structured output expected for this session");
	});

	test("non-string result is coerced via JSON.stringify then validated", async () => {
		const registry = createSchemaRegistry();
		registry.register("ses_1", compileSchema(SCHEMA));
		const t = createStructuredOutputTool(registry);
		// A model may pass an object despite the string arg schema — accept it.
		const out = await t.execute(
			{ result: { n: 5 } as unknown as string },
			ctx("ses_1"),
		);
		expect(out).toBe("accepted");
		expect(registry.resultFor("ses_1")).toEqual({
			present: true,
			value: { n: 5 },
		});
	});

	test("JSON parse failure returns an error string carrying the parse message", async () => {
		const registry = createSchemaRegistry();
		registry.register("ses_2", compileSchema(SCHEMA));
		const t = createStructuredOutputTool(registry);
		const out = await t.execute({ result: "not json {" }, ctx("ses_2"));
		expect(typeof out).toBe("string");
		expect(out as string).toContain("JSON");
		// Nothing stored on a parse failure.
		expect(registry.resultFor("ses_2").present).toBe(false);
	});

	test("validation failure returns the retry-prefixed flattened errors string", async () => {
		const registry = createSchemaRegistry();
		registry.register("ses_3", compileSchema(SCHEMA));
		const t = createStructuredOutputTool(registry);
		const out = await t.execute({ result: '{"n":"oops"}' }, ctx("ses_3"));
		expect(out as string).toStartWith(
			"schema validation failed — fix and call structured_output again: ",
		);
		expect(registry.resultFor("ses_3").present).toBe(false);
	});

	test("validation failure records the failure reason for diagnostics (Task 7.2.1)", async () => {
		const registry = createSchemaRegistry();
		registry.register("ses_diag", compileSchema(SCHEMA));
		const t = createStructuredOutputTool(registry);
		await t.execute({ result: '{"n":"oops"}' }, ctx("ses_diag"));
		// The validation errors are recorded so agent-call can render schema_invalid.
		expect(registry.lastFailure("ses_diag")).toBeDefined();
		expect(registry.lastFailure("ses_diag")).not.toBe("");
	});

	test("a JSON parse failure also records a failure (the tool WAS called, Task 7.2.1)", async () => {
		// Parse failure and schema-validation failure both mean "the tool was called
		// but produced no stored value" — both feed schema_invalid, distinguishing
		// them from schema_no_call (the tool was never called at all).
		const registry = createSchemaRegistry();
		registry.register("ses_pf", compileSchema(SCHEMA));
		const t = createStructuredOutputTool(registry);
		await t.execute({ result: "not json {" }, ctx("ses_pf"));
		expect(registry.lastFailure("ses_pf")).toBeDefined();
	});

	test("valid string result is stored and returns 'accepted'", async () => {
		const registry = createSchemaRegistry();
		registry.register("ses_4", compileSchema(SCHEMA));
		const t = createStructuredOutputTool(registry);
		const out = await t.execute({ result: '{"n":42}' }, ctx("ses_4"));
		expect(out).toBe("accepted");
		expect(registry.resultFor("ses_4")).toEqual({
			present: true,
			value: { n: 42 },
		});
	});
});
