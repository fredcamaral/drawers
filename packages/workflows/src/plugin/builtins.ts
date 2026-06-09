/**
 * Built-in workflow registry (Epic 2.2).
 *
 * Built-in workflows ship INSIDE the plugin bundle as TS string constants
 * (there is no non-TS asset embedding in `scripts/build.ts` — Bun.build only
 * takes JS/TS entrypoints, so a built-in's source lives here as a string).
 * A built-in is resolved by name BEFORE the on-disk `.opencode/workflows/<name>`
 * lookup, so a built-in **wins** over a user file of the same name: a shipped
 * capability is predictably available and cannot be silently shadowed. Both
 * resolution paths — the in-script `workflow()` global (via `createSourceResolver`)
 * and the top-level `workflow` tool (via its own `loadSavedWorkflow`) — consult
 * this registry through {@link lookupBuiltin}.
 *
 * Phase 2 shipped the mechanism with an empty registry; Phase 3 adds the
 * `deep-research` source.
 */

import { DEEP_RESEARCH_SOURCE } from "./builtin-deep-research";

/** Built-in name → workflow script source. */
export const BUILTIN_WORKFLOWS: Record<string, string> = {
	"deep-research": DEEP_RESEARCH_SOURCE,
};

/**
 * Return the built-in source for `name`, or `undefined` if there is no built-in
 * by that name. `registry` defaults to {@link BUILTIN_WORKFLOWS}; tests inject a
 * fake registry to exercise precedence without shipping a real built-in.
 */
export function lookupBuiltin(
	name: string,
	registry: Record<string, string> = BUILTIN_WORKFLOWS,
): string | undefined {
	return Object.hasOwn(registry, name) ? registry[name] : undefined;
}
