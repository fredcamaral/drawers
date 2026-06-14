import { describe, expect, test } from "bun:test";
import type { BgTask, LaunchRequest, SessionRunner } from "@drawers/core";
import type { ForkMessage } from "../fork/transcript";
import { createBgTaskTool } from "./task";

/**
 * A typed, scripted {@link SessionRunner} fake. No SDK, no real engine — the
 * tool's job is pure argument mapping + error translation, so we record the
 * shapes it forwards and script the outcomes it must translate.
 *
 * Unimplemented methods throw: any test that trips one is exercising a path the
 * tool should not touch.
 */
interface FakeRunnerScript {
	/** Tasks the tool's `list()` call sees (for depth inference). */
	listTasks?: BgTask[];
	/** Resolve `launch()` with this task; default echoes the request. */
	onLaunch?: (req: LaunchRequest) => Promise<BgTask>;
	/** Resolve/reject `resume()`. */
	onResume?: (taskId: string, prompt: string) => Promise<BgTask>;
}

interface FakeRunner extends SessionRunner {
	launched: LaunchRequest[];
	resumed: Array<{ taskId: string; prompt: string }>;
}

function makeRunner(script: FakeRunnerScript = {}): FakeRunner {
	const launched: LaunchRequest[] = [];
	const resumed: Array<{ taskId: string; prompt: string }> = [];
	const notImpl = (name: string) => (): never => {
		throw new Error(`FakeRunner.${name} should not be called`);
	};

	return {
		launched,
		resumed,
		list: () => script.listTasks ?? [],
		launch: async (req) => {
			launched.push(req);
			if (script.onLaunch) {
				return script.onLaunch(req);
			}
			return {
				id: "bg_launched",
				parentSessionID: req.parentSessionID,
				description: req.description,
				agent: req.agent,
				status: "running",
				createdAt: 0,
				depth: req.depth,
				concurrencyKey: "k",
				model: req.model,
			};
		},
		resume: async (taskId, prompt) => {
			resumed.push({ taskId, prompt });
			if (script.onResume) {
				return script.onResume(taskId, prompt);
			}
			return {
				id: taskId,
				parentSessionID: "ses_parent",
				description: "resumed",
				agent: "build",
				status: "running",
				createdAt: 0,
				depth: 0,
				concurrencyKey: "k",
			};
		},
		awaitCompletion: notImpl("awaitCompletion") as never,
		cancel: notImpl("cancel") as never,
		readOutput: notImpl("readOutput") as never,
		handleEvent: notImpl("handleEvent") as never,
		dispose: notImpl("dispose") as never,
	};
}

/** A minimal ToolContext: only the fields the tool reads. */
function makeContext(over: { sessionID?: string } = {}) {
	const metadataCalls: Array<{ title?: string }> = [];
	const context = {
		sessionID: over.sessionID ?? "ses_parent",
		messageID: "msg_1",
		agent: "build",
		directory: "/repo",
		worktree: "/repo",
		abort: new AbortController().signal,
		metadata: (input: { title?: string; metadata?: unknown }) => {
			metadataCalls.push({ title: input.title });
		},
		ask: async () => {
			throw new Error("ask should not be called");
		},
	};
	return { context, metadataCalls };
}

/** Resolve a ToolResult (string | object) to its output text. */
function outputText(result: string | { output: string }): string {
	return typeof result === "string" ? result : result.output;
}

/** A terminal task fixture for depth-inference lists. */
function task(over: Partial<BgTask>): BgTask {
	return {
		id: "bg_x",
		parentSessionID: "ses_parent",
		description: "d",
		agent: "build",
		status: "running",
		createdAt: 0,
		depth: 0,
		concurrencyKey: "k",
		...over,
	};
}

// Launch args the schema would resolve to (defaults already applied, since
// opencode validates before calling execute). `agent` defaults to "build".
function launchArgs(over: Record<string, unknown> = {}) {
	return {
		description: "do a thing",
		prompt: "go do it",
		agent: "build",
		model: undefined,
		task_id: undefined,
		fork: false,
		...over,
	} as Parameters<ReturnType<typeof createBgTaskTool>["execute"]>[0];
}

describe("bg_task tool — launch", () => {
	test("maps args to LaunchRequest with agent default and depth 0 from parent", async () => {
		const runner = makeRunner();
		const tool = createBgTaskTool(runner);
		const { context, metadataCalls } = makeContext({ sessionID: "ses_parent" });

		const result = await tool.execute(launchArgs(), context);

		expect(runner.launched).toHaveLength(1);
		const req = runner.launched[0];
		expect(req?.parentSessionID).toBe("ses_parent");
		expect(req?.description).toBe("do a thing");
		expect(req?.prompt).toBe("go do it");
		expect(req?.agent).toBe("build");
		expect(req?.model).toBeUndefined();
		expect(req?.depth).toBe(0);

		// metadata title set on launch.
		expect(metadataCalls).toEqual([{ title: "do a thing" }]);

		// result text carries the id, status and the no-poll guidance.
		const text = outputText(result);
		expect(text).toContain("bg_launched");
		expect(text).toContain("running");
		expect(text.toLowerCase()).toContain("do not poll");
		expect(text).toContain("bg_output");
	});

	test("passes through a non-default agent and model", async () => {
		const runner = makeRunner();
		const tool = createBgTaskTool(runner);
		const { context } = makeContext();

		await tool.execute(
			launchArgs({ agent: "plan", model: "anthropic/claude-x" }),
			context,
		);

		const req = runner.launched[0];
		expect(req?.agent).toBe("plan");
		expect(req?.model).toBe("anthropic/claude-x");
	});

	test("infers depth 1 when called from a tracked child session", async () => {
		// A child session belongs to a depth-0 task; a call from it is depth 1.
		const runner = makeRunner({
			listTasks: [task({ id: "bg_parent", sessionID: "ses_child", depth: 0 })],
		});
		const tool = createBgTaskTool(runner);
		const { context } = makeContext({ sessionID: "ses_child" });

		await tool.execute(launchArgs(), context);

		expect(runner.launched[0]?.depth).toBe(1);
	});

	test("depth-exceeded launch error is returned as an honest string", async () => {
		const runner = makeRunner({
			onLaunch: async () => {
				throw new Error("Background task depth 2 exceeds max depth 2");
			},
		});
		const tool = createBgTaskTool(runner);
		const { context } = makeContext();

		const text = outputText(await tool.execute(launchArgs(), context));
		expect(text.toLowerCase()).toContain("depth");
		expect(text).toContain("exceeds max depth");
	});
});

describe("bg_task tool — launch validation", () => {
	test("missing description → error string, no launch", async () => {
		const runner = makeRunner();
		const tool = createBgTaskTool(runner);
		const { context } = makeContext();

		const text = outputText(
			await tool.execute(launchArgs({ description: "  " }), context),
		);
		expect(text.toLowerCase()).toContain("description");
		expect(runner.launched).toHaveLength(0);
	});

	test("missing prompt → error string, no launch", async () => {
		const runner = makeRunner();
		const tool = createBgTaskTool(runner);
		const { context } = makeContext();

		const text = outputText(
			await tool.execute(launchArgs({ prompt: "" }), context),
		);
		expect(text.toLowerCase()).toContain("prompt");
		expect(runner.launched).toHaveLength(0);
	});
});

describe("bg_task tool — resume", () => {
	test("maps task_id + prompt to resume(); ignores other args", async () => {
		const runner = makeRunner({
			onResume: async (taskId) =>
				task({ id: taskId, status: "running", sessionID: "ses_r" }),
		});
		const tool = createBgTaskTool(runner);
		const { context, metadataCalls } = makeContext();

		const result = await tool.execute(
			launchArgs({ task_id: "bg_old", prompt: "continue please" }),
			context,
		);

		expect(runner.launched).toHaveLength(0);
		expect(runner.resumed).toEqual([
			{ taskId: "bg_old", prompt: "continue please" },
		]);
		// Resume does not set a UI title (no description in resume mode).
		expect(metadataCalls).toHaveLength(0);

		const text = outputText(result);
		expect(text).toContain("bg_old");
		expect(text).toContain("running");
	});

	test("resume with missing prompt → validation error string, no resume", async () => {
		const runner = makeRunner();
		const tool = createBgTaskTool(runner);
		const { context } = makeContext();

		const text = outputText(
			await tool.execute(
				launchArgs({ task_id: "bg_old", prompt: "" }),
				context,
			),
		);
		expect(text.toLowerCase()).toContain("prompt");
		expect(runner.resumed).toHaveLength(0);
	});

	test("taskStillRunning rejection is translated to an honest string", async () => {
		const runner = makeRunner({
			onResume: async () => {
				throw new Error("taskStillRunning: bg_old is running");
			},
		});
		const tool = createBgTaskTool(runner);
		const { context } = makeContext();

		const text = outputText(
			await tool.execute(
				launchArgs({ task_id: "bg_old", prompt: "go" }),
				context,
			),
		);
		expect(text.toLowerCase()).toContain("still running");
		expect(text).toContain("bg_old");
	});

	test("sessionExpired rejection is translated to an honest string", async () => {
		const runner = makeRunner({
			onResume: async () => {
				throw new Error("sessionExpired: bg_old session ses_x is gone");
			},
		});
		const tool = createBgTaskTool(runner);
		const { context } = makeContext();

		const text = outputText(
			await tool.execute(
				launchArgs({ task_id: "bg_old", prompt: "go" }),
				context,
			),
		);
		expect(text.toLowerCase()).toContain("session");
		expect(text.toLowerCase()).toContain("expired");
	});

	test("an unexpected resume error rethrows (hard failure)", async () => {
		const runner = makeRunner({
			onResume: async () => {
				throw new Error("ECONNRESET: socket hang up");
			},
		});
		const tool = createBgTaskTool(runner);
		const { context } = makeContext();

		await expect(
			tool.execute(launchArgs({ task_id: "bg_old", prompt: "go" }), context),
		).rejects.toThrow("ECONNRESET");
	});
});

describe("bg_task tool — fork", () => {
	/** A fetchMessages spy: records the sessionID it was called with. */
	function makeFetch(messages: ForkMessage[]) {
		const calls: string[] = [];
		const fetchMessages = async (sessionID: string) => {
			calls.push(sessionID);
			return messages;
		};
		return { fetchMessages, calls };
	}

	const userMsg = (text: string): ForkMessage => ({
		info: { role: "user" },
		parts: [{ type: "text", text }],
	});

	test("fork:true injects the built transcript as a synthetic context part", async () => {
		const runner = makeRunner();
		const { fetchMessages, calls } = makeFetch([
			userMsg("the secret is zanzibar"),
		]);
		const tool = createBgTaskTool(runner, { fetchMessages });
		const { context } = makeContext({ sessionID: "ses_parent" });

		await tool.execute(launchArgs({ fork: true }), context);

		// fetched the parent session's transcript.
		expect(calls).toEqual(["ses_parent"]);

		const req = runner.launched[0];
		expect(req?.contextParts).toBeDefined();
		expect(req?.contextParts).toHaveLength(1);
		const part = req?.contextParts?.[0];
		expect(part?.type).toBe("text");
		expect(part?.synthetic).toBe(true);
		// the transcript carries the parent fact + the fork header.
		expect(part?.text).toContain("zanzibar");
		expect(part?.text.toLowerCase()).toContain("forked");
	});

	test("fork:true with an empty transcript launches WITHOUT contextParts", async () => {
		const runner = makeRunner();
		// No messages → buildForkTranscript returns "" → no context part.
		const { fetchMessages, calls } = makeFetch([]);
		const tool = createBgTaskTool(runner, { fetchMessages });
		const { context } = makeContext({ sessionID: "ses_parent" });

		await tool.execute(launchArgs({ fork: true }), context);

		expect(calls).toEqual(["ses_parent"]);
		expect(runner.launched).toHaveLength(1);
		expect(runner.launched[0]?.contextParts).toBeUndefined();
	});

	test("fetchMessages throw (transient fetch failure) → honest error string, no launch", async () => {
		const runner = makeRunner();
		// A failed parent-transcript fetch (e.g. ECONNRESET surfaced by the engine)
		// must NOT be treated as an empty session: refuse the fork, do not launch.
		const fetchMessages = async () => {
			throw new Error("fetchSessionMessages: ECONNRESET");
		};
		const tool = createBgTaskTool(runner, { fetchMessages });
		const { context } = makeContext();

		const result = await tool.execute(launchArgs({ fork: true }), context);
		const text = typeof result === "string" ? result : result.output;

		expect(text.toLowerCase()).toContain("fork");
		expect(text).toContain("ECONNRESET");
		expect(text.toLowerCase()).toContain("parent transcript");
		// no launch happened — we refuse to send a blind context.
		expect(runner.launched).toHaveLength(0);
	});

	test("transcript-builder throw (drift guard) → honest error string, no launch", async () => {
		const runner = makeRunner();
		// A non-empty input whose only part carries payload under an unknown type
		// trips buildForkTranscript's drift guard (it throws).
		const driftMsg: ForkMessage = {
			info: { role: "assistant" },
			parts: [{ type: "mystery_kind", text: "payload that should extract" }],
		};
		const { fetchMessages } = makeFetch([driftMsg]);
		const tool = createBgTaskTool(runner, { fetchMessages });
		const { context } = makeContext();

		const result = await tool.execute(launchArgs({ fork: true }), context);
		const text = typeof result === "string" ? result : result.output;

		expect(text.toLowerCase()).toContain("fork");
		expect(text.toLowerCase()).toContain("schema");
		// no launch happened — we refuse to send a blind context.
		expect(runner.launched).toHaveLength(0);
	});

	test("fork:false never calls fetchMessages", async () => {
		const runner = makeRunner();
		const { fetchMessages, calls } = makeFetch([userMsg("irrelevant")]);
		const tool = createBgTaskTool(runner, { fetchMessages });
		const { context } = makeContext();

		await tool.execute(launchArgs({ fork: false }), context);

		expect(calls).toHaveLength(0);
		expect(runner.launched[0]?.contextParts).toBeUndefined();
	});
});
