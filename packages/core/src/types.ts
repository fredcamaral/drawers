import type { Event } from "@opencode-ai/sdk";

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
	id: string; // "bg_" + 8-char suffix, collision-checked
	sessionID?: string; // set once the child session exists
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
	agent: string;
	model?: string;
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

export interface SessionRunner {
	launch(req: LaunchRequest): Promise<BgTask>;
	awaitCompletion(taskId: string, timeoutMs?: number): Promise<BgTask>;
	cancel(taskId: string): Promise<BgTask>;
	resume(taskId: string, prompt: string): Promise<BgTask>;
	readOutput(taskId: string, opts?: ReadOpts): Promise<TaskOutput>;
	list(parentSessionID?: string): BgTask[];
	// `Event` is the typed SDK discriminated union (per docs/sdk-surface-audit.md
	// rows g/j); narrowing happens in Task 1.3.2/1.3.3.
	handleEvent(event: Event): Promise<void>;
	dispose(): Promise<void>;
}

export interface Clock {
	now(): number;
}
