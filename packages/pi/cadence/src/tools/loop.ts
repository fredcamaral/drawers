/**
 * `loop` — arm an INTERVAL-driven re-prompt of the current session.
 *
 * Every `interval_ms` (floored at 1000ms by the engine) the instruction is
 * re-injected into THIS session. The optional `until` predicate gates completion:
 * before each re-prompt the engine checks the last assistant message for the
 * `GOAL_COMPLETE` sentinel and stops when present. A `max_iterations` safety cap
 * (default 10) bounds runaway loops regardless of the predicate.
 *
 * Validation failures are RETURNED as honest text (a result the model reads and
 * acts on), not thrown — a throw would mark the call errored, which is the wrong
 * signal for "you gave me an empty instruction, here is what is missing".
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

export function createLoopTool(getEngine: () => CadenceEngine) {
	return defineTool({
		name: "loop",
		label: "Loop",
		description:
			"Re-inject a prompt into THIS session on an interval. Pass instruction " +
			"and interval_ms (floored at 1000ms). Optional until: a completion " +
			"predicate — the loop stops once the last assistant message contains " +
			"GOAL_COMPLETE. max_iterations caps the loop (default 10).",
		parameters: Type.Object({
			instruction: Type.String({
				description: "the prompt to re-inject each interval",
			}),
			interval_ms: Type.Number({
				description: "milliseconds between re-prompts (floored at 1000)",
			}),
			max_iterations: Type.Optional(
				Type.Number({ description: "safety cap on re-prompts (default 10)" }),
			),
			until: Type.Optional(
				Type.String({
					description: "completion predicate; loop stops on GOAL_COMPLETE",
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
			const instruction = asString(params.instruction);
			if (instruction.length === 0) {
				return text("instruction is required");
			}
			const intervalMs = asPositiveInt(params.interval_ms);
			if (intervalMs === undefined) {
				return text("interval_ms is required and must be a positive number");
			}
			const maxIterations = asPositiveInt(params.max_iterations);
			const until = asString(params.until);

			const directive = await getEngine().start({
				sessionID: ctx.sessionManager.getSessionId(),
				kind: "loop",
				instruction,
				intervalMs,
				...(maxIterations !== undefined ? { maxIterations } : {}),
				...(until.length > 0 ? { until } : {}),
			});

			return text(
				`loop ${directive.id} armed — every ${directive.intervalMs}ms, ` +
					`cap ${directive.maxIterations} iteration(s)` +
					(directive.until !== undefined
						? `, stops on GOAL_COMPLETE for: ${directive.until}`
						: ""),
			);
		},
	});
}
