/**
 * Defensive arg coercion shared by the cadence tools.
 *
 * opencode's raw execute path applies NO Zod defaults/coercion, so an omitted or
 * mistyped arg can reach `execute()` as `undefined`/`NaN`/wrong-typed. These
 * helpers narrow such input to honest values: a non-string becomes "" (the tools
 * treat empty as "absent"), and a non-positive/NaN/Infinity number becomes
 * `undefined` (the tools then fall back to a default or report an error).
 */

/** Coerce to a string; anything non-string becomes "". */
export function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** Coerce to a floored positive integer; non-finite/<=0 becomes `undefined`. */
export function asPositiveInt(value: unknown): number | undefined {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n) || n <= 0) {
		return undefined;
	}
	return Math.floor(n);
}
