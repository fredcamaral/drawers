/**
 * Defensive arg coercion shared by the cadence tools.
 *
 * pi validates tool params against the typebox schema, but the coercion is kept
 * for two reasons: it preserves the exact flooring (`1500.9 → 1500`, `7.8 → 7`) and
 * empty-treated-as-absent behavior the original tools relied on, and it guards a
 * `prepareArguments`-resumed legacy arg shape that may not match the current schema.
 * A non-string becomes "" (the tools treat empty as "absent"), and a
 * non-positive/NaN/Infinity number becomes `undefined` (the tools then fall back to
 * a default or report an error).
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
