/**
 * `goal` — arm an IDLE-driven completion gate for the current session.
 *
 * On every per-prompt boundary (pi's `agent_end`) for this session the engine reads
 * the last assistant message: a `GOAL_COMPLETE` sentinel means the goal is met
 * (done); anything else re-prompts the goal until it is met or `max_iterations`
 * (default 10) is hit. This is the anti-premature-completion bar — the model must
 * explicitly declare the objective satisfied rather than drifting idle.
 *
 * A missing goal is RETURNED as honest text, not thrown (a result the model reads).
 */

import {
	defineTool,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CadenceEngine } from "../engine";
import { asPositiveInt, asString } from "./args";

function text(message: string) {
	return { content: [{ type: "text" as const, text: message }], details: {} };
}

export function createGoalTool(getEngine: () => CadenceEngine) {
	return defineTool({
		name: "goal",
		label: "Goal",
		description:
			"Hold THIS session to a goal: on each idle, if the last assistant " +
			"message does not contain GOAL_COMPLETE the goal is re-prompted until " +
			"met or max_iterations (default 10) is reached.",
		parameters: Type.Object({
			goal: Type.String({
				description: "the objective to hold the session to",
			}),
			max_iterations: Type.Optional(
				Type.Number({ description: "safety cap on re-prompts (default 10)" }),
			),
		}),
		async execute(
			_toolCallId,
			params,
			_signal,
			_onUpdate,
			ctx: ExtensionContext,
		) {
			const goal = asString(params.goal);
			if (goal.length === 0) {
				return text("goal is required");
			}
			const maxIterations = asPositiveInt(params.max_iterations);

			const directive = await getEngine().start({
				sessionID: ctx.sessionManager.getSessionId(),
				kind: "goal",
				instruction: goal,
				...(maxIterations !== undefined ? { maxIterations } : {}),
			});

			return text(
				`goal ${directive.id} armed — re-prompted on each idle until ` +
					`GOAL_COMPLETE or ${directive.maxIterations} iteration(s): ${goal}`,
			);
		},
	});
}
