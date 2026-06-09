import { describe, expect, test } from "bun:test";
import { evaluateScript } from "../runtime/evaluate";
import { parseScript } from "../runtime/meta";
import type { AgentOpts, RuntimeApi } from "../runtime/types";
import { DEEP_RESEARCH_SOURCE } from "./builtin-deep-research";

/**
 * Control-flow test for the built-in deep-research script. parseScript proves it
 * parses; this proves its LOGIC runs end-to-end on allowed globals only and
 * threads claims → verdicts → citations correctly. Agents are stubbed by label,
 * so no web/model access happens — we assert the script's plumbing, not research
 * quality (live behavior needs real web tools and is not unit-testable).
 */

const body = parseScript(DEEP_RESEARCH_SOURCE).bodySource;

/** Build a RuntimeApi with real pipeline/parallel and a label-dispatched agent. */
function makeApi(opts: {
	args: unknown;
	agent: (prompt: string, o?: AgentOpts) => Promise<unknown>;
}): RuntimeApi {
	return {
		agent: opts.agent as RuntimeApi["agent"],
		phase: () => {},
		log: () => {},
		args: opts.args,
		budget: { total: null, spent: () => 0, remaining: () => Infinity },
		workflow: (() => {
			throw new Error("workflow() not used");
		}) as RuntimeApi["workflow"],
		parallel: async (thunks: Array<() => Promise<unknown>>) =>
			Promise.all(thunks.map((t) => t())),
		pipeline: async (
			items: unknown[],
			...stages: Array<(prev: unknown, item: unknown, i: number) => unknown>
		) =>
			Promise.all(
				items.map(async (item, i) => {
					let v: unknown = item;
					for (const stage of stages) v = await stage(v, item, i);
					return v;
				}),
			),
	} as RuntimeApi;
}

/** Default happy-path agent: 2 angles, 1 supported claim each. */
function happyAgent(verdictSupported: (claimText: string) => boolean) {
	return async (_prompt: string, o?: AgentOpts) => {
		const label = o?.label ?? "";
		if (label === "plan") return { angles: ["angle-A", "angle-B"] };
		if (label.startsWith("search:")) {
			return {
				claims: [{ text: "claim from " + label, source: "https://src/" + label }],
			};
		}
		if (label === "verify") {
			// The verify prompt embeds the claim text; decide support from it.
			return { supported: verdictSupported(_prompt), reason: "r" };
		}
		if (label === "synthesize") return "THE CITED REPORT";
		return null;
	};
}

describe("built-in deep-research — control flow", () => {
	test("threads claims through verify into a cited report", async () => {
		const api = makeApi({
			args: { question: "what is X?" },
			agent: happyAgent(() => true),
		});
		const result = (await evaluateScript(body, api)) as {
			question: string;
			report: unknown;
			citations: Array<{ text: string; source: string }>;
			dropped: number;
		};
		expect(result.question).toBe("what is X?");
		expect(result.report).toBe("THE CITED REPORT");
		// 2 angles × 1 claim each, all supported → 2 citations, 0 dropped.
		expect(result.citations).toHaveLength(2);
		expect(result.dropped).toBe(0);
		expect(result.citations.every((c) => c.source.startsWith("https://"))).toBe(
			true,
		);
	});

	test("drops claims the adversarial verifier refutes", async () => {
		const api = makeApi({
			args: { question: "what is Y?" },
			// Refute the claim from angle-A's search, support angle-B's.
			agent: happyAgent((prompt) => prompt.includes("search:1")),
		});
		const result = (await evaluateScript(body, api)) as {
			citations: unknown[];
			dropped: number;
		};
		expect(result.citations).toHaveLength(1);
		expect(result.dropped).toBe(1);
	});

	test("an empty question returns an honest error without spawning agents", async () => {
		let called = false;
		const api = makeApi({
			args: {},
			agent: async () => {
				called = true;
				return null;
			},
		});
		const result = (await evaluateScript(body, api)) as { error?: string };
		expect(result.error).toContain("question");
		expect(called).toBe(false);
	});
});
