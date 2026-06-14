import { beforeEach, describe, expect, test } from "bun:test";
import {
	createNotificationQueue,
	type NotificationQueue,
	type TaskNotice,
} from "./notify";
import type { SessionStatusMap } from "./session-runner";
import type { BgTask } from "./types";
import {
	createWakeNotifier,
	MAX_WAKE_ROUNDS,
	type WakeClient,
} from "./wake-notifier";

// --- fixtures --------------------------------------------------------------

let seq = 0;

function makeTask(over: Partial<BgTask> = {}): BgTask {
	seq += 1;
	return {
		id: `bg_${seq.toString().padStart(8, "0")}`,
		parentSessionID: "parent_a",
		description: "do the thing",
		agent: "build",
		status: "completed",
		createdAt: 1000,
		startedAt: 1100,
		completedAt: 1600,
		depth: 0,
		concurrencyKey: "k",
		...over,
	};
}

/** Records every promptAsync call; status() answers from a scripted map/throw. */
interface PromptCall {
	id: string;
	body: {
		agent?: string;
		parts: Array<{ type: "text"; text: string }>;
	};
}

interface FakeClient extends WakeClient {
	calls: PromptCall[];
	statusCalls: number;
	/** Deferreds keyed by call index so a test can hold a wake in flight. */
	settlePrompt: (index: number) => void;
	rejectPrompt: (index: number, err: unknown) => void;
}

function makeClient(opts: {
	status?: SessionStatusMap;
	statusThrows?: boolean;
	autoSettle?: boolean; // resolve promptAsync immediately (default true)
	/** Side effect fired on every promptAsync (models completions mid-wake). */
	onPrompt?: () => void;
}): FakeClient {
	const calls: PromptCall[] = [];
	const resolvers: Array<() => void> = [];
	const rejectors: Array<(err: unknown) => void> = [];
	const autoSettle = opts.autoSettle ?? true;

	const client: FakeClient = {
		calls,
		statusCalls: 0,
		settlePrompt: (i) => resolvers[i]?.(),
		rejectPrompt: (i, err) => rejectors[i]?.(err),
		session: {
			status: async () => {
				client.statusCalls += 1;
				if (opts.statusThrows) {
					throw new Error("status() boom");
				}
				return { data: opts.status ?? {} };
			},
			promptAsync: (args) => {
				calls.push({
					id: args.path.id,
					body: {
						...(args.body.agent !== undefined
							? { agent: args.body.agent }
							: {}),
						parts: args.body.parts.map((p) => ({
							type: "text" as const,
							text: p.text,
						})),
					},
				});
				opts.onPrompt?.();
				if (autoSettle) {
					return Promise.resolve();
				}
				return new Promise<void>((resolve, reject) => {
					resolvers.push(resolve);
					rejectors.push(reject);
				});
			},
		},
	};
	return client;
}

/** Drain the microtask queue a few times so async notify() settles. */
function flush(): Promise<void> {
	return (async () => {
		for (let i = 0; i < 12; i++) {
			await Promise.resolve();
		}
	})();
}

/** Pending notice at index `i`, asserted present (avoids non-null assertions). */
function notice(parent: string, i = 0): TaskNotice {
	const list = queue.pending(parent);
	const n = list[i];
	if (!n) {
		throw new Error(`expected a pending notice at index ${i} for ${parent}`);
	}
	return n;
}

/** Recorded prompt call at index `i`, asserted present. */
function callAt(calls: PromptCall[], i = 0): PromptCall {
	const c = calls[i];
	if (!c) {
		throw new Error(`expected a promptAsync call at index ${i}`);
	}
	return c;
}

/** Joined text of a prompt call's parts. */
function callText(call: PromptCall): string {
	return call.body.parts.map((p) => p.text).join("\n");
}

let queue: NotificationQueue;

beforeEach(() => {
	queue = createNotificationQueue({});
});

// ---------------------------------------------------------------------------

describe("wake notifier", () => {
	// Named test 1: idle parent → one coalesced promptAsync carrying all pending
	// notices, consumed (queue drained, marked notified).
	test("idle parent → one coalesced wake carrying all pending notices, consumed", async () => {
		const client = makeClient({ status: { parent_a: { type: "idle" } } });
		const wake = createWakeNotifier({ client, queue });

		const t1 = makeTask({ parentSessionID: "parent_a", description: "alpha" });
		const t2 = makeTask({ parentSessionID: "parent_a", description: "beta" });
		queue.push(t1);
		queue.push(t2);

		await wake.notify(notice("parent_a"));
		await flush();

		// Exactly one wake prompt to the parent.
		expect(client.calls).toHaveLength(1);
		const call = callAt(client.calls);
		expect(call.id).toBe("parent_a");
		const text = callText(call);
		// Coalesced: both notices present.
		expect(text).toContain("alpha");
		expect(text).toContain("beta");
		// CC-style demarcation.
		expect(text).toContain("[task-notification]");
		expect(text.toLowerCase()).toContain("automated notice");
		expect(text.toLowerCase()).toContain("not the user");
		// Parent keeps its own agent — wake omits the agent field.
		expect(call.body.agent).toBeUndefined();
		// Consumed: queue drained.
		expect(queue.pending("parent_a")).toHaveLength(0);
	});

	// Named test 2: busy parent → no prompt, notices remain queued for the flush.
	test("busy parent → no wake, notices remain queued", async () => {
		const client = makeClient({ status: { parent_a: { type: "busy" } } });
		const wake = createWakeNotifier({ client, queue });

		queue.push(makeTask({ parentSessionID: "parent_a" }));
		await wake.notify(notice("parent_a"));
		await flush();

		expect(client.calls).toHaveLength(0);
		expect(queue.pending("parent_a")).toHaveLength(1);
	});

	// Named test 3: retry parent → treated like busy (leave queued).
	test("retry parent → no wake, notices remain queued", async () => {
		const client = makeClient({
			status: {
				parent_a: { type: "retry", attempt: 1, message: "x", next: 0 },
			},
		});
		const wake = createWakeNotifier({ client, queue });

		queue.push(makeTask({ parentSessionID: "parent_a" }));
		await wake.notify(notice("parent_a"));
		await flush();

		expect(client.calls).toHaveLength(0);
		expect(queue.pending("parent_a")).toHaveLength(1);
	});

	// Named test 4: parent ABSENT from the status map → wake (absent ≠ busy).
	test("absent parent (not in status map) → wake fires", async () => {
		const client = makeClient({ status: { someone_else: { type: "busy" } } });
		const wake = createWakeNotifier({ client, queue });

		queue.push(makeTask({ parentSessionID: "parent_a" }));
		await wake.notify(notice("parent_a"));
		await flush();

		expect(client.calls).toHaveLength(1);
		expect(callAt(client.calls).id).toBe("parent_a");
		expect(queue.pending("parent_a")).toHaveLength(0);
	});

	// Named test 5: promptAsync throws → notices stay queued (passive fallback —
	// the at-least-once direction: the prompt MAY have landed server-side).
	test("promptAsync rejects → notices remain queued, not consumed", async () => {
		const client = makeClient({
			status: { parent_a: { type: "idle" } },
			autoSettle: false,
		});
		const wake = createWakeNotifier({ client, queue });

		queue.push(makeTask({ parentSessionID: "parent_a" }));
		const p = wake.notify(notice("parent_a"));
		await flush();
		client.rejectPrompt(0, new Error("prompt boom"));
		await p;
		await flush();

		// The wake was attempted but failed → notices NOT consumed.
		expect(queue.pending("parent_a")).toHaveLength(1);
	});

	// Named test 6: status() itself throws → fenced, no wake, notices remain.
	// Decision: a FAILED status read (throw) ≠ a successful "absent" read. We
	// do not prompt-inject a parent we cannot reason about; the passive flush is
	// the guaranteed fallback.
	test("status() throws → fenced, no wake, notices remain", async () => {
		const client = makeClient({ statusThrows: true });
		const errors: string[] = [];
		const wake = createWakeNotifier({
			client,
			queue,
			logger: { error: (m) => errors.push(m) },
		});

		queue.push(makeTask({ parentSessionID: "parent_a" }));
		await wake.notify(notice("parent_a"));
		await flush();

		expect(client.calls).toHaveLength(0);
		expect(queue.pending("parent_a")).toHaveLength(1);
		expect(errors.length).toBeGreaterThan(0);
	});

	// Named test 7: per-parent in-flight guard — concurrent notices for the same
	// parent produce a SINGLE in-flight wake (no double prompt).
	test("concurrent notices for one parent → single in-flight wake", async () => {
		const client = makeClient({
			status: { parent_a: { type: "idle" } },
			autoSettle: false,
		});
		const wake = createWakeNotifier({ client, queue });

		const t1 = makeTask({ parentSessionID: "parent_a", description: "first" });
		const t2 = makeTask({ parentSessionID: "parent_a", description: "second" });
		queue.push(t1);
		queue.push(t2);

		// Two notify() calls overlap; the first holds the prompt in flight.
		const p1 = wake.notify(notice("parent_a", 0));
		const p2 = wake.notify(notice("parent_a", 1));
		await flush();

		// Only one promptAsync despite two notify() calls.
		expect(client.calls).toHaveLength(1);

		client.settlePrompt(0);
		await Promise.all([p1, p2]);
		await flush();

		// Still exactly one — the guard suppressed the second, and the first
		// coalesced both notices (both were pending at snapshot time).
		expect(client.calls).toHaveLength(1);
		const text = callText(callAt(client.calls));
		expect(text).toContain("first");
		expect(text).toContain("second");
		expect(queue.pending("parent_a")).toHaveLength(0);
	});

	// Named test 8: distinct parents wake independently (guard is per-parent).
	test("distinct parents → independent wakes", async () => {
		const client = makeClient({
			status: { parent_a: { type: "idle" }, parent_b: { type: "idle" } },
		});
		const wake = createWakeNotifier({ client, queue });

		queue.push(makeTask({ parentSessionID: "parent_a" }));
		queue.push(makeTask({ parentSessionID: "parent_b" }));
		await wake.notify(notice("parent_a"));
		await wake.notify(notice("parent_b"));
		await flush();

		expect(client.calls).toHaveLength(2);
		const ids = client.calls.map((c) => c.id).sort();
		expect(ids).toEqual(["parent_a", "parent_b"]);
	});

	// Finding #4: a notice arriving while a wake's promptAsync is in flight must
	// NOT be marked notified by that wake's drain (its text never contained it) —
	// and must not be lost: the bounded follow-up round delivers it.
	test("mid-flight notice is not consumed by the in-flight wake; follow-up wake delivers it once", async () => {
		const client = makeClient({
			status: { parent_a: { type: "idle" } },
			autoSettle: false,
		});
		const wake = createWakeNotifier({ client, queue });

		queue.push(makeTask({ parentSessionID: "parent_a", description: "alpha" }));
		const p = wake.notify(notice("parent_a"));
		await flush();
		expect(client.calls).toHaveLength(1);

		// beta completes while alpha's wake prompt is in flight.
		queue.push(makeTask({ parentSessionID: "parent_a", description: "beta" }));

		client.settlePrompt(0);
		await flush();

		// Wake 1 carried ONLY alpha; beta was not silently consumed by its drain.
		expect(callText(callAt(client.calls, 0))).toContain("alpha");
		expect(callText(callAt(client.calls, 0))).not.toContain("beta");

		// The bounded follow-up round delivered beta in its own wake.
		expect(client.calls).toHaveLength(2);
		expect(callText(callAt(client.calls, 1))).toContain("beta");
		expect(callText(callAt(client.calls, 1))).not.toContain("alpha");

		client.settlePrompt(1);
		await p;
		await flush();

		// No loss, no duplicates: each notice delivered exactly once, queue empty.
		expect(client.calls).toHaveLength(2);
		expect(queue.pending("parent_a")).toHaveLength(0);
	});

	// Finding #4: the follow-up loop is BOUNDED — a stream of completions landing
	// during each wake stops waking after MAX_WAKE_ROUNDS; the remainder stays
	// queued for the passive flush.
	test("follow-up wakes are bounded; the overflow stays queued for the passive flush", async () => {
		const client = makeClient({
			status: { parent_a: { type: "idle" } },
			onPrompt: () => {
				// Every wake triggers a fresh completion mid-flight.
				queue.push(
					makeTask({ parentSessionID: "parent_a", description: "extra" }),
				);
			},
		});
		const wake = createWakeNotifier({ client, queue });

		queue.push(makeTask({ parentSessionID: "parent_a", description: "first" }));
		await wake.notify(notice("parent_a"));
		await flush();

		expect(client.calls).toHaveLength(MAX_WAKE_ROUNDS);
		// The last mid-flight arrival was NOT woken (bound hit) and NOT lost.
		expect(queue.pending("parent_a")).toHaveLength(1);
	});

	// Finding #8: empty pending → early return, no status read, no prompt.
	test("empty pending → early return without a status read", async () => {
		const client = makeClient({ status: { parent_a: { type: "idle" } } });
		const wake = createWakeNotifier({ client, queue });

		await wake.notify({
			taskId: "bg_ghost001",
			parentSessionID: "parent_a",
			description: "already flushed",
			status: "completed",
			hint: "n/a",
		});
		await flush();

		expect(client.statusCalls).toBe(0);
		expect(client.calls).toHaveLength(0);
	});
});
