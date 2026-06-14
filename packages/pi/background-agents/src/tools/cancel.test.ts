/**
 * Unit tests for `bg_cancel`. Scripted runner; the pi factory binds
 * `getParentSessionID` so `all` filters this session's non-terminal tasks.
 * Scenarios ported from the opencode suite.
 */

import { describe, expect, test } from "bun:test";
import type { BgTask, TaskStatus } from "@drawers/pi-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { makeFakeContext, makeScriptedRunner } from "../test-fakes";
import { createBgCancelTool } from "./cancel";

const NOOP_UPDATE = undefined;

function task(id: string, status: TaskStatus): BgTask {
	return {
		id,
		parentSessionID: "parent_1",
		description: `task ${id}`,
		agent: "build",
		status,
		createdAt: 1,
		depth: 0,
		concurrencyKey: "k",
	};
}

async function run(
	tool: ReturnType<typeof createBgCancelTool>,
	params: Record<string, unknown>,
	ctx: ExtensionContext,
): Promise<string> {
	const res = await tool.execute(
		"call_1",
		// biome-ignore lint/suspicious/noExplicitAny: schema-typed params from tests.
		params as any,
		undefined,
		NOOP_UPDATE,
		ctx,
	);
	return res.content.map((c) => ("text" in c ? c.text : "")).join("");
}

describe("bg_cancel", () => {
	test("task_id only: cancels the single task and reports its status", async () => {
		const runner = makeScriptedRunner({
			onCancel: async (id) => task(id, "cancelled"),
		});
		const tool = createBgCancelTool(
			() => runner,
			() => "parent_1",
		);
		const { ctx } = makeFakeContext();
		const out = await run(tool, { task_id: "bg_a" }, ctx);
		expect(runner.cancelled).toEqual(["bg_a"]);
		expect(out).toContain("bg_a");
		expect(out).toContain("cancelled");
	});

	test("all: cancels every non-terminal task of this session, terminal untouched", async () => {
		const runner = makeScriptedRunner({
			listTasks: [
				task("bg_run", "running"),
				task("bg_pend", "pending"),
				task("bg_done", "completed"),
				task("bg_err", "error"),
			],
			onCancel: async (id) => task(id, "cancelled"),
		});
		const tool = createBgCancelTool(
			() => runner,
			() => "parent_1",
		);
		const { ctx } = makeFakeContext();
		const out = await run(tool, { all: true }, ctx);
		expect(runner.cancelled.sort()).toEqual(["bg_pend", "bg_run"]);
		expect(out).toContain("bg_run");
		expect(out).toContain("bg_pend");
		expect(out).not.toContain("bg_done");
	});

	test("all: one cancel throws, the rest succeed — both reported, count covers all attempted", async () => {
		const runner = makeScriptedRunner({
			listTasks: [task("bg_run", "running"), task("bg_pend", "pending")],
			onCancel: async (id) => {
				if (id === "bg_pend") throw new Error("backend unavailable");
				return task(id, "cancelled");
			},
		});
		const tool = createBgCancelTool(
			() => runner,
			() => "parent_1",
		);
		const { ctx } = makeFakeContext();
		const out = await run(tool, { all: true }, ctx);
		expect(out).toContain("bg_run");
		expect(out).toContain("cancelled");
		expect(out).toContain("bg_pend");
		expect(out).toContain("error: backend unavailable");
		expect(out).toContain("2 task(s)");
	});

	test("both task_id and all set → readable XOR error, no cancel", async () => {
		const runner = makeScriptedRunner({
			onCancel: async () => {
				throw new Error("must not cancel when args invalid");
			},
		});
		const tool = createBgCancelTool(
			() => runner,
			() => "parent_1",
		);
		const { ctx } = makeFakeContext();
		const out = await run(tool, { task_id: "bg_a", all: true }, ctx);
		expect(out.toLowerCase()).toContain("exactly one");
	});

	test("neither task_id nor all → readable XOR error, no cancel", async () => {
		const runner = makeScriptedRunner({
			onCancel: async () => {
				throw new Error("must not cancel when args invalid");
			},
		});
		const tool = createBgCancelTool(
			() => runner,
			() => "parent_1",
		);
		const { ctx } = makeFakeContext();
		const out = await run(tool, {}, ctx);
		expect(out.toLowerCase()).toContain("exactly one");
	});

	test("all with zero non-terminal → nothing to cancel", async () => {
		const runner = makeScriptedRunner({
			listTasks: [task("bg_done", "completed"), task("bg_err", "error")],
			onCancel: async () => {
				throw new Error("must not cancel terminal tasks");
			},
		});
		const tool = createBgCancelTool(
			() => runner,
			() => "parent_1",
		);
		const { ctx } = makeFakeContext();
		const out = await run(tool, { all: true }, ctx);
		expect(out.toLowerCase()).toContain("nothing to cancel");
	});

	test("single terminal task no-op reflects current state honestly", async () => {
		const runner = makeScriptedRunner({
			onCancel: async (id) => task(id, "completed"),
		});
		const tool = createBgCancelTool(
			() => runner,
			() => "parent_1",
		);
		const { ctx } = makeFakeContext();
		const out = await run(tool, { task_id: "bg_done" }, ctx);
		expect(out).toContain("bg_done");
		expect(out).toContain("completed");
	});

	test("single unknown task (runner throws) → honest per-task error string", async () => {
		const runner = makeScriptedRunner({
			onCancel: async () => {
				throw new Error("Unknown task: bg_missing");
			},
		});
		const tool = createBgCancelTool(
			() => runner,
			() => "parent_1",
		);
		const { ctx } = makeFakeContext();
		const out = await run(tool, { task_id: "bg_missing" }, ctx);
		expect(out.toLowerCase()).toContain("unknown task");
	});
});
