/**
 * `cadence_stop` — halt one directive by id, or every active directive of the
 * current session.
 *
 * Pass `id` to stop a single loop/goal; omit it to stop all active directives
 * for this session. The outcome string is honest: stopping an unknown id or a
 * session with nothing active says so rather than feigning success.
 */

import {
	defineTool,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CadenceEngine } from "../engine";
import { asString } from "./args";

function text(message: string) {
	return { content: [{ type: "text" as const, text: message }], details: {} };
}

export function createStopTool(getEngine: () => CadenceEngine) {
	return defineTool({
		name: "cadence_stop",
		label: "Cadence stop",
		description:
			"Stop a cadence directive. Pass id to stop one, or omit id to stop every " +
			"active loop/goal started from this session.",
		parameters: Type.Object({
			id: Type.Optional(
				Type.String({
					description:
						"the cadence_ directive id (omit to stop all for this session)",
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
			const engine = getEngine();
			const sessionID = ctx.sessionManager.getSessionId();
			const id = asString(params.id);
			if (id.length > 0) {
				// Scoped to the caller's session — a directive owned by another
				// session is treated as not found, never stopped.
				const directive = await engine.stop(id, sessionID);
				if (directive === undefined) {
					return text(`no such directive: ${id}`);
				}
				return text(`${directive.id} — ${directive.status}`);
			}

			const stopped = await engine.stopForSession(sessionID);
			if (stopped.length === 0) {
				return text("nothing to stop — no active directives for this session");
			}
			return text(
				`stopped ${stopped.length} directive(s): ${stopped
					.map((d) => d.id)
					.join(", ")}`,
			);
		},
	});
}
