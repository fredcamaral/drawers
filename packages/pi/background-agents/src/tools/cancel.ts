/**
 * `bg_cancel` — cancel one background task by id, or all non-terminal tasks of
 * this parent session.
 *
 * pi port. Factory-DI on a {@link SessionRunner} thunk + the bound
 * `parentSessionID` (the per-session runner already filters its list by parent;
 * we pass it explicitly for symmetry). Exactly one of `task_id` / `all` must be
 * supplied; both or neither returns a model-readable error string. Cancelling an
 * already-terminal task no-ops in the runner and returns its current state.
 *
 * Node-safe: no Bun.* APIs.
 */

import { isTerminal, type SessionRunner } from "@drawers/pi-core";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** A model-readable tool result. */
function text(message: string) {
	return { content: [{ type: "text" as const, text: message }], details: {} };
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

export function createBgCancelTool(
	getRunner: () => SessionRunner,
	getParentSessionID: () => string,
) {
	return defineTool({
		name: "bg_cancel",
		label: "Background cancel",
		description:
			"Cancel a background task. Pass task_id to cancel one task, or all=true " +
			"to cancel every still-running task started from this session. Supply " +
			"exactly one of the two.",
		promptSnippet: "Cancel one background task, or all of this session's",
		parameters: Type.Object({
			task_id: Type.Optional(
				Type.String({
					description: "the bg_ task id to cancel (omit when all=true)",
				}),
			),
			all: Type.Optional(
				Type.Boolean({
					description: "cancel every non-terminal task of this session",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const runner = getRunner();
			const taskId =
				typeof params.task_id === "string" && params.task_id.length > 0
					? params.task_id
					: undefined;
			const hasId = taskId !== undefined;
			const all = params.all === true;
			if (hasId === all) {
				return text("provide exactly one of task_id or all");
			}

			if (all) {
				const pending = runner
					.list(getParentSessionID())
					.filter((t) => !isTerminal(t.status));
				if (pending.length === 0) {
					return text("nothing to cancel — no running tasks for this session");
				}
				const lines = await Promise.all(
					pending.map((t) => cancelOne(runner, t.id)),
				);
				return text(
					`cancelled ${pending.length} task(s):\n${lines.join("\n")}`,
				);
			}

			// hasId is true here (exactly-one check passed).
			return text(await cancelOne(runner, taskId as string));
		},
	});
}
