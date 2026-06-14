/**
 * In-memory concurrency limiter with key-based slots, FIFO queueing, and
 * direct slot handoff on release. No timers, no persistence.
 *
 * Limit and key resolution follow where the configured knob lives:
 * model-level > provider-level > default > 5. A resolved limit of 0 means
 * unlimited (acquire never queues).
 */

export interface ConcurrencyConfig {
	defaultConcurrency?: number;
	providerConcurrency?: Record<string, number>;
	modelConcurrency?: Record<string, number>;
}

/** A held or pending acquisition. `id` is stable for cancellation. */
export interface SlotHolder {
	id: string;
}

/**
 * The promise returned by {@link ConcurrencyManager.acquire}. The slot id is
 * attached synchronously so a still-pending waiter can be cancelled by id
 * before its promise has resolved.
 */
export type AcquireResult = Promise<SlotHolder> & { readonly id: string };

/** Rejection type for cancelled queue waiters, so callers can discriminate. */
export class WaiterCancelledError extends Error {
	readonly waiterId: string;

	constructor(waiterId: string, reason: string) {
		super(reason);
		this.name = "WaiterCancelledError";
		this.waiterId = waiterId;
	}
}

const FALLBACK_LIMIT = 5;
const UNLIMITED = 0;

/** A single queued waiter. Settles exactly once: first settle wins. */
interface Waiter {
	id: string;
	grant: (holder: SlotHolder) => void;
	deny: (error: WaiterCancelledError) => void;
	done: boolean;
}

export class ConcurrencyManager {
	private readonly cfg: ConcurrencyConfig;
	private readonly active = new Map<string, number>();
	private readonly waiting = new Map<string, Waiter[]>();
	private seq = 0;

	constructor(config: ConcurrencyConfig = {}) {
		this.cfg = config;
	}

	/** Resolve the effective slot limit for a model. 0 means unlimited. */
	limitFor(model: string): number {
		const byModel = this.cfg.modelConcurrency?.[model];
		if (byModel !== undefined) {
			return byModel;
		}
		const byProvider = this.cfg.providerConcurrency?.[providerOf(model)];
		if (byProvider !== undefined) {
			return byProvider;
		}
		if (this.cfg.defaultConcurrency !== undefined) {
			return this.cfg.defaultConcurrency;
		}
		return FALLBACK_LIMIT;
	}

	/** Resolve the slot key — follows where the configured knob lives. */
	keyFor(model: string): string {
		if (this.cfg.modelConcurrency?.[model] !== undefined) {
			return model;
		}
		const provider = providerOf(model);
		if (provider && this.cfg.providerConcurrency?.[provider] !== undefined) {
			return provider;
		}
		return model;
	}

	/** Active (held) slot count for a model's key. */
	runningCount(model: string): number {
		return this.active.get(this.keyFor(model)) ?? 0;
	}

	/** Pending waiter count for a model's key. */
	queueLength(model: string): number {
		return this.waiting.get(this.keyFor(model))?.length ?? 0;
	}

	/**
	 * Acquire a slot. Resolves immediately when under the limit (or unlimited),
	 * otherwise enqueues FIFO and resolves when a slot is handed off.
	 */
	acquire(model: string): AcquireResult {
		const id = this.nextId();
		const limit = this.limitFor(model);

		if (limit === UNLIMITED) {
			return attachId(Promise.resolve({ id }), id);
		}

		const key = this.keyFor(model);
		const held = this.active.get(key) ?? 0;
		if (held < limit) {
			this.active.set(key, held + 1);
			return attachId(Promise.resolve({ id }), id);
		}

		const promise = new Promise<SlotHolder>((resolve, reject) => {
			const waiter: Waiter = {
				id,
				done: false,
				grant: (holder) => {
					if (waiter.done) {
						return;
					}
					waiter.done = true;
					resolve(holder);
				},
				deny: (error) => {
					if (waiter.done) {
						return;
					}
					waiter.done = true;
					reject(error);
				},
			};
			const queue = this.waiting.get(key);
			if (queue) {
				queue.push(waiter);
			} else {
				this.waiting.set(key, [waiter]);
			}
		});
		return attachId(promise, id);
	}

	/**
	 * Free a slot. If a live FIFO waiter exists, hand the slot directly to it
	 * (the active count is unchanged). Otherwise decrement.
	 */
	release(model: string): void {
		const key = this.keyFor(model);
		const queue = this.waiting.get(key);

		if (queue) {
			while (queue.length > 0) {
				const next = queue.shift();
				if (queue.length === 0) {
					this.waiting.delete(key);
				}
				if (next && !next.done) {
					next.grant({ id: next.id });
					return;
				}
			}
		}

		const held = this.active.get(key) ?? 0;
		if (held > 0) {
			this.active.set(key, held - 1);
		}
	}

	/** Reject a specific queued waiter by id. No-op if settled or unknown. */
	cancelWaiter(model: string, id: string): void {
		const key = this.keyFor(model);
		const queue = this.waiting.get(key);
		if (!queue) {
			return;
		}
		const index = queue.findIndex((w) => w.id === id && !w.done);
		if (index === -1) {
			return;
		}
		const [waiter] = queue.splice(index, 1);
		if (queue.length === 0) {
			this.waiting.delete(key);
		}
		if (waiter) {
			waiter.deny(
				new WaiterCancelledError(id, `Concurrency waiter cancelled: ${id}`),
			);
		}
	}

	/** Reject every queued waiter for a model's key. */
	cancelWaiters(model: string): void {
		const key = this.keyFor(model);
		this.rejectQueue(key, `Concurrency waiters cancelled for key: ${key}`);
	}

	/** Reject all waiters everywhere and reset all counts. */
	clear(): void {
		for (const key of [...this.waiting.keys()]) {
			this.rejectQueue(key, `Concurrency manager cleared: ${key}`);
		}
		this.waiting.clear();
		this.active.clear();
	}

	private rejectQueue(key: string, reason: string): void {
		const queue = this.waiting.get(key);
		if (!queue) {
			return;
		}
		this.waiting.delete(key);
		for (const waiter of queue) {
			if (!waiter.done) {
				waiter.deny(new WaiterCancelledError(waiter.id, reason));
			}
		}
	}

	private nextId(): string {
		this.seq += 1;
		return `w${this.seq}`;
	}
}

function providerOf(model: string): string {
	return model.split("/")[0] ?? model;
}

function attachId(promise: Promise<SlotHolder>, id: string): AcquireResult {
	return Object.defineProperty(promise, "id", {
		value: id,
		writable: false,
		enumerable: true,
	}) as AcquireResult;
}
