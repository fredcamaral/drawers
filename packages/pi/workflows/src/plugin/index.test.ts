/**
 * Factory wiring test for the workflows extension entry (the pi default export).
 *
 * Asserts the LOAD-TIME contract (gotcha #1): the factory registers its tools and
 * lifecycle handlers synchronously at load, BEFORE any session_start, and a tool
 * invoked before session_start throws a clean "no active session". We do NOT drive
 * session_start (it resolves a spawnable pi cli + builds the real runner — the
 * orchestrator's live smoke covers that path).
 */

import { describe, expect, test } from "bun:test";
import type {
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import workflowsFactory from "./index";

interface CapturedApi {
	api: ExtensionAPI;
	tools: ToolDefinition[];
	events: string[];
}

/** A fake ExtensionAPI that records every registerTool + on(event) at load. */
function captureApi(): CapturedApi {
	const tools: ToolDefinition[] = [];
	const events: string[] = [];
	const api = {
		registerTool: (tool: ToolDefinition) => {
			tools.push(tool);
		},
		registerCommand: () => {},
		on: (event: string) => {
			events.push(event);
		},
		sendUserMessage: () => {},
	} as unknown as ExtensionAPI;
	return { api, tools, events };
}

describe("workflows extension factory — load-time registration", () => {
	test("registers the structured_output + workflow tools at load", () => {
		const { api, tools } = captureApi();
		workflowsFactory(api);
		const names = tools.map((t) => t.name);
		expect(names).toContain("structured_output");
		expect(names).toContain("workflow");
		expect(names).toContain("workflow_status");
		expect(names).toContain("workflow_stop");
		// Six tools register at load.
		expect(tools.length).toBeGreaterThanOrEqual(6);
	});

	test("wires the four lifecycle handlers at load", () => {
		const { api, events } = captureApi();
		workflowsFactory(api);
		expect(events).toContain("session_start");
		expect(events).toContain("before_agent_start");
		expect(events).toContain("tool_call");
		expect(events).toContain("session_shutdown");
	});

	test("a workflow tool invoked before session_start throws a clean no-session error", async () => {
		const { api, tools } = captureApi();
		workflowsFactory(api);
		const statusTool = tools.find((t) => t.name === "workflow_status");
		expect(statusTool).toBeDefined();
		// The tool resolves the engine via getEngine(), which throws before session_start.
		await expect(
			statusTool?.execute(
				"tc",
				{ run_id: "wf_x" } as never,
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow(/no active session/);
	});
});
