/**
 * `cadence_stop` — halt one directive by id, or every active directive of the
 * current session.
 *
 * Pass `id` to stop a single loop/goal; omit it to stop all active directives
 * for this session. The outcome string is honest: stopping an unknown id or a
 * session with nothing active says so rather than feigning success.
 */

import { type ToolContext, tool } from "@opencode-ai/plugin";
import type { CadenceEngine } from "../engine";

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

export function createStopTool(engine: CadenceEngine) {
	return tool({
		description:
			"Stop a cadence directive. Pass id to stop one, or omit id to stop every " +
			"active loop/goal started from this session.",
		args: {
			id: tool.schema
				.string()
				.optional()
				.describe(
					"the cadence_ directive id (omit to stop all for this session)",
				),
		},
		async execute(args, context: ToolContext) {
			const id = asString(args.id);
			if (id.length > 0) {
				// Scoped to the caller's session — a directive owned by another
				// session is treated as not found, never stopped.
				const directive = await engine.stop(id, context.sessionID);
				if (directive === undefined) {
					return `no such directive: ${id}`;
				}
				return `${directive.id} — ${directive.status}`;
			}

			const stopped = await engine.stopForSession(context.sessionID);
			if (stopped.length === 0) {
				return "nothing to stop — no active directives for this session";
			}
			return `stopped ${stopped.length} directive(s): ${stopped
				.map((d) => d.id)
				.join(", ")}`;
		},
	});
}
