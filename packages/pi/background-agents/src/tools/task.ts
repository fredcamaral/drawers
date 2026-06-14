/**
 * `bg_task` — launch a background agent task, or resume a terminal one.
 *
 * pi port of the opencode tool. Factory-DI: {@link createBgTaskTool} takes a
 * {@link SessionRunner} thunk (resolved at runtime, after session_start) plus the
 * collaborators the launch path needs — the parent's depth and a synchronous
 * reader for the parent transcript (fork). The tool is pure argument mapping +
 * error translation; concurrency/sessions/completion live in core.
 *
 * Two modes, keyed on `task_id`:
 *   - absent  → LAUNCH. Maps `description`/`prompt`/`agent`/`model` into a
 *     {@link LaunchRequest}; `depth` is `parentDepth + 1`.
 *   - present → RESUME. Only `prompt` is used; every other arg is ignored.
 *
 * Error strategy (pi tools FAIL by throwing — gotcha #3): expected outcomes the
 * model should reason over (validation gaps, depth-exceeded, taskStillRunning,
 * sessionExpired, fork-read failure) are RETURNED as model-readable text (a
 * successful tool result). Genuinely exceptional `resume` failures THROW.
 *
 * Node-safe: no Bun.* APIs.
 */

import type {
	BgTask,
	LaunchRequest,
	SessionRunner,
	TextPartInput,
} from "@drawers/pi-core";
import {
	defineTool,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type AgentResolverDeps,
	type ResolvedAgent,
	resolveAgent,
} from "../agent-resolver";
import {
	buildForkTranscript,
	type PiSessionEntryLike,
	piEntriesToForkMessages,
} from "../fork/transcript";

/**
 * Display/persist name when no agent is requested AND none resolves: the child
 * runs pi's DEFAULT coding assistant (no `--append-system-prompt`, no `--tools`).
 * This is a LABEL only — it is NEVER passed to pi as a flag (pi has no `--agent`).
 */
const DEFAULT_AGENT_LABEL = "default";

/**
 * Collaborators `bg_task` needs at runtime. `getRunner` resolves the engine's
 * runner lazily (after session_start). `parentSessionID`/`getParentDepth` fix the
 * spawn identity + depth for THIS parent session. `readParentEntries` returns the
 * parent transcript synchronously from `ctx.sessionManager` for a `fork` launch.
 */
export interface BgTaskToolDeps {
	getRunner: () => SessionRunner;
	/** The parent session id this tool launches under (resolved at execute time). */
	getParentSessionID: () => string;
	/** The parent's own bg-depth (0 for a top-level session); child = this + 1. */
	getParentDepth: () => number;
	/** Synchronous in-process read of the parent session's entries (for fork). */
	readParentEntries: (ctx: ExtensionContext) => readonly PiSessionEntryLike[];
	/**
	 * Resolve an agent NAME to pi-native child knobs (system prompt / tools /
	 * model). Defaults to {@link resolveAgent}; injected in tests so they stay
	 * hermetic (no real `~/.pi`). `undefined` return → run pi's default assistant.
	 */
	resolveAgent?: (
		name: string | undefined,
		cwd: string,
		deps?: AgentResolverDeps,
	) => ResolvedAgent | undefined;
}

/**
 * Resume errors core raises are plain `Error`s whose `message` is prefixed with a
 * stable token (`session-runner.ts` `resume()`):
 *   - `taskStillRunning: <id> is <status>`
 *   - `sessionExpired: <id> ...`
 * We translate exactly these two prefixes; anything else rethrows.
 */
const TASK_STILL_RUNNING = "taskStillRunning:";
const SESSION_EXPIRED = "sessionExpired:";

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Strip a known prefix from a core error message, leaving the human detail. */
function detailAfter(message: string, prefix: string): string {
	return message.slice(prefix.length).trim();
}

/** A model-readable tool result (a successful result the model reasons over). */
function text(message: string) {
	return { content: [{ type: "text" as const, text: message }], details: {} };
}

/** Coerce to a trimmed string; anything non-string becomes "". */
function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/**
 * Launch result text. Carries the id, the status, and explicit no-poll guidance
 * so the model does not turn `bg_task` into a poll-storm: it will be notified on
 * completion and should read the result with `bg_output` only then.
 */
function launchResultText(task: BgTask): string {
	return [
		`Launched background task ${task.id} (status: ${task.status}).`,
		"It is running in the background — you will be notified on completion; " +
			`do NOT poll. Call bg_output(task_id="${task.id}") when notified.`,
	].join(" ");
}

/** Resume result text — mirrors launch's no-poll contract. */
function resumeResultText(task: BgTask): string {
	return [
		`Resumed background task ${task.id} (status: ${task.status}).`,
		"It is running in the background — you will be notified on completion; " +
			`do NOT poll. Call bg_output(task_id="${task.id}") when notified.`,
	].join(" ");
}

export function createBgTaskTool(deps: BgTaskToolDeps) {
	const { getRunner, getParentSessionID, getParentDepth, readParentEntries } =
		deps;
	const resolve = deps.resolveAgent ?? resolveAgent;
	return defineTool({
		name: "bg_task",
		label: "Background task",
		description:
			"Launch a background agent task that runs independently of this turn, " +
			"or resume a finished one. You are notified when it completes — do NOT " +
			"poll; call bg_output(task_id) when notified. Pass task_id to resume a " +
			"completed/errored/cancelled task (only prompt is used; other args are " +
			"ignored).",
		promptSnippet: "Launch or resume a fire-and-forget background agent task",
		promptGuidelines: [
			"Use bg_task to offload independent work to a background agent; do not " +
				"poll it — call bg_output(task_id) only when bg_task notifies you it " +
				"finished.",
		],
		parameters: Type.Object({
			description: Type.String({
				description: "Short title for the task (shown in the UI).",
			}),
			prompt: Type.String({
				description: "The instruction for the background agent.",
			}),
			agent: Type.Optional(
				Type.String({
					description:
						"Agent to run the task as. Resolved against pi's agent " +
						"definitions (.pi/agents/<name>.md or ~/.pi/agent/agents/<name>.md): " +
						"the file's body becomes the child's system prompt and its " +
						"frontmatter sets model/tools. If omitted or unresolved, the child " +
						"runs pi's default coding assistant.",
				}),
			),
			model: Type.Optional(
				Type.String({
					description: 'Optional model override, "provider/model".',
				}),
			),
			task_id: Type.Optional(
				Type.String({
					description:
						"Resume an existing terminal task instead of launching a new " +
						"one. When set, only `prompt` is used.",
				}),
			),
			fork: Type.Optional(
				Type.Boolean({
					description:
						"Fork this session's context into the child: the parent's " +
						"transcript is injected as reference context before the task " +
						"prompt. Only applies to launch (ignored on resume).",
				}),
			),
		}),
		async execute(
			_toolCallId,
			params,
			_signal,
			_onUpdate,
			ctx: ExtensionContext,
		) {
			const runner = getRunner();
			// pi does NOT apply schema defaults to raw incoming values (gotcha #4) —
			// coerce defensively and default in code.
			const description = asString(params.description);
			const prompt = asString(params.prompt);
			const agentRaw = asString(params.agent);
			// No "build" default — pi has no agent named "build" and no --agent flag.
			// An absent/empty name means: run pi's default coding assistant.
			const agentName = agentRaw.length > 0 ? agentRaw : undefined;
			const explicitModel =
				typeof params.model === "string" && params.model.length > 0
					? params.model
					: undefined;
			const taskId =
				typeof params.task_id === "string" && params.task_id.length > 0
					? params.task_id
					: undefined;
			const fork = params.fork === true;

			// --- RESUME mode -------------------------------------------------
			if (taskId !== undefined) {
				if (prompt.trim().length === 0) {
					return text(
						"Cannot resume: `prompt` is required (the follow-up instruction).",
					);
				}
				try {
					const resumed = await runner.resume(taskId, prompt);
					return text(resumeResultText(resumed));
				} catch (err) {
					const message = errorMessage(err);
					if (message.startsWith(TASK_STILL_RUNNING)) {
						return text(
							`Cannot resume ${taskId}: it is still running ` +
								`(${detailAfter(message, TASK_STILL_RUNNING)}). ` +
								"Wait for completion, then resume or read its output.",
						);
					}
					if (message.startsWith(SESSION_EXPIRED)) {
						return text(
							`Cannot resume ${taskId}: its session has expired ` +
								`(${detailAfter(message, SESSION_EXPIRED)}). ` +
								"Launch a new background task instead.",
						);
					}
					// Unexpected: a real failure the model cannot reason around.
					throw err;
				}
			}

			// --- LAUNCH mode -------------------------------------------------
			if (description.trim().length === 0) {
				return text(
					"Cannot launch: `description` is required (a short task title).",
				);
			}
			if (prompt.trim().length === 0) {
				return text(
					"Cannot launch: `prompt` is required (the task instruction).",
				);
			}

			// Depth: the child is one level below THIS parent session's bg-depth.
			// core's maxDepth guard does the rejecting; we just compute + carry.
			const depth = getParentDepth() + 1;

			// Fork: inject the parent session's transcript as a synthetic context
			// part. An empty transcript ("") → launch WITHOUT contextParts. The pi
			// transcript read is in-process (no SDK/network), so a thrown read is a
			// programming/schema error, not a transient outage — but we still refuse
			// the launch rather than ship a child a blind/corrupt context, with an
			// honest, distinct message.
			let contextParts: TextPartInput[] | undefined;
			if (fork) {
				let transcript: string;
				try {
					const entries = readParentEntries(ctx);
					transcript = buildForkTranscript(piEntriesToForkMessages(entries));
				} catch (err) {
					return text(
						"Cannot fork parent context: the transcript builder failed " +
							`(${errorMessage(err)}). This usually means the pi message ` +
							"shape drifted. Not launching to avoid sending a child a blind " +
							"or corrupt context.",
					);
				}
				if (transcript.length > 0) {
					contextParts = [{ type: "text", text: transcript, synthetic: true }];
				}
			}

			// Resolve the agent NAME → pi-native child knobs (system prompt / tools /
			// model). Absent or unresolved → undefined: the child runs pi's default
			// coding assistant (no append, no error). Resolution reads files only; a
			// throw would be exceptional, so we let it surface rather than mask it.
			const resolved = resolve(agentName, ctx.cwd);
			// Display/persist label: the requested name, else the resolved file's
			// implicit name, else the default-assistant label. Never a pi flag.
			const agentLabel = agentName ?? DEFAULT_AGENT_LABEL;
			// Model precedence: an explicit `model` param overrides the agent
			// definition's frontmatter `model`.
			const model = explicitModel ?? resolved?.model;

			// Surface the task title in the TUI when present (best-effort).
			try {
				if (ctx.hasUI) {
					ctx.ui.setStatus("bg_task", description);
				}
			} catch {
				// best-effort — a status failure never blocks the launch.
			}

			const req: LaunchRequest = {
				parentSessionID: getParentSessionID(),
				description,
				prompt,
				agent: agentLabel,
				depth,
				...(model !== undefined ? { model } : {}),
				...(resolved?.appendSystemPrompt !== undefined
					? { appendSystemPrompt: resolved.appendSystemPrompt }
					: {}),
				...(resolved?.tools !== undefined ? { tools: resolved.tools } : {}),
				...(contextParts !== undefined ? { contextParts } : {}),
			};
			try {
				const launched = await runner.launch(req);
				return text(launchResultText(launched));
			} catch (err) {
				// Depth-exceeded (and any other launch guard) is an expected outcome
				// the model should reason over, not a crash.
				return text(`Cannot launch background task: ${errorMessage(err)}`);
			}
		},
	});
}
