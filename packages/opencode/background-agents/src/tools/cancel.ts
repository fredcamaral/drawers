/**
 * `bg_cancel` — cancel one background task by id, or all non-terminal tasks of
 * the current session.
 *
 * Exactly one of `task_id` / `all` must be supplied; both or neither returns an
 * honest error string the model can correct. Cancelling a task that is already
 * terminal no-ops in the runner and returns its current state — reported as-is,
 * never dressed up as a fresh cancellation.
 */

import { isTerminal, type SessionRunner } from "@drawers/core";
import { type ToolContext, tool } from "@opencode-ai/plugin";

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Cancel a single task, returning a one-line outcome string. */
async function cancelOne(
	runner: SessionRunner,
	taskId: string,
): Promise<string> {
	try {
		const task = await runner.cancel(taskId);
		return `${task.id} — ${task.status}`;
	} catch (err) {
		return `${taskId} — error: ${errorMessage(err)}`;
	}
}

export function createBgCancelTool(runner: SessionRunner) {
	return tool({
		description:
			"Cancel a background task. Pass task_id to cancel one task, or all=true " +
			"to cancel every still-running task started from this session. Supply " +
			"exactly one of the two.",
		args: {
			task_id: tool.schema
				.string()
				.optional()
				.describe("the bg_ task id to cancel (omit when all=true)"),
			all: tool.schema
				.boolean()
				.default(false)
				.describe("cancel every non-terminal task of this session"),
		},
		async execute(args, context: ToolContext) {
			const { task_id } = args;

			const hasId = task_id !== undefined && task_id !== "";
			const all = args.all === true;
			if (hasId === all) {
				return "provide exactly one of task_id or all";
			}

			if (all) {
				const pending = runner
					.list(context.sessionID)
					.filter((t) => !isTerminal(t.status));
				if (pending.length === 0) {
					return "nothing to cancel — no running tasks for this session";
				}
				const lines = await Promise.all(
					pending.map((t) => cancelOne(runner, t.id)),
				);
				return `cancelled ${pending.length} task(s):\n${lines.join("\n")}`;
			}

			// hasId is true here (exactly-one check passed).
			return cancelOne(runner, task_id as string);
		},
	});
}
