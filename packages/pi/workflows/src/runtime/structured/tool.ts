/**
 * `structured_output` — the tool a CHILD agent calls to return a schema-conforming
 * result for `agent({ schema })` (Task 3.3.2, pi port).
 *
 * pi-native redesign vs opencode. In opencode the parent and child shared ONE
 * process and ONE in-memory {@link SchemaRegistry}: the child's `structured_output`
 * call validated against that shared registry and `store`d the accepted value, and
 * the parent read it straight back from the same Map. In pi the child is a SEPARATE
 * `pi --mode rpc` subprocess — there is no shared Map to write into. So this tool is
 * a DUMB ECHO: it takes the model's JSON value and returns it as its result `content`
 * (uncapped, model-irrelevant beyond the echo) with `terminate: true`, ending the
 * child's turn cleanly with the value as the LAST `structured_output` tool result on
 * the persisted transcript. The PARENT (`agent-call.ts` `resolveStructured`) reads
 * that tool result back off the child's transcript, then compiles-and-validates it
 * against the schema it holds — moving ALL validation parent-side, where the schema
 * lives. The model-facing retry (a bad value) is the parent's existing single
 * STRUCTURED_NUDGE resume carrying the validation errors, not an in-child re-prompt.
 *
 * The child cannot reach the parent's registry, so it does NOT validate here:
 * validating in the child would require shipping the compiled schema across the
 * process boundary and re-introducing a child-side registry — the rejected design.
 * The prompt suffix the parent appends (agent-call's `structuredPromptSuffix`) tells
 * the model the schema; this tool just captures whatever value the model produces.
 *
 * `terminate: true` (pi tool contract): the follow-up LLM call is skipped only when
 * EVERY finalized tool in the batch terminates. A `structured_output` call is the
 * agent's intended final action, so it terminates the turn on the structured answer.
 *
 * Node-safe: no Bun.* APIs.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * The marker the child echoes so the parent can locate THIS payload unambiguously
 * even if a transcript reader collapses tool metadata. The parent reads the tool
 * result by `toolName === "structured_output"`; the marker is a defensive secondary
 * locator when only flat text survives the transcript materialization.
 */
export const STRUCTURED_OUTPUT_TOOL_NAME = "structured_output";

/**
 * Build the `structured_output` tool definition for the CHILD subprocess. It is
 * registered at extension load (so the child, which loads this same extension, has
 * it) and granted per-launch via `toolsOverride.structured_output`. The PARENT never
 * invokes it — registering it parent-side is harmless.
 *
 * Returns the raw JSON value verbatim as the tool result `content` text and
 * `terminate: true`. The parent extracts it from the transcript and validates it; a
 * parse/schema failure becomes the parent's nudge-and-retry, not a child-side error
 * string.
 */
export function createStructuredOutputTool() {
	return defineTool({
		name: STRUCTURED_OUTPUT_TOOL_NAME,
		label: "Structured output",
		description:
			"Return your final result as a JSON value conforming to the required " +
			"schema. Pass the JSON-encoded value as `result`. This ends your turn; " +
			"the orchestrator validates the value and, if it does not conform, asks " +
			"you once more to call this tool with a corrected value.",
		promptSnippet: "Return the final structured answer as a JSON value",
		parameters: Type.Object({
			result: Type.String({
				description: "JSON-encoded value conforming to the required schema",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			// Defensive coercion: pi does NOT apply schema defaults/coercion to raw
			// incoming values (gotcha #4), and a model may hand us an object despite the
			// declared string arg. Accept either — echo a stringified value so the
			// transcript carries a parseable JSON string the parent can read back.
			const raw =
				typeof params.result === "string"
					? params.result
					: JSON.stringify(params.result);
			return {
				// The echoed value is the LLM-facing content too; it is the agent's last
				// turn, so what the model "sees" no longer matters. The parent reads THIS
				// text off the persisted transcript and validates it.
				content: [{ type: "text" as const, text: raw }],
				// Also stash the raw value in details (persisted, not LLM-facing) for any
				// future renderer/state path; the parent reads from content today.
				details: { result: raw },
				// End the turn on the structured answer (skips the trailing LLM call when
				// the whole batch terminates — the canonical structured_output use).
				terminate: true,
			};
		},
	});
}
