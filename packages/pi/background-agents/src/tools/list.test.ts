/**
 * Unit tests for `bg_list`. A fixed {@link Clock} makes the age/duration
 * rendering deterministic. Scenarios ported from the opencode suite.
 */

import { describe, expect, test } from "bun:test";
import type { BgTask, Clock, TaskStatus } from "@drawers/pi-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { makeFakeContext, makeScriptedRunner } from "../test-fakes";
import { createBgListTool } from "./list";

const NOOP_UPDATE = undefined;
const fixedClock: Clock = { now: () => 100_000 };

function task(
	id: string,
	status: TaskStatus,
	over: Partial<BgTask> = {},
): BgTask {
	return {
		id,
		parentSessionID: "parent_1",
		description: `task ${id}`,
		agent: "build",
		status,
		createdAt: 0,
		depth: 0,
		concurrencyKey: "k",
		...over,
	};
}

async function run(
	tool: ReturnType<typeof createBgListTool>,
	ctx: ExtensionContext,
): Promise<string> {
	const res = await tool.execute("call_1", {}, undefined, NOOP_UPDATE, ctx);
	return res.content.map((c) => ("text" in c ? c.text : "")).join("");
}

describe("bg_list", () => {
	test("empty list returns the no-tasks message; list filtered by parent", async () => {
		const runner = makeScriptedRunner({ listTasks: [] });
		const tool = createBgListTool(
			() => runner,
			() => "parent_1",
			fixedClock,
		);
		const { ctx } = makeFakeContext();
		const out = await run(tool, ctx);
		expect(out).toContain("no background tasks for this session");
	});

	test("renders one line per task with id, status, description", async () => {
		const runner = makeScriptedRunner({
			listTasks: [
				task("bg_a", "running", { createdAt: 90_000, startedAt: 95_000 }),
				task("bg_b", "completed", {
					createdAt: 80_000,
					startedAt: 81_000,
					completedAt: 99_000,
				}),
			],
		});
		const tool = createBgListTool(
			() => runner,
			() => "parent_1",
			fixedClock,
		);
		const { ctx } = makeFakeContext();
		const out = await run(tool, ctx);
		const lines = out.split("\n").filter((l) => l.includes("bg_"));
		expect(lines.length).toBe(2);
		expect(out).toContain("bg_a");
		expect(out).toContain("running");
		expect(out).toContain("bg_b");
		expect(out).toContain("completed");
		expect(out).toContain("task bg_a");
	});

	test("truncates a long description to ~60 chars with an ellipsis", async () => {
		const longDesc = "x".repeat(200);
		const runner = makeScriptedRunner({
			listTasks: [
				task("bg_long", "running", {
					description: longDesc,
					createdAt: 99_000,
					startedAt: 99_000,
				}),
			],
		});
		const tool = createBgListTool(
			() => runner,
			() => "parent_1",
			fixedClock,
		);
		const { ctx } = makeFakeContext();
		const out = await run(tool, ctx);
		const line = out.split("\n").find((l) => l.includes("bg_long")) ?? "";
		expect(line).not.toContain(longDesc);
		expect(line).toContain("…");
		const xRun = line.match(/x+/)?.[0] ?? "";
		expect(xRun.length).toBeLessThanOrEqual(60);
	});

	test("duration for a completed task, age for a running task", async () => {
		const runner = makeScriptedRunner({
			listTasks: [
				task("bg_done", "completed", {
					createdAt: 60_000,
					startedAt: 62_000,
					completedAt: 80_000,
				}),
				task("bg_run", "running", { createdAt: 88_000, startedAt: 90_000 }),
			],
		});
		const tool = createBgListTool(
			() => runner,
			() => "parent_1",
			fixedClock,
		);
		const { ctx } = makeFakeContext();
		const out = await run(tool, ctx);
		expect(out).toContain("18s (done)");
		expect(out).toContain("10s (age)");
	});

	test("minutes formatting for long-running durations", async () => {
		const runner = makeScriptedRunner({
			listTasks: [
				task("bg_long", "completed", {
					createdAt: 0,
					startedAt: 0,
					completedAt: 125_000,
				}),
			],
		});
		const tool = createBgListTool(
			() => runner,
			() => "parent_1",
			fixedClock,
		);
		const { ctx } = makeFakeContext();
		const out = await run(tool, ctx);
		expect(out).toContain("2m05s (done)");
	});
});
