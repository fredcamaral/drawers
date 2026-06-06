import { describe, expect, test } from "bun:test";
import { MetaError, parseScript, ScriptSyntaxError } from "../index";

describe("parseScript — valid meta", () => {
	test("full meta: name, description, whenToUse, phases with title/detail/model", () => {
		const source = [
			"export const meta = {",
			"\tname: 'review-changes',",
			"\tdescription: 'Review the working tree',",
			"\twhenToUse: 'after edits',",
			"\tphases: [",
			"\t\t{ title: 'Review', detail: 'look at the diff' },",
			"\t\t{ title: 'Verify', detail: 'run tests', model: 'haiku' },",
			"\t],",
			"}",
			"await phase('Review')",
		].join("\n");

		const parsed = parseScript(source);

		expect(parsed.meta.name).toBe("review-changes");
		expect(parsed.meta.description).toBe("Review the working tree");
		expect(parsed.meta.whenToUse).toBe("after edits");
		expect(parsed.meta.phases).toEqual([
			{ title: "Review", detail: "look at the diff" },
			{ title: "Verify", detail: "run tests", model: "haiku" },
		]);
	});

	test("minimal meta: name + description only", () => {
		const source = "export const meta = { name: 'x', description: 'y' }\n";
		const parsed = parseScript(source);
		expect(parsed.meta.name).toBe("x");
		expect(parsed.meta.description).toBe("y");
		expect(parsed.meta.whenToUse).toBeUndefined();
		expect(parsed.meta.phases).toBeUndefined();
	});

	test("literal value materialization: number, boolean, null, nested array", () => {
		const source = [
			"export const meta = {",
			"\tname: 'n',",
			"\tdescription: 'd',",
			"\tphases: [{ title: 'A' }],",
			"}",
		].join("\n");
		const parsed = parseScript(source);
		expect(parsed.meta.phases).toEqual([{ title: "A" }]);
	});
});

describe("parseScript — script syntax", () => {
	test("TypeScript annotation in body fails as ScriptSyntaxError", () => {
		const source = [
			"export const meta = { name: 'n', description: 'd' }",
			'const x: string = "a"',
		].join("\n");
		expect(() => parseScript(source)).toThrow(ScriptSyntaxError);
	});

	test("TypeScript annotation inside meta fails as ScriptSyntaxError", () => {
		const source = "export const meta: any = { name: 'n', description: 'd' }";
		expect(() => parseScript(source)).toThrow(ScriptSyntaxError);
	});
});

describe("parseScript — non-pure meta literals → MetaError", () => {
	test("identifier reference", () => {
		const source = ["export const meta = { name: 'n', description: d }"].join(
			"\n",
		);
		expect(() => parseScript(source)).toThrow(MetaError);
		try {
			parseScript(source);
		} catch (err) {
			expect((err as MetaError).message).toContain("Identifier");
		}
	});

	test("call expression", () => {
		const source = "export const meta = { name: fn(), description: 'd' }";
		expect(() => parseScript(source)).toThrow(MetaError);
		try {
			parseScript(source);
		} catch (err) {
			expect((err as MetaError).message).toContain("CallExpression");
		}
	});

	test("spread element", () => {
		const source =
			"export const meta = { ...base, name: 'n', description: 'd' }";
		expect(() => parseScript(source)).toThrow(MetaError);
		try {
			parseScript(source);
		} catch (err) {
			expect((err as MetaError).message).toContain("SpreadElement");
		}
	});

	test("template literal (even without interpolation)", () => {
		const source = "export const meta = { name: `n`, description: 'd' }";
		expect(() => parseScript(source)).toThrow(MetaError);
		try {
			parseScript(source);
		} catch (err) {
			expect((err as MetaError).message).toContain("TemplateLiteral");
		}
	});

	test("computed key", () => {
		const source = "export const meta = { ['name']: 'n', description: 'd' }";
		expect(() => parseScript(source)).toThrow(MetaError);
	});

	test("unary minus (negative number)", () => {
		const source =
			"export const meta = { name: 'n', description: 'd', rank: -1 }";
		expect(() => parseScript(source)).toThrow(MetaError);
		try {
			parseScript(source);
		} catch (err) {
			expect((err as MetaError).message).toContain("UnaryExpression");
		}
	});
});

describe("parseScript — meta value validation → MetaError", () => {
	test("missing name", () => {
		const source = "export const meta = { description: 'd' }";
		expect(() => parseScript(source)).toThrow(MetaError);
	});

	test("empty description", () => {
		const source = "export const meta = { name: 'n', description: '' }";
		expect(() => parseScript(source)).toThrow(MetaError);
	});

	test("phase without string title", () => {
		const source =
			"export const meta = { name: 'n', description: 'd', phases: [{ detail: 'x' }] }";
		expect(() => parseScript(source)).toThrow(MetaError);
	});
});

describe("parseScript — declaration shape", () => {
	test("missing meta export", () => {
		const source = "const x = 1\n";
		expect(() => parseScript(source)).toThrow(MetaError);
		try {
			parseScript(source);
		} catch (err) {
			expect((err as MetaError).message).toContain("export const meta");
		}
	});

	test("stray import is rejected", () => {
		const source = [
			"import fs from 'node:fs'",
			"export const meta = { name: 'n', description: 'd' }",
		].join("\n");
		expect(() => parseScript(source)).toThrow(MetaError);
		try {
			parseScript(source);
		} catch (err) {
			expect((err as MetaError).message).toContain("self-contained");
		}
	});

	test("second export is rejected", () => {
		const source = [
			"export const meta = { name: 'n', description: 'd' }",
			"export const other = 1",
		].join("\n");
		expect(() => parseScript(source)).toThrow(MetaError);
		try {
			parseScript(source);
		} catch (err) {
			expect((err as MetaError).message).toContain("self-contained");
		}
	});
});

describe("parseScript — bodySource", () => {
	test("meta export is blanked and body line numbers are preserved", () => {
		const source = [
			"export const meta = {",
			"\tname: 'n',",
			"\tdescription: 'd',",
			"}",
			"const marker = 'BODY_TOKEN'",
		].join("\n");

		const parsed = parseScript(source);

		// meta export text is gone from the body
		expect(parsed.bodySource).not.toContain("export const meta");
		// the marker still sits on its original line (line 5, index 4)
		const lines = parsed.bodySource.split("\n");
		expect(lines[4]).toContain("BODY_TOKEN");
		// total line count is unchanged
		expect(lines.length).toBe(source.split("\n").length);
	});
});
