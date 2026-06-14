/**
 * Unit tests for the completion notifier — the in-process collapse of opencode's
 * wake-notifier + notify-hooks. Two behaviours pinned (ported from the opencode
 * index.test.ts wake-wiring suite):
 *   - idle parent → toast AND a `sendUserMessage` wake naming bg_output, then the
 *     delivered snapshot is consumed from the queue;
 *   - busy parent → toast only, NO wake, notice stays for the passive drain.
 * Plus: the before_agent_start passive drain returns the synthetic message; all
 * paths are fenced (a throwing notify/sendUserMessage never escapes).
 */

import { describe, expect, test } from "bun:test";
import {
	createNotificationQueue,
	type NoticeRecord,
	type NotificationQueue,
} from "@drawers/pi-core";
import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	createBeforeAgentStartDrain,
	createCompletionNotifier,
} from "./notifier";
import { makeFakeContext } from "./test-fakes";

const PARENT = "parent_1";

/** Build a fake pi recording every sendUserMessage. */
function makePi(opts: { throws?: boolean } = {}): {
	pi: ExtensionAPI;
	sent: Array<{ content: string; deliverAs?: string }>;
} {
	const sent: Array<{ content: string; deliverAs?: string }> = [];
	const pi = {
		sendUserMessage: (
			content: string | unknown,
			options?: { deliverAs?: string },
		) => {
			if (opts.throws) throw new Error("sendUserMessage boom");
			sent.push({ content: String(content), deliverAs: options?.deliverAs });
			return Promise.resolve();
		},
	} as unknown as ExtensionAPI;
	return { pi, sent };
}

/** Push a terminal record into the queue (which then fires onNotify). */
function pushCompletion(
	queue: NotificationQueue<NoticeRecord>,
	over: Partial<NoticeRecord> = {},
): void {
	queue.push({
		id: "bg_abc12345",
		parentSessionID: PARENT,
		description: "do the thing",
		status: "completed",
		createdAt: 1,
		completedAt: 2,
		...over,
	});
}

describe("createCompletionNotifier", () => {
	test("idle parent → toast AND a followUp wake naming bg_output, snapshot consumed", () => {
		const queue = createNotificationQueue<NoticeRecord>({});
		const { ctx, probe } = makeFakeContext({ idle: true });
		const { pi, sent } = makePi();
		const notify = createCompletionNotifier({
			pi,
			ctx,
			parentSessionID: PARENT,
			queue,
		});

		// The queue's push fires onNotify (= our notifier) synchronously.
		queue.push({
			id: "bg_abc12345",
			parentSessionID: PARENT,
			description: "do the thing",
			status: "completed",
			createdAt: 1,
			completedAt: 2,
		});
		const notice = queue.pending(PARENT)[0];
		expect(notice).toBeDefined();
		if (notice) notify(notice);

		expect(probe.notifyCalls).toHaveLength(1);
		expect(probe.notifyCalls[0]?.message).toContain("bg_abc12345");
		expect(sent).toHaveLength(1);
		expect(sent[0]?.deliverAs).toBe("followUp");
		expect(sent[0]?.content).toContain("[task-notification]");
		expect(sent[0]?.content).toContain("bg_output");
		// the delivered snapshot was consumed.
		expect(queue.pending(PARENT)).toHaveLength(0);
	});

	test("busy parent → toast only, NO wake, notice stays for the passive flush", () => {
		const queue = createNotificationQueue<NoticeRecord>({});
		const { ctx, probe } = makeFakeContext({ idle: false });
		const { pi, sent } = makePi();
		const notify = createCompletionNotifier({
			pi,
			ctx,
			parentSessionID: PARENT,
			queue,
		});

		queue.push({
			id: "bg_abc12345",
			parentSessionID: PARENT,
			description: "do the thing",
			status: "completed",
			createdAt: 1,
			completedAt: 2,
		});
		const notice = queue.pending(PARENT)[0];
		if (notice) notify(notice);

		expect(probe.notifyCalls).toHaveLength(1);
		expect(sent).toHaveLength(0);
		expect(queue.pending(PARENT)).toHaveLength(1);
	});

	test("a notice for a DIFFERENT parent never wakes this notifier", () => {
		const queue = createNotificationQueue<NoticeRecord>({});
		const { ctx } = makeFakeContext({ idle: true });
		const { pi, sent } = makePi();
		const notify = createCompletionNotifier({
			pi,
			ctx,
			parentSessionID: PARENT,
			queue,
		});
		queue.push({
			id: "bg_other",
			parentSessionID: "some_other_parent",
			description: "d",
			status: "completed",
			createdAt: 1,
			completedAt: 2,
		});
		const notice = queue.pending("some_other_parent")[0];
		if (notice) notify(notice);
		expect(sent).toHaveLength(0);
	});

	test("a throwing sendUserMessage leaves the notice queued (not consumed)", () => {
		const queue = createNotificationQueue<NoticeRecord>({});
		const { ctx } = makeFakeContext({ idle: true });
		const { pi } = makePi({ throws: true });
		const notify = createCompletionNotifier({
			pi,
			ctx,
			parentSessionID: PARENT,
			queue,
		});
		pushCompletion(queue);
		const notice = queue.pending(PARENT)[0];
		expect(() => notice && notify(notice)).not.toThrow();
		// not consumed — left for the passive drain.
		expect(queue.pending(PARENT)).toHaveLength(1);
	});

	test("a throwing ui.notify never escapes and the wake still proceeds", () => {
		const queue = createNotificationQueue<NoticeRecord>({});
		const { ctx } = makeFakeContext({ idle: true, notifyThrows: true });
		const { pi, sent } = makePi();
		const notify = createCompletionNotifier({
			pi,
			ctx,
			parentSessionID: PARENT,
			queue,
		});
		pushCompletion(queue);
		const notice = queue.pending(PARENT)[0];
		expect(() => notice && notify(notice)).not.toThrow();
		expect(sent).toHaveLength(1);
	});

	test("coalesces multiple pending notices into a single wake", () => {
		const queue = createNotificationQueue<NoticeRecord>({});
		const { ctx } = makeFakeContext({ idle: true });
		const { pi, sent } = makePi();
		const notify = createCompletionNotifier({
			pi,
			ctx,
			parentSessionID: PARENT,
			queue,
		});
		// Two completions land; only the first onNotify wakes (consuming both).
		pushCompletion(queue, { id: "bg_one", completedAt: 2 });
		pushCompletion(queue, { id: "bg_two", completedAt: 3 });
		const first = queue.pending(PARENT)[0];
		if (first) notify(first);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.content).toContain("bg_one");
		expect(sent[0]?.content).toContain("bg_two");
		expect(queue.pending(PARENT)).toHaveLength(0);
	});
});

describe("createBeforeAgentStartDrain", () => {
	const event = {
		type: "before_agent_start",
	} as unknown as BeforeAgentStartEvent;

	test("with pending notices → returns a synthetic non-displayed message", () => {
		const queue = createNotificationQueue<NoticeRecord>({});
		pushCompletion(queue);
		const drain = createBeforeAgentStartDrain({
			parentSessionID: PARENT,
			queue,
		});
		const { ctx } = makeFakeContext();
		const result = drain(event, ctx);
		expect(result).toBeDefined();
		expect(result?.message.customType).toBe("bg_notification");
		expect(result?.message.display).toBe(false);
		expect(result?.message.content).toContain("bg_output");
		// the passive flush drained the queue.
		expect(queue.pending(PARENT)).toHaveLength(0);
	});

	test("no pending notices → returns undefined (no change to the turn)", () => {
		const queue = createNotificationQueue<NoticeRecord>({});
		const drain = createBeforeAgentStartDrain({
			parentSessionID: PARENT,
			queue,
		});
		const { ctx } = makeFakeContext();
		expect(drain(event, ctx)).toBeUndefined();
	});

	test("a throwing flushFor is fenced → returns undefined, turn proceeds", () => {
		const throwingQueue = {
			flushFor: () => {
				throw new Error("flush boom");
			},
		} as unknown as Pick<NotificationQueue, "flushFor">;
		const drain = createBeforeAgentStartDrain({
			parentSessionID: PARENT,
			queue: throwingQueue,
		});
		const { ctx } = makeFakeContext();
		expect(drain(event, ctx as ExtensionContext)).toBeUndefined();
	});
});
