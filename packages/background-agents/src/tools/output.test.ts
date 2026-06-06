import { describe, expect, test } from "bun:test";
import type {
	BgTask,
	ReadOpts,
	SessionRunner,
	TaskOutput,
} from "@drawers/core";
import type { ToolContext } from "@opencode-ai/plugin";
import { createBgOutputTool } from "./output";

/**
 * A scripted fake SessionRunner. Only the methods bg_output touches are wired;
 * the rest throw so an accidental dependency surfaces loudly.
 */
type RunnerOverrides = Partial<
	Pick<SessionRunner, "awaitCompletion" | "readOutput" | "list">
>;

function makeRunner(overrides: RunnerOverrides): SessionRunner {
	const notImpl = (name: string) => () => {
		throw new Error(`unexpected call: ${name}`);
	};
	return {
		launch: notImpl("launch"),
		awaitCompletion:
			overrides.awaitCompletion ??
			(notImpl("awaitCompletion") as SessionRunner["awaitCompletion"]),
		cancel: notImpl("cancel") as SessionRunner["cancel"],
		resume: notImpl("resume") as SessionRunner["resume"],
		readOutput:
			overrides.readOutput ??
			(notImpl("readOutput") as SessionRunner["readOutput"]),
		list: overrides.list ?? (notImpl("list") as SessionRunner["list"]),
		handleEvent: notImpl("handleEvent") as SessionRunner["handleEvent"],
		dispose: notImpl("dispose") as SessionRunner["dispose"],
	};
}

/** A ToolContext stub exposing only what bg_output reads (sessionID, abort). */
function makeContext(abort?: AbortSignal): ToolContext {
	return {
		sessionID: "ses_parent",
		messageID: "msg_1",
		agent: "build",
		directory: "/tmp",
		worktree: "/tmp",
		abort: abort ?? new AbortController().signal,
		metadata: () => undefined,
		ask: async () => undefined,
	};
}

async function run(
	tool: ReturnType<typeof createBgOutputTool>,
	args: Record<string, unknown>,
	ctx: ToolContext,
): Promise<string> {
	// biome-ignore lint/suspicious/noExplicitAny: schema-typed args supplied by tests.
	const res = await tool.execute(args as any, ctx);
	return typeof res === "string" ? res : res.output;
}

describe("createBgOutputTool", () => {
	test("block-timeout path returns honest still-running string, not a throw", async () => {
		const runner = makeRunner({
			awaitCompletion: async (_id, timeoutMs) => {
				throw new Error(`awaitCompletion timeout after ${timeoutMs}ms: bg_x`);
			},
		});
		const tool = createBgOutputTool(runner);
		const out = await run(
			tool,
			{ task_id: "bg_x", block: true, timeout_ms: 1234 },
			makeContext(),
		);
		expect(out).toContain("still running after 1234ms");
		expect(out).toContain("do not retry");
	});

	test("block-abort path: abort fired mid-wait wins the race and removes its listener", async () => {
		const controller = new AbortController();
		let listenerCount = 0;
		const realAdd = controller.signal.addEventListener.bind(controller.signal);
		const realRemove = controller.signal.removeEventListener.bind(
			controller.signal,
		);
		controller.signal.addEventListener = ((
			type: string,
			cb: EventListenerOrEventListenerObject,
			opts?: boolean | AddEventListenerOptions,
		) => {
			if (type === "abort") listenerCount += 1;
			return realAdd(type, cb, opts);
		}) as typeof controller.signal.addEventListener;
		controller.signal.removeEventListener = ((
			type: string,
			cb: EventListenerOrEventListenerObject,
			opts?: boolean | EventListenerOptions,
		) => {
			if (type === "abort") listenerCount -= 1;
			return realRemove(type, cb, opts);
		}) as typeof controller.signal.removeEventListener;

		const runner = makeRunner({
			// Never resolves on its own — only the abort can win.
			awaitCompletion: () => new Promise<BgTask>(() => undefined),
		});
		const tool = createBgOutputTool(runner);
		const p = run(
			tool,
			{ task_id: "bg_x", block: true },
			makeContext(controller.signal),
		);
		// Fire abort on the next tick, mid-wait.
		queueMicrotask(() => controller.abort());
		const out = await p;
		expect(out).toContain("wait cancelled");
		// No leaked listener: added then removed exactly.
		expect(listenerCount).toBe(0);
	});

	test("block-abort path: already-aborted signal bails before awaiting", async () => {
		const controller = new AbortController();
		controller.abort();
		const runner = makeRunner({
			awaitCompletion: () => {
				throw new Error("awaitCompletion must not be called when pre-aborted");
			},
		});
		const tool = createBgOutputTool(runner);
		const out = await run(
			tool,
			{ task_id: "bg_x", block: true },
			makeContext(controller.signal),
		);
		expect(out).toContain("wait cancelled");
	});

	test("block-success path: awaits, then reads and formats status + summary", async () => {
		let awaited = false;
		const task: BgTask = {
			id: "bg_x",
			parentSessionID: "ses_parent",
			description: "do the thing",
			agent: "build",
			status: "completed",
			createdAt: 1,
			depth: 0,
			concurrencyKey: "k",
		};
		const runner = makeRunner({
			awaitCompletion: async () => {
				awaited = true;
				return task;
			},
			readOutput: async (_id, opts?: ReadOpts) => {
				expect(opts?.full ?? false).toBe(false);
				return { status: "completed", summaryText: "the answer is 42" };
			},
		});
		const tool = createBgOutputTool(runner);
		const out = await run(
			tool,
			{ task_id: "bg_x", block: true },
			makeContext(),
		);
		expect(awaited).toBe(true);
		expect(out).toContain("completed");
		expect(out).toContain("the answer is 42");
	});

	test("full-transcript rendering appends the fenced filtered transcript", async () => {
		const result: TaskOutput = {
			status: "completed",
			summaryText: "summary line",
			messages: [
				{ role: "user", parts: [{ type: "text", text: "ask" }] },
				{
					role: "assistant",
					parts: [
						{ type: "text", text: "reply" },
						{ type: "tool", text: "tool output" },
					],
				},
			],
		};
		const runner = makeRunner({
			readOutput: async (_id, opts?: ReadOpts) => {
				expect(opts?.full).toBe(true);
				return result;
			},
		});
		const tool = createBgOutputTool(runner);
		const out = await run(tool, { task_id: "bg_x", full: true }, makeContext());
		expect(out).toContain("summary line");
		expect(out).toContain("```");
		expect(out).toContain("ask");
		expect(out).toContain("reply");
		expect(out).toContain("tool output");
	});

	test("unknown task id (runner throws) returns an honest error string", async () => {
		const runner = makeRunner({
			readOutput: async () => {
				throw new Error("Unknown task: bg_missing");
			},
		});
		const tool = createBgOutputTool(runner);
		const out = await run(tool, { task_id: "bg_missing" }, makeContext());
		expect(out.toLowerCase()).toContain("unknown task");
		// honest, not a fake success
		expect(out).not.toContain("completed");
	});

	test("no block: reads directly without awaiting completion", async () => {
		const runner = makeRunner({
			readOutput: async () => ({
				status: "running",
				summaryText: "in progress",
			}),
		});
		const tool = createBgOutputTool(runner);
		const out = await run(tool, { task_id: "bg_x" }, makeContext());
		expect(out).toContain("running");
		expect(out).toContain("in progress");
	});
});
