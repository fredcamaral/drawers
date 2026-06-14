/**
 * Focused tests for the runner-coupled `agent()` primitive, driven through a real
 * {@link createWorkflowRun} over a scripted {@link SessionRunner} (no live pi child).
 *
 * Coverage:
 *   - fan-out: parallel() launches two children and collects both results;
 *   - barrier: pipeline() runs steps in order, threading each result forward;
 *   - structured read-back: a child's echoed JSON is parsed/validated PARENT-side via
 *     the readStructured seam; the schema_no_call nudge resume path;
 *   - the HIGH fix: a constrained-`tools` agent's launch carries `structured_output`
 *     in the `--tools` allow-list (so the child can actually call it), while a
 *     default agent stays unconstrained (`tools` undefined);
 *   - worktree isolation: mint → clean merge → cleanup, and a mint miss degrade.
 */

import { describe, expect, test } from "bun:test";
import { createWorkflowRun } from "./index";
import {
	makeFakeWorktreeManager,
	makeScriptedRunner,
	scriptOf,
} from "./test-fakes";
import type { ProgressEvent } from "./types";

const PARENT = "parent_session_1";

describe("agent() over the pi runner — fan-out + barrier", () => {
	test("parallel() fans out two children and collects both results", async () => {
		const runner = makeScriptedRunner([
			{ summaryText: "alpha" },
			{ summaryText: "beta" },
		]);
		const run = createWorkflowRun({
			runner,
			parentSessionID: PARENT,
			runId: "run_fanout",
		});
		const source = scriptOf(
			`const [a, b] = await parallel([
				() => agent("do a", { label: "a" }),
				() => agent("do b", { label: "b" }),
			]);
			return [a, b];`,
		);
		const result = await run.run(source);

		expect(result.status).toBe("completed");
		expect(result.returnValue).toEqual(["alpha", "beta"]);
		expect(runner.launches).toHaveLength(2);
		expect(result.agentCount).toBe(2);
		// Both children announced and ended.
		const ends = result.progress.filter((e) => e.type === "agent:end");
		expect(ends).toHaveLength(2);
		expect(
			ends.every((e) => (e as { status: string }).status === "completed"),
		).toBe(true);
	});

	test("pipeline() runs steps in order, threading each result forward", async () => {
		const runner = makeScriptedRunner([
			{ summaryText: "step1" },
			{ summaryText: "step2" },
		]);
		const seen: unknown[] = [];
		const run = createWorkflowRun({
			runner,
			parentSessionID: PARENT,
			runId: "run_pipe",
			onProgress: (e) => {
				if (e.type === "agent:start") {
					seen.push((e as { label: string }).label);
				}
			},
		});
		// pipeline(items, ...stages): each stage gets (prev, item, index). One item
		// threaded through two ordered stages — the second sees the first's result.
		const source = scriptOf(
			`const out = await pipeline(
				["seed"],
				() => agent("first", { label: "first" }),
				(prev) => agent("second got " + prev, { label: "second" }),
			);
			return out;`,
		);
		const result = await run.run(source);

		expect(result.status).toBe("completed");
		// One item → one result: the final stage's output ("step2").
		expect(result.returnValue).toEqual(["step2"]);
		// Ordering barrier: "first" starts before "second".
		expect(seen).toEqual(["first", "second"]);
		// The second prompt was threaded the first stage's result.
		expect(runner.launches[1]?.prompt).toContain("second got step1");
	});
});

describe("agent() — pi tool gating (the HIGH fix)", () => {
	test("a constrained-tools agent's launch unions structured_output INTO --tools", async () => {
		const runner = makeScriptedRunner([{ structured: '{"verdict":"pass"}' }]);
		const run = createWorkflowRun({
			runner,
			parentSessionID: PARENT,
			runId: "run_gating",
			// A resolved agent whose frontmatter constrains tools to a strict list that
			// does NOT include structured_output — exactly the bug scenario.
			resolveAgentKnobs: () => ({
				appendSystemPrompt: "you are a reviewer",
				tools: ["read", "bash"],
			}),
			readStructured: (taskId, sessionId) =>
				runner.readStructuredFor(taskId, sessionId),
		});
		const source = scriptOf(
			`return await agent("review it", {
				agentType: "reviewer",
				schema: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] },
			});`,
		);
		const result = await run.run(source);

		expect(result.status).toBe("completed");
		// The parent parsed + validated the echoed value.
		expect(result.returnValue).toEqual({ verdict: "pass" });
		// THE FIX: the launch `--tools` allow-list includes the agent's frontmatter
		// tools AND structured_output (else the child could never call the tool).
		const launch = runner.launches[0];
		expect(launch).toBeDefined();
		expect(launch?.tools).toBeDefined();
		expect(new Set(launch?.tools)).toEqual(
			new Set(["read", "bash", "structured_output"]),
		);
		// And the appended system prompt rode through.
		expect(launch?.appendSystemPrompt).toBe("you are a reviewer");
	});

	test("a default (unconstrained) agent keeps tools undefined — all tools enabled", async () => {
		const runner = makeScriptedRunner([{ structured: '{"verdict":"ok"}' }]);
		const run = createWorkflowRun({
			runner,
			parentSessionID: PARENT,
			runId: "run_default",
			// No resolveAgentKnobs → default assistant, no tool constraint.
			readStructured: (taskId, sessionId) =>
				runner.readStructuredFor(taskId, sessionId),
		});
		const source = scriptOf(
			`return await agent("review", {
				schema: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] },
			});`,
		);
		const result = await run.run(source);

		expect(result.returnValue).toEqual({ verdict: "ok" });
		// undefined → pi enables ALL tools (structured_output included); we must NOT
		// materialize a restricting list for an unconstrained agent.
		expect(runner.launches[0]?.tools).toBeUndefined();
		// The recursion-guard composition seam still carries the override map.
		expect(runner.launches[0]?.toolsOverride?.structured_output).toBe(true);
	});

	test("opts.tools union into --tools for a constrained agent", async () => {
		const runner = makeScriptedRunner([{ summaryText: "done" }]);
		const run = createWorkflowRun({
			runner,
			parentSessionID: PARENT,
			runId: "run_optstools",
			resolveAgentKnobs: () => ({
				appendSystemPrompt: "agent",
				tools: ["read"],
			}),
		});
		const source = scriptOf(
			`return await agent("search the web", {
				agentType: "researcher",
				tools: ["web_search", "web_fetch"],
			});`,
		);
		await run.run(source);
		expect(new Set(runner.launches[0]?.tools)).toEqual(
			new Set(["read", "web_search", "web_fetch"]),
		);
	});
});

describe("agent({ schema }) — structured read-back", () => {
	test("schema_no_call earns ONE nudge resume then resolves null", async () => {
		// First read: child never called the tool (undefined). The nudge resume re-reads
		// and STILL gets nothing → null, classified schema_no_call.
		const runner = makeScriptedRunner([{ structured: undefined }]);
		const diagnostics: string[] = [];
		const run = createWorkflowRun({
			runner,
			parentSessionID: PARENT,
			runId: "run_nocall",
			readStructured: (taskId, sessionId) =>
				runner.readStructuredFor(taskId, sessionId),
			onDiagnostic: (d) => diagnostics.push(d.reason),
		});
		const source = scriptOf(
			`return await agent("x", { schema: { type: "object" } });`,
		);
		const result = await run.run(source);

		expect(result.returnValue).toBeNull();
		// Exactly one nudge resume was issued.
		expect(runner.resumes).toHaveLength(1);
		expect(runner.resumes[0]?.prompt).toContain("structured_output");
		expect(diagnostics).toContain("schema_no_call");
	});

	test("a nudge that then yields a valid value resolves it", async () => {
		let calls = 0;
		const runner = makeScriptedRunner([
			{
				// First read empty, second read (after nudge) valid.
				structured: () => {
					calls += 1;
					return calls === 1 ? undefined : '{"n":42}';
				},
			},
		]);
		const run = createWorkflowRun({
			runner,
			parentSessionID: PARENT,
			runId: "run_nudgeok",
			readStructured: (taskId, sessionId) =>
				runner.readStructuredFor(taskId, sessionId),
		});
		const source = scriptOf(
			`return await agent("x", {
				schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
			});`,
		);
		const result = await run.run(source);
		expect(result.returnValue).toEqual({ n: 42 });
		expect(runner.resumes).toHaveLength(1);
	});

	test("an invalid echoed value is rejected parent-side → schema_invalid", async () => {
		// The child echoes a value that violates the schema on BOTH reads.
		const runner = makeScriptedRunner([{ structured: '{"n":"not-a-number"}' }]);
		const reasons: string[] = [];
		const run = createWorkflowRun({
			runner,
			parentSessionID: PARENT,
			runId: "run_invalid",
			readStructured: (taskId, sessionId) =>
				runner.readStructuredFor(taskId, sessionId),
			onDiagnostic: (d) => reasons.push(d.reason),
		});
		const source = scriptOf(
			`return await agent("x", {
				schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
			});`,
		);
		const result = await run.run(source);
		expect(result.returnValue).toBeNull();
		expect(reasons).toContain("schema_invalid");
	});
});

describe("agent({ isolation: 'worktree' }) — mint/merge", () => {
	test("mint → clean merge → cleanup, result passes through", async () => {
		const runner = makeScriptedRunner([{ summaryText: "isolated work" }]);
		const wt = makeFakeWorktreeManager(); // default: clean merge
		const run = createWorkflowRun({
			runner,
			parentSessionID: PARENT,
			runId: "run_iso",
			worktreeManager: wt,
		});
		const source = scriptOf(
			`return await agent("mutate files", { isolation: "worktree", label: "iso" });`,
		);
		const result = await run.run(source);

		expect(result.status).toBe("completed");
		expect(result.returnValue).toBe("isolated work");
		expect(wt.creates).toHaveLength(1);
		// The mint key folds the unique call index into the label (`<label>-<index>`).
		expect(wt.creates[0]).toEqual({ runId: "run_iso", label: "iso-0" });
		// The minted worktree dir re-rooted the launch (fake mints /wt/<label>-<serial>).
		expect(runner.launches[0]?.directory).toBe("/wt/iso-0-1");
		// A clean merge reclaimed the worktree.
		expect(wt.merges).toHaveLength(1);
		expect(wt.cleanups).toHaveLength(1);
	});

	test("a mint miss degrades to null with worktree_mint_failed (no detonation)", async () => {
		const runner = makeScriptedRunner([{ summaryText: "never used" }]);
		const wt = makeFakeWorktreeManager({ createReturns: null });
		const reasons: string[] = [];
		const run = createWorkflowRun({
			runner,
			parentSessionID: PARENT,
			runId: "run_mintmiss",
			worktreeManager: wt,
			onDiagnostic: (d) => reasons.push(d.reason),
		});
		const source = scriptOf(
			`return await agent("mutate", { isolation: "worktree", label: "m" });`,
		);
		const result = await run.run(source);

		expect(result.status).toBe("completed"); // the run did not detonate
		expect(result.returnValue).toBeNull();
		expect(reasons).toContain("worktree_mint_failed");
		// No child launched (degrade is pre-launch).
		expect(runner.launches).toHaveLength(0);
	});

	test("a merge conflict yields a first-class {status:'conflict'} result, worktree preserved", async () => {
		const runner = makeScriptedRunner([{ summaryText: "work" }]);
		const wt = makeFakeWorktreeManager({
			mergeOutcome: {
				conflict: true,
				branch: "wf/run_conf/c-0-1",
				files: ["src/a.ts"],
				baseRef: "base123",
			},
		});
		const run = createWorkflowRun({
			runner,
			parentSessionID: PARENT,
			runId: "run_conf",
			worktreeManager: wt,
		});
		const source = scriptOf(
			`return await agent("mutate", { isolation: "worktree", label: "c" });`,
		);
		const result = await run.run(source);

		expect(result.returnValue).toMatchObject({
			status: "conflict",
			files: ["src/a.ts"],
		});
		// Conflict preserves the worktree: NO cleanup.
		expect(wt.cleanups).toHaveLength(0);
	});
});

describe("progress emission order", () => {
	test("start → launched → end fire in order with the bound sessionID", async () => {
		const runner = makeScriptedRunner([{ summaryText: "r" }]);
		const events: ProgressEvent[] = [];
		const run = createWorkflowRun({
			runner,
			parentSessionID: PARENT,
			runId: "run_order",
			onProgress: (e) => events.push(e),
		});
		await run.run(scriptOf(`return await agent("go", { label: "g" });`));

		const types = events
			.filter(
				(e) =>
					e.type === "agent:start" ||
					e.type === "agent:launched" ||
					e.type === "agent:end",
			)
			.map((e) => e.type);
		expect(types).toEqual(["agent:start", "agent:launched", "agent:end"]);
		const launched = events.find((e) => e.type === "agent:launched") as {
			sessionID: string;
		};
		const end = events.find((e) => e.type === "agent:end") as {
			sessionID?: string;
		};
		expect(launched.sessionID).toBe("sess_0");
		expect(end.sessionID).toBe("sess_0");
	});
});
