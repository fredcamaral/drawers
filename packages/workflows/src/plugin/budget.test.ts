import { describe, expect, test } from "bun:test";
import { createTokenBudget } from "./budget";

/**
 * Tests for the token budget provider (Task 4.3.1).
 *
 * The budget is a {@link BudgetView} the runtime reads (total/spent/remaining)
 * plus a `recordTask(sessionID)` the agent primitive calls at settle. It fetches
 * a session's messages ONCE and sums assistant `tokens.output + tokens.reasoning`
 * (reasoning is output-priced). Every fetch/shape failure is fenced: warn + add 0.
 */

/** A minimal assistant message slice the budget reads. */
function assistant(output: number, reasoning: number): unknown {
	return { info: { role: "assistant", tokens: { output, reasoning } } };
}

/** A user message (never counted). */
function user(): unknown {
	return { info: { role: "user", tokens: { output: 999, reasoning: 999 } } };
}

describe("createTokenBudget — factory validation", () => {
	test("rejects a non-finite total (NaN)", () => {
		expect(() =>
			createTokenBudget({ total: Number.NaN, fetchMessages: async () => [] }),
		).toThrow();
	});

	test("rejects Infinity", () => {
		expect(() =>
			createTokenBudget({
				total: Number.POSITIVE_INFINITY,
				fetchMessages: async () => [],
			}),
		).toThrow();
	});

	test("rejects zero", () => {
		expect(() =>
			createTokenBudget({ total: 0, fetchMessages: async () => [] }),
		).toThrow();
	});

	test("rejects a negative total", () => {
		expect(() =>
			createTokenBudget({ total: -5, fetchMessages: async () => [] }),
		).toThrow();
	});
});

describe("createTokenBudget — view starts empty", () => {
	test("total is as given; spent 0; remaining == total", () => {
		const b = createTokenBudget({ total: 1000, fetchMessages: async () => [] });
		expect(b.total).toBe(1000);
		expect(b.spent()).toBe(0);
		expect(b.remaining()).toBe(1000);
	});
});

describe("createTokenBudget — recordTask accumulates", () => {
	test("sums output+reasoning across assistant messages only", async () => {
		const b = createTokenBudget({
			total: 1000,
			fetchMessages: async () => [assistant(10, 5), user(), assistant(20, 0)],
		});
		await b.recordTask("ses_1");
		// (10+5) + (20+0) = 35; the user message's tokens are ignored.
		expect(b.spent()).toBe(35);
		expect(b.remaining()).toBe(965);
	});

	test("accumulates across multiple recordTask calls", async () => {
		const b = createTokenBudget({
			total: 1000,
			fetchMessages: async () => [assistant(100, 0)],
		});
		await b.recordTask("ses_1");
		await b.recordTask("ses_2");
		expect(b.spent()).toBe(200);
	});

	test("missing tokens → 0 contribution", async () => {
		const b = createTokenBudget({
			total: 1000,
			fetchMessages: async () => [
				{ info: { role: "assistant" } }, // no tokens field
				{ info: { role: "assistant", tokens: {} } }, // empty tokens
				{ info: { role: "assistant", tokens: { output: 7 } } }, // partial
				{}, // no info at all
			],
		});
		await b.recordTask("ses_1");
		expect(b.spent()).toBe(7);
	});

	test("remaining never goes below 0 even past the ceiling", async () => {
		const b = createTokenBudget({
			total: 50,
			fetchMessages: async () => [assistant(200, 0)],
		});
		await b.recordTask("ses_1");
		expect(b.spent()).toBe(200);
		expect(b.remaining()).toBe(0);
	});
});

describe("createTokenBudget — fenced failures add 0", () => {
	test("a throwing fetch logs a warn and adds 0", async () => {
		const warns: string[] = [];
		const b = createTokenBudget({
			total: 1000,
			fetchMessages: async () => {
				throw new Error("network down");
			},
			logger: { warn: (m) => warns.push(m) },
		});
		await b.recordTask("ses_1");
		expect(b.spent()).toBe(0);
		expect(warns.length).toBe(1);
	});

	test("a non-array / garbage shape adds 0 (defensive)", async () => {
		const b = createTokenBudget({
			total: 1000,
			// Pretend the fetch returns something not array-shaped.
			fetchMessages: async () => undefined as unknown as unknown[],
		});
		await b.recordTask("ses_1");
		expect(b.spent()).toBe(0);
	});

	test("fences without a logger (no crash when logger absent)", async () => {
		const b = createTokenBudget({
			total: 1000,
			fetchMessages: async () => {
				throw new Error("boom");
			},
		});
		await b.recordTask("ses_1");
		expect(b.spent()).toBe(0);
	});
});
