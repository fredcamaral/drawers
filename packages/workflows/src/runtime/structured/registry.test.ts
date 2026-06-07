import { describe, expect, test } from "bun:test";
import { createSchemaRegistry } from "./registry";
import type { CompiledSchema } from "./validate";

/** A trivial CompiledSchema double — the registry never inspects it. */
function fakeSchema(tag: string): CompiledSchema {
	return {
		validate: () => ({ ok: true }),
		// tag is observable only via identity in these tests.
		toString: () => tag,
	} as unknown as CompiledSchema;
}

describe("createSchemaRegistry — register/lookup/clear lifecycle", () => {
	test("register then lookup returns the same compiled schema; clear removes it", () => {
		const reg = createSchemaRegistry();
		const schema = fakeSchema("s1");

		expect(reg.lookup("ses_1")).toBeUndefined();

		reg.register("ses_1", schema);
		expect(reg.lookup("ses_1")).toBe(schema);

		reg.clear("ses_1");
		expect(reg.lookup("ses_1")).toBeUndefined();
	});

	test("clear also drops a stored result for the session", () => {
		const reg = createSchemaRegistry();
		reg.register("ses_1", fakeSchema("s1"));
		reg.store("ses_1", { value: 42 });

		expect(reg.resultFor("ses_1").present).toBe(true);
		reg.clear("ses_1");
		expect(reg.resultFor("ses_1").present).toBe(false);
		expect(reg.lookup("ses_1")).toBeUndefined();
	});
});

describe("createSchemaRegistry — last validation failure (Task 7.2.1)", () => {
	test("no failure recorded → lastFailure undefined", () => {
		const reg = createSchemaRegistry();
		expect(reg.lastFailure("ses_1")).toBeUndefined();
	});

	test("recordFailure then lastFailure returns the reason string", () => {
		const reg = createSchemaRegistry();
		reg.recordFailure("ses_1", "missing required 'verdict'");
		expect(reg.lastFailure("ses_1")).toBe("missing required 'verdict'");
	});

	test("last failure wins (overwrite across retries)", () => {
		const reg = createSchemaRegistry();
		reg.recordFailure("ses_1", "first error");
		reg.recordFailure("ses_1", "second error");
		expect(reg.lastFailure("ses_1")).toBe("second error");
	});

	test("a successful store does NOT clear an earlier failure (they are independent records)", () => {
		// The agent primitive only reads lastFailure when resultFor.present is false,
		// so store and failure need not interlock — but clear() drops both.
		const reg = createSchemaRegistry();
		reg.recordFailure("ses_1", "boom");
		reg.store("ses_1", { ok: 1 });
		expect(reg.resultFor("ses_1").present).toBe(true);
		expect(reg.lastFailure("ses_1")).toBe("boom");
	});

	test("clear drops the recorded failure", () => {
		const reg = createSchemaRegistry();
		reg.recordFailure("ses_1", "boom");
		reg.clear("ses_1");
		expect(reg.lastFailure("ses_1")).toBeUndefined();
	});

	test("failures are per-session isolated", () => {
		const reg = createSchemaRegistry();
		reg.recordFailure("ses_a", "a-err");
		reg.recordFailure("ses_b", "b-err");
		reg.clear("ses_a");
		expect(reg.lastFailure("ses_a")).toBeUndefined();
		expect(reg.lastFailure("ses_b")).toBe("b-err");
	});
});

describe("createSchemaRegistry — resultFor present-flag semantics", () => {
	test("never stored → present:false, no value", () => {
		const reg = createSchemaRegistry();
		const r = reg.resultFor("ses_unknown");
		expect(r.present).toBe(false);
		expect(r.value).toBeUndefined();
	});

	test("stored undefined → present:true with value undefined (distinct from never-stored)", () => {
		const reg = createSchemaRegistry();
		reg.store("ses_1", undefined);
		const r = reg.resultFor("ses_1");
		expect(r.present).toBe(true);
		expect(r.value).toBeUndefined();
	});

	test("stored a concrete value → present:true with that value", () => {
		const reg = createSchemaRegistry();
		reg.store("ses_1", { ok: 1 });
		const r = reg.resultFor("ses_1");
		expect(r.present).toBe(true);
		expect(r.value).toEqual({ ok: 1 });
	});

	test("last store wins (overwrite)", () => {
		const reg = createSchemaRegistry();
		reg.store("ses_1", "first");
		reg.store("ses_1", "second");
		expect(reg.resultFor("ses_1").value).toBe("second");
	});
});

describe("createSchemaRegistry — per-session isolation", () => {
	test("two sessions hold independent schemas and results", () => {
		const reg = createSchemaRegistry();
		const sa = fakeSchema("A");
		const sb = fakeSchema("B");

		reg.register("ses_a", sa);
		reg.register("ses_b", sb);
		reg.store("ses_a", "result-a");
		reg.store("ses_b", "result-b");

		expect(reg.lookup("ses_a")).toBe(sa);
		expect(reg.lookup("ses_b")).toBe(sb);
		expect(reg.resultFor("ses_a").value).toBe("result-a");
		expect(reg.resultFor("ses_b").value).toBe("result-b");

		// clearing one leaves the other intact.
		reg.clear("ses_a");
		expect(reg.lookup("ses_a")).toBeUndefined();
		expect(reg.resultFor("ses_a").present).toBe(false);
		expect(reg.lookup("ses_b")).toBe(sb);
		expect(reg.resultFor("ses_b").value).toBe("result-b");
	});
});
