/**
 * Unit tests for `bg_task`. The tool is pure argument mapping + error
 * translation, so we drive a hand-scripted SessionRunner (no engine, no real
 * child) and assert the shapes it forwards + the strings it returns.
 *
 * Scenarios ported from the opencode suite (tools/task.test.ts), adapted to the
 * pi seam: depth comes from the injected `getParentDepth` (env-stamped at
 * session_start), and the fork transcript is read from the parent's session
 * entries via the injected `readParentEntries` rather than an SDK fetch.
 */

import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedAgent } from "../agent-resolver";
import type { PiSessionEntryLike } from "../fork/transcript";
import { makeFakeContext, makeScriptedRunner } from "../test-fakes";
import { createBgTaskTool } from "./task";

const SIGNAL = undefined;
const NOOP_UPDATE = undefined;

/** A pi message session entry (user/assistant) shaped for the fork adapter. */
function userEntry(text: string): PiSessionEntryLike {
	return { type: "message", message: { role: "user", content: text } };
}

interface ToolDeps {
	depth?: number;
	parentSessionID?: string;
	entries?: readonly PiSessionEntryLike[];
	entriesThrows?: boolean;
	/** Map of agent name → resolved knobs the injected resolver returns. */
	agents?: Record<string, ResolvedAgent>;
}

function makeTool(
	runner: ReturnType<typeof makeScriptedRunner>,
	deps: ToolDeps = {},
) {
	return createBgTaskTool({
		getRunner: () => runner,
		getParentSessionID: () => deps.parentSessionID ?? "parent_1",
		getParentDepth: () => deps.depth ?? 0,
		readParentEntries: () => {
			if (deps.entriesThrows) throw new Error("getBranch boom");
			return deps.entries ?? [];
		},
		// Hermetic resolver: looks the name up in the injected map; absent → default.
		resolveAgent: (name) =>
			name !== undefined ? deps.agents?.[name] : undefined,
	});
}

/** Run execute and return the flattened text content. */
async function run(
	tool: ReturnType<typeof createBgTaskTool>,
	params: Record<string, unknown>,
	ctx: ExtensionContext,
): Promise<string> {
	const res = await tool.execute(
		"call_1",
		// biome-ignore lint/suspicious/noExplicitAny: schema-typed params from tests.
		params as any,
		SIGNAL,
		NOOP_UPDATE,
		ctx,
	);
	return res.content.map((c) => ("text" in c ? c.text : "")).join("");
}

describe("bg_task — launch", () => {
	test("no agent → default label, no pi-native knobs, depth = parent+1", async () => {
		const runner = makeScriptedRunner();
		const tool = makeTool(runner, { depth: 0, parentSessionID: "parent_1" });
		const { ctx, probe } = makeFakeContext();

		const out = await run(
			tool,
			{ description: "do a thing", prompt: "go do it" },
			ctx,
		);

		expect(runner.launched).toHaveLength(1);
		const req = runner.launched[0];
		expect(req?.parentSessionID).toBe("parent_1");
		expect(req?.description).toBe("do a thing");
		expect(req?.prompt).toBe("go do it");
		// Display/persist label only — NOT a pi flag (pi has no --agent).
		expect(req?.agent).toBe("default");
		expect(req?.model).toBeUndefined();
		// No agent resolved → no pi-native knobs threaded.
		expect(req?.appendSystemPrompt).toBeUndefined();
		expect(req?.tools).toBeUndefined();
		expect(req?.depth).toBe(1);
		// UI status set to the title.
		expect(probe.statusCalls).toEqual([{ key: "bg_task", text: "do a thing" }]);
		// result carries the id, status, no-poll guidance.
		expect(out).toContain("bg_launched");
		expect(out).toContain("running");
		expect(out.toLowerCase()).toContain("do not poll");
		expect(out).toContain("bg_output");
	});

	test("child of a depth-1 parent launches at depth 2", async () => {
		const runner = makeScriptedRunner();
		const tool = makeTool(runner, { depth: 1 });
		const { ctx } = makeFakeContext();
		await run(tool, { description: "d", prompt: "p" }, ctx);
		expect(runner.launched[0]?.depth).toBe(2);
	});

	test("resolves an agent name → label + pi-native knobs; explicit model overrides frontmatter", async () => {
		const runner = makeScriptedRunner();
		const tool = makeTool(runner, {
			agents: {
				plan: {
					appendSystemPrompt: "You plan carefully.",
					tools: ["read", "grep"],
					model: "anthropic/from-frontmatter",
					filePath: "/agents/plan.md",
					source: "user",
				},
			},
		});
		const { ctx } = makeFakeContext();
		await run(
			tool,
			{
				description: "d",
				prompt: "p",
				agent: "plan",
				model: "anthropic/claude-x",
			},
			ctx,
		);
		const req = runner.launched[0];
		expect(req?.agent).toBe("plan"); // display/persist label
		expect(req?.appendSystemPrompt).toBe("You plan carefully.");
		expect(req?.tools).toEqual(["read", "grep"]);
		// explicit model param wins over the agent definition's frontmatter model.
		expect(req?.model).toBe("anthropic/claude-x");
	});

	test("resolved agent without an explicit model param uses the frontmatter model", async () => {
		const runner = makeScriptedRunner();
		const tool = makeTool(runner, {
			agents: {
				plan: {
					appendSystemPrompt: "You plan.",
					model: "anthropic/from-frontmatter",
					filePath: "/agents/plan.md",
					source: "project",
				},
			},
		});
		const { ctx } = makeFakeContext();
		await run(tool, { description: "d", prompt: "p", agent: "plan" }, ctx);
		const req = runner.launched[0];
		expect(req?.model).toBe("anthropic/from-frontmatter");
		expect(req?.tools).toBeUndefined();
	});

	test("a named-but-unresolved agent → label kept, default assistant (no knobs)", async () => {
		const runner = makeScriptedRunner();
		// No `agents` map entry → resolver returns undefined.
		const tool = makeTool(runner, { agents: {} });
		const { ctx } = makeFakeContext();
		await run(tool, { description: "d", prompt: "p", agent: "ghost" }, ctx);
		const req = runner.launched[0];
		expect(req?.agent).toBe("ghost"); // label survives for display
		expect(req?.appendSystemPrompt).toBeUndefined();
		expect(req?.tools).toBeUndefined();
		expect(req?.model).toBeUndefined();
	});

	test("depth-exceeded launch error is returned as an honest string, not thrown", async () => {
		const runner = makeScriptedRunner({
			onLaunch: async () => {
				throw new Error("Background task depth 2 exceeds max depth 2");
			},
		});
		const tool = makeTool(runner);
		const { ctx } = makeFakeContext();
		const out = await run(tool, { description: "d", prompt: "p" }, ctx);
		expect(out.toLowerCase()).toContain("depth");
		expect(out).toContain("exceeds max depth");
	});

	test("setStatus throwing never blocks the launch", async () => {
		const runner = makeScriptedRunner();
		const tool = makeTool(runner);
		const { ctx } = makeFakeContext({ setStatusThrows: true });
		const out = await run(tool, { description: "d", prompt: "p" }, ctx);
		expect(runner.launched).toHaveLength(1);
		expect(out).toContain("bg_launched");
	});

	test("no UI → no setStatus call, launch still proceeds", async () => {
		const runner = makeScriptedRunner();
		const tool = makeTool(runner);
		const { ctx, probe } = makeFakeContext({ hasUI: false });
		await run(tool, { description: "d", prompt: "p" }, ctx);
		expect(probe.statusCalls).toHaveLength(0);
		expect(runner.launched).toHaveLength(1);
	});
});

describe("bg_task — launch validation", () => {
	test("missing description → error string, no launch", async () => {
		const runner = makeScriptedRunner();
		const tool = makeTool(runner);
		const { ctx } = makeFakeContext();
		const out = await run(tool, { description: "  ", prompt: "p" }, ctx);
		expect(out.toLowerCase()).toContain("description");
		expect(runner.launched).toHaveLength(0);
	});

	test("missing prompt → error string, no launch", async () => {
		const runner = makeScriptedRunner();
		const tool = makeTool(runner);
		const { ctx } = makeFakeContext();
		const out = await run(tool, { description: "d", prompt: "" }, ctx);
		expect(out.toLowerCase()).toContain("prompt");
		expect(runner.launched).toHaveLength(0);
	});
});

describe("bg_task — resume", () => {
	test("maps task_id + prompt to resume(); ignores other args, sets no status", async () => {
		const runner = makeScriptedRunner();
		const tool = makeTool(runner);
		const { ctx, probe } = makeFakeContext();
		const out = await run(
			tool,
			{
				task_id: "bg_old",
				prompt: "continue please",
				description: "ignored",
				agent: "ignored",
			},
			ctx,
		);
		expect(runner.launched).toHaveLength(0);
		expect(runner.resumed).toEqual([
			{ taskId: "bg_old", prompt: "continue please" },
		]);
		expect(probe.statusCalls).toHaveLength(0);
		expect(out).toContain("bg_old");
		expect(out).toContain("running");
	});

	test("resume with missing prompt → validation error string, no resume", async () => {
		const runner = makeScriptedRunner();
		const tool = makeTool(runner);
		const { ctx } = makeFakeContext();
		const out = await run(tool, { task_id: "bg_old", prompt: "" }, ctx);
		expect(out.toLowerCase()).toContain("prompt");
		expect(runner.resumed).toHaveLength(0);
	});

	test("taskStillRunning rejection translated to a readable string", async () => {
		const runner = makeScriptedRunner({
			onResume: async () => {
				throw new Error("taskStillRunning: bg_old is running");
			},
		});
		const tool = makeTool(runner);
		const { ctx } = makeFakeContext();
		const out = await run(tool, { task_id: "bg_old", prompt: "go" }, ctx);
		expect(out.toLowerCase()).toContain("still running");
		expect(out).toContain("bg_old");
	});

	test("sessionExpired rejection translated to a readable string", async () => {
		const runner = makeScriptedRunner({
			onResume: async () => {
				throw new Error("sessionExpired: bg_old session ses_x is gone");
			},
		});
		const tool = makeTool(runner);
		const { ctx } = makeFakeContext();
		const out = await run(tool, { task_id: "bg_old", prompt: "go" }, ctx);
		expect(out.toLowerCase()).toContain("expired");
		expect(out).toContain("bg_old");
	});

	test("an unexpected resume error rethrows (hard failure)", async () => {
		const runner = makeScriptedRunner({
			onResume: async () => {
				throw new Error("ECONNRESET: socket hang up");
			},
		});
		const tool = makeTool(runner);
		const { ctx } = makeFakeContext();
		await expect(
			run(tool, { task_id: "bg_old", prompt: "go" }, ctx),
		).rejects.toThrow("ECONNRESET");
	});
});

describe("bg_task — fork context assembly", () => {
	test("fork:true injects the built transcript as a synthetic context part", async () => {
		const runner = makeScriptedRunner();
		const tool = makeTool(runner, {
			entries: [userEntry("the secret is zanzibar")],
		});
		const { ctx } = makeFakeContext();
		await run(tool, { description: "d", prompt: "p", fork: true }, ctx);

		const req = runner.launched[0];
		expect(req?.contextParts).toBeDefined();
		expect(req?.contextParts).toHaveLength(1);
		const part = req?.contextParts?.[0];
		expect(part?.type).toBe("text");
		expect(part?.synthetic).toBe(true);
		expect(part?.text).toContain("zanzibar");
		expect(part?.text.toLowerCase()).toContain("forked");
	});

	test("fork:true with an empty transcript launches WITHOUT contextParts", async () => {
		const runner = makeScriptedRunner();
		const tool = makeTool(runner, { entries: [] });
		const { ctx } = makeFakeContext();
		await run(tool, { description: "d", prompt: "p", fork: true }, ctx);
		expect(runner.launched).toHaveLength(1);
		expect(runner.launched[0]?.contextParts).toBeUndefined();
	});

	test("readParentEntries throw → readable error string, no launch", async () => {
		const runner = makeScriptedRunner();
		const tool = makeTool(runner, { entriesThrows: true });
		const { ctx } = makeFakeContext();
		const out = await run(
			tool,
			{ description: "d", prompt: "p", fork: true },
			ctx,
		);
		expect(out.toLowerCase()).toContain("fork");
		expect(out).toContain("getBranch boom");
		expect(runner.launched).toHaveLength(0);
	});

	test("transcript-builder drift guard throw → readable error string, no launch", async () => {
		// The real drift guard lives in buildForkTranscript (exercised in
		// fork/transcript.test.ts). Here we pin that ANY builder throw — including
		// the drift-guard's — is caught by the tool and surfaced as a readable
		// string instead of crashing the turn, and that no launch happens (we
		// refuse to ship a child a blind context).
		const runner = makeScriptedRunner();
		const tool = createBgTaskTool({
			getRunner: () => runner,
			getParentSessionID: () => "parent_1",
			getParentDepth: () => 0,
			readParentEntries: () => {
				throw new Error(
					"buildForkTranscript: schema drift — update the adapter",
				);
			},
		});
		const { ctx } = makeFakeContext();
		const out = await run(
			tool,
			{ description: "d", prompt: "p", fork: true },
			ctx,
		);
		expect(out.toLowerCase()).toContain("fork");
		expect(out).toContain("schema drift");
		expect(runner.launched).toHaveLength(0);
	});

	test("fork:false never reads parent entries", async () => {
		const runner = makeScriptedRunner();
		let readCount = 0;
		const tool = createBgTaskTool({
			getRunner: () => runner,
			getParentSessionID: () => "parent_1",
			getParentDepth: () => 0,
			readParentEntries: () => {
				readCount += 1;
				return [];
			},
		});
		const { ctx } = makeFakeContext();
		await run(tool, { description: "d", prompt: "p", fork: false }, ctx);
		expect(readCount).toBe(0);
		expect(runner.launched[0]?.contextParts).toBeUndefined();
	});
});
