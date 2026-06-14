/**
 * Background-task ID generation.
 *
 * IDs are a configurable prefix (default `"bg_"`) + an 8-character lowercase
 * alphanumeric suffix. The prefix is overridable so other engines reuse the
 * same collision-checked generator with their own namespace (the workflows
 * engine mints `"wf_"` run ids). The random source is injectable so tests can
 * force collisions and exhaustion; the default (`Math.random`) is acceptable
 * here because engine-internal IDs do not carry the workflow-script determinism
 * requirement — only injectability does.
 */

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const SUFFIX_LENGTH = 8;
const MAX_ATTEMPTS = 100;
const DEFAULT_PREFIX = "bg_";

export interface IdGeneratorOptions {
	/** Injectable random source in [0, 1). Defaults to `Math.random`. */
	random?: () => number;
	/** ID namespace prefix. Defaults to `"bg_"`. */
	prefix?: string;
}

export interface IdGenerator {
	/**
	 * Returns a fresh prefix-namespaced ID (default `bg_*`; the prefix is
	 * configurable per generator) not present in `liveIds`. Regenerates on
	 * collision and throws after {@link MAX_ATTEMPTS} attempts rather than
	 * looping forever.
	 */
	next(liveIds: ReadonlySet<string>): string;
}

export function createIdGenerator(opts: IdGeneratorOptions = {}): IdGenerator {
	const random = opts.random ?? Math.random;
	const prefix = opts.prefix ?? DEFAULT_PREFIX;

	function candidate(): string {
		let suffix = "";
		for (let i = 0; i < SUFFIX_LENGTH; i += 1) {
			const raw = Math.floor(random() * ALPHABET.length) % ALPHABET.length;
			// A misbehaving injected `random` (NaN, negative) would otherwise index
			// out of the alphabet and leak literal "undefined" into the id
			// (`bg_undefined…`). Clamp to a valid index instead — the id stays
			// well-formed even under a broken source.
			const index = Number.isFinite(raw) && raw >= 0 ? raw : 0;
			suffix += ALPHABET[index];
		}
		return `${prefix}${suffix}`;
	}

	return {
		next(liveIds: ReadonlySet<string>): string {
			for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
				const id = candidate();
				if (!liveIds.has(id)) {
					return id;
				}
			}
			throw new Error(
				`Failed to generate a unique task ID after ${MAX_ATTEMPTS} attempts`,
			);
		},
	};
}
