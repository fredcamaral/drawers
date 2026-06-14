/**
 * `bg_list` — show the background tasks started from this parent session.
 *
 * pi port. Renders one compact line per task: id, status, age-or-duration, and a
 * truncated description. Age/duration is computed from the task's own timestamps
 * against an injected {@link Clock} (defaults to wall-clock) so the rendering is
 * deterministic under test. Factory-DI on a {@link SessionRunner} thunk + the
 * bound `parentSessionID`.
 *
 * Node-safe: no Bun.* APIs.
 */

import type { BgTask, Clock, SessionRunner } from "@drawers/pi-core";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DESCRIPTION_CAP = 60;
const ELLIPSIS = "…";

const wallClock: Clock = { now: () => Date.now() };

/** A model-readable tool result. */
function text(message: string) {
	return { content: [{ type: "text" as const, text: message }], details: {} };
}

/** Truncate to {@link DESCRIPTION_CAP} chars, appending an ellipsis if cut. */
function truncate(input: string): string {
	const oneLine = input.replace(/\s+/g, " ").trim();
	if (oneLine.length <= DESCRIPTION_CAP) {
		return oneLine;
	}
	return oneLine.slice(0, DESCRIPTION_CAP) + ELLIPSIS;
}

/** Whole-second human duration, e.g. "10s", "2m05s". */
function humanizeMs(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	if (totalSeconds < 60) {
		return `${totalSeconds}s`;
	}
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

/**
 * Duration for a terminal task (start→complete), else age for a live one
 * (start-or-create→now). Pending tasks without a `startedAt` fall back to
 * `createdAt`.
 */
function timing(task: BgTask, now: number): string {
	const start = task.startedAt ?? task.createdAt;
	if (task.completedAt !== undefined) {
		return `${humanizeMs(task.completedAt - start)} (done)`;
	}
	return `${humanizeMs(now - start)} (age)`;
}

export function createBgListTool(
	getRunner: () => SessionRunner,
	getParentSessionID: () => string,
	clock: Clock = wallClock,
) {
	return defineTool({
		name: "bg_list",
		label: "Background list",
		description:
			"List the background tasks started from the current session, with their " +
			"id, status, runtime, and description. Use this to find a task_id.",
		promptSnippet: "List this session's background tasks",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			const tasks = getRunner().list(getParentSessionID());
			if (tasks.length === 0) {
				return text("no background tasks for this session");
			}
			const now = clock.now();
			const lines = tasks.map(
				(t) =>
					`${t.id}  ${t.status}  ${timing(t, now)}  ${truncate(t.description)}`,
			);
			return text(lines.join("\n"));
		},
	});
}
