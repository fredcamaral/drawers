/**
 * Shared test doubles for the bg-agents extension unit tests.
 *
 * Two seams are faked here:
 *
 *   - {@link FakeRpcClient}/{@link FakeFactory} — the runner DI seam, ported from
 *     core's `session-runner.test.ts`. One fake == one synthetic pi child. Tests
 *     emit synthetic `agent_end`/exit to drive a real {@link createSessionRunner}
 *     through {@link createEngine} without spawning a `pi --mode rpc` process.
 *   - {@link makeScriptedRunner} — a hand-scripted {@link SessionRunner} for the
 *     per-tool unit tests, where the tool's job is pure argument mapping + error
 *     translation and a full engine is unnecessary. Unimplemented methods throw,
 *     so any test that trips one is exercising a path the tool should not touch.
 *
 * NOT a `.test.ts` file: it is a helper imported BY tests. The default `bun test`
 * glob never collects it as a suite, and it carries no top-level side effects.
 *
 * Node-safe: no Bun.* APIs.
 */

import type {
	BgTask,
	PiAgentMessage,
	ReadOpts,
	RpcAgentEvent,
	RpcClientCreateOptions,
	RpcClientFactory,
	RpcClientLike,
	RpcExitInfo,
	SessionRunner,
	TaskOutput,
} from "@drawers/pi-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// --- the fake RpcClientLike (ported from core/session-runner.test.ts) ------

export interface FakeCallLog {
	startCount: number;
	stopCount: number;
	abortCount: number;
	prompts: string[];
	getMessagesCount: number;
}

/** A synthetic pi child. `emit`/`emitExit` push synthetic events to subscribers. */
export class FakeRpcClient implements RpcClientLike {
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
	startError?: Error;
	promptError?: Error;

	constructor(opts: RpcClientCreateOptions) {
		this.opts = opts;
	}

	async start(): Promise<void> {
		this.log.startCount += 1;
		if (this.startError) {
			throw this.startError;
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
}

/** A factory recording every created fake child in order. */
export class FakeFactory implements RpcClientFactory {
	readonly created: FakeRpcClient[] = [];
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

// --- synthetic pi message/event builders ----------------------------------

export function assistantMsg(
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

export function endOk(text = "done"): RpcAgentEvent {
	return {
		type: "agent_end",
		messages: [assistantMsg("stop", text)],
		willRetry: false,
	};
}

export function endError(msg: string): RpcAgentEvent {
	return {
		type: "agent_end",
		messages: [assistantMsg("error", "x", msg)],
		willRetry: false,
	};
}

/** Flush the microtask queue a few turns. */
export async function flush(): Promise<void> {
	for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

// --- a hand-scripted SessionRunner for the per-tool unit tests --------------

export interface ScriptedRunner extends SessionRunner {
	launched: import("@drawers/pi-core").LaunchRequest[];
	resumed: Array<{ taskId: string; prompt: string }>;
	cancelled: string[];
}

export interface RunnerScript {
	listTasks?: BgTask[];
	onLaunch?: (req: import("@drawers/pi-core").LaunchRequest) => Promise<BgTask>;
	onResume?: (taskId: string, prompt: string) => Promise<BgTask>;
	onCancel?: (taskId: string) => Promise<BgTask>;
	onAwaitCompletion?: (taskId: string, timeoutMs?: number) => Promise<BgTask>;
	onReadOutput?: (taskId: string, opts?: ReadOpts) => Promise<TaskOutput>;
}

export function makeScriptedRunner(script: RunnerScript = {}): ScriptedRunner {
	const launched: import("@drawers/pi-core").LaunchRequest[] = [];
	const resumed: Array<{ taskId: string; prompt: string }> = [];
	const cancelled: string[] = [];
	const notImpl = (name: string) => (): never => {
		throw new Error(`ScriptedRunner.${name} should not be called`);
	};

	return {
		launched,
		resumed,
		cancelled,
		list: (parent?: string) => {
			const all = script.listTasks ?? [];
			return parent === undefined
				? all
				: all.filter((t) => t.parentSessionID === parent);
		},
		launch: async (req) => {
			launched.push(req);
			if (script.onLaunch) return script.onLaunch(req);
			return {
				id: "bg_launched",
				sessionID: "bg_launched",
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
			if (script.onResume) return script.onResume(taskId, prompt);
			return {
				id: taskId,
				parentSessionID: "parent_1",
				description: "resumed",
				agent: "build",
				status: "running",
				createdAt: 0,
				depth: 0,
				concurrencyKey: "k",
			};
		},
		cancel: async (taskId) => {
			cancelled.push(taskId);
			if (script.onCancel) return script.onCancel(taskId);
			return {
				id: taskId,
				parentSessionID: "parent_1",
				description: "cancelled",
				agent: "build",
				status: "cancelled",
				createdAt: 0,
				depth: 0,
				concurrencyKey: "k",
			};
		},
		awaitCompletion: (script.onAwaitCompletion ??
			notImpl("awaitCompletion")) as SessionRunner["awaitCompletion"],
		readOutput: (script.onReadOutput ??
			notImpl("readOutput")) as SessionRunner["readOutput"],
		dispose: notImpl("dispose") as SessionRunner["dispose"],
	};
}

// --- a minimal ExtensionContext for tool/notifier tests ---------------------

export interface FakeContextOptions {
	hasUI?: boolean;
	idle?: boolean;
	setStatusThrows?: boolean;
	notifyThrows?: boolean;
}

export interface FakeContextProbe {
	statusCalls: Array<{ key: string; text: string }>;
	notifyCalls: Array<{ message: string; level: string }>;
}

/**
 * Builds a structural {@link ExtensionContext} carrying ONLY the fields the bg
 * tools + notifier read (`hasUI`, `ui.setStatus`, `ui.notify`, `isIdle`). Cast to
 * the full type at the boundary — the unread surface is irrelevant to these
 * tests, and faking the entire 40-field context would be noise.
 */
export function makeFakeContext(opts: FakeContextOptions = {}): {
	ctx: ExtensionContext;
	probe: FakeContextProbe;
} {
	const probe: FakeContextProbe = { statusCalls: [], notifyCalls: [] };
	const ctx = {
		hasUI: opts.hasUI ?? true,
		isIdle: () => opts.idle ?? true,
		ui: {
			setStatus: (key: string, text: string) => {
				if (opts.setStatusThrows) throw new Error("setStatus boom");
				probe.statusCalls.push({ key, text });
			},
			notify: (message: string, level: string) => {
				if (opts.notifyThrows) throw new Error("notify boom");
				probe.notifyCalls.push({ message, level });
			},
		},
	} as unknown as ExtensionContext;
	return { ctx, probe };
}
