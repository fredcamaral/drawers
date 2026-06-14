import { describe, expect, test } from "bun:test";
import { compileSchema, SchemaCompileError } from "./validate";

describe("compileSchema — valid values", () => {
	test("a value matching the schema → ok:true", () => {
		const compiled = compileSchema({
			type: "object",
			properties: { name: { type: "string" }, age: { type: "number" } },
			required: ["name"],
			additionalProperties: false,
		});

		const r = compiled.validate({ name: "fred", age: 40 });
		expect(r.ok).toBe(true);
	});

	test("a minimal schema accepts the right primitive", () => {
		const compiled = compileSchema({ type: "string" });
		expect(compiled.validate("hello").ok).toBe(true);
	});
});

describe("compileSchema — invalid values flatten to a readable error string", () => {
	test("wrong type → ok:false with a message mentioning the instance path", () => {
		const compiled = compileSchema({
			type: "object",
			properties: { age: { type: "number" } },
			required: ["age"],
		});

		const r = compiled.validate({ age: "not-a-number" });
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error("expected failure");
		// the retry signal: path + message, human/model readable.
		expect(r.errors).toContain("/age");
		expect(r.errors.toLowerCase()).toContain("number");
	});

	test("multiple errors are joined with '; ' (allErrors)", () => {
		const compiled = compileSchema({
			type: "object",
			properties: { a: { type: "number" }, b: { type: "number" } },
			required: ["a", "b"],
			additionalProperties: false,
		});

		const r = compiled.validate({ a: "x", b: "y" });
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error("expected failure");
		expect(r.errors).toContain("; ");
		expect(r.errors).toContain("/a");
		expect(r.errors).toContain("/b");
	});

	test("missing required property surfaces a readable error", () => {
		const compiled = compileSchema({
			type: "object",
			properties: { name: { type: "string" } },
			required: ["name"],
		});

		const r = compiled.validate({});
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error("expected failure");
		expect(r.errors.toLowerCase()).toContain("required");
		expect(r.errors).toContain("name");
	});
});

describe("compileSchema — malformed schema detonates", () => {
	test("an invalid schema throws SchemaCompileError carrying ajv's message", () => {
		// `type` must be a string/array of known types — a number is malformed.
		expect(() => compileSchema({ type: 123 } as object)).toThrow(
			SchemaCompileError,
		);
	});

	test("the SchemaCompileError message is non-empty (carries ajv detail)", () => {
		let caught: unknown;
		try {
			compileSchema({ type: "not-a-real-type" } as object);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(SchemaCompileError);
		expect((caught as SchemaCompileError).message.length).toBeGreaterThan(0);
	});
});

describe("compileSchema — correctness across repeated compiles", () => {
	// Correctness-only (per task): we do NOT spy on Ajv's internal compile cache;
	// we assert that compiling the same schema object twice yields validators that
	// behave identically.
	test("compiling the same schema object twice yields equivalent validators", () => {
		const schema = {
			type: "object",
			properties: { n: { type: "number" } },
			required: ["n"],
		};
		const a = compileSchema(schema);
		const b = compileSchema(schema);

		expect(a.validate({ n: 1 }).ok).toBe(true);
		expect(b.validate({ n: 1 }).ok).toBe(true);
		expect(a.validate({ n: "x" }).ok).toBe(false);
		expect(b.validate({ n: "x" }).ok).toBe(false);
	});
});
