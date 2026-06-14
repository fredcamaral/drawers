/**
 * Focused wiring test for the workflows engine over the real pi-core SessionRunner.
 *
 * The runner is built inside the engine, so we drive it through the FAKE RpcClient
 * seam (one fake == one synthetic `pi --mode rpc` child): a launch settles via a
 * synthetic `agent_end(willRetry:false)`. The transcript reader is injected to
 * return the fake's messages, so per-agent stats + structured read-back resolve
 * without a real child.
 *
 * Coverage:
 *   - a trivial one-agent workflow runs to a `completed` record with the agent
 *     rolled up (model/status/tokens) and the return value captured;
 *   - the feed file carries run:start → agent:* → run:end in emit order;
 *   - structured read-back: the engine's `readStructured` locates the child's
 *     `structured_output` tool result on the transcript and the parent validates it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	PiAgentMessage,
	RpcAgentEvent,
	RpcClientCreateOptions,
	RpcClientFactory,
	RpcClientLike,
	RpcExitInfo,
	SessionTranscriptReader,
} from "@drawers/pi-core";
import { createWorkflowEngine, type WorkflowEngine } from "./engine";

// --- the fake pi child (one fake == one rpc subprocess) --------------------

class FakeRpcClient implements RpcClientLike {
	readonly opts: RpcClientCreateOptions;
	private eventListeners: Array<(e: RpcAgentEvent) => void> = [];
	private exitListeners: Array<(i: RpcExitInfo) => void> = [];
	messages: PiAgentMessage[] = [];
	sessionFile = "/sessions/fake.jsonl";
	constructor(opts: RpcClientCreateOptions) {
		this.opts = opts;
	}
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async prompt(): Promise<void> {
		// Settle on the next microtask: emit agent_end(willRetry:false) → terminal.
		queueMicrotask(() =>
			this.emit({
				type: "agent_end",
				messages: this.messages,
				willRetry: false,
			}),
		);
	}
	async abort(): Promise<void> {}
	onEvent(l: (e: RpcAgentEvent) => void): () => void {
		this.eventListeners.push(l);
		return () => {
			const i = this.eventListeners.indexOf(l);
			if (i !== -1) this.eventListeners.splice(i, 1);
		};
	}
	onExit(l: (i: RpcExitInfo) => void): () => void {
		this.exitListeners.push(l);
		return () => {
			const i = this.exitListeners.indexOf(l);
			if (i !== -1) this.exitListeners.splice(i, 1);
		};
	}
	async getMessages(): Promise<PiAgentMessage[]> {
		return this.messages;
	}
	async getState(): Promise<{
		sessionId: string;
		sessionFile?: string;
		isStreaming: boolean;
	}> {
		return {
			sessionId: this.opts.sessionId ?? "?",
			sessionFile: this.sessionFile,
			isStreaming: false,
		};
	}
	getStderr(): string {
		return "";
	}
	emit(e: RpcAgentEvent): void {
		for (const l of [...this.eventListeners]) l(e);
	}
}

class FakeFactory implements RpcClientFactory {
	readonly created: FakeRpcClient[] = [];
	configure?: (fake: FakeRpcClient, n: number) => void;
	create(opts: RpcClientCreateOptions): RpcClientLike {
		const fake = new FakeRpcClient(opts);
		this.configure?.(fake, this.created.length);
		this.created.push(fake);
		return fake;
	}
}

function assistantWithUsage(text: string): PiAgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		// pi assistant usage: cumulative; the deriver sums per assistant message.
		usage: { input: 100, output: 25, totalTokens: 125 },
	} as unknown as PiAgentMessage;
}

const scriptOf = (body: string, name = "wf"): string =>
	`export const meta = { name: ${JSON.stringify(name)}, description: "t" };\n${body}`;

async function flush(): Promise<void> {
	for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

describe("workflow engine wiring over the real runner", () => {
	let dataDir: string;
	let engine: WorkflowEngine | undefined;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "wf-engine-test-"));
	});
	afterEach(async () => {
		await engine?.dispose();
		engine = undefined;
		await rm(dataDir, { recursive: true, force: true });
	});

	test("a one-agent workflow runs to a completed record with the agent rolled up", async () => {
		const factory = new FakeFactory();
		factory.configure = (fake) => {
			fake.messages = [assistantWithUsage("the answer is 42")];
		};
		const transcriptReader: SessionTranscriptReader = async () => [
			assistantWithUsage("the answer is 42"),
		];

		engine = createWorkflowEngine({
			rpcFactory: factory,
			transcriptReader,
			directory: dataDir,
			dataDir,
		});
		await engine.ready();

		const { runId } = await engine.startRun({
			parentSessionID: "parent_1",
			source: scriptOf(`return await agent("compute", { label: "compute" });`),
		});

		const handle = engine.statusOf(runId);
		expect(handle).toBeDefined();
		await handle?.settled;
		await flush();

		const record = engine.statusOf(runId)?.record;
		expect(record?.status).toBe("completed");
		expect(record?.returnValue).toBe("the answer is 42");
		// The agent rolled up onto the record with derived stats.
		expect(record?.agents).toHaveLength(1);
		expect(record?.agents?.[0]?.status).toBe("completed");
		expect(record?.agents?.[0]?.tokens?.output).toBe(25);
		// One child was spawned.
		expect(factory.created).toHaveLength(1);
	});

	test("the feed file carries run:start → agent events → run:end in order", async () => {
		const factory = new FakeFactory();
		factory.configure = (fake) => {
			fake.messages = [assistantWithUsage("done")];
		};
		const transcriptReader: SessionTranscriptReader = async () => [
			assistantWithUsage("done"),
		];
		engine = createWorkflowEngine({
			rpcFactory: factory,
			transcriptReader,
			directory: dataDir,
			dataDir,
		});
		await engine.ready();

		const { runId } = await engine.startRun({
			parentSessionID: "parent_1",
			source: scriptOf(`return await agent("x", { label: "x" });`),
		});
		await engine.statusOf(runId)?.settled;
		await flush();

		const feedRaw = await readFile(
			join(dataDir, "workflow-feed", `${runId}.jsonl`),
			"utf-8",
		);
		const lines = feedRaw
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as { type: string });
		const types = lines.map((l) => l.type);
		expect(types[0]).toBe("run:start");
		expect(types[types.length - 1]).toBe("run:end");
		// The agent's lifecycle landed between, in order.
		const startIdx = types.indexOf("agent:start");
		const endIdx = types.indexOf("agent:end");
		expect(startIdx).toBeGreaterThan(0);
		expect(endIdx).toBeGreaterThan(startIdx);
	});

	test("structured read-back: the engine validates the child's echoed tool result", async () => {
		const echoed = '{"verdict":"pass"}';
		// The transcript carries a structured_output toolResult the engine scans for.
		const transcript: PiAgentMessage[] = [
			assistantWithUsage("calling tool"),
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "structured_output",
				content: [{ type: "text", text: echoed }],
			} as unknown as PiAgentMessage,
		];
		const factory = new FakeFactory();
		factory.configure = (fake) => {
			fake.messages = transcript;
		};
		const transcriptReader: SessionTranscriptReader = async () => transcript;

		engine = createWorkflowEngine({
			rpcFactory: factory,
			transcriptReader,
			directory: dataDir,
			dataDir,
		});
		await engine.ready();

		const { runId } = await engine.startRun({
			parentSessionID: "parent_1",
			source: scriptOf(
				`return await agent("review", {
					label: "review",
					schema: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] },
				});`,
			),
		});
		await engine.statusOf(runId)?.settled;
		await flush();

		const record = engine.statusOf(runId)?.record;
		expect(record?.status).toBe("completed");
		expect(record?.returnValue).toEqual({ verdict: "pass" });
	});
});
