/**
 * Core type contract for the background-task engine. Other epics program
 * against these shapes, so changes here are load-bearing.
 */

export type TaskStatus =
	| "pending"
	| "running"
	| "completed"
	| "error"
	| "cancelled";

/** Terminal statuses: a task in any of these will not transition further. */
export const TERMINAL_STATUSES = new Set<TaskStatus>([
	"completed",
	"error",
	"cancelled",
]);

/** True when `status` is terminal (no further transitions expected). */
export function isTerminal(status: TaskStatus): boolean {
	return TERMINAL_STATUSES.has(status);
}

export interface BgTask {
	id: string; // prefix + 8-char suffix, collision-checked (prefix is configurable
	// per IdGenerator — background-agents mints "bg_", workflows mints "wf_")
	sessionID?: string; // set once the child session exists
	/**
	 * Absolute path to the pi session transcript file, captured from the child's
	 * `getState()` after launch/resume. Persisted so `readOutput` on a
	 * torn-down/terminal task can read the transcript from disk
	 * (SessionManager.open) without a live RPC child. Absent on pre-field tasks
	 * and on children that never reported a file → disk read derives from the
	 * session dir or degrades to the recorded error.
	 */
	sessionFile?: string;
	parentSessionID: string;
	description: string;
	agent: string;
	status: TaskStatus;
	createdAt: number;
	startedAt?: number;
	completedAt?: number;
	error?: string;
	depth: number; // recursion guard
	concurrencyKey: string;
	model?: string; // launch `model` string (provider/model), retained so resume
	// can re-acquire the same concurrency slot. Added in Task 1.3.4.
	/**
	 * The EFFECTIVE tools map dispatched with the launch prompt — the recursion
	 * guard (unless `noSpawnTools: false`) merged with the launch's
	 * `toolsOverride`. Stored (and persisted: the task store serializes the full
	 * BgTask) so `resume()` replays the SAME tool config instead of a bare
	 * recursion guard — e.g. the workflows structured-output nudge resumes a
	 * child whose launch enabled `structured_output`. Absent on tasks persisted
	 * before this field existed → resume falls back to the bare guard.
	 */
	tools?: Record<string, boolean>;
	/**
	 * pi-native system-prompt append resolved at launch (the agent definition's
	 * markdown body, or any caller-supplied text), passed to the child as
	 * `--append-system-prompt`. Persisted so `resume()` re-applies it to the FRESH
	 * child — pi `--append-system-prompt` is a per-invocation flag, not part of the
	 * replayed session, so resume must re-pass it. Absent → the child runs its
	 * default coding-assistant prompt.
	 */
	appendSystemPrompt?: string;
	/**
	 * pi-native tool allow-list resolved at launch (the agent definition's `tools`
	 * frontmatter), passed to the child as `--tools <csv>`. Persisted so `resume()`
	 * re-applies it. Distinct from {@link BgTask.tools} (the recursion-guard boolean
	 * MAP dispatched per-prompt) — this is the CLI tool filter for the pi child.
	 * Absent/empty → pi's default tool set.
	 */
	agentTools?: string[];
	notified?: boolean; // notification-queue flush state (Epic 1.4)
}

/**
 * A single text part for a prompt's `parts` array. Lives here (not in
 * session-runner.ts) so consumers building {@link LaunchRequest.contextParts}
 * can reference it without importing the runner module.
 */
export interface TextPartInput {
	type: "text";
	text: string;
	/** Model-only context (e.g. forked transcript); excluded from UI display. */
	synthetic?: boolean;
}

export interface LaunchRequest {
	parentSessionID: string;
	description: string;
	prompt: string;
	/**
	 * Agent NAME for bookkeeping/display + persistence ({@link BgTask.agent}). This
	 * is NOT a pi flag — pi has no `--agent`. The caller (bg-agents' agent
	 * resolver) maps this name to the pi-native knobs below; the runner threads
	 * those, never the name, into the child.
	 */
	agent: string;
	model?: string;
	/**
	 * pi-native system-prompt append (the resolved agent definition's body, or any
	 * caller text). Threaded into the child as `--append-system-prompt` and
	 * persisted on the task so `resume()` re-applies it. Absent → default prompt.
	 */
	appendSystemPrompt?: string;
	/**
	 * pi-native tool allow-list (the resolved agent definition's `tools`). Threaded
	 * into the child as `--tools <csv>` and persisted so `resume()` re-applies it.
	 * Absent/empty → pi's default tool set.
	 */
	tools?: string[];
	depth: number;
	toolsOverride?: Record<string, boolean>;
	noSpawnTools?: boolean; // default true
	/**
	 * Extra parts prepended BEFORE the task-prompt part in the launch
	 * `promptAsync` call. Used to inject forked parent context (Epic 2.3). Order
	 * is guaranteed: context parts first, prompt part last.
	 */
	contextParts?: TextPartInput[];
	/**
	 * Per-launch project/worktree directory forwarded as the `session.create`
	 * QUERY param (SDK `SessionCreateData.query.directory`), which re-roots the
	 * worker's Bash/tool cwd (host-probed green 2026-06-08 against opencode
	 * v1.16.2). UNUSED until per-agent worktree isolation (Epic H.1) wires it;
	 * absent → the engine-wide directory applies as today. It is a CREATE-time
	 * query, NOT a body field and NOT a prompt-time param — see SessionCreateBody.
	 */
	directory?: string;
	/**
	 * Invoked SYNCHRONOUSLY after the child session is created and BEFORE the
	 * prompt is dispatched. Lets callers register per-session state (e.g. a
	 * structured-output schema) with no race against the child's first turn.
	 * A throw here fails the launch loudly — it is a caller programming error.
	 */
	onSessionCreated?: (sessionID: string) => void;
}

export interface ReadOpts {
	full?: boolean;
}

/** A single part of a filtered transcript message (Task 1.3.4). */
export interface TaskOutputPart {
	type: string;
	text: string;
}

/** A filtered transcript message: role + text/tool parts only. */
export interface TaskOutputMessage {
	role: "user" | "assistant";
	parts: TaskOutputPart[];
}

export interface TaskOutput {
	status: TaskStatus;
	summaryText: string;
	/** Present only when `readOutput` is called with `{ full: true }`. */
	messages?: TaskOutputMessage[];
}

export interface Clock {
	now(): number;
}

/**
 * The launch/lifecycle surface every background-task engine programs against.
 * Implemented by the pi-native runner (one `pi --mode rpc` child per task).
 *
 * Mirrors the opencode `SessionRunner` VERBATIM minus `handleEvent`: pi has no
 * shared SDK event bus, so completion is driven by the child's own event stream
 * inside the runner (see the completion fuser), not by an externally pumped
 * `handleEvent`.
 */
export interface SessionRunner {
	launch(req: LaunchRequest): Promise<BgTask>;
	awaitCompletion(taskId: string, timeoutMs?: number): Promise<BgTask>;
	cancel(taskId: string): Promise<BgTask>;
	resume(taskId: string, prompt: string): Promise<BgTask>;
	readOutput(taskId: string, opts?: ReadOpts): Promise<TaskOutput>;
	list(parentSessionID?: string): BgTask[];
	dispose(): Promise<void>;
}
