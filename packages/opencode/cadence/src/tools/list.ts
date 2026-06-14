/**
 * `cadence_list` — list the active loop/goal directives of the current session.
 *
 * Read-only. Returns a one-line-per-directive summary (id, kind, iteration
 * progress, and cadence/predicate detail) or an explicit "none" when the session
 * has no active directives.
 */

import { type ToolContext, tool } from "@opencode-ai/plugin";
import type { CadenceEngine, Directive } from "../engine";

function describe(directive: Directive): string {
	const progress = `${directive.iterations}/${directive.maxIterations}`;
	if (directive.kind === "loop") {
		const detail =
			directive.until !== undefined ? ` until=${directive.until}` : "";
		return `${directive.id} loop every=${directive.intervalMs}ms ${progress}${detail}`;
	}
	return `${directive.id} goal ${progress} — ${directive.instruction}`;
}

export function createListTool(engine: CadenceEngine) {
	return tool({
		description:
			"List the active loop/goal directives started from this session.",
		args: {},
		async execute(_args, context: ToolContext) {
			const active = engine.list(context.sessionID);
			if (active.length === 0) {
				return "no active cadence directives for this session";
			}
			return active.map(describe).join("\n");
		},
	});
}
