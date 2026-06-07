import { describe, expect, test } from "bun:test";
import {
	adaptWakeClient,
	createNotificationQueue,
	createWakeNotifier,
	createWakeOnNotify,
	type NotificationQueue,
	type SdkWakeSessionClient,
	type TaskNotice,
} from "@drawers/core";
import type { Hooks } from "@opencode-ai/plugin";
import { createWorkflowChatMessageHook } from "./digest-hook";
import type { RunHandle, WorkflowEngine } from "./engine";
import * as entry from "./index";

/**
 * The opencode loader calls EVERY export of the registered entry module as a
 * function. The workflows plugin entry must therefore expose EXACTLY ONE export,
 * and it must be a function (the {@link Plugin} factory). Library helpers live in
 * `../index.ts` (the package's `./lib` export), never here.
 */
describe("workflows plugin entry module", () => {
	test("exposes exactly one export", () => {
		expect(Object.keys(entry)).toHaveLength(1);
	});

	test("the single export is a function (the Plugin factory)", () => {
		const values = Object.values(entry);
		expect(typeof values[0]).toBe("function");
	});
});

// ---- Task 6.2.4: live-run digest on the next user turn -------------------

type ChatMessageHook = NonNullable<Hooks["chat.message"]>;
type ChatMessageOutput = Parameters<ChatMessageHook>[1];

/** A fake engine exposing only the digest read surface. */
function fakeEngine(live: RunHandle[]): WorkflowEngine {
	return {
		liveRunsFor: () => live,
	} as unknown as WorkflowEngine;
}

/** A live run handle: running record + stamped progress + a fixed clock view. */
function liveHandle(over: {
	id: string;
	description: string;
	createdAt: number;
	nowMs: number;
	done: number;
	running: number;
}): RunHandle {
	const progress: RunHandle["progress"] = [];
	let at = over.createdAt + 1;
	for (let i = 0; i < over.done; i += 1) {
		progress.push({ type: "agent:start", label: `d${i}`, phase: "p", at });
		progress.push({
			type: "agent:end",
			label: `d${i}`,
			status: "completed",
			at: at + 1,
		});
		at += 2;
	}
	for (let i = 0; i < over.running; i += 1) {
		progress.push({ type: "agent:start", label: `r${i}`, phase: "p", at });
		at += 1;
	}
	return {
		record: {
			id: over.id,
			parentSessionID: "ses_parent",
			status: "running",
			description: over.description,
			createdAt: over.createdAt,
			scriptPath: `/x/${over.id}.js`,
		},
		progress,
		now: () => over.nowMs,
	};
}

/** A hook input/output pair with a parts array to inspect. */
function makeIo(sessionID: string): {
	input: Parameters<ChatMessageHook>[0];
	output: ChatMessageOutput;
} {
	return {
		input: { sessionID } as unknown as Parameters<ChatMessageHook>[0],
		output: {
			message: { id: "msg_1", sessionID },
			parts: [],
		} as unknown as ChatMessageOutput,
	};
}

/** Concatenate every text part's text. */
function partsText(output: ChatMessageOutput): string {
	return output.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");
}

function emptyQueue(): NotificationQueue {
	return createNotificationQueue({});
}

describe("createWorkflowChatMessageHook — live-run digest (Task 6.2.4)", () => {
	test("a live run prepends a one-line digest with name, elapsed, done/seen", async () => {
		const handle = liveHandle({
			id: "wf_dig00001",
			description: "review-changes",
			createdAt: 1_000,
			nowMs: 33_000, // 32000ms elapsed → "32.0s" via the shared formatter.
			done: 3,
			running: 2,
		});
		const hook = createWorkflowChatMessageHook(
			fakeEngine([handle]),
			emptyQueue(),
		);
		const { input, output } = makeIo("ses_parent");
		await hook(input, output);

		const text = partsText(output);
		expect(text).toContain("wf_dig00001");
		expect(text).toContain("review-changes");
		expect(text).toContain("running 32.0s");
		// 3 done, 5 seen (3 done + 2 running).
		expect(text).toContain("3/5 agents done");
	});

	test("no live runs → no digest part added", async () => {
		const hook = createWorkflowChatMessageHook(fakeEngine([]), emptyQueue());
		const { input, output } = makeIo("ses_parent");
		await hook(input, output);
		expect(output.parts).toHaveLength(0);
	});

	test("the digest is repeatable: two turns both carry the line (no exactly-once)", async () => {
		const handle = liveHandle({
			id: "wf_dig00002",
			description: "demo",
			createdAt: 1_000,
			nowMs: 5_000,
			done: 1,
			running: 1,
		});
		const hook = createWorkflowChatMessageHook(
			fakeEngine([handle]),
			emptyQueue(),
		);
		const io1 = makeIo("ses_parent");
		await hook(io1.input, io1.output);
		const io2 = makeIo("ses_parent");
		await hook(io2.input, io2.output);
		expect(partsText(io1.output)).toContain("wf_dig00002");
		expect(partsText(io2.output)).toContain("wf_dig00002");
	});

	test("terminal notices still flow (and exactly-once) alongside the digest", async () => {
		const queue = emptyQueue();
		queue.push({
			id: "wf_term0001",
			parentSessionID: "ses_parent",
			status: "completed",
			description: "finished",
			createdAt: 1_000,
			completedAt: 2_000,
			// biome-ignore lint/suspicious/noExplicitAny: minimal BgTask-shaped push payload.
		} as any);
		const handle = liveHandle({
			id: "wf_dig00003",
			description: "stillgoing",
			createdAt: 1_000,
			nowMs: 4_000,
			done: 0,
			running: 1,
		});
		const hook = createWorkflowChatMessageHook(fakeEngine([handle]), queue);

		const io1 = makeIo("ses_parent");
		await hook(io1.input, io1.output);
		const t1 = partsText(io1.output);
		// Both surfaces present on the first turn.
		expect(t1).toContain("wf_dig00003"); // digest
		expect(t1).toContain("wf_term0001"); // terminal notice

		// Second turn: digest repeats, terminal notice does NOT (flushed once).
		const io2 = makeIo("ses_parent");
		await hook(io2.input, io2.output);
		const t2 = partsText(io2.output);
		expect(t2).toContain("wf_dig00003");
		expect(t2).not.toContain("wf_term0001");
	});
});

// ---- Task 6.3.2: active-wake wiring (toast + wake on the onNotify seam) -----
//
// The plugin entry composes onNotify exactly as below: a toast notifier wrapped
// by createWakeOnNotify, with the wake notifier built from adaptWakeClient over
// the raw SDK client and the engine's queue. These tests pin that composition's
// behavior (idle parent → wake prompt; busy parent → no prompt, passive flush
// intact) without instantiating the fs-backed engine — the wake notifier itself
// is exhaustively tested in core's wake-notifier.test.ts.

interface RawStatusMap {
	[sessionID: string]:
		| { type: "idle" }
		| { type: "retry"; attempt: number; message: string; next: number }
		| { type: "busy" };
}

function makeRawWakeClient(status: RawStatusMap): SdkWakeSessionClient & {
	prompts: Array<{ id: string; text: string }>;
} {
	const prompts: Array<{ id: string; text: string }> = [];
	return {
		prompts,
		session: {
			status: async () => ({ data: status }),
			promptAsync: async (opts) => {
				prompts.push({
					id: opts.path.id,
					text: opts.body.parts.map((p) => p.text).join("\n"),
				});
				return undefined;
			},
		},
	};
}

function wfNotice(over: Partial<TaskNotice> = {}): TaskNotice {
	return {
		taskId: "wf_abc12345",
		parentSessionID: "ses_parent",
		description: "review",
		status: "completed",
		hint: 'Call workflow_status(run_id="wf_abc12345") for the result.',
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

describe("workflows plugin wake wiring (Task 6.3.2)", () => {
	test("idle parent → onNotify fires toast AND a wake promptAsync naming workflow_status", async () => {
		// renderHint mirrors the workflows engine (engine.ts: runHint → workflow_status).
		const queue = createNotificationQueue({
			renderHint: (task) => `workflow_status run_id=${task.id} for the result`,
		});
		const raw = makeRawWakeClient({ ses_parent: { type: "idle" } });
		const toasted: TaskNotice[] = [];
		const wake = createWakeNotifier({
			client: adaptWakeClient(raw),
			queue,
			clock: { now: () => 0 },
		});
		const onNotify = createWakeOnNotify(
			(n) => toasted.push(n),
			() => wake,
		);

		// The engine pushes the notice into the queue, then calls onNotify.
		const notice = wfNotice();
		queue.push({
			id: notice.taskId,
			parentSessionID: notice.parentSessionID,
			description: notice.description,
			status: notice.status,
			createdAt: 1,
			completedAt: 2,
			// biome-ignore lint/suspicious/noExplicitAny: minimal BgTask-shaped push payload.
		} as any);
		onNotify(queue.pending("ses_parent")[0] ?? notice);
		await settle();

		expect(toasted).toHaveLength(1);
		expect(raw.prompts).toHaveLength(1);
		expect(raw.prompts[0]?.id).toBe("ses_parent");
		expect(raw.prompts[0]?.text).toContain("[task-notification]");
		expect(raw.prompts[0]?.text).toContain("workflow_status");
		expect(queue.pending("ses_parent")).toHaveLength(0); // consumed
	});

	test("busy parent → toast fires, NO wake prompt, notice stays for the flush", async () => {
		const queue = createNotificationQueue({});
		const raw = makeRawWakeClient({ ses_parent: { type: "busy" } });
		const toasted: TaskNotice[] = [];
		const wake = createWakeNotifier({
			client: adaptWakeClient(raw),
			queue,
			clock: { now: () => 0 },
		});
		const onNotify = createWakeOnNotify(
			(n) => toasted.push(n),
			() => wake,
		);

		const notice = wfNotice();
		queue.push({
			id: notice.taskId,
			parentSessionID: notice.parentSessionID,
			description: notice.description,
			status: notice.status,
			createdAt: 1,
			completedAt: 2,
			// biome-ignore lint/suspicious/noExplicitAny: minimal BgTask-shaped push payload.
		} as any);
		onNotify(queue.pending("ses_parent")[0] ?? notice);
		await settle();

		expect(toasted).toHaveLength(1);
		expect(raw.prompts).toHaveLength(0);
		expect(queue.pending("ses_parent")).toHaveLength(1); // passive flush intact
	});
});
