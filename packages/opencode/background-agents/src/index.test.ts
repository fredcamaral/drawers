import { describe, expect, test } from "bun:test";
import {
	adaptSdkClient,
	createNotificationQueue,
	createWakeNotifier,
	createWakeOnNotify,
	type NoticeRecord,
	type SdkSessionClient,
	type TaskNotice,
} from "@drawers/core";
import * as entry from "./index";

/**
 * The opencode loader calls EVERY export of the registered entry module as a
 * function. The background-agents entry must therefore expose EXACTLY ONE export,
 * and it must be a function (the {@link Plugin} factory). Testable helpers live in
 * engine.ts / tools/*, never re-exported here.
 */
describe("background-agents plugin entry module", () => {
	test("exposes exactly one export", () => {
		expect(Object.keys(entry)).toHaveLength(1);
	});

	test("the single export is a function (the Plugin factory)", () => {
		const values = Object.values(entry);
		expect(typeof values[0]).toBe("function");
	});
});

// ---- Task 6.3.2: active-wake wiring (toast + wake on the onNotify seam) -----
//
// The plugin entry composes onNotify exactly as below: a toast notifier wrapped
// by createWakeOnNotify, with the wake notifier riding the SAME adaptSdkClient-
// wrapped client the engine uses (finding #5 — the wake adapter duplicate was
// deleted). These tests pin that composition's behavior (idle parent → wake
// prompt naming bg_output; busy parent → no prompt, passive flush intact)
// without instantiating the fs-backed engine — the wake notifier itself is
// exhaustively tested in core's wake-notifier.test.ts.

interface RawStatusMap {
	[sessionID: string]:
		| { type: "idle" }
		| { type: "retry"; attempt: number; message: string; next: number }
		| { type: "busy" };
}

function makeRawClient(status: RawStatusMap): SdkSessionClient & {
	prompts: Array<{ id: string; text: string }>;
} {
	const prompts: Array<{ id: string; text: string }> = [];
	const unexpected = (name: string) => async (): Promise<never> => {
		throw new Error(`unexpected call: session.${name}`);
	};
	return {
		prompts,
		session: {
			create: unexpected("create"),
			abort: unexpected("abort"),
			messages: unexpected("messages"),
			get: unexpected("get"),
			status: async () => ({ data: status }),
			promptAsync: async (opts) => {
				prompts.push({
					id: opts.path.id,
					text: opts.body.parts.map((p) => p.text).join("\n"),
				});
				// Real-SDK envelope: success resolves { data, error: undefined }.
				return { data: undefined };
			},
		},
	};
}

function bgNotice(over: Partial<TaskNotice> = {}): TaskNotice {
	return {
		taskId: "bg_abc12345",
		parentSessionID: "ses_parent",
		description: "do the thing",
		status: "completed",
		hint: 'Call bg_output(task_id="bg_abc12345") for the full result.',
		...over,
	};
}

function settle(): Promise<void> {
	return (async () => {
		for (let i = 0; i < 12; i += 1) {
			await Promise.resolve();
		}
	})();
}

describe("background-agents plugin wake wiring (Task 6.3.2)", () => {
	test("idle parent → onNotify fires toast AND a wake promptAsync naming bg_output", async () => {
		// The queue is generic over NoticeRecord (finding #3), so the minimal
		// record-shaped payload pushes honestly — no `as any`.
		const queue = createNotificationQueue<NoticeRecord>({});
		const raw = makeRawClient({ ses_parent: { type: "idle" } });
		const toasted: TaskNotice[] = [];
		const wake = createWakeNotifier({
			client: adaptSdkClient(raw),
			queue,
		});
		const onNotify = createWakeOnNotify(
			(n) => toasted.push(n),
			() => wake,
		);

		const notice = bgNotice();
		queue.push({
			id: notice.taskId,
			parentSessionID: notice.parentSessionID,
			description: notice.description,
			status: notice.status,
			createdAt: 1,
			completedAt: 2,
		});
		onNotify(queue.pending("ses_parent")[0] ?? notice);
		await settle();

		expect(toasted).toHaveLength(1);
		expect(raw.prompts).toHaveLength(1);
		expect(raw.prompts[0]?.id).toBe("ses_parent");
		expect(raw.prompts[0]?.text).toContain("[task-notification]");
		expect(raw.prompts[0]?.text).toContain("bg_output");
		expect(queue.pending("ses_parent")).toHaveLength(0); // consumed
	});

	test("busy parent → toast fires, NO wake prompt, notice stays for the flush", async () => {
		const queue = createNotificationQueue<NoticeRecord>({});
		const raw = makeRawClient({ ses_parent: { type: "busy" } });
		const toasted: TaskNotice[] = [];
		const wake = createWakeNotifier({
			client: adaptSdkClient(raw),
			queue,
		});
		const onNotify = createWakeOnNotify(
			(n) => toasted.push(n),
			() => wake,
		);

		const notice = bgNotice();
		queue.push({
			id: notice.taskId,
			parentSessionID: notice.parentSessionID,
			description: notice.description,
			status: notice.status,
			createdAt: 1,
			completedAt: 2,
		});
		onNotify(queue.pending("ses_parent")[0] ?? notice);
		await settle();

		expect(toasted).toHaveLength(1);
		expect(raw.prompts).toHaveLength(0);
		expect(queue.pending("ses_parent")).toHaveLength(1); // passive flush intact
	});
});
