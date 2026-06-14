import { describe, expect, test } from "bun:test";
import { DeterminismError, evaluateScript } from "./evaluate";
import { ScriptSyntaxError } from "./meta";
import type { RuntimeApi } from "./types";

/** A no-op API whose members fail loudly if a test relies on them unexpectedly. */
function makeApi(overrides: Partial<RuntimeApi> = {}): RuntimeApi {
	const reject = () => {
		throw new Error("unexpected API call");
	};
	return {
		agent: reject,
		pipeline: reject,
		parallel: reject,
		phase: reject,
		log: () => {},
		args: {},
		budget: { total: null, spent: () => 0, remaining: () => Infinity },
		workflow: reject as RuntimeApi["workflow"],
		shell: reject as RuntimeApi["shell"],
		...overrides,
	};
}

describe("evaluateScript — body execution", () => {
	test("body returns a value", async () => {
		const result = await evaluateScript("return 1 + 2", makeApi());
		expect(result).toBe(3);
	});

	test("body with no return yields undefined", async () => {
		const result = await evaluateScript("const x = 1", makeApi());
		expect(result).toBeUndefined();
	});

	test("body awaits an injected agent and returns its result", async () => {
		const api = makeApi({
			agent: async (prompt: unknown) => `handled: ${String(prompt)}`,
		});
		const result = await evaluateScript(
			"return await agent('do the thing')",
			api,
		);
		expect(result).toBe("handled: do the thing");
	});
});

describe("evaluateScript — determinism guards", () => {
	test("Date.now() throws DeterminismError", async () => {
		await expect(
			evaluateScript("return Date.now()", makeApi()),
		).rejects.toThrow(DeterminismError);
	});

	test("Math.random() throws DeterminismError", async () => {
		await expect(
			evaluateScript("return Math.random()", makeApi()),
		).rejects.toThrow(DeterminismError);
	});

	test("argless new Date() throws DeterminismError", async () => {
		await expect(
			evaluateScript("return new Date()", makeApi()),
		).rejects.toThrow(DeterminismError);
	});

	test("new Date(123) works and other Date/Math usage is unaffected", async () => {
		const result = await evaluateScript(
			"return new Date(123).getTime() + Math.floor(2.5)",
			makeApi(),
		);
		expect(result).toBe(125);
	});

	test("Date.parse and Date.UTC pass through", async () => {
		const result = await evaluateScript(
			"return Date.parse('1970-01-01T00:00:00.000Z') + Date.UTC(1970, 0, 1)",
			makeApi(),
		);
		expect(result).toBe(0);
	});

	test("globalThis.Date is unreachable (frozen empty object)", async () => {
		const result = await evaluateScript(
			"return typeof globalThis.Date",
			makeApi(),
		);
		expect(result).toBe("undefined");
	});

	test("process and fetch are undefined in-script", async () => {
		const result = await evaluateScript(
			"return [typeof process, typeof fetch]",
			makeApi(),
		);
		expect(result).toEqual(["undefined", "undefined"]);
	});

	test("setTimeout throws", async () => {
		await expect(
			evaluateScript("setTimeout(() => {}, 0)", makeApi()),
		).rejects.toThrow();
	});

	test("console.log forwards to the injected log as one narrator line", async () => {
		const logged: string[] = [];
		const api = makeApi({
			log: (message: string) => {
				logged.push(message);
			},
		});
		await evaluateScript("console.log('x', 42)", api);
		expect(logged).toEqual(["x 42"]);
	});

	test("strict-mode accidental global write throws", async () => {
		await expect(
			evaluateScript("undeclaredVar = 1", makeApi()),
		).rejects.toThrow();
	});
});

describe("evaluateScript — error propagation", () => {
	test("a thrown body error propagates with its message intact", async () => {
		await expect(
			evaluateScript("throw new Error('boom')", makeApi()),
		).rejects.toThrow("boom");
	});

	test("a syntax-error body becomes a ScriptSyntaxError", async () => {
		await expect(evaluateScript("return (", makeApi())).rejects.toThrow(
			ScriptSyntaxError,
		);
	});
});
