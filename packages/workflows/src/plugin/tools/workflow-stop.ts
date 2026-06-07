/**
 * `workflow_stop` — cancel a live workflow run by run_id.
 *
 * Built as a `tool()` factory closing over the engine. Three outcomes, all
 * honest strings (never a thrown crash the model cannot reason over):
 *   - unknown run_id → error listing the known runs;
 *   - already-terminal run → report its status, no-op (do NOT dress a finished
 *     run up as a fresh cancellation);
 *   - running run → `engine.stopRun(runId)`, confirm the cancellation.
 */

import { type ToolContext, tool } from "@opencode-ai/plugin";
import type { WorkflowEngine } from "../engine";

/** Coerce a raw arg to string (opencode's raw path may hand a non-string). */
function coerceId(raw: unknown): string {
	return typeof raw === "string" ? raw : String(raw);
}

/** The error string listing every known runId. */
function unknownText(engine: WorkflowEngine, runId: string): string {
	const known = [...engine.runs.keys()];
	const list = known.length > 0 ? known.join(", ") : "(none)";
	return `unknown run_id ${runId}. Known runs: ${list}`;
}

export function createWorkflowStopTool(engine: WorkflowEngine) {
	return tool({
		description:
			"Stop a running workflow by run_id. Aborts the run and all its in-flight " +
			"agents. A run that has already completed/errored/cancelled is reported " +
			"as-is — stopping it is a no-op.",
		args: {
			run_id: tool.schema
				.string()
				.describe("the wf_ run id returned by the workflow tool"),
		},
		async execute(args, _context: ToolContext) {
			const runId = coerceId(args.run_id);
			const handle = engine.statusOf(runId);
			if (handle === undefined) {
				return unknownText(engine, runId);
			}

			if (handle.record.status !== "running") {
				return `workflow ${runId} already ${handle.record.status} — nothing to stop.`;
			}

			engine.stopRun(runId);
			return `workflow ${runId} cancelled.`;
		},
	});
}
