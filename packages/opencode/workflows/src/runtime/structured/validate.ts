import Ajv, { type ValidateFunction } from "ajv";

/**
 * ajv wrapper for `agent({ schema })` structured output (Task 3.3.1).
 *
 * A JSON Schema is compiled ONCE at `agent()` call time into a {@link CompiledSchema}
 * whose `validate` returns either `{ ok: true }` or `{ ok: false; errors }` — the
 * `errors` string is the retry signal handed back to the model, so it is flattened
 * to be human/model readable (instancePath + message per error, joined with "; ").
 *
 * A malformed schema is a SCRIPT bug, not a runtime degrade: ajv's compile throw
 * propagates wrapped in {@link SchemaCompileError} so it detonates at `agent()`
 * call time carrying ajv's own diagnostic message.
 */

/** A schema compiled into a reusable validator. */
export interface CompiledSchema {
	validate(value: unknown): { ok: true } | { ok: false; errors: string };
}

/** ajv could not compile the schema — a malformed-schema SCRIPT bug. */
export class SchemaCompileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SchemaCompileError";
	}
}

/**
 * One shared Ajv instance for the whole module. Ajv caches compiled validators by
 * schema identity, so reusing a single instance gives us a free compile cache and
 * avoids re-instantiating the (non-trivial) compiler per call. `allErrors` is on so
 * a single validation surfaces every violation in the retry signal, not just the
 * first.
 */
const ajv = new Ajv({ allErrors: true });

/**
 * Compile a JSON Schema into a {@link CompiledSchema}.
 *
 * @throws {SchemaCompileError} when ajv rejects the schema as malformed.
 */
export function compileSchema(schema: object): CompiledSchema {
	let validateFn: ValidateFunction;
	try {
		validateFn = ajv.compile(schema);
	} catch (err) {
		throw new SchemaCompileError(
			err instanceof Error ? err.message : String(err),
		);
	}

	return {
		validate(value: unknown) {
			if (validateFn(value)) {
				return { ok: true };
			}
			return { ok: false, errors: flattenErrors(validateFn) };
		},
	};
}

/**
 * Flatten ajv's error array into ONE readable string: `instancePath message` per
 * error, joined with "; ". This string IS what the model sees on a failed turn, so
 * it must read as actionable guidance, not as a JSON dump.
 */
function flattenErrors(validateFn: ValidateFunction): string {
	const errors = validateFn.errors ?? [];
	return errors
		.map((e) => {
			const path = e.instancePath || "(root)";
			return `${path} ${e.message ?? "is invalid"}`.trim();
		})
		.join("; ");
}
