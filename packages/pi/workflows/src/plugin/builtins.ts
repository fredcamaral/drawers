/**
 * Built-in workflow registry (Epic 2.2).
 *
 * Built-in workflows ship INSIDE the extension bundle as TS string constants.
 * A built-in is resolved by name BEFORE the on-disk `.pi/workflows/<name>` lookup,
 * so a built-in **wins** over a user file of the same name: a shipped capability is
 * predictably available and cannot be silently shadowed. Both resolution paths —
 * the in-script `workflow()` global (via `createSourceResolver`) and the top-level
 * `workflow` tool (via its own `loadSavedWorkflow`) — consult this registry through
 * {@link lookupBuiltin}.
 */

import { DEEP_RESEARCH_SOURCE } from "./builtin-deep-research";
import { ROLLING_WAVE_SOURCE } from "./builtin-rolling-wave";

/** Built-in name → workflow script source. */
export const BUILTIN_WORKFLOWS: Record<string, string> = {
	"deep-research": DEEP_RESEARCH_SOURCE,
	"rolling-wave": ROLLING_WAVE_SOURCE,
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
