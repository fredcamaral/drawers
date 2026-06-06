/**
 * Background-task ID generation.
 *
 * IDs are `"bg_"` + an 8-character lowercase alphanumeric suffix. The random
 * source is injectable so tests can force collisions and exhaustion; the
 * default (`Math.random`) is acceptable here because engine-internal IDs do not
 * carry the workflow-script determinism requirement — only injectability does.
 */

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const SUFFIX_LENGTH = 8;
const MAX_ATTEMPTS = 100;

export interface IdGeneratorOptions {
	/** Injectable random source in [0, 1). Defaults to `Math.random`. */
	random?: () => number;
}

export interface IdGenerator {
	/**
	 * Returns a fresh `bg_*` ID not present in `liveIds`. Regenerates on
	 * collision and throws after {@link MAX_ATTEMPTS} attempts rather than
	 * looping forever.
	 */
	next(liveIds: ReadonlySet<string>): string;
}

export function createIdGenerator(opts: IdGeneratorOptions = {}): IdGenerator {
	const random = opts.random ?? Math.random;

	function candidate(): string {
		let suffix = "";
		for (let i = 0; i < SUFFIX_LENGTH; i += 1) {
			const index = Math.floor(random() * ALPHABET.length) % ALPHABET.length;
			suffix += ALPHABET[index];
		}
		return `bg_${suffix}`;
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
