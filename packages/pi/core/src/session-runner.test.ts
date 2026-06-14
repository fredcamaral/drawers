/**
 * Unit tests for the pi-native SessionRunner.
 *
 * Everything is driven through a FAKE RpcClientLike (one fake == one synthetic pi
 * child) injected via a fake RpcClientFactory. The fake lets a test emit synthetic
 * agent events / process exits on demand, so every launch/cancel/resume/exit
 * interleaving is exercised without a real `pi --mode rpc` process. A manual timer
 * factory keeps the prompt watchdog and resume bound deterministic.
 *
 * Scenario taxonomy ported from the opencode session-runner suite, adapted to the
 * per-process pi model (no shared SDK event bus; completion via the child's own
 * event stream + exit).
 */

import { describe, expect, test } from "bun:test";
import type { TimerFactory, TimerHandle } from "./completion";
import { ConcurrencyManager } from "./concurrency";
import { createIdGenerator } from "./ids";
import type {
	PiAgentMessage,
	RpcAgentEvent,
	RpcClientCreateOptions,
	RpcClientFactory,
	RpcClientLike,
	RpcExitInfo,
	SessionTranscriptReader,
} from "./rpc-client";
import { createSessionRunner, type SessionRunnerDeps } from "./session-runner";
import type { BgTask, Clock, LaunchRequest } from "./types";

// --- the fake RpcClientLike ------------------------------------------------

interface FakeCallLog {
	startCount: number;
	stopCount: number;
	abortCount: number;
	prompts: string[];
	getMessagesCount: number;
}

/**
 * A synthetic pi child. start/stop/prompt/abort resolve unless armed to reject;
 * `emit` pushes a synthetic event to subscribers, `emitExit` a synthetic exit.
 */
class FakeRpcClient implements RpcClientLike {
	readonly opts: RpcClientCreateOptions;
	readonly log: FakeCallLog = {
		startCount: 0,
		stopCount: 0,
		abortCount: 0,
		prompts: [],
		getMessagesCount: 0,
	};
	private eventListeners: Array<(e: RpcAgentEvent) => void> = [];
	private exitListeners: Array<(i: RpcExitInfo) => void> = [];
	messages: PiAgentMessage[] = [];
	sessionFile?: string = "/sessions/file.jsonl";
	stderr = "";

	// arm rejections
	startError?: Error;
	promptError?: Error;
	getStateError?: Error;
	getMessagesError?: Error;
	// a deferred start: start() hangs until resolveStart() is called.
	private startResolve?: () => void;
	private startReject?: (e: Error) => void;
	private deferStart = false;

	constructor(opts: RpcClientCreateOptions) {
		this.opts = opts;
	}

	deferNextStart(): void {
		this.deferStart = true;
	}
	resolveStart(): void {
		this.startResolve?.();
	}
	rejectStart(e: Error): void {
		this.startReject?.(e);
	}

	async start(): Promise<void> {
		this.log.startCount += 1;
		if (this.startError) {
			throw this.startError;
		}
		if (this.deferStart) {
			await new Promise<void>((res, rej) => {
				this.startResolve = res;
				this.startReject = rej;
			});
		}
	}
	async stop(): Promise<void> {
		this.log.stopCount += 1;
	}
	async prompt(message: string): Promise<void> {
		this.log.prompts.push(message);
		if (this.promptError) {
			throw this.promptError;
		}
	}
	async abort(): Promise<void> {
		this.log.abortCount += 1;
	}
	onEvent(listener: (e: RpcAgentEvent) => void): () => void {
		this.eventListeners.push(listener);
		return () => {
			const i = this.eventListeners.indexOf(listener);
			if (i !== -1) this.eventListeners.splice(i, 1);
		};
	}
	onExit(listener: (i: RpcExitInfo) => void): () => void {
		this.exitListeners.push(listener);
		return () => {
			const i = this.exitListeners.indexOf(listener);
			if (i !== -1) this.exitListeners.splice(i, 1);
		};
	}
	async getMessages(): Promise<PiAgentMessage[]> {
		this.log.getMessagesCount += 1;
		if (this.getMessagesError) {
			throw this.getMessagesError;
		}
		return this.messages;
	}
	async getState(): Promise<{
		sessionId: string;
		sessionFile?: string;
		isStreaming: boolean;
	}> {
		if (this.getStateError) {
			throw this.getStateError;
		}
		return {
			sessionId: this.opts.sessionId ?? "?",
			sessionFile: this.sessionFile,
			isStreaming: false,
		};
	}
	getStderr(): string {
		return this.stderr;
	}

	/** Push a synthetic event to all current subscribers. */
	emit(e: RpcAgentEvent): void {
		for (const l of [...this.eventListeners]) l(e);
	}
	/** Push a synthetic exit to all current subscribers. */
	emitExit(i: RpcExitInfo): void {
		for (const l of [...this.exitListeners]) l(i);
	}
	get hasEventListeners(): boolean {
		return this.eventListeners.length > 0;
	}
}

/** A factory recording every created fake child in order. */
class FakeFactory implements RpcClientFactory {
	readonly created: FakeRpcClient[] = [];
	/** Optional hook to configure each fake right after construction. */
	configure?: (fake: FakeRpcClient, n: number) => void;
	create(opts: RpcClientCreateOptions): RpcClientLike {
		const fake = new FakeRpcClient(opts);
		this.configure?.(fake, this.created.length);
		this.created.push(fake);
		return fake;
	}
	last(): FakeRpcClient {
		const f = this.created[this.created.length - 1];
		if (!f) throw new Error("no fake created yet");
		return f;
	}
}

// --- synthetic event builders ---------------------------------------------

function assistantMsg(
	stopReason: "stop" | "error" | "aborted",
	text = "done",
	errorMessage?: string,
): PiAgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason,
		errorMessage,
	};
}
function endOk(text = "done"): RpcAgentEvent {
	return {
		type: "agent_end",
		messages: [assistantMsg("stop", text)],
		willRetry: false,
	};
}
function endError(msg: string): RpcAgentEvent {
	return {
		type: "agent_end",
		messages: [assistantMsg("error", "x", msg)],
		willRetry: false,
	};
}
function agentStart(): RpcAgentEvent {
	return { type: "agent_start" };
}

// --- manual timers ---------------------------------------------------------

function makeTimers() {
	let seq = 0;
	const pending = new Map<number, { cb: () => void; ms: number }>();
	const factory: TimerFactory = (cb, ms): TimerHandle => {
		const id = ++seq;
		pending.set(id, { cb, ms });
		return { clear: () => void pending.delete(id) };
	};
	return {
		factory,
		count: () => pending.size,
		fireAll: () => {
			const e = [...pending.values()];
			pending.clear();
			for (const t of e) t.cb();
		},
	};
}

// --- runner harness --------------------------------------------------------

const clock: Clock = { now: () => 5000 };

interface HarnessOpts {
	concurrency?: ConcurrencyManager;
	transcriptReader?: SessionTranscriptReader;
	recoveredTasks?: BgTask[];
	configureFake?: (fake: FakeRpcClient, n: number) => void;
	persist?: (t: BgTask) => Promise<void>;
	onTaskComplete?: (t: BgTask) => void;
	promptWatchdogMs?: number;
}

function makeRunner(opts: HarnessOpts = {}) {
	const factory = new FakeFactory();
	if (opts.configureFake) factory.configure = opts.configureFake;
	const concurrency =
		opts.concurrency ?? new ConcurrencyManager({ defaultConcurrency: 2 });
	const timers = makeTimers();
	const persisted: BgTask[] = [];
	const reader: SessionTranscriptReader =
		opts.transcriptReader ?? (async () => []);
	const deps: SessionRunnerDeps = {
		rpcFactory: factory,
		transcriptReader: reader,
		concurrency,
		ids: createIdGenerator({ prefix: "bg_" }),
		clock,
		persist:
			opts.persist ??
			(async (t) => {
				persisted.push({ ...t });
			}),
		setTimer: timers.factory,
		recoveredTasks: opts.recoveredTasks,
		onTaskComplete: opts.onTaskComplete,
		sessionDir: "/sessions",
		config: { promptWatchdogMs: opts.promptWatchdogMs ?? 90000 },
	};
	const runner = createSessionRunner(deps);
	return { runner, factory, concurrency, timers, persisted };
}

function req(overrides: Partial<LaunchRequest> = {}): LaunchRequest {
	return {
		parentSessionID: "parent_1",
		description: "test task",
		prompt: "do the thing",
		agent: "build",
		model: "anthropic/opus",
		depth: 0,
		...overrides,
	};
}

/** Flush the microtask queue a few turns. */
async function flush(): Promise<void> {
	for (let i = 0; i < 6; i++) await Promise.resolve();
}

// --- launch happy path -----------------------------------------------------

describe("SessionRunner — launch happy path", () => {
	test("launch → running task, child started with minted session id/dir/cwd, prompt dispatched", async () => {
		const h = makeRunner();
		const task = await h.runner.launch(req({ directory: "/wt/a" }));
		expect(task.status).toBe("running");
		expect(task.sessionID).toBe(task.id);
		const fake = h.factory.last();
		expect(fake.log.startCount).toBe(1);
		expect(fake.opts.sessionId).toBe(task.id);
		expect(fake.opts.sessionDir).toBe("/sessions");
		expect(fake.opts.cwd).toBe("/wt/a");
		expect(fake.opts.model).toBe("anthropic/opus");
		// No pi-native agent knobs by default → no --agent (pi has none), no
		// --append-system-prompt, no --tools.
		expect(fake.opts.appendSystemPrompt).toBeUndefined();
		expect(fake.opts.tools).toBeUndefined();
		expect(fake.log.prompts).toEqual(["do the thing"]);
		expect(task.sessionFile).toBe("/sessions/file.jsonl");
		// recursion guard present by default
		expect(task.tools?.bg_task).toBe(false);
	});

	test("pi-native knobs (appendSystemPrompt/tools) thread into create() and persist on the task", async () => {
		const h = makeRunner();
		const task = await h.runner.launch(
			req({
				appendSystemPrompt: "You are a careful reviewer.",
				tools: ["read", "grep"],
			}),
		);
		const fake = h.factory.last();
		expect(fake.opts.appendSystemPrompt).toBe("You are a careful reviewer.");
		expect(fake.opts.tools).toEqual(["read", "grep"]);
		// persisted on the task so resume() replays them.
		expect(task.appendSystemPrompt).toBe("You are a careful reviewer.");
		expect(task.agentTools).toEqual(["read", "grep"]);
	});

	test("agent_end(stop) → completed; awaitCompletion resolves with output", async () => {
		const h = makeRunner();
		const task = await h.runner.launch(req());
		const fake = h.factory.last();
		fake.messages = [assistantMsg("stop", "final answer")];
		fake.emit(endOk("final answer"));
		const done = await h.runner.awaitCompletion(task.id);
		expect(done.status).toBe("completed");
		// teardown stopped the child
		expect(fake.log.stopCount).toBe(1);
		const out = await h.runner.readOutput(task.id);
		// terminal task → disk read (live child gone). Reader default returns [] →
		// graceful empty summary.
		expect(out.status).toBe("completed");
	});

	test("toolsOverride merges over the recursion guard; noSpawnTools:false omits the guard", async () => {
		const h = makeRunner();
		const t1 = await h.runner.launch(req({ toolsOverride: { custom: true } }));
		expect(t1.tools?.bg_task).toBe(false);
		expect(t1.tools?.custom).toBe(true);
		const t2 = await h.runner.launch(req({ noSpawnTools: false }));
		expect(t2.tools?.bg_task).toBeUndefined();
	});

	test("contextParts are flattened ahead of the prompt", async () => {
		const h = makeRunner();
		await h.runner.launch(
			req({
				contextParts: [
					{ type: "text", text: "CTX_A" },
					{ type: "text", text: "CTX_B" },
				],
			}),
		);
		const fake = h.factory.last();
		expect(fake.log.prompts[0]).toBe("CTX_A\n\nCTX_B\n\ndo the thing");
	});

	test("onSessionCreated fires with the minted id before the prompt", async () => {
		const seen: string[] = [];
		const h = makeRunner();
		const task = await h.runner.launch(
			req({ onSessionCreated: (id) => seen.push(id) }),
		);
		expect(seen).toEqual([task.id]);
	});
});

// --- error classification --------------------------------------------------

describe("SessionRunner — terminal classification", () => {
	test("agent_end(error) → error with the reason", async () => {
		const h = makeRunner();
		const task = await h.runner.launch(req());
		h.factory.last().emit(endError("model refused"));
		const done = await h.runner.awaitCompletion(task.id);
		expect(done.status).toBe("error");
		expect(done.error).toBe("model refused");
	});

	test("agent_end(aborted) → cancelled", async () => {
		const h = makeRunner();
		const task = await h.runner.launch(req());
		h.factory.last().emit({
			type: "agent_end",
			messages: [assistantMsg("aborted")],
			willRetry: false,
		});
		const done = await h.runner.awaitCompletion(task.id);
		expect(done.status).toBe("cancelled");
	});

	test("willRetry:true does NOT complete; a following willRetry:false does", async () => {
		const h = makeRunner();
		const task = await h.runner.launch(req());
		const fake = h.factory.last();
		fake.emit({
			type: "agent_end",
			messages: [assistantMsg("error", "x", "transient")],
			willRetry: true,
		});
		await flush();
		expect((await h.runner.readOutput(task.id)).status).toBe("running");
		fake.emit(endOk());
		const done = await h.runner.awaitCompletion(task.id);
		expect(done.status).toBe("completed");
	});

	test("auto_retry_* events are non-terminal", async () => {
		const h = makeRunner();
		const task = await h.runner.launch(req());
		const fake = h.factory.last();
		fake.emit({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 1,
			errorMessage: "e",
		});
		fake.emit({ type: "auto_retry_end", success: true, attempt: 1 });
		await flush();
		expect((await h.runner.readOutput(task.id)).status).toBe("running");
	});
});

// --- process exit / crash --------------------------------------------------

describe("SessionRunner — process exit before agent_end", () => {
	test("child exits while running → error, slot released", async () => {
		const h = makeRunner();
		const task = await h.runner.launch(req());
		const fake = h.factory.last();
		expect(h.concurrency.runningCount("anthropic/opus")).toBe(1);
		fake.emitExit({
			code: 1,
			signal: null,
			error: new Error("Agent process exited (code=1)"),
		});
		const done = await h.runner.awaitCompletion(task.id);
		expect(done.status).toBe("error");
		expect(done.error).toContain("process");
		expect(h.concurrency.runningCount("anthropic/opus")).toBe(0);
	});

	test("clean exit AFTER terminal agent_end is a no-op", async () => {
		const h = makeRunner();
		const task = await h.runner.launch(req());
		const fake = h.factory.last();
		fake.emit(endOk());
		const done = await h.runner.awaitCompletion(task.id);
		expect(done.status).toBe("completed");
		fake.emitExit({ code: 0, signal: null }); // the stop() teardown exit
		expect((await h.runner.readOutput(task.id)).status).toBe("completed");
	});
});

// --- prompt watchdog (C1) --------------------------------------------------

describe("SessionRunner — prompt watchdog (C1)", () => {
	test("a prompt that resolves without ever starting a run is flipped to error by the watchdog", async () => {
		const h = makeRunner({ promptWatchdogMs: 90000 });
		const task = await h.runner.launch(req());
		// prompt() resolved fine (the pi success:false swallow). No agent_start, no
		// agent_end. The watchdog timer is armed.
		expect(h.timers.count()).toBeGreaterThanOrEqual(1);
		h.timers.fireAll();
		const done = await h.runner.awaitCompletion(task.id);
		expect(done.status).toBe("error");
		expect(done.error).toMatch(/no agent activity|preflight/i);
		expect(h.concurrency.runningCount("anthropic/opus")).toBe(0);
	});

	test("agent_start disarms the watchdog so a slow real run is not misclassified", async () => {
		const h = makeRunner({ promptWatchdogMs: 90000 });
		const task = await h.runner.launch(req());
		const fake = h.factory.last();
		fake.emit(agentStart());
		h.timers.fireAll(); // any leftover timers fire — must NOT error the task
		await flush();
		expect((await h.runner.readOutput(task.id)).status).toBe("running");
		fake.emit(endOk());
		expect((await h.runner.awaitCompletion(task.id)).status).toBe("completed");
	});

	test("prompt() rejection (process death) routes through the .catch, not the watchdog", async () => {
		const h = makeRunner({
			configureFake: (f) => {
				f.promptError = new Error("Agent process exited (code=1)");
			},
		});
		const task = await h.runner.launch(req());
		const done = await h.runner.awaitCompletion(task.id);
		expect(done.status).toBe("error");
		expect(h.concurrency.runningCount("anthropic/opus")).toBe(0);
	});
});

// --- start() failure -------------------------------------------------------

describe("SessionRunner — start() failure", () => {
	test("rpc.start rejects → launch rejects, task error, slot released, orphan stopped", async () => {
		const h = makeRunner({
			configureFake: (f) => {
				f.startError = new Error("boom on start");
			},
		});
		await expect(h.runner.launch(req())).rejects.toThrow(/boom on start/);
		const fake = h.factory.last();
		expect(fake.log.stopCount).toBe(1); // orphan stopped by the catch
		expect(h.concurrency.runningCount("anthropic/opus")).toBe(0);
		const tasks = h.runner.list();
		expect(tasks[0]?.status).toBe("error");
	});
});

// --- cancel ----------------------------------------------------------------

describe("SessionRunner — cancel", () => {
	test("cancel of running task: abort issued, child stopped, slot released, terminal cancelled", async () => {
		const h = makeRunner();
		const task = await h.runner.launch(req());
		const fake = h.factory.last();
		const done = await h.runner.cancel(task.id);
		expect(done.status).toBe("cancelled");
		expect(fake.log.abortCount).toBe(1);
		expect(fake.log.stopCount).toBe(1);
		expect(h.concurrency.runningCount("anthropic/opus")).toBe(0);
	});

	test("cancel during launch acquire (slot saturated): no child created, waiter cancelled, slot clean", async () => {
		const conc = new ConcurrencyManager({ defaultConcurrency: 1 });
		const h = makeRunner({ concurrency: conc });
		const t1 = await h.runner.launch(req());
		expect(conc.runningCount("anthropic/opus")).toBe(1);
		// second launch queues (limit 1). Start it, do not await.
		const p2 = h.runner.launch(req());
		await flush();
		const queuedTasks = h.runner.list().filter((t) => t.status === "pending");
		expect(queuedTasks.length).toBe(1);
		const queued = queuedTasks[0]!;
		const cancelled = await h.runner.cancel(queued.id);
		expect(cancelled.status).toBe("cancelled");
		const t2 = await p2;
		expect(t2.status).toBe("cancelled");
		// only ONE child ever created (for t1)
		expect(h.factory.created.length).toBe(1);
		// releasing t1 must hand the slot cleanly; queue empty
		expect(conc.queueLength("anthropic/opus")).toBe(0);
	});

	test("cancel after terminal is a no-op (returns terminal, no second teardown)", async () => {
		let completeHookCalls = 0;
		const h = makeRunner({ onTaskComplete: () => (completeHookCalls += 1) });
		const task = await h.runner.launch(req());
		h.factory.last().emit(endOk());
		await h.runner.awaitCompletion(task.id);
		expect(completeHookCalls).toBe(1);
		const after = await h.runner.cancel(task.id);
		expect(after.status).toBe("completed");
		expect(completeHookCalls).toBe(1); // not re-fired
		expect(h.factory.last().log.stopCount).toBe(1); // not re-stopped
	});

	test("cancel mid-run while child still streaming: the late agent_end is a denied no-op", async () => {
		const h = makeRunner();
		const task = await h.runner.launch(req());
		const fake = h.factory.last();
		await h.runner.cancel(task.id);
		// a late agent_end from the aborted run must not re-flip
		fake.emit(endOk());
		expect((await h.runner.readOutput(task.id)).status).toBe("cancelled");
	});
});

// --- resume ----------------------------------------------------------------

describe("SessionRunner — resume", () => {
	test("resume spawns a FRESH child against the SAME session id/dir and dispatches the new prompt", async () => {
		const h = makeRunner();
		const task = await h.runner.launch(req());
		h.factory.last().emit(endOk("turn 1"));
		await h.runner.awaitCompletion(task.id);
		expect(h.factory.created.length).toBe(1);

		const resumed = await h.runner.resume(task.id, "turn 2 prompt");
		expect(resumed.status).toBe("running");
		expect(h.factory.created.length).toBe(2);
		const fresh = h.factory.last();
		expect(fresh.opts.sessionId).toBe(task.id); // SAME session id
		expect(fresh.opts.sessionDir).toBe("/sessions");
		expect(fresh.log.prompts).toEqual(["turn 2 prompt"]);

		fresh.emit(endOk("turn 2"));
		const done = await h.runner.awaitCompletion(task.id);
		expect(done.status).toBe("completed");
	});

	test("resume re-applies the launch's persisted pi-native knobs to the fresh child", async () => {
		const h = makeRunner();
		const task = await h.runner.launch(
			req({
				appendSystemPrompt: "You are a careful reviewer.",
				tools: ["read", "grep"],
			}),
		);
		h.factory.last().emit(endOk("turn 1"));
		await h.runner.awaitCompletion(task.id);

		await h.runner.resume(task.id, "turn 2 prompt");
		const fresh = h.factory.last();
		expect(fresh.opts.appendSystemPrompt).toBe("You are a careful reviewer.");
		expect(fresh.opts.tools).toEqual(["read", "grep"]);
	});

	test("resume rejects on a running task (taskStillRunning), task unchanged", async () => {
		const h = makeRunner();
		const task = await h.runner.launch(req());
		await expect(h.runner.resume(task.id, "x")).rejects.toThrow(
			/taskStillRunning/,
		);
		expect((await h.runner.readOutput(task.id)).status).toBe("running");
	});

	test("concurrent resume rejects (resumeInFlight), single fresh child", async () => {
		const h = makeRunner();
		const task = await h.runner.launch(req());
		h.factory.last().emit(endOk());
		await h.runner.awaitCompletion(task.id);
		// hang the fresh child's start so the first resume stays in-flight
		const h2configured: FakeRpcClient[] = [];
		h.factory.configure = (f) => {
			f.deferNextStart();
			h2configured.push(f);
		};
		const p1 = h.runner.resume(task.id, "a");
		await flush();
		await expect(h.runner.resume(task.id, "b")).rejects.toThrow(
			/resumeInFlight/,
		);
		// release the deferred start so p1 completes
		h2configured[0]?.resolveStart();
		const r1 = await p1;
		expect(r1.status).toBe("running");
		expect(h2configured.length).toBe(1); // only one fresh child
	});

	test("resume re-acquires the slot; a saturated queue times out and rejects cleanly", async () => {
		const conc = new ConcurrencyManager({ defaultConcurrency: 1 });
		const h = makeRunner({ concurrency: conc });
		const task = await h.runner.launch(req());
		h.factory.last().emit(endOk());
		await h.runner.awaitCompletion(task.id);
		// occupy the single slot with another launch that never finishes. Disarm
		// its prompt watchdog (emit agent_start) so the only armed timer left is the
		// resume acquire-timeout — otherwise firing the blocker's watchdog would
		// error it, free the slot, and hand it to the queued resume.
		await h.runner.launch(req());
		h.factory.last().emit(agentStart());
		expect(conc.runningCount("anthropic/opus")).toBe(1);
		// resume queues; fire the acquire-timeout timer
		const p = h.runner.resume(task.id, "blocked");
		await flush();
		expect(h.timers.count()).toBe(1); // only the resume acquire-timeout
		h.timers.fireAll();
		await expect(p).rejects.toThrow(/resumeTimeout/);
		expect(conc.queueLength("anthropic/opus")).toBe(0); // waiter cleaned up
	});
});

// --- readOutput ------------------------------------------------------------

describe("SessionRunner — readOutput", () => {
	test("running task: reads from the LIVE child; summary = last assistant text", async () => {
		const h = makeRunner();
		const task = await h.runner.launch(req());
		const fake = h.factory.last();
		fake.messages = [
			{ role: "user", content: "q" },
			assistantMsg("stop", "live answer"),
		];
		const out = await h.runner.readOutput(task.id);
		expect(out.status).toBe("running");
		expect(out.summaryText).toBe("live answer");
		expect(fake.log.getMessagesCount).toBe(1);
	});

	test("terminal task: reads from DISK via the transcript reader", async () => {
		let readerArgs: { sessionId: string; sessionFile?: string } | undefined;
		const reader: SessionTranscriptReader = async (args) => {
			readerArgs = args;
			return [assistantMsg("stop", "disk answer")];
		};
		const h = makeRunner({ transcriptReader: reader });
		const task = await h.runner.launch(req());
		h.factory.last().emit(endOk());
		await h.runner.awaitCompletion(task.id);
		const out = await h.runner.readOutput(task.id, { full: true });
		expect(out.status).toBe("completed");
		expect(out.summaryText).toBe("disk answer");
		expect(readerArgs?.sessionId).toBe(task.id);
		expect(readerArgs?.sessionFile).toBe("/sessions/file.jsonl");
		// no live child consulted for a terminal task
		expect(h.factory.last().log.getMessagesCount).toBe(0);
	});

	test("full transcript: user + assistant text kept, tool result folded & capped", async () => {
		const longErr = `prefix ${"x".repeat(3000)} the actual failure: timeout at the end`;
		const reader: SessionTranscriptReader = async () => [
			{ role: "user", content: "hello" },
			assistantMsg("stop", "hi there"),
			{
				role: "toolResult",
				toolCallId: "c1",
				toolName: "bash",
				content: [{ type: "text", text: longErr }],
			},
		];
		const h = makeRunner({ transcriptReader: reader });
		const task = await h.runner.launch(req());
		h.factory.last().emit(endOk());
		await h.runner.awaitCompletion(task.id);
		const out = await h.runner.readOutput(task.id, { full: true });
		expect(out.messages).toBeDefined();
		const roles = out.messages!.map((m) => m.role);
		expect(roles).toEqual(["user", "assistant", "assistant"]);
		const toolPart = out.messages![2]!.parts[0]!;
		expect(toolPart.type).toBe("tool");
		// error-shaped → head+tail preserved, total under the cap, end survives
		expect(toolPart.text).toContain("truncated");
		expect(toolPart.text).toContain("timeout at the end");
	});

	test("pending task (no session) → graceful empty, no reader/child call", async () => {
		const conc = new ConcurrencyManager({ defaultConcurrency: 1 });
		let readerCalls = 0;
		const h = makeRunner({
			concurrency: conc,
			transcriptReader: async () => {
				readerCalls += 1;
				return [];
			},
		});
		await h.runner.launch(req()); // takes the slot
		const p2 = h.runner.launch(req()); // queues, pending, no session
		await flush();
		const pending = h.runner.list().find((t) => t.status === "pending")!;
		const out = await h.runner.readOutput(pending.id);
		expect(out.status).toBe("pending");
		expect(out.summaryText).toBe("");
		expect(readerCalls).toBe(0);
		// cleanup the queued launch
		await h.runner.cancel(pending.id);
		await p2;
	});

	test("reader rejection degrades to the recorded error, never throws", async () => {
		const h = makeRunner({
			transcriptReader: async () => {
				throw new Error("disk gone");
			},
		});
		const task = await h.runner.launch(req());
		h.factory.last().emit(endError("the recorded error"));
		await h.runner.awaitCompletion(task.id);
		const out = await h.runner.readOutput(task.id);
		expect(out.status).toBe("error");
		expect(out.summaryText).toBe("the recorded error");
	});
});

// --- list ------------------------------------------------------------------

describe("SessionRunner — list", () => {
	test("reflects task states, ordered by createdAt, filterable by parent", async () => {
		const h = makeRunner();
		const a = await h.runner.launch(req({ parentSessionID: "p1" }));
		const b = await h.runner.launch(req({ parentSessionID: "p2" }));
		h.factory.created[0]!.emit(endOk());
		await h.runner.awaitCompletion(a.id);
		const all = h.runner.list();
		expect(all.length).toBe(2);
		expect(all.find((t) => t.id === a.id)?.status).toBe("completed");
		expect(all.find((t) => t.id === b.id)?.status).toBe("running");
		const onlyP2 = h.runner.list("p2");
		expect(onlyP2.map((t) => t.id)).toEqual([b.id]);
	});
});

// --- slot accounting -------------------------------------------------------

describe("SessionRunner — slot accounting", () => {
	test("returns to baseline after launch+complete, launch+cancel, launch+error", async () => {
		const h = makeRunner();
		const key = "anthropic/opus";
		const base = h.concurrency.runningCount(key);

		const c = await h.runner.launch(req());
		h.factory.last().emit(endOk());
		await h.runner.awaitCompletion(c.id);
		expect(h.concurrency.runningCount(key)).toBe(base);

		const x = await h.runner.launch(req());
		await h.runner.cancel(x.id);
		expect(h.concurrency.runningCount(key)).toBe(base);

		const e = await h.runner.launch(req());
		h.factory.last().emit(endError("err"));
		await h.runner.awaitCompletion(e.id);
		expect(h.concurrency.runningCount(key)).toBe(base);
	});

	test("a queued launch is granted the slot when the holder completes", async () => {
		const conc = new ConcurrencyManager({ defaultConcurrency: 1 });
		const h = makeRunner({ concurrency: conc });
		const t1 = await h.runner.launch(req());
		const p2 = h.runner.launch(req());
		await flush();
		expect(conc.runningCount("anthropic/opus")).toBe(1);
		// complete t1 → slot handed to the queued launch
		h.factory.created[0]!.emit(endOk());
		await h.runner.awaitCompletion(t1.id);
		const t2 = await p2;
		expect(t2.status).toBe("running");
		expect(h.factory.created.length).toBe(2);
	});
});

// --- depth guard -----------------------------------------------------------

describe("SessionRunner — depth guard", () => {
	test("depth >= maxDepth rejects, no task registered, no child, no slot touched", async () => {
		const h = makeRunner();
		await expect(h.runner.launch(req({ depth: 2 }))).rejects.toThrow(/depth/);
		expect(h.runner.list().length).toBe(0);
		expect(h.factory.created.length).toBe(0);
		expect(h.concurrency.runningCount("anthropic/opus")).toBe(0);
	});
});

// --- restart recovery ------------------------------------------------------

describe("SessionRunner — restart recovery", () => {
	function recoveredTask(over: Partial<BgTask>): BgTask {
		return {
			id: "bg_recov01",
			parentSessionID: "p",
			description: "d",
			agent: "build",
			status: "running",
			createdAt: 1,
			depth: 0,
			concurrencyKey: "anthropic/opus",
			model: "anthropic/opus",
			sessionID: "bg_recov01",
			...over,
		};
	}

	test("non-terminal recovered task is finalized error('lost during restart'), no child spawned", async () => {
		const rec = recoveredTask({ status: "running" });
		const h = makeRunner({ recoveredTasks: [rec] });
		const done = await h.runner.awaitCompletion(rec.id);
		expect(done.status).toBe("error");
		expect(done.error).toBe("lost during restart");
		expect(h.factory.created.length).toBe(0); // no re-attach
	});

	test("terminal recovered task is registered as-is and remains readable/listable", async () => {
		const rec = recoveredTask({ status: "completed", completedAt: 2 });
		const h = makeRunner({
			recoveredTasks: [rec],
			transcriptReader: async () => [assistantMsg("stop", "from disk")],
		});
		const listed = h.runner.list();
		expect(listed.map((t) => t.id)).toEqual([rec.id]);
		const out = await h.runner.readOutput(rec.id);
		expect(out.status).toBe("completed");
		expect(out.summaryText).toBe("from disk");
		expect(h.factory.created.length).toBe(0);
	});

	test("recovered task holds NO concurrency slot", async () => {
		const rec = recoveredTask({ status: "running" });
		const h = makeRunner({ recoveredTasks: [rec] });
		await h.runner.awaitCompletion(rec.id);
		expect(h.concurrency.runningCount("anthropic/opus")).toBe(0);
	});
});

// --- dispose ---------------------------------------------------------------

describe("SessionRunner — dispose", () => {
	test("dispose stops every live child and rejects pending awaiters", async () => {
		const h = makeRunner();
		const task = await h.runner.launch(req());
		const fake = h.factory.last();
		const waiting = h.runner.awaitCompletion(task.id);
		await h.runner.dispose();
		expect(fake.log.stopCount).toBe(1);
		await expect(waiting).rejects.toThrow(/disposed/i);
	});
});
