/**
 * Pure composition primitives for workflow scripts (spec §3.3 rows 2-3, §4, §5, §9).
 *
 * These functions NEVER touch the runner — they compose whatever async functions
 * the script passes. `pipeline()` is the default composition primitive: per-item
 * independent chains with NO barrier between stages. `parallel()` is the barrier:
 * it awaits all thunks before returning. Both "degrade, don't detonate" — a
 * failure becomes a `null` slot rather than a rejection — and both refuse to
 * silently truncate: more than `ITEM_CAP` items/thunks throws at call time.
 */

/** Maximum items per single `pipeline()`/`parallel()` call (spec §5). */
export const ITEM_CAP = 4096;

/**
 * A single pipeline stage. Receives the previous stage's result (`prev`), the
 * original item that started this chain (`originalItem`), and the item's index.
 * May be sync or async; its return value is awaited and fed to the next stage.
 */
export type PipelineStage = (
	prev: unknown,
	originalItem: unknown,
	index: number,
) => unknown;

/**
 * Thrown when a `pipeline()`/`parallel()` call exceeds {@link ITEM_CAP}.
 *
 * Canonical home for this error type. Carries the actual count and the cap so the
 * caller can report precisely instead of guessing — silent truncation reads as
 * "covered everything" (spec §9), so the cap is an explicit error, never a slice.
 */
export class ItemCapError extends Error {
	/** The actual number of items/thunks the caller passed. */
	readonly count: number;
	/** The maximum allowed (always {@link ITEM_CAP}). */
	readonly cap: number;

	constructor(count: number, cap: number = ITEM_CAP) {
		super(
			`too many items for a single call: ${count} exceeds the cap of ${cap}`,
		);
		this.name = "ItemCapError";
		this.count = count;
		this.cap = cap;
	}
}

/**
 * Runs each item through all stages **independently, with no barrier** — item A
 * can be in stage 3 while item B is in stage 1 (spec §3.3, §4). Each stage receives
 * `(prevResult, originalItem, index)`. A throwing stage (sync or async) drops THAT
 * item to `null` and skips its remaining stages; other items are unaffected
 * (spec §9). Zero stages returns the items as-is.
 *
 * The per-item loop below IS the no-barrier property: nothing synchronizes across
 * items — each item's chain is its own independent promise.
 *
 * @throws {ItemCapError} when `items.length` exceeds {@link ITEM_CAP}.
 */
export function pipeline<T>(
	items: readonly T[],
	...stages: PipelineStage[]
): Promise<unknown[]> {
	if (items.length > ITEM_CAP) {
		throw new ItemCapError(items.length);
	}

	return Promise.all(
		items.map(async (item, index) => {
			let prev: unknown = item;
			for (const stage of stages) {
				try {
					prev = await stage(prev, item, index);
				} catch {
					return null;
				}
			}
			return prev;
		}),
	);
}

/**
 * Runs thunks concurrently with a **barrier**: awaits all before returning
 * (spec §3.3, §4). A failing thunk — whether it rejects, throws asynchronously,
 * throws synchronously, or is not callable — resolves to `null` in the result
 * array at its original index; the call itself NEVER rejects (spec §9).
 *
 * `Promise.resolve().then(() => thunk())` invokes the thunk inside the microtask
 * continuation so that a synchronous throw — and a non-callable `thunk`, which
 * raises "thunk is not a function" — are both routed into the same `.catch()` as
 * async rejections. (Calling the thunk explicitly, rather than passing it as the
 * `then` handler, is what makes a non-function slot resolve to `null`: per ES
 * semantics `then(nonFunction)` would silently pass `undefined` through instead.)
 *
 * @throws {ItemCapError} when `thunks.length` exceeds {@link ITEM_CAP}.
 */
export function parallel(
	thunks: ReadonlyArray<() => unknown>,
): Promise<unknown[]> {
	if (thunks.length > ITEM_CAP) {
		throw new ItemCapError(thunks.length);
	}

	return Promise.all(
		thunks.map((thunk) =>
			Promise.resolve()
				.then(() => thunk())
				.catch(() => null),
		),
	);
}
