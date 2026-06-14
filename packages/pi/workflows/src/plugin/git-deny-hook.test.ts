/**
 * Tests for the `tool_call` git-deny hook (the §0.3 kill switch) and the
 * `structured_output` child tool (the pi read-back echo).
 *
 * The git-deny hook discriminates a worker child by `ctx.mode === "rpc"` (pi gives
 * the hook no sessionID), so the tests drive it with synthetic `ToolCallEvent`s and
 * a structural ctx carrying just `mode`.
 */

import { describe, expect, test } from "bun:test";
import type {
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import {
	createStructuredOutputTool,
	STRUCTURED_OUTPUT_TOOL_NAME,
} from "../runtime/structured/tool";
import { createGitDenyHook } from "./git-deny-hook";

/** A structural ExtensionContext carrying only the `mode` the hook reads. */
function ctxWithMode(mode: "rpc" | "tui" | "json" | "print"): ExtensionContext {
	return { mode } as unknown as ExtensionContext;
}

function bashEvent(command: string): ToolCallEvent {
	return {
		type: "tool_call",
		toolCallId: "tc1",
		toolName: "bash",
		input: { command },
	} as ToolCallEvent;
}

describe("git-deny hook", () => {
	const hook = createGitDenyHook();

	test("blocks destructive git in a worker child (rpc mode)", () => {
		const res = hook(bashEvent("git reset --hard HEAD"), ctxWithMode("rpc"));
		expect(res).toBeDefined();
		expect(res?.block).toBe(true);
		expect(res?.reason).toContain("destructive git");
	});

	test("blocks git restore / checkout -- / stash / clean in rpc mode", () => {
		for (const cmd of [
			"git restore src/x.ts",
			"git checkout -- .",
			"git stash",
			"git clean -fd",
		]) {
			const res = hook(bashEvent(cmd), ctxWithMode("rpc"));
			expect(res?.block).toBe(true);
		}
	});

	test("does NOT block in tui mode (the parent's own git is the user's action)", () => {
		expect(
			hook(bashEvent("git reset --hard HEAD"), ctxWithMode("tui")),
		).toBeUndefined();
	});

	test("does NOT block a non-destructive git (commit) even in rpc mode", () => {
		expect(
			hook(bashEvent("git commit -m wip"), ctxWithMode("rpc")),
		).toBeUndefined();
	});

	test("ignores non-bash tools", () => {
		const readEvent = {
			type: "tool_call",
			toolCallId: "tc2",
			toolName: "read",
			input: { path: "x" },
		} as ToolCallEvent;
		expect(hook(readEvent, ctxWithMode("rpc"))).toBeUndefined();
	});
});

describe("structured_output tool — echo + terminate", () => {
	const tool = createStructuredOutputTool();
	const ctx = {} as unknown as ExtensionContext;

	test("echoes a JSON string verbatim as content text and terminates the turn", async () => {
		const raw = '{"verdict":"pass","score":7}';
		const res = await tool.execute(
			"tc",
			{ result: raw },
			undefined,
			undefined,
			ctx,
		);
		expect(res.terminate).toBe(true);
		expect(res.content).toEqual([{ type: "text", text: raw }]);
	});

	test("coerces a non-string result to a JSON string (defensive)", async () => {
		// A model may hand an object despite the declared string arg.
		const res = await tool.execute(
			"tc",
			{ result: { a: 1 } as unknown as string },
			undefined,
			undefined,
			ctx,
		);
		expect(res.content?.[0]).toEqual({ type: "text", text: '{"a":1}' });
		expect(res.terminate).toBe(true);
	});

	test("the tool name is the read-back marker the parent scans for", () => {
		expect(tool.name).toBe(STRUCTURED_OUTPUT_TOOL_NAME);
		expect(STRUCTURED_OUTPUT_TOOL_NAME).toBe("structured_output");
	});
});
