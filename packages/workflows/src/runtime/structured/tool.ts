/**
 * `structured_output` — the tool a child agent calls to return a schema-conforming
 * result for `agent({ schema })` (Task 3.3.2).
 *
 * This is the retry mechanism: a parse failure or a schema-validation failure is
 * returned as an ERROR STRING so the MODEL sees it and calls the tool again with a
 * fixed value. A script-level parse failure NEVER happens — the script only ever
 * sees the validated object (or `null` when the child never produced one).
 *
 * Built here as a `tool()` factory (a {@link ToolDefinition}); actual registration
 * with opencode is Phase 4's plugin shell. The factory closes over the per-run
 * {@link SchemaRegistry} so a child's call resolves against its own session's
 * schema and stores the accepted value for `agent-call` to read back.
 *
 * Phase 2 lesson (NaN bug): opencode's raw execute path does NOT apply Zod
 * defaults/coercion, so `args.result` is coerced defensively — a model may pass an
 * object despite the string arg schema; we accept it rather than punishing it.
 */

import { type ToolContext, tool } from "@opencode-ai/plugin";
import type { SchemaRegistry } from "./registry";

/** Prefix on the validation-failure string — THE model-facing retry signal. */
const VALIDATION_RETRY_PREFIX =
	"schema validation failed — fix and call structured_output again: ";

export function createStructuredOutputTool(registry: SchemaRegistry) {
	return tool({
		description:
			"Return your final result as a JSON value conforming to the required " +
			"schema. The value is validated; on failure you receive the errors and " +
			"must call this tool again with a corrected value.",
		args: {
			result: tool.schema
				.string()
				.describe("JSON-encoded value conforming to the required schema"),
		},
		async execute(args, context: ToolContext) {
			const sessionID = context.sessionID;

			const schema = registry.lookup(sessionID);
			if (schema === undefined) {
				return "no structured output expected for this session";
			}

			// Defensive coercion: the raw execute path skips Zod, so a model may hand
			// us an object instead of the declared string. Accept either.
			const raw =
				typeof args.result === "string"
					? args.result
					: JSON.stringify(args.result);

			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch (err) {
				return `could not parse result as JSON — fix and call structured_output again: ${
					err instanceof Error ? err.message : String(err)
				}`;
			}

			const verdict = schema.validate(parsed);
			if (!verdict.ok) {
				return VALIDATION_RETRY_PREFIX + verdict.errors;
			}

			registry.store(sessionID, parsed);
			return "accepted";
		},
	});
}
