/**
 * `workflow_stop` — cancel a live workflow run by run_id (pi port).
 *
 * Built as a `defineTool` factory closing over a LAZY engine thunk. Three
 * outcomes, all honest strings (never a thrown crash the model cannot reason
 * over):
 *   - unknown run_id → error listing the known runs;
 *   - already-terminal run → report its status, no-op (do NOT dress a finished
 *     run up as a fresh cancellation);
 *   - running run → `engine.stopRun(runId)`, confirm the cancellation.
 *
 * Node-safe: no Bun.* APIs.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { WorkflowEngine } from "../engine";

/** A model-readable tool result. */
function text(message: string) {
	return { content: [{ type: "text" as const, text: message }], details: {} };
}

/** Coerce a raw arg to string (pi's raw path may hand a non-string). */
function coerceId(raw: unknown): string {
	return typeof raw === "string" ? raw : String(raw);
}

/** The error string listing every known runId. */
function unknownText(engine: WorkflowEngine, runId: string): string {
	const known = [...engine.runs.keys()];
	const list = known.length > 0 ? known.join(", ") : "(none)";
	return `unknown run_id ${runId}. Known runs: ${list}`;
}

export function createWorkflowStopTool(getEngine: () => WorkflowEngine) {
	return defineTool({
		name: "workflow_stop",
		label: "Workflow stop",
		description:
			"Stop a running workflow by run_id. Aborts the run and all its in-flight " +
			"agents. A run that has already completed/errored/cancelled is reported " +
			"as-is — stopping it is a no-op.",
		promptSnippet: "Stop a running workflow by run_id",
		parameters: Type.Object({
			run_id: Type.String({
				description: "the wf_ run id returned by the workflow tool",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const engine = getEngine();
			const runId = coerceId(params.run_id);
			const handle = engine.statusOf(runId);
			if (handle === undefined) {
				return text(unknownText(engine, runId));
			}

			if (handle.record.status !== "running") {
				return text(
					`workflow ${runId} already ${handle.record.status} — nothing to stop.`,
				);
			}

			engine.stopRun(runId);
			return text(`workflow ${runId} cancelled.`);
		},
	});
}
