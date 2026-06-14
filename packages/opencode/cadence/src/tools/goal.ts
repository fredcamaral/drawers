/**
 * `goal` — arm an IDLE-driven completion gate for the current session.
 *
 * On every `session.idle` for this session the engine reads the last assistant
 * message: a `GOAL_COMPLETE` sentinel means the goal is met (done); anything else
 * re-prompts the goal until it is met or `max_iterations` (default 10) is hit.
 * This is the anti-premature-completion bar — the model must explicitly declare
 * the objective satisfied rather than drifting idle.
 *
 * Args are coerced defensively; a missing goal degrades to an honest error.
 */

import { type ToolContext, tool } from "@opencode-ai/plugin";
import type { CadenceEngine } from "../engine";
import { asPositiveInt, asString } from "./args";

export function createGoalTool(engine: CadenceEngine) {
	return tool({
		description:
			"Hold THIS session to a goal: on each idle, if the last assistant " +
			"message does not contain GOAL_COMPLETE the goal is re-prompted until " +
			"met or max_iterations (default 10) is reached.",
		args: {
			goal: tool.schema
				.string()
				.describe("the objective to hold the session to"),
			max_iterations: tool.schema
				.number()
				.optional()
				.describe("safety cap on re-prompts (default 10)"),
		},
		async execute(args, context: ToolContext) {
			const goal = asString(args.goal);
			if (goal.length === 0) {
				return "goal is required";
			}
			const maxIterations = asPositiveInt(args.max_iterations);

			const directive = await engine.start({
				sessionID: context.sessionID,
				kind: "goal",
				instruction: goal,
				...(maxIterations !== undefined ? { maxIterations } : {}),
			});

			return (
				`goal ${directive.id} armed — re-prompted on each idle until ` +
				`GOAL_COMPLETE or ${directive.maxIterations} iteration(s): ${goal}`
			);
		},
	});
}
