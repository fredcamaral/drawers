/**
 * The pi RPC seam — the dependency-injection boundary between the SessionRunner
 * and a `pi --mode rpc` child process.
 *
 * One {@link RpcClientLike} == one OS process == one pi session. The runner
 * depends ONLY on the structural {@link RpcClientLike} interface and a
 * {@link RpcClientFactory}, so tests inject a fake that emits synthetic events
 * and the production path ({@link createRpcClientFactory}) wraps the exported
 * `RpcClient` from `@earendil-works/pi-coding-agent`.
 *
 * Two findings shape this seam, both confirmed against pi 0.79.3:
 *
 *  1. `RpcClient.onEvent`'s listener is typed `(e: AgentEvent) => void` — the
 *     BARE agent-core union, which lacks `willRetry` and the retry/extension
 *     variants. The WIRE data is the richer `AgentSessionEvent` (RPC mode emits
 *     it verbatim, rewriting `agent_end` with `willRetry`). So the runner reads
 *     events through {@link RpcAgentEvent}, the correctly-typed union, NOT the
 *     mistyped stock listener type.
 *
 *  2. `RpcClient` exposes NO exit/error EVENT — a child that crashes BETWEEN
 *     turns is invisible until the next command rejects. {@link RpcClientLike}
 *     therefore adds {@link RpcClientLike.onExit}, which the real factory wires
 *     onto the underlying child process's own `exit`/`error` listeners (it owns
 *     the spawn rather than reusing the stock `RpcClient`'s private child).
 *
 * Node-safe: no Bun.* APIs.
 */

import { resolve } from "node:path";

// --- pi message/content shapes (narrowed) ---------------------------------
// Narrowed structural copies of the pi 0.79.3 types we read off the transcript.
// We do NOT import them from the package: the runner only reads a handful of
// fields, and a structural copy keeps core free of a value-level pi dependency
// and lets tests build messages without the full pi type surface.

export interface PiTextContent {
	type: "text";
	text: string;
}

export interface PiToolCall {
	type: "toolCall";
	id: string;
	name: string;
}

/** Any other assistant content block (thinking, image, …) — ignored on read. */
export interface PiOtherContent {
	type: string;
	[k: string]: unknown;
}

export type PiAssistantContent = PiTextContent | PiToolCall | PiOtherContent;

/** pi `StopReason` (pi-ai types.ts). Classifies a terminal `agent_end`. */
export type PiStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface PiUserMessage {
	role: "user";
	content: string | PiAssistantContent[];
}

export interface PiAssistantMessage {
	role: "assistant";
	content: PiAssistantContent[];
	stopReason?: PiStopReason;
	errorMessage?: string;
}

export interface PiToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: PiAssistantContent[];
	isError?: boolean;
}

/** The transcript message union the runner reads (narrowed pi `AgentMessage`). */
export type PiAgentMessage =
	| PiUserMessage
	| PiAssistantMessage
	| PiToolResultMessage
	| { role: string; [k: string]: unknown };

/** A pi image content part forwarded to `prompt` (narrowed pi `ImageContent`). */
export interface PiImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

// --- the event union the runner narrows ------------------------------------

/**
 * The rich agent-session event the runner narrows. Matches what RPC mode emits
 * on stdout (`AgentSessionEvent`), which is strictly richer than the type
 * `RpcClient.onEvent` advertises:
 *  - `agent_start` marks a run actually beginning — emitted only AFTER preflight
 *    succeeds, so it disarms the prompt watchdog (the run is genuinely under way).
 *  - `agent_end` carries `willRetry` (TRUE = pi will auto-retry → NON-terminal;
 *    FALSE = the run is done, success OR final error).
 *  - `auto_retry_start` / `auto_retry_end` are transient, NOT terminal.
 *  - `extension_error` is an out-of-band error surfaced during a turn.
 * Everything else passes through as a generic `{ type, … }`.
 */
export type RpcAgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: PiAgentMessage[]; willRetry: boolean }
	| {
			type: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| {
			type: "auto_retry_end";
			success: boolean;
			attempt: number;
			finalError?: string;
	  }
	| {
			type: "extension_error";
			extensionPath: string;
			event: string;
			error: string;
	  }
	| { type: string; [k: string]: unknown };

/** How a torn-down/terminal child signals exit (wired by the real factory). */
export interface RpcExitInfo {
	code: number | null;
	signal: string | null;
	error?: Error;
}

/**
 * The structural surface the SessionRunner depends on. Deliberately minimal so
 * neither tests nor the runner bind to pi's internal types harder than needed.
 *
 * `waitForIdle` is intentionally ABSENT: the stock implementation resolves on
 * the FIRST `agent_end` regardless of `willRetry`, so it would complete a turn
 * pi is about to auto-retry. The runner builds completion from raw `onEvent` +
 * `onExit` instead (see the completion fuser).
 */
export interface RpcClientLike {
	/** Spawn the child. Rejects if it dies immediately. */
	start(): Promise<void>;
	/** SIGTERM → grace → SIGKILL. Idempotent. */
	stop(): Promise<void>;
	/** Send a prompt. Resolves on command ACK; REJECTS if the prompt is refused
	 *  before acceptance or the child is already dead. Completion arrives via
	 *  events, never via this promise. */
	prompt(message: string, images?: PiImageContent[]): Promise<void>;
	/** Abort the in-flight run. The run still concludes with an `agent_end`
	 *  whose last assistant `stopReason` is `aborted`. */
	abort(): Promise<void>;
	/** Subscribe to the (correctly-typed) event stream. Returns an unsubscribe. */
	onEvent(listener: (event: RpcAgentEvent) => void): () => void;
	/** Subscribe to child exit/error. NOT on stock `RpcClient`; the real factory
	 *  wires the child process's `exit`/`error` listeners. Returns unsubscribe. */
	onExit(listener: (info: RpcExitInfo) => void): () => void;
	/** Full live transcript (`get_messages`). */
	getMessages(): Promise<PiAgentMessage[]>;
	/** Session state, carrying the pi-assigned/minted session id + file. */
	getState(): Promise<{
		sessionId: string;
		sessionFile?: string;
		isStreaming: boolean;
	}>;
	/** Best-effort stderr capture for error context. */
	getStderr(): string;
}

export interface RpcClientCreateOptions {
	/** Worktree root (LaunchRequest.directory). Passed as the child cwd, which
	 *  re-roots the worker's bash/edit/read. */
	cwd?: string;
	/** `provider/model` split into pi's `--provider`/`--model`, or passed raw. */
	model?: string;
	/** Session id minted by the runner. Passed as `--session-id`; reused on
	 *  resume so pi re-attaches and replays the persisted transcript. */
	sessionId?: string;
	/** Session storage/lookup dir. Passed as `--session-dir`. */
	sessionDir?: string;
	/**
	 * Extra system-prompt text (or a file path) appended to the child's default
	 * coding-assistant prompt. Passed as `--append-system-prompt <value>`. This is
	 * the pi-native way to run a child "as" an agent: the agent definition's
	 * markdown body becomes the appended prompt. pi has NO `--agent` flag — the
	 * agent concept is resolved by the CALLER (see bg-agents' agent resolver), not
	 * by pi from a name. Omitted → the child runs its default coding assistant.
	 */
	appendSystemPrompt?: string;
	/**
	 * Tool allow-list for the child. Joined to a CSV and passed as
	 * `--tools <csv>` (only when non-empty). Mirrors a pi agent definition's
	 * `tools` frontmatter. Omitted/empty → pi's default tool set.
	 */
	tools?: string[];
	/** Arbitrary extra CLI args appended last. */
	extraArgs?: string[];
}

export interface RpcClientFactory {
	/** Spawn one `pi --mode rpc` child = one session. */
	create(opts: RpcClientCreateOptions): RpcClientLike;
}

/**
 * Read a session's persisted transcript from disk — the `readOutput` path for a
 * terminal/torn-down task (no live child). Injected so the runner does not bind
 * to pi's `SessionManager`; the real implementation
 * ({@link createSessionTranscriptReader}) opens the session file and resolves
 * the message list.
 */
export type SessionTranscriptReader = (args: {
	sessionId: string;
	sessionFile?: string;
	sessionDir?: string;
	cwd?: string;
}) => Promise<PiAgentMessage[]>;

// --- the real, pi-backed factory -------------------------------------------

/** Split a `provider/model` string into pi's provider + model parts. */
function splitModel(model: string | undefined): {
	provider?: string;
	model?: string;
} {
	if (!model) {
		return {};
	}
	const slash = model.indexOf("/");
	if (slash === -1) {
		return { model };
	}
	return { provider: model.slice(0, slash), model: model.slice(slash + 1) };
}

/** The same split rendered as CLI flags, for the observer-child invocation. */
function modelArgs(model: string | undefined): string[] {
	const { provider, model: m } = splitModel(model);
	const args: string[] = [];
	if (provider !== undefined) {
		args.push("--provider", provider);
	}
	if (m !== undefined) {
		args.push("--model", m);
	}
	return args;
}

/** Build the `args` array appended after `--mode rpc` (handled by RpcClient). */
function sessionArgs(opts: RpcClientCreateOptions): string[] {
	const args: string[] = [];
	if (opts.sessionId !== undefined) {
		args.push("--session-id", opts.sessionId);
	}
	if (opts.sessionDir !== undefined) {
		args.push("--session-dir", opts.sessionDir);
	}
	if (opts.appendSystemPrompt !== undefined) {
		args.push("--append-system-prompt", opts.appendSystemPrompt);
	}
	if (opts.tools && opts.tools.length > 0) {
		args.push("--tools", opts.tools.join(","));
	}
	if (opts.extraArgs && opts.extraArgs.length > 0) {
		args.push(...opts.extraArgs);
	}
	return args;
}

/**
 * The methods the real factory needs off the stock `RpcClient`. Structural so
 * `createRpcClientFactory` can be unit-tested with a fake `RpcClient` and so
 * core does not bind to the pi value-level type. The real `RpcClient` is
 * assignable (its `onEvent` listener is broader-typed but call-compatible).
 */
export interface StockRpcClient {
	start(): Promise<void>;
	stop(): Promise<void>;
	prompt(message: string, images?: unknown[]): Promise<void>;
	abort(): Promise<void>;
	onEvent(listener: (event: unknown) => void): () => void;
	getMessages(): Promise<unknown[]>;
	getState(): Promise<{
		sessionId: string;
		sessionFile?: string;
		isStreaming: boolean;
	}>;
	getStderr(): string;
}

/** Constructs a stock `RpcClient` given the resolved options. */
export type StockRpcClientCtor = (opts: {
	cliPath?: string;
	cwd?: string;
	provider?: string;
	model?: string;
	args?: string[];
}) => StockRpcClient;

export interface RpcClientFactoryDeps {
	/** Absolute path to the installed pi `dist/cli.js`. REQUIRED — the stock
	 *  default `"dist/cli.js"` is relative and ENOENTs under the wrong cwd. */
	cliPath: string;
	/** Construct a stock RpcClient. Defaults to the real `RpcClient` ctor when
	 *  the package is resolvable; tests inject a fake. */
	rpcClientCtor: StockRpcClientCtor;
	logger?: {
		debug?(msg: string, meta?: Record<string, unknown>): void;
		error?(msg: string, meta?: Record<string, unknown>): void;
	};
}

/** True for an error message shaped like a `RpcClient` process-death rejection
 *  (`Agent process exited (…)` / `Agent process error: …` / stdin-not-writable).
 *  These are the ONLY ways the stock client surfaces a dead child (finding #2). */
function isProcessDeathError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return (
		msg.includes("Agent process exited") ||
		msg.includes("Agent process error") ||
		msg.includes("stdin is not writable") ||
		msg.includes("stdin error")
	);
}

/**
 * The production factory. Each `create()` returns an {@link RpcClientLike}
 * backed by a stock `RpcClient` (which owns the live RPC pipe and the correct
 * JSONL framing — finding #7).
 *
 * EXIT DETECTION (finding #2): the stock `RpcClient` exposes neither an exit
 * event nor its child process — a dead child surfaces ONLY as a rejected
 * `prompt`/`abort`/`getState`/`getMessages` promise. We do NOT spawn a second
 * process to observe exit first-hand: a second `pi --mode rpc` against the same
 * `--session-id` would contend on the session file. Instead `onExit` is fired
 * (exactly once) when any wrapped command rejects with a process-death-shaped
 * error. This is an HONEST limitation: a crash strictly between turns (no
 * outstanding command) is detected at the NEXT command the runner issues
 * (resume/cancel/readOutput) — at which point that command's rejection fires
 * `onExit`. There is no live between-turns crash signal through the stock
 * client; surfacing one would require a forked client that exposes its child.
 */
export function createRpcClientFactory(
	deps: RpcClientFactoryDeps,
): RpcClientFactory {
	return {
		create(opts: RpcClientCreateOptions): RpcClientLike {
			const sArgs = sessionArgs(opts);
			const { provider, model } = splitModel(opts.model);
			const client = deps.rpcClientCtor({
				cliPath: deps.cliPath,
				cwd: opts.cwd,
				provider,
				model,
				args: sArgs,
			});

			const exitListeners: Array<(info: RpcExitInfo) => void> = [];
			let exited = false;

			const emitExit = (info: RpcExitInfo): void => {
				if (exited) {
					return;
				}
				exited = true;
				for (const l of [...exitListeners]) {
					try {
						l(info);
					} catch (err) {
						deps.logger?.error?.("onExit listener threw", {
							err: err instanceof Error ? err.message : String(err),
						});
					}
				}
			};

			/** Run a stock-client command; if it rejects with a process-death error,
			 *  fire `onExit` before rethrowing so the fuser sees the crash. */
			const observed = async <T>(op: () => Promise<T>): Promise<T> => {
				try {
					return await op();
				} catch (err) {
					if (isProcessDeathError(err)) {
						emitExit({
							code: null,
							signal: null,
							error: err instanceof Error ? err : new Error(String(err)),
						});
					}
					throw err;
				}
			};

			return {
				start: () => observed(() => client.start()),
				async stop(): Promise<void> {
					// A deliberate stop is not a crash — suppress onExit by marking
					// exited first (a stop-time rejection is teardown noise).
					exited = true;
					await client.stop();
				},
				prompt: (message, images) =>
					observed(() => client.prompt(message, images)),
				abort: () => observed(() => client.abort()),
				onEvent(listener: (event: RpcAgentEvent) => void): () => void {
					// The wire data is the rich AgentSessionEvent; the stock listener
					// type lies by omission, so we cast at the boundary.
					//
					// pi dispatches events SYNCHRONOUSLY inside the child stdout "data"
					// handler with NO try/catch around its listener loop (rpc-client.js
					// handleLine). A synchronous throw here would propagate out of a Node
					// stream emit and become an uncaught exception that kills the parent
					// (the drawers host). Guard the listener the same way emitExit guards
					// onExit listeners: log and swallow.
					return client.onEvent((event) => {
						try {
							listener(event as RpcAgentEvent);
						} catch (err) {
							deps.logger?.error?.("onEvent listener threw", {
								err: err instanceof Error ? err.message : String(err),
							});
						}
					});
				},
				onExit(listener: (info: RpcExitInfo) => void): () => void {
					exitListeners.push(listener);
					return () => {
						const i = exitListeners.indexOf(listener);
						if (i !== -1) {
							exitListeners.splice(i, 1);
						}
					};
				},
				getMessages: () =>
					observed(() => client.getMessages()) as Promise<PiAgentMessage[]>,
				getState: () => observed(() => client.getState()),
				getStderr: () => client.getStderr(),
			};
		},
	};
}

/**
 * The production transcript reader: opens the session file via pi's
 * `SessionManager` and resolves the materialized message list. The pi module is
 * imported LAZILY (dynamic `import`) so core stays loadable in environments
 * where pi is not installed (tests inject their own reader) and so the value
 * dependency never enters the static graph.
 */
export function createSessionTranscriptReader(): SessionTranscriptReader {
	return async ({ sessionFile, sessionId, sessionDir, cwd }) => {
		if (!sessionFile) {
			// Without a concrete file path we cannot resolve the on-disk session
			// deterministically (the runner persists sessionFile from getState).
			return [];
		}
		const mod = (await import("@earendil-works/pi-coding-agent")) as {
			SessionManager: {
				open(
					path: string,
					sessionDir?: string,
					cwdOverride?: string,
				): { buildSessionContext(): { messages: PiAgentMessage[] } };
			};
		};
		void sessionId;
		const sm = mod.SessionManager.open(resolve(sessionFile), sessionDir, cwd);
		return sm.buildSessionContext().messages ?? [];
	};
}
