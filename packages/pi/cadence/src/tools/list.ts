/**
 * `cadence_list` — list the active loop/goal directives of the current session.
 *
 * Read-only. Returns a one-line-per-directive summary (id, kind, iteration
 * progress, and cadence/predicate detail) or an explicit "none" when the session
 * has no active directives.
 */

import {
	defineTool,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CadenceEngine, Directive } from "../engine";

function text(message: string) {
	return { content: [{ type: "text" as const, text: message }], details: {} };
}

function describe(directive: Directive): string {
	const progress = `${directive.iterations}/${directive.maxIterations}`;
	if (directive.kind === "loop") {
		const detail =
			directive.until !== undefined ? ` until=${directive.until}` : "";
		return `${directive.id} loop every=${directive.intervalMs}ms ${progress}${detail}`;
	}
	return `${directive.id} goal ${progress} — ${directive.instruction}`;
}

export function createListTool(getEngine: () => CadenceEngine) {
	return defineTool({
		name: "cadence_list",
		label: "Cadence list",
		description:
			"List the active loop/goal directives started from this session.",
		parameters: Type.Object({}),
		async execute(
			_toolCallId,
			_params,
			_signal,
			_onUpdate,
			ctx: ExtensionContext,
		) {
			const active = getEngine().list(ctx.sessionManager.getSessionId());
			if (active.length === 0) {
				return text("no active cadence directives for this session");
			}
			return text(active.map(describe).join("\n"));
		},
	});
}
