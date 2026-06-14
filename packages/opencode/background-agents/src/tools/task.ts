/**
 * `bg_task` — launch a background agent task, or resume a terminal one.
 *
 * Factory-DI: {@link createBgTaskTool} takes the {@link SessionRunner} so tests
 * inject a typed fake (no SDK, no live engine). The tool is pure argument
 * mapping + error translation; all the heavy lifting (concurrency, sessions,
 * completion) lives in core.
 *
 * Two modes, keyed on `task_id`:
 *   - absent  → LAUNCH. Maps `description`/`prompt`/`agent`/`model` into a
 *     {@link LaunchRequest}; `depth` is INFERRED from the caller's session.
 *   - present → RESUME. Only `prompt` is used; every other arg is ignored.
 *
 * Error strategy (custom-tools.md): expected outcomes the model should reason
 * over — validation gaps, depth-exceeded, `taskStillRunning`, `sessionExpired`
 * — return honest strings. Genuinely exceptional failures rethrow so opencode
 * surfaces them.
 */

import type { BgTask, SessionRunner } from "@drawers/core";
import { tool } from "@opencode-ai/plugin";
import { buildForkTranscript, type ForkMessage } from "../fork/transcript";

const DEFAULT_AGENT = "build";

/**
 * Optional collaborators for `bg_task`. `fetchMessages` is the seam the engine
 * exposes ({@link Engine.fetchSessionMessages}) so a `fork: true` launch can
 * read the parent session's transcript and inject it as context. Omitted in
 * unit tests that never exercise fork.
 */
export interface BgTaskToolDeps {
	fetchMessages?: (sessionID: string) => Promise<ForkMessage[]>;
}

/**
 * Resume errors core raises are plain `Error`s whose `message` is prefixed with
 * a stable token (`session-runner.ts` `resume()`):
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

/**
 * Launch result text. Carries the id, the status, and explicit no-poll guidance
 * so the model does not turn `bg_task` into a poll-storm: it will be notified on
 * completion and should read the result with `bg_output` only then.
 */
function launchResultText(taskTask: BgTask): string {
	return [
		`Launched background task ${taskTask.id} (status: ${taskTask.status}).`,
		"It is running in the background — you will be notified on completion; " +
			`do NOT poll. Call bg_output("${taskTask.id}") when notified.`,
	].join(" ");
}

/** Resume result text — mirrors launch's no-poll contract. */
function resumeResultText(taskTask: BgTask): string {
	return [
		`Resumed background task ${taskTask.id} (status: ${taskTask.status}).`,
		"It is running in the background — you will be notified on completion; " +
			`do NOT poll. Call bg_output("${taskTask.id}") when notified.`,
	].join(" ");
}

export function createBgTaskTool(
	runner: SessionRunner,
	deps: BgTaskToolDeps = {},
) {
	const fetchMessages = deps.fetchMessages;
	return tool({
		description:
			"Launch a background agent task that runs independently of this turn, " +
			"or resume a finished one. You are notified when it completes — do NOT " +
			"poll; call bg_output(task_id) when notified. Pass task_id to resume a " +
			"completed/errored/cancelled task (only prompt is used; other args are " +
			"ignored).",
		args: {
			description: tool.schema
				.string()
				.describe("Short title for the task (shown in the UI)."),
			prompt: tool.schema
				.string()
				.describe("The instruction for the background agent."),
			agent: tool.schema
				.string()
				.default(DEFAULT_AGENT)
				.describe('Agent to run the task as. Defaults to "build".'),
			model: tool.schema
				.string()
				.optional()
				.describe('Optional model override, "provider/model".'),
			task_id: tool.schema
				.string()
				.optional()
				.describe(
					"Resume an existing terminal task instead of launching a new " +
						"one. When set, only `prompt` is used.",
				),
			fork: tool.schema
				.boolean()
				.default(false)
				.describe(
					"Fork this session's context into the child: the parent's " +
						"transcript is injected as reference context before the task " +
						"prompt. Only applies to launch (ignored on resume).",
				),
		},
		async execute(args, context) {
			const { description, prompt, agent, model, task_id, fork } = args;

			// --- RESUME mode -------------------------------------------------
			if (task_id !== undefined) {
				if (prompt.trim().length === 0) {
					return "Cannot resume: `prompt` is required (the follow-up instruction).";
				}
				try {
					const resumed = await runner.resume(task_id, prompt);
					return resumeResultText(resumed);
				} catch (err) {
					const message = errorMessage(err);
					if (message.startsWith(TASK_STILL_RUNNING)) {
						return (
							`Cannot resume ${task_id}: it is still running ` +
							`(${detailAfter(message, TASK_STILL_RUNNING)}). ` +
							"Wait for completion, then resume or read its output."
						);
					}
					if (message.startsWith(SESSION_EXPIRED)) {
						return (
							`Cannot resume ${task_id}: its session has expired ` +
							`(${detailAfter(message, SESSION_EXPIRED)}). ` +
							"Launch a new background task instead."
						);
					}
					// Unexpected: a real failure the model cannot reason around.
					throw err;
				}
			}

			// --- LAUNCH mode -------------------------------------------------
			if (description.trim().length === 0) {
				return "Cannot launch: `description` is required (a short task title).";
			}
			if (prompt.trim().length === 0) {
				return "Cannot launch: `prompt` is required (the task instruction).";
			}

			// Depth inference: if the calling session is itself a tracked task's
			// child session, this call is one level deeper than that task. core's
			// maxDepth guard does the rejecting; we just compute + report.
			const parent = runner
				.list()
				.find((t) => t.sessionID === context.sessionID);
			const depth = (parent?.depth ?? -1) + 1;

			context.metadata({ title: description });

			// Fork: inject the parent session's transcript as a synthetic context
			// part. An empty transcript ("") → launch WITHOUT contextParts (don't
			// ship an empty header). Two failure modes refuse the launch rather than
			// ship a child a blind context, each with an honest, distinct message:
			//   - fetchMessages throws → could not READ the parent transcript (a
			//     transient SDK/network failure, NOT a genuinely empty session);
			//   - buildForkTranscript throws → the SDK message schema drifted.
			let contextParts:
				| Array<{ type: "text"; text: string; synthetic: true }>
				| undefined;
			if (fork === true && fetchMessages) {
				let messages: ForkMessage[];
				try {
					messages = await fetchMessages(context.sessionID);
				} catch (err) {
					return (
						"Cannot fork: failed to read the parent transcript " +
						`(${errorMessage(err)}). Not launching blind — retry, or launch ` +
						"without fork if the parent context is not required."
					);
				}
				let transcript: string;
				try {
					transcript = buildForkTranscript(messages);
				} catch (err) {
					return (
						"Cannot fork parent context: the transcript builder failed " +
						`(${errorMessage(err)}). This usually means the SDK message ` +
						"schema drifted. Not launching to avoid sending a child a blind " +
						"or corrupt context."
					);
				}
				if (transcript.length > 0) {
					contextParts = [{ type: "text", text: transcript, synthetic: true }];
				}
			}

			try {
				const launched = await runner.launch({
					parentSessionID: context.sessionID,
					description,
					prompt,
					agent,
					model,
					depth,
					contextParts,
				});
				return launchResultText(launched);
			} catch (err) {
				// Depth-exceeded (and any other launch guard) is an expected outcome
				// the model should reason over, not a crash.
				return `Cannot launch background task: ${errorMessage(err)}`;
			}
		},
	});
}
