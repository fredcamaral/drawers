/**
 * `loop` — arm an INTERVAL-driven re-prompt of the current session.
 *
 * Every `interval_ms` (floored at 1000ms by the engine) the instruction is
 * re-injected into THIS session. The optional `until` predicate gates completion:
 * before each re-prompt the engine checks the last assistant message for the
 * `GOAL_COMPLETE` sentinel and stops when present. A `max_iterations` safety cap
 * (default 10) bounds runaway loops regardless of the predicate.
 *
 * Args are coerced defensively — opencode's raw path may hand non-strings — and a
 * missing/invalid required arg degrades to an honest error string rather than the
 * literal "undefined".
 */

import { type ToolContext, tool } from "@opencode-ai/plugin";
import type { CadenceEngine } from "../engine";
import { asPositiveInt, asString } from "./args";

export function createLoopTool(engine: CadenceEngine) {
	return tool({
		description:
			"Re-inject a prompt into THIS session on an interval. Pass instruction " +
			"and interval_ms (floored at 1000ms). Optional until: a completion " +
			"predicate — the loop stops once the last assistant message contains " +
			"GOAL_COMPLETE. max_iterations caps the loop (default 10).",
		args: {
			instruction: tool.schema
				.string()
				.describe("the prompt to re-inject each interval"),
			interval_ms: tool.schema
				.number()
				.describe("milliseconds between re-prompts (floored at 1000)"),
			max_iterations: tool.schema
				.number()
				.optional()
				.describe("safety cap on re-prompts (default 10)"),
			until: tool.schema
				.string()
				.optional()
				.describe("completion predicate; loop stops on GOAL_COMPLETE"),
		},
		async execute(args, context: ToolContext) {
			const instruction = asString(args.instruction);
			if (instruction.length === 0) {
				return "instruction is required";
			}
			const intervalMs = asPositiveInt(args.interval_ms);
			if (intervalMs === undefined) {
				return "interval_ms is required and must be a positive number";
			}
			const maxIterations = asPositiveInt(args.max_iterations);
			const until = asString(args.until);

			const directive = await engine.start({
				sessionID: context.sessionID,
				kind: "loop",
				instruction,
				intervalMs,
				...(maxIterations !== undefined ? { maxIterations } : {}),
				...(until.length > 0 ? { until } : {}),
			});

			return (
				`loop ${directive.id} armed — every ${directive.intervalMs}ms, ` +
				`cap ${directive.maxIterations} iteration(s)` +
				(directive.until !== undefined
					? `, stops on GOAL_COMPLETE for: ${directive.until}`
					: "")
			);
		},
	});
}
