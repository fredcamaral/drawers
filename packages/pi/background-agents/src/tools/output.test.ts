/**
 * Unit tests for `bg_output`. Scripted SessionRunner; the abort source is the
 * `signal` execute param (pi) rather than `ctx.abort` (opencode). Scenarios
 * ported from the opencode suite: block timeout, NaN/omitted timeout coercion,
 * abort-wins + listener cleanup, full-transcript render, unknown id.
 */

import { describe, expect, test } from "bun:test";
import type { BgTask, ReadOpts, TaskOutput } from "@drawers/pi-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { makeFakeContext, makeScriptedRunner } from "../test-fakes";
import { createBgOutputTool } from "./output";

const NOOP_UPDATE = undefined;

function completedTask(): BgTask {
	return {
		id: "bg_x",
		parentSessionID: "parent_1",
		description: "d",
		agent: "build",
		status: "completed",
		createdAt: 1,
		depth: 0,
		concurrencyKey: "k",
	};
}

async function run(
	tool: ReturnType<typeof createBgOutputTool>,
	params: Record<string, unknown>,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<string> {
	const res = await tool.execute(
		"call_1",
		// biome-ignore lint/suspicious/noExplicitAny: schema-typed params from tests.
		params as any,
		signal,
		NOOP_UPDATE,
		ctx,
	);
	return res.content.map((c) => ("text" in c ? c.text : "")).join("");
}

describe("bg_output", () => {
	test("block timeout → honest still-running string, not a throw", async () => {
		const runner = makeScriptedRunner({
			onAwaitCompletion: async (_id, timeoutMs) => {
				throw new Error(`awaitCompletion timeout after ${timeoutMs}ms: bg_x`);
			},
		});
		const tool = createBgOutputTool(() => runner);
		const { ctx } = makeFakeContext();
		const out = await run(
			tool,
			{ task_id: "bg_x", block: true, timeout_ms: 1234 },
			undefined,
			ctx,
		);
		expect(out).toContain("still running after 1234ms");
		expect(out).toContain("do not");
	});

	test("omitted timeout_ms forwards the 60s default (not NaN) to awaitCompletion", async () => {
		let seen: number | undefined;
		const runner = makeScriptedRunner({
			onAwaitCompletion: async (_id, timeoutMs) => {
				seen = timeoutMs;
				return completedTask();
			},
			onReadOutput: async () => ({ status: "completed", summaryText: "ok" }),
		});
		const tool = createBgOutputTool(() => runner);
		const { ctx } = makeFakeContext();
		await run(tool, { task_id: "bg_x", block: true }, undefined, ctx);
		expect(seen).toBe(60_000);
		expect(Number.isNaN(seen)).toBe(false);
	});

	test("explicit NaN timeout_ms coerced to the default", async () => {
		let seen: number | undefined;
		const runner = makeScriptedRunner({
			onAwaitCompletion: async (_id, timeoutMs) => {
				seen = timeoutMs;
				return completedTask();
			},
			onReadOutput: async () => ({ status: "completed", summaryText: "ok" }),
		});
		const tool = createBgOutputTool(() => runner);
		const { ctx } = makeFakeContext();
		await run(
			tool,
			{ task_id: "bg_x", block: true, timeout_ms: Number.NaN },
			undefined,
			ctx,
		);
		expect(seen).toBe(60_000);
	});

	test("timeout_ms above the cap is clamped to 300000", async () => {
		let seen: number | undefined;
		const runner = makeScriptedRunner({
			onAwaitCompletion: async (_id, timeoutMs) => {
				seen = timeoutMs;
				return completedTask();
			},
			onReadOutput: async () => ({ status: "completed", summaryText: "ok" }),
		});
		const tool = createBgOutputTool(() => runner);
		const { ctx } = makeFakeContext();
		await run(
			tool,
			{ task_id: "bg_x", block: true, timeout_ms: 9_999_999 },
			undefined,
			ctx,
		);
		expect(seen).toBe(300_000);
	});

	test("abort fired mid-wait wins the race and removes its listener (no leak)", async () => {
		const controller = new AbortController();
		let listenerCount = 0;
		const realAdd = controller.signal.addEventListener.bind(controller.signal);
		const realRemove = controller.signal.removeEventListener.bind(
			controller.signal,
		);
		controller.signal.addEventListener = ((
			type: string,
			cb: EventListenerOrEventListenerObject,
			o?: boolean | AddEventListenerOptions,
		) => {
			if (type === "abort") listenerCount += 1;
			return realAdd(type, cb, o);
		}) as typeof controller.signal.addEventListener;
		controller.signal.removeEventListener = ((
			type: string,
			cb: EventListenerOrEventListenerObject,
			o?: boolean | EventListenerOptions,
		) => {
			if (type === "abort") listenerCount -= 1;
			return realRemove(type, cb, o);
		}) as typeof controller.signal.removeEventListener;

		const runner = makeScriptedRunner({
			onAwaitCompletion: () => new Promise<BgTask>(() => undefined),
		});
		const tool = createBgOutputTool(() => runner);
		const { ctx } = makeFakeContext();
		const p = run(
			tool,
			{ task_id: "bg_x", block: true },
			controller.signal,
			ctx,
		);
		queueMicrotask(() => controller.abort());
		const out = await p;
		expect(out).toContain("wait cancelled");
		expect(listenerCount).toBe(0);
	});

	test("already-aborted signal bails before awaiting", async () => {
		const controller = new AbortController();
		controller.abort();
		const runner = makeScriptedRunner({
			onAwaitCompletion: async () => {
				throw new Error("must not await when pre-aborted");
			},
		});
		const tool = createBgOutputTool(() => runner);
		const { ctx } = makeFakeContext();
		const out = await run(
			tool,
			{ task_id: "bg_x", block: true },
			controller.signal,
			ctx,
		);
		expect(out).toContain("wait cancelled");
	});

	test("block success: awaits, then reads and formats status + summary", async () => {
		let awaited = false;
		const runner = makeScriptedRunner({
			onAwaitCompletion: async () => {
				awaited = true;
				return completedTask();
			},
			onReadOutput: async (_id, opts?: ReadOpts) => {
				expect(opts?.full ?? false).toBe(false);
				return { status: "completed", summaryText: "the answer is 42" };
			},
		});
		const tool = createBgOutputTool(() => runner);
		const { ctx } = makeFakeContext();
		const out = await run(
			tool,
			{ task_id: "bg_x", block: true },
			undefined,
			ctx,
		);
		expect(awaited).toBe(true);
		expect(out).toContain("completed");
		expect(out).toContain("the answer is 42");
	});

	test("full transcript appends the fenced filtered transcript", async () => {
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
		const runner = makeScriptedRunner({
			onReadOutput: async (_id, opts?: ReadOpts) => {
				expect(opts?.full).toBe(true);
				return result;
			},
		});
		const tool = createBgOutputTool(() => runner);
		const { ctx } = makeFakeContext();
		const out = await run(
			tool,
			{ task_id: "bg_x", full: true },
			undefined,
			ctx,
		);
		expect(out).toContain("summary line");
		expect(out).toContain("```");
		expect(out).toContain("ask");
		expect(out).toContain("reply");
		expect(out).toContain("tool output");
	});

	test("full transcript with undefined-text part: no literal 'undefined', head-only on empty summary", async () => {
		const result: TaskOutput = {
			status: "completed",
			summaryText: "",
			messages: [
				{
					role: "assistant",
					parts: [
						{ type: "text", text: "visible" },
						{ type: "tool", text: undefined as unknown as string },
					],
				},
			],
		};
		const runner = makeScriptedRunner({ onReadOutput: async () => result });
		const tool = createBgOutputTool(() => runner);
		const { ctx } = makeFakeContext();
		const out = await run(
			tool,
			{ task_id: "bg_x", full: true },
			undefined,
			ctx,
		);
		expect(out).toContain("visible");
		expect(out).not.toContain("undefined");
		expect(out.startsWith("task bg_x — completed\n\nfull transcript:")).toBe(
			true,
		);
	});

	test("unknown id (runner throws) → honest error string, no fake success", async () => {
		const runner = makeScriptedRunner({
			onReadOutput: async () => {
				throw new Error("Unknown task: bg_missing");
			},
		});
		const tool = createBgOutputTool(() => runner);
		const { ctx } = makeFakeContext();
		const out = await run(tool, { task_id: "bg_missing" }, undefined, ctx);
		expect(out.toLowerCase()).toContain("unknown task");
		expect(out).not.toContain("completed");
	});

	test("no block: reads directly without awaiting", async () => {
		const runner = makeScriptedRunner({
			onReadOutput: async () => ({
				status: "running",
				summaryText: "in progress",
			}),
		});
		const tool = createBgOutputTool(() => runner);
		const { ctx } = makeFakeContext();
		const out = await run(tool, { task_id: "bg_x" }, undefined, ctx);
		expect(out).toContain("running");
		expect(out).toContain("in progress");
	});

	test("missing task_id → readable error", async () => {
		const runner = makeScriptedRunner();
		const tool = createBgOutputTool(() => runner);
		const { ctx } = makeFakeContext();
		const out = await run(tool, {}, undefined, ctx);
		expect(out.toLowerCase()).toContain("task_id");
	});
});
