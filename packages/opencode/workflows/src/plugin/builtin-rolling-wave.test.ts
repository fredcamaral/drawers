import { describe, expect, test } from "bun:test";
import { evaluateScript } from "../runtime/evaluate";
import { parseScript } from "../runtime/meta";
import type { AgentOpts, RuntimeApi } from "../runtime/types";
import { ROLLING_WAVE_SOURCE } from "./builtin-rolling-wave";

/**
 * Control-flow test for the built-in rolling-wave script. parseScript proves it
 * parses; this proves its LOGIC runs end-to-end on allowed globals only and
 * threads decompose → implement → review → fix → synthesize correctly. Agents are
 * stubbed by label, so no model access happens — we assert the script's plumbing
 * (happy path, fix loop, stop-on-red break, empty-goal guard, verifyDiff wiring),
 * not implementation quality (live behavior needs real agents and is not
 * unit-testable). Stubs are deterministic: no clocks/random.
 */

const body = parseScript(ROLLING_WAVE_SOURCE).bodySource;

/** Build a RuntimeApi with real pipeline/parallel and a label-dispatched agent. */
function makeApi(opts: {
	args: unknown;
	agent: (prompt: string, o?: AgentOpts) => Promise<unknown>;
	/** Accumulates every log() message, for red-gate reporting assertions. */
	logs?: string[];
}): RuntimeApi {
	return {
		agent: opts.agent as RuntimeApi["agent"],
		phase: () => {},
		log: (message: string) => {
			opts.logs?.push(message);
		},
		args: opts.args,
		budget: { total: null, spent: () => 0, remaining: () => Infinity },
		workflow: (() => {
			throw new Error("workflow() not used");
		}) as RuntimeApi["workflow"],
		shell: (() => {
			throw new Error("shell() not used");
		}) as RuntimeApi["shell"],
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

type Verdict = { gatesPass: boolean; findings: string[] };

/**
 * Dispatch a stub agent by label prefix. `reviews` maps a review/rereview label
 * to the verdict it should return (explicit `null` simulates a degraded review
 * agent); `calledLabels` accumulates every label seen so negative assertions (no
 * fix, no later task, no agent at all) can check absence. `plan` (when the key is
 * present) overrides the decompose result; `implementResults` overrides
 * implement:/fix: results per label so degrade paths (null, merge conflict) are
 * testable. `rereview:` is matched BEFORE `review:` since both start with "re".
 */
function dispatchAgent(opts: {
	tasks: string[];
	reviews: Record<string, Verdict | null>;
	calledLabels: string[];
	implementOpts?: Array<{ label: string; opts?: AgentOpts }>;
	plan?: unknown;
	implementResults?: Record<string, unknown>;
	prompts?: Array<{ label: string; prompt: string }>;
}) {
	return async (prompt: string, o?: AgentOpts) => {
		const label = o?.label ?? "";
		opts.calledLabels.push(label);
		opts.prompts?.push({ label, prompt });
		if (opts.implementOpts && label.startsWith("implement:")) {
			opts.implementOpts.push({ label, opts: o });
		}
		if (label === "decompose") {
			return "plan" in opts ? opts.plan : { tasks: opts.tasks };
		}
		if (label.startsWith("rereview:") || label.startsWith("review:")) {
			return label in opts.reviews
				? opts.reviews[label]
				: { gatesPass: true, findings: [] };
		}
		if (label.startsWith("implement:") || label.startsWith("fix:")) {
			if (opts.implementResults && label in opts.implementResults) {
				return opts.implementResults[label];
			}
			return "wrote to disk";
		}
		if (label === "synthesize") return "REPORT";
		return null;
	};
}

type RollingWaveResult = {
	goal: string;
	completed: string[];
	remaining: string[];
	failed?: { task: string; reason: string; branch?: string } | null;
	report: unknown;
	error?: string;
};

describe("built-in rolling-wave — control flow", () => {
	test("happy path threads all tasks through to a report", async () => {
		const calledLabels: string[] = [];
		const api = makeApi({
			args: { goal: "ship the feature" },
			agent: dispatchAgent({ tasks: ["t0", "t1"], reviews: {}, calledLabels }),
		});
		const result = (await evaluateScript(body, api)) as RollingWaveResult;
		expect(result.goal).toBe("ship the feature");
		expect(result.completed).toEqual(["t0", "t1"]);
		expect(result.remaining).toEqual([]);
		expect(result.report).toBe("REPORT");
		// No review was red → no fix loop fired.
		expect(calledLabels.some((l) => l.startsWith("fix:"))).toBe(false);
	});

	test("a red review triggers fix + re-review, then continues on green", async () => {
		const calledLabels: string[] = [];
		const api = makeApi({
			args: { goal: "g" },
			agent: dispatchAgent({
				tasks: ["t0", "t1"],
				reviews: {
					"review:0": { gatesPass: false, findings: ["f1"] },
					"rereview:0": { gatesPass: true, findings: [] },
					"review:1": { gatesPass: true, findings: [] },
				},
				calledLabels,
			}),
		});
		const result = (await evaluateScript(body, api)) as RollingWaveResult;
		expect(calledLabels).toContain("fix:0");
		expect(calledLabels).toContain("rereview:0");
		expect(result.completed).toEqual(["t0", "t1"]);
	});

	test("stop-on-red halts the wave before later tasks", async () => {
		const calledLabels: string[] = [];
		const api = makeApi({
			args: { goal: "g" },
			agent: dispatchAgent({
				tasks: ["t0", "t1", "t2"],
				reviews: {
					"review:0": { gatesPass: false, findings: ["f"] },
					"rereview:0": { gatesPass: false, findings: ["still"] },
				},
				calledLabels,
			}),
		});
		const result = (await evaluateScript(body, api)) as RollingWaveResult;
		expect(result.completed).toEqual([]);
		expect(result.remaining).toContain("t1");
		expect(result.remaining).toContain("t2");
		// The break fired before task 1 was implemented.
		expect(calledLabels).not.toContain("implement:1");
	});

	test("an empty goal returns an honest error without spawning agents", async () => {
		let called = false;
		const api = makeApi({
			args: {},
			agent: async () => {
				called = true;
				return null;
			},
		});
		const result = (await evaluateScript(body, api)) as RollingWaveResult;
		expect(result.error).toContain("goal");
		expect(called).toBe(false);
	});

	test("verifyDiff shape is wired from args.testCmd", async () => {
		const withCmd: Array<{ label: string; opts?: AgentOpts }> = [];
		const apiWithCmd = makeApi({
			args: { goal: "g", testCmd: "bun test" },
			agent: dispatchAgent({
				tasks: ["t0"],
				reviews: {},
				calledLabels: [],
				implementOpts: withCmd,
			}),
		});
		await evaluateScript(body, apiWithCmd);
		const implemented = withCmd.find((c) => c.label === "implement:0");
		expect(implemented?.opts?.verifyDiff).toEqual({ check: "bun test" });

		const noCmd: Array<{ label: string; opts?: AgentOpts }> = [];
		const apiNoCmd = makeApi({
			args: { goal: "g" },
			agent: dispatchAgent({
				tasks: ["t0"],
				reviews: {},
				calledLabels: [],
				implementOpts: noCmd,
			}),
		});
		await evaluateScript(body, apiNoCmd);
		const implementedNoCmd = noCmd.find((c) => c.label === "implement:0");
		expect(implementedNoCmd?.opts?.verifyDiff).toBe(true);
	});

	test("a null decompose plan falls back to the goal as a single task", async () => {
		const calledLabels: string[] = [];
		const api = makeApi({
			args: { goal: "just do it" },
			agent: dispatchAgent({
				tasks: [],
				reviews: {},
				calledLabels,
				plan: null,
			}),
		});
		const result = (await evaluateScript(body, api)) as RollingWaveResult;
		expect(result.completed).toEqual(["just do it"]);
		expect(calledLabels.filter((l) => l.startsWith("implement:"))).toEqual([
			"implement:0",
		]);
	});

	test("a null review verdict is stop-on-red — no fix, no later task, not done", async () => {
		const calledLabels: string[] = [];
		const api = makeApi({
			args: { goal: "g" },
			agent: dispatchAgent({
				tasks: ["t0", "t1"],
				reviews: { "review:0": null },
				calledLabels,
			}),
		});
		const result = (await evaluateScript(body, api)) as RollingWaveResult;
		expect(result.completed).toEqual([]);
		expect(result.remaining).toEqual(["t0", "t1"]);
		expect(calledLabels).not.toContain("fix:0");
		expect(calledLabels).not.toContain("implement:1");
	});

	test("a null implement is a red gate — review never dispatched, wave stops", async () => {
		const calledLabels: string[] = [];
		const logs: string[] = [];
		const api = makeApi({
			args: { goal: "g" },
			logs,
			agent: dispatchAgent({
				tasks: ["t0", "t1"],
				reviews: {},
				calledLabels,
				implementResults: { "implement:0": null },
			}),
		});
		const result = (await evaluateScript(body, api)) as RollingWaveResult;
		// A degraded implement means the work did NOT land; reviewing the cumulative
		// diff anyway could pass on prior tasks' changes (green-on-red).
		expect(calledLabels).not.toContain("review:0");
		expect(calledLabels).not.toContain("implement:1");
		expect(result.completed).toEqual([]);
		expect(result.remaining).toEqual(["t0", "t1"]);
		expect(result.failed?.task).toBe("t0");
		expect(logs.join("\n")).toContain("t0");
	});

	test("a conflict implement is a red gate that surfaces the preserved branch", async () => {
		const calledLabels: string[] = [];
		const logs: string[] = [];
		const api = makeApi({
			args: { goal: "g" },
			logs,
			agent: dispatchAgent({
				tasks: ["t0", "t1"],
				reviews: {},
				calledLabels,
				implementResults: {
					"implement:0": {
						status: "conflict",
						branch: "workflow/implement-0",
						files: ["a.ts"],
						baseRef: "deadbeef",
					},
				},
			}),
		});
		const result = (await evaluateScript(body, api)) as RollingWaveResult;
		expect(calledLabels).not.toContain("review:0");
		expect(result.completed).toEqual([]);
		expect(result.failed?.task).toBe("t0");
		expect(result.failed?.branch).toBe("workflow/implement-0");
		expect(logs.join("\n")).toContain("workflow/implement-0");
	});

	test("a degraded fix is a red gate — re-review never dispatched", async () => {
		const calledLabels: string[] = [];
		const api = makeApi({
			args: { goal: "g" },
			agent: dispatchAgent({
				tasks: ["t0", "t1"],
				reviews: { "review:0": { gatesPass: false, findings: ["f"] } },
				calledLabels,
				implementResults: { "fix:0": null },
			}),
		});
		const result = (await evaluateScript(body, api)) as RollingWaveResult;
		expect(calledLabels).toContain("fix:0");
		expect(calledLabels).not.toContain("rereview:0");
		expect(calledLabels).not.toContain("implement:1");
		expect(result.completed).toEqual([]);
		expect(result.failed?.task).toBe("t0");
	});

	test("decompose output is truncated to MAX_TASKS (20)", async () => {
		const calledLabels: string[] = [];
		const tasks = Array.from({ length: 25 }, (_, i) => "t" + i);
		const api = makeApi({
			args: { goal: "g" },
			agent: dispatchAgent({ tasks, reviews: {}, calledLabels }),
		});
		const result = (await evaluateScript(body, api)) as RollingWaveResult;
		expect(result.completed.length).toBe(20);
		expect(calledLabels).toContain("implement:19");
		expect(calledLabels).not.toContain("implement:20");
	});

	test("review prompts disclose the cumulative diff scope and prior tasks", async () => {
		const prompts: Array<{ label: string; prompt: string }> = [];
		const api = makeApi({
			args: { goal: "g" },
			agent: dispatchAgent({
				tasks: ["t0", "t1"],
				reviews: {},
				calledLabels: [],
				prompts,
			}),
		});
		await evaluateScript(body, api);
		const second = prompts.find((p) => p.label === "review:1");
		expect(second?.prompt).toContain("CUMULATIVE");
		// Prior completed tasks are listed so the reviewer can attribute changes.
		expect(second?.prompt).toContain("t0");
		expect(second?.prompt).toContain("ONLY");
		const first = prompts.find((p) => p.label === "review:0");
		expect(first?.prompt).toContain("CUMULATIVE");
	});
});
