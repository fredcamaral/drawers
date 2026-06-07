import { describe, expect, test } from "bun:test";
import { computeWorkflowKey } from "./keys";
import type { ChildRunResult } from "./sub-workflow";
import { createSubWorkflowPrimitive } from "./sub-workflow";
import type { JournalEntry, ProgressEvent, WorkflowFn } from "./types";

/**
 * Unit tests for the `workflow()` sub-workflow primitive (Task 4.3.2).
 *
 * The factory is driven directly with fakes: a `resolveSubWorkflow` that maps a
 * name/ref to source, and a `runChild` that stands in for a real child run. The
 * goal is to pin the BEHAVIOUR the factory owns — nesting guard, resolver-throw
 * propagation, the synthetic journal boundary (cache hit / prefix break / record),
 * error throwing, the shared cap, and label-prefixed progress — without booting a
 * real createWorkflowRun (that path is covered live + in conformance).
 */

const AGENT_CAP = 1_000;

interface Boxes {
	counters: { agents: number };
	callIndex: { value: number };
	emitted: ProgressEvent[];
}

function makeBoxes(): Boxes {
	return {
		counters: { agents: 0 },
		callIndex: { value: 0 },
		emitted: [],
	};
}

interface FactoryOpts {
	boxes: Boxes;
	resolveSubWorkflow?: (
		nameOrRef: string | { scriptPath: string },
	) => Promise<string>;
	runChild?: (source: string, childArgs: unknown) => Promise<ChildRunResult>;
	replay?: { entries: JournalEntry[]; onRecord: (e: JournalEntry) => void };
}

function makeWorkflow(opts: FactoryOpts): WorkflowFn {
	const { boxes } = opts;
	return createSubWorkflowPrimitive({
		resolveSubWorkflow: opts.resolveSubWorkflow,
		runChild:
			opts.runChild ??
			(async () => ({ status: "completed", returnValue: "child-result" })),
		counters: boxes.counters,
		callIndex: boxes.callIndex,
		emit: (e) => boxes.emitted.push(e),
		currentPhase: () => undefined,
		replay: opts.replay,
	});
}

describe("workflow() — nesting guard (depth 1)", () => {
	test("no resolver (the CHILD case) → throws NestingError", async () => {
		const boxes = makeBoxes();
		const workflow = makeWorkflow({ boxes, resolveSubWorkflow: undefined });
		await expect(workflow("anything")).rejects.toThrow(/one level/);
	});

	test("NestingError carries the name", async () => {
		const boxes = makeBoxes();
		const workflow = makeWorkflow({ boxes, resolveSubWorkflow: undefined });
		let caught: unknown;
		try {
			await workflow("x");
		} catch (err) {
			caught = err;
		}
		expect((caught as Error).name).toBe("NestingError");
	});
});

describe("workflow() — resolver-throw is a catchable script error", () => {
	test("an unknown name (resolver rejects) propagates out of workflow()", async () => {
		const boxes = makeBoxes();
		const workflow = makeWorkflow({
			boxes,
			resolveSubWorkflow: async () => {
				throw new Error("no workflow named 'ghost'");
			},
		});
		await expect(workflow("ghost")).rejects.toThrow(/ghost/);
	});
});

describe("workflow() — child error throws (catchable, unlike agent's null)", () => {
	test("child status error → workflow() throws Error(child.error)", async () => {
		const boxes = makeBoxes();
		const workflow = makeWorkflow({
			boxes,
			resolveSubWorkflow: async () => "child source",
			runChild: async () => ({ status: "error", error: "child blew up" }),
		});
		await expect(workflow("c")).rejects.toThrow("child blew up");
	});
});

describe("workflow() — completed child returns its returnValue", () => {
	test("status completed → resolves the child's returnValue", async () => {
		const boxes = makeBoxes();
		const workflow = makeWorkflow({
			boxes,
			resolveSubWorkflow: async () => "child source",
			runChild: async () => ({
				status: "completed",
				returnValue: { marker: "from-child" },
			}),
		});
		await expect(workflow("c", { x: 1 })).resolves.toEqual({
			marker: "from-child",
		});
	});
});

describe("workflow() — shared cap counts the boundary against the parent", () => {
	test("a workflow() call increments the shared agent counter", async () => {
		const boxes = makeBoxes();
		const workflow = makeWorkflow({
			boxes,
			resolveSubWorkflow: async () => "src",
		});
		await workflow("c");
		expect(boxes.counters.agents).toBe(1);
	});

	test("at the lifetime cap, workflow() throws AgentCapError without running the child", async () => {
		const boxes = makeBoxes();
		boxes.counters.agents = AGENT_CAP;
		let ran = false;
		const workflow = makeWorkflow({
			boxes,
			resolveSubWorkflow: async () => "src",
			runChild: async () => {
				ran = true;
				return { status: "completed", returnValue: 1 };
			},
		});
		await expect(workflow("c")).rejects.toThrow(/cap/i);
		expect(ran).toBe(false);
	});
});

describe("workflow() — synthetic journal boundary (replay)", () => {
	test("prefix intact + matching boundary key → child NEVER runs; cached returnValue + 'cached' log", async () => {
		const boxes = makeBoxes();
		const SRC = "resolved child source";
		const ARGS = { x: 1 };
		const key = computeWorkflowKey(SRC, ARGS);
		const recorded: JournalEntry[] = [];
		let childRan = false;
		const workflow = makeWorkflow({
			boxes,
			resolveSubWorkflow: async () => SRC,
			runChild: async () => {
				childRan = true;
				return { status: "completed", returnValue: "LIVE" };
			},
			replay: {
				entries: [{ index: 0, key, status: "ok", result: "CACHED" }],
				onRecord: (e) => recorded.push(e),
			},
		});

		const out = await workflow("helper", ARGS);
		expect(out).toBe("CACHED");
		expect(childRan).toBe(false);
		// Re-recorded into the new journal so the resumed run is self-contained.
		expect(recorded).toEqual([
			{ index: 0, key, status: "ok", result: "CACHED" },
		]);
		// A "cached" log line names the workflow.
		const logs = boxes.emitted.filter((e) => e.type === "log");
		expect(
			logs.some((e) => e.type === "log" && /helper.*cached/.test(e.message)),
		).toBe(true);
	});

	test("a child-source edit → no matching boundary key → child runs live", async () => {
		// Task 7.3.1: the boundary key lands in the SAME byKey queue map as agent()
		// keys, no special-casing. An edited child source produces a different key,
		// which has no queued entry → the child runs live.
		const boxes = makeBoxes();
		const recorded: JournalEntry[] = [];
		let childRan = false;
		const workflow = makeWorkflow({
			boxes,
			// Resolver now returns DIFFERENT source than what was journaled → key mismatch.
			resolveSubWorkflow: async () => "EDITED child source",
			runChild: async () => {
				childRan = true;
				return { status: "completed", returnValue: "LIVE" };
			},
			replay: {
				entries: [
					{
						index: 0,
						key: computeWorkflowKey("OLD source", undefined),
						status: "ok",
						result: "STALE",
					},
				],
				onRecord: (e) => recorded.push(e),
			},
		});

		const out = await workflow("helper");
		expect(out).toBe("LIVE");
		expect(childRan).toBe(true);
		// The live result is recorded under the NEW boundary key.
		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.result).toBe("LIVE");
	});

	test("position independence: a boundary key still replays after an unrelated edit before it", async () => {
		// Field finding R4 applied to workflow(): editing one boundary must not void a
		// later unchanged boundary. The first call's edited source misses; the second
		// call's UNCHANGED source still finds its queued entry and replays cached.
		const boxes = makeBoxes();
		const SRC = "helper source";
		const ARGS = { x: 1 };
		const matchKey = computeWorkflowKey(SRC, ARGS);
		let childRuns = 0;
		const resolved = ["EDITED first source", SRC];
		const workflow = makeWorkflow({
			boxes,
			resolveSubWorkflow: async () => resolved.shift() as string,
			runChild: async () => {
				childRuns += 1;
				return { status: "completed", returnValue: "LIVE" };
			},
			replay: {
				entries: [
					{
						index: 0,
						key: computeWorkflowKey("first OLD source", undefined),
						status: "ok",
						result: "STALE",
					},
					{ index: 1, key: matchKey, status: "ok", result: "CACHED" },
				],
				onRecord: () => {},
			},
		});

		// First boundary: edited source, no matching key → runs live.
		expect(await workflow("first")).toBe("LIVE");
		// Second boundary: unchanged → its key still has a queued entry → cached,
		// even though an earlier boundary diverged (the old prefix latch would have
		// re-run it).
		expect(await workflow("helper", ARGS)).toBe("CACHED");
		expect(childRuns).toBe(1);
	});

	test("live completed child → onRecord captures the boundary entry", async () => {
		const boxes = makeBoxes();
		const recorded: JournalEntry[] = [];
		const SRC = "src";
		const workflow = makeWorkflow({
			boxes,
			resolveSubWorkflow: async () => SRC,
			runChild: async () => ({ status: "completed", returnValue: 99 }),
			replay: { entries: [], onRecord: (e) => recorded.push(e) },
		});
		await workflow("c", { k: "v" });
		expect(recorded).toEqual([
			{
				index: 0,
				key: computeWorkflowKey(SRC, { k: "v" }),
				status: "ok",
				result: 99,
			},
		]);
	});
});

describe("workflow() — progress labelling", () => {
	test("child progress is forwarded with the child name prefixed onto agent labels", async () => {
		const boxes = makeBoxes();
		const workflow = makeWorkflow({
			boxes,
			resolveSubWorkflow: async () => "src",
			runChild: async (_src, _args) => {
				// The factory passes an onProgress into runChild; we simulate the child
				// emitting an agent:start with a bare label.
				boxes.emitted.length = 0; // ignore the start log for this assertion
				return { status: "completed", returnValue: 1 };
			},
		});
		// The labelling contract is verified structurally: runChild receives an
		// onProgress that prefixes. We assert via a dedicated runChild below.
		let forwarded: ProgressEvent | undefined;
		const wf2 = createSubWorkflowPrimitive({
			resolveSubWorkflow: async () => "src",
			runChild: async (_src, _args, onProgress) => {
				onProgress?.({ type: "agent:start", label: "inner", phase: "P" });
				return { status: "completed", returnValue: 1 };
			},
			counters: boxes.counters,
			callIndex: boxes.callIndex,
			emit: (e) => {
				forwarded = e;
			},
			currentPhase: () => undefined,
		});
		await wf2("childName");
		expect(forwarded).toEqual({
			type: "agent:start",
			label: "childName/inner",
			phase: "P",
		});
		// (the first `workflow` instance is unused beyond construction)
		void workflow;
	});
});
