import { describe, expect, test } from "bun:test";
import type { BgTask, Clock, SessionRunner, TaskStatus } from "@drawers/core";
import type { ToolContext } from "@opencode-ai/plugin";
import { createBgListTool } from "./list";

function makeRunner(list: (parent?: string) => BgTask[]): SessionRunner {
	const notImpl = (name: string) => () => {
		throw new Error(`unexpected call: ${name}`);
	};
	return {
		launch: notImpl("launch") as SessionRunner["launch"],
		awaitCompletion: notImpl(
			"awaitCompletion",
		) as SessionRunner["awaitCompletion"],
		cancel: notImpl("cancel") as SessionRunner["cancel"],
		resume: notImpl("resume") as SessionRunner["resume"],
		readOutput: notImpl("readOutput") as SessionRunner["readOutput"],
		list,
		handleEvent: notImpl("handleEvent") as SessionRunner["handleEvent"],
		dispose: notImpl("dispose") as SessionRunner["dispose"],
	};
}

function makeContext(): ToolContext {
	return {
		sessionID: "ses_parent",
		messageID: "msg_1",
		agent: "build",
		directory: "/tmp",
		worktree: "/tmp",
		abort: new AbortController().signal,
		metadata: () => undefined,
		ask: async () => undefined,
	};
}

function task(
	id: string,
	status: TaskStatus,
	overrides: Partial<BgTask> = {},
): BgTask {
	return {
		id,
		parentSessionID: "ses_parent",
		description: `task ${id}`,
		agent: "build",
		status,
		createdAt: 0,
		depth: 0,
		concurrencyKey: "k",
		...overrides,
	};
}

const fixedClock: Clock = { now: () => 100_000 };

async function run(
	tool: ReturnType<typeof createBgListTool>,
	ctx: ToolContext,
): Promise<string> {
	const res = await tool.execute({}, ctx);
	return typeof res === "string" ? res : res.output;
}

describe("createBgListTool", () => {
	test("empty list returns the no-tasks message", async () => {
		const runner = makeRunner((parent) => {
			expect(parent).toBe("ses_parent");
			return [];
		});
		const tool = createBgListTool(runner, fixedClock);
		const out = await run(tool, makeContext());
		expect(out).toContain("no background tasks for this session");
	});

	test("renders one line per task with id, status, description", async () => {
		const runner = makeRunner(() => [
			task("bg_a", "running", { createdAt: 90_000, startedAt: 95_000 }),
			task("bg_b", "completed", {
				createdAt: 80_000,
				startedAt: 81_000,
				completedAt: 99_000,
			}),
		]);
		const tool = createBgListTool(runner, fixedClock);
		const out = await run(tool, makeContext());
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
		const runner = makeRunner(() => [
			task("bg_long", "running", {
				description: longDesc,
				createdAt: 99_000,
				startedAt: 99_000,
			}),
		]);
		const tool = createBgListTool(runner, fixedClock);
		const out = await run(tool, makeContext());
		const line = out.split("\n").find((l) => l.includes("bg_long")) ?? "";
		// full 200-char description must not be present verbatim
		expect(line).not.toContain(longDesc);
		expect(line).toContain("…");
		// truncated body stays at or below the cap (plus the ellipsis)
		const xRun = line.match(/x+/)?.[0] ?? "";
		expect(xRun.length).toBeLessThanOrEqual(60);
	});

	test("computes duration for a completed task and age for a running task", async () => {
		const runner = makeRunner(() => [
			// completed: duration = completedAt - startedAt = 18s
			task("bg_done", "completed", {
				createdAt: 60_000,
				startedAt: 62_000,
				completedAt: 80_000,
			}),
			// running: age from startedAt to now = 100000 - 90000 = 10s
			task("bg_run", "running", {
				createdAt: 88_000,
				startedAt: 90_000,
			}),
		]);
		const tool = createBgListTool(runner, fixedClock);
		const out = await run(tool, makeContext());
		expect(out).toContain("18s");
		expect(out).toContain("10s");
	});
});
