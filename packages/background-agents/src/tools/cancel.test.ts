import { describe, expect, test } from "bun:test";
import type { BgTask, SessionRunner, TaskStatus } from "@drawers/core";
import type { ToolContext } from "@opencode-ai/plugin";
import { createBgCancelTool } from "./cancel";

type RunnerOverrides = Partial<Pick<SessionRunner, "cancel" | "list">>;

function makeRunner(overrides: RunnerOverrides): SessionRunner {
	const notImpl = (name: string) => () => {
		throw new Error(`unexpected call: ${name}`);
	};
	return {
		launch: notImpl("launch") as SessionRunner["launch"],
		awaitCompletion: notImpl(
			"awaitCompletion",
		) as SessionRunner["awaitCompletion"],
		cancel: overrides.cancel ?? (notImpl("cancel") as SessionRunner["cancel"]),
		resume: notImpl("resume") as SessionRunner["resume"],
		readOutput: notImpl("readOutput") as SessionRunner["readOutput"],
		list: overrides.list ?? (notImpl("list") as SessionRunner["list"]),
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

function task(id: string, status: TaskStatus): BgTask {
	return {
		id,
		parentSessionID: "ses_parent",
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
	args: Record<string, unknown>,
	ctx: ToolContext,
): Promise<string> {
	// biome-ignore lint/suspicious/noExplicitAny: schema-typed args supplied by tests.
	const res = await tool.execute(args as any, ctx);
	return typeof res === "string" ? res : res.output;
}

describe("createBgCancelTool", () => {
	test("task_id only: cancels the single task and reports resulting status", async () => {
		let cancelled: string | undefined;
		const runner = makeRunner({
			cancel: async (id) => {
				cancelled = id;
				return task(id, "cancelled");
			},
		});
		const tool = createBgCancelTool(runner);
		const out = await run(tool, { task_id: "bg_a" }, makeContext());
		expect(cancelled).toBe("bg_a");
		expect(out).toContain("bg_a");
		expect(out).toContain("cancelled");
	});

	test("all only: cancels every non-terminal task, reports per-task outcomes", async () => {
		const cancelledIds: string[] = [];
		const runner = makeRunner({
			list: (parent) => {
				expect(parent).toBe("ses_parent");
				return [
					task("bg_run", "running"),
					task("bg_pend", "pending"),
					task("bg_done", "completed"),
					task("bg_err", "error"),
				];
			},
			cancel: async (id) => {
				cancelledIds.push(id);
				return task(id, "cancelled");
			},
		});
		const tool = createBgCancelTool(runner);
		const out = await run(tool, { all: true }, makeContext());
		// Only non-terminal tasks get cancelled.
		expect(cancelledIds.sort()).toEqual(["bg_pend", "bg_run"]);
		expect(out).toContain("bg_run");
		expect(out).toContain("bg_pend");
		// Terminal tasks are not touched.
		expect(out).not.toContain("bg_done");
	});

	test("both task_id and all set: error string, no cancel calls", async () => {
		const runner = makeRunner({
			cancel: () => {
				throw new Error("must not cancel when args are invalid");
			},
		});
		const tool = createBgCancelTool(runner);
		const out = await run(tool, { task_id: "bg_a", all: true }, makeContext());
		expect(out.toLowerCase()).toContain("exactly one");
	});

	test("neither task_id nor all set: error string, no cancel calls", async () => {
		const runner = makeRunner({
			cancel: () => {
				throw new Error("must not cancel when args are invalid");
			},
		});
		const tool = createBgCancelTool(runner);
		const out = await run(tool, {}, makeContext());
		expect(out.toLowerCase()).toContain("exactly one");
	});

	test("all with mixed statuses but zero non-terminal: nothing to cancel", async () => {
		const runner = makeRunner({
			list: () => [task("bg_done", "completed"), task("bg_err", "error")],
			cancel: () => {
				throw new Error("must not cancel terminal tasks");
			},
		});
		const tool = createBgCancelTool(runner);
		const out = await run(tool, { all: true }, makeContext());
		expect(out.toLowerCase()).toContain("nothing to cancel");
	});

	test("single terminal task no-op: reflects current state honestly", async () => {
		const runner = makeRunner({
			// cancel of a terminal task no-ops, returning current state.
			cancel: async (id) => task(id, "completed"),
		});
		const tool = createBgCancelTool(runner);
		const out = await run(tool, { task_id: "bg_done" }, makeContext());
		expect(out).toContain("bg_done");
		expect(out).toContain("completed");
	});

	test("single unknown task (runner throws): honest error string", async () => {
		const runner = makeRunner({
			cancel: async () => {
				throw new Error("Unknown task: bg_missing");
			},
		});
		const tool = createBgCancelTool(runner);
		const out = await run(tool, { task_id: "bg_missing" }, makeContext());
		expect(out.toLowerCase()).toContain("unknown task");
	});
});
