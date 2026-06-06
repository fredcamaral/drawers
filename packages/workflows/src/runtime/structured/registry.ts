import type { CompiledSchema } from "./validate";

/**
 * Per-session schema + result registry for `agent({ schema })` structured output
 * (Task 3.3.1).
 *
 * The race this exists to win: a child session's `structured_output` tool call must
 * find its schema already registered. The schema is registered (via core's
 * `onSessionCreated` hook) the instant the child sessionID exists, before its first
 * turn runs. The tool call then `lookup`s the schema, validates, and `store`s the
 * accepted value; `agent-call` reads it back via `resultFor` and `clear`s the
 * entries in its finally (Task 3.3.2) — so there is no TTL here, just plain Maps.
 */

/** Lookup/store surface keyed by child sessionID. */
export interface SchemaRegistry {
	register(sessionID: string, schema: CompiledSchema): void;
	lookup(sessionID: string): CompiledSchema | undefined;
	store(sessionID: string, value: unknown): void;
	/**
	 * Read a stored result. `present` distinguishes "a value was stored" (even if
	 * that value is `undefined`) from "nothing was ever stored".
	 */
	resultFor(sessionID: string): { present: boolean; value?: unknown };
	clear(sessionID: string): void;
}

export function createSchemaRegistry(): SchemaRegistry {
	const schemas = new Map<string, CompiledSchema>();
	// A stored result lives here; membership in the Map is the `present` flag, so a
	// stored `undefined` is distinguishable from a never-stored session.
	const results = new Map<string, unknown>();

	return {
		register(sessionID, schema) {
			schemas.set(sessionID, schema);
		},
		lookup(sessionID) {
			return schemas.get(sessionID);
		},
		store(sessionID, value) {
			results.set(sessionID, value);
		},
		resultFor(sessionID) {
			if (results.has(sessionID)) {
				return { present: true, value: results.get(sessionID) };
			}
			return { present: false };
		},
		clear(sessionID) {
			schemas.delete(sessionID);
			results.delete(sessionID);
		},
	};
}
