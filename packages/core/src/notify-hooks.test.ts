import { describe, expect, test } from "bun:test";
import {
	createChatMessageHook,
	createToastNotifier,
	createWakeOnNotify,
	type NotificationQueue,
	type NotificationQueueLogger,
	type TaskNotice,
	type TaskStatus,
	type WakeNotifier,
} from "./index";

/** Rendered text-part shape the hook pushes — for typed test assertions. */
interface TextPartShape {
	id: string;
	sessionID: string;
	messageID: string;
	type: string;
	text: string;
	synthetic?: boolean;
}

/** Minimal UserMessage stand-in — avoids a direct @opencode-ai/sdk dep here. */
interface FakeUserMessage {
	id: string;
	sessionID: string;
	role: "user";
	time: { created: number };
	agent: string;
	model: { providerID: string; modelID: string };
}

// --- test doubles -----------------------------------------------------------

/** A queue whose flushFor returns a scripted list (or throws). */
function makeQueue(
	flushImpl: (parentSessionID: string) => TaskNotice[],
): NotificationQueue {
	const notImpl = (name: string) => () => {
		throw new Error(`unexpected call: ${name}`);
	};
	return {
		push: notImpl("push") as NotificationQueue["push"],
		flushFor: flushImpl,
		pending: notImpl("pending") as NotificationQueue["pending"],
		seed: notImpl("seed") as NotificationQueue["seed"],
	};
}

function makeLogger(): NotificationQueueLogger & {
	errors: Array<[string, unknown]>;
} {
	const errors: Array<[string, unknown]> = [];
	return {
		errors,
		debug: () => {},
		error: (msg, meta) => {
			errors.push([msg, meta]);
		},
	};
}

function makeMessage(): FakeUserMessage {
	return {
		id: "msg_user_1",
		sessionID: "ses_parent",
		role: "user",
		time: { created: 1000 },
		agent: "build",
		model: { providerID: "anthropic", modelID: "claude" },
	};
}

function makeOutput(): { message: FakeUserMessage; parts: unknown[] } {
	return { message: makeMessage(), parts: [] };
}

function makeNotice(over: Partial<TaskNotice> = {}): TaskNotice {
	return {
		taskId: "bg_abc12345",
		parentSessionID: "ses_parent",
		description: "do the thing",
		status: "completed",
		durationMs: 32_000,
		hint: 'Call bg_output(task_id="bg_abc12345") for the full result.',
		...over,
	};
}

const input = {
	sessionID: "ses_parent",
	messageID: "msg_user_1",
};

// --- tests -------------------------------------------------------------------

describe("createChatMessageHook", () => {
	test("empty flush leaves output.parts untouched", async () => {
		const hook = createChatMessageHook(makeQueue(() => []));
		const output = makeOutput();
		await hook(input, output as never);
		expect(output.parts).toEqual([]);
	});

	test("non-empty flush pushes exactly two parts: visible then synthetic", async () => {
		const hook = createChatMessageHook(makeQueue(() => [makeNotice()]));
		const output = makeOutput();
		await hook(input, output as never);

		expect(output.parts).toHaveLength(2);

		const parts = output.parts as TextPartShape[];
		const visible = parts[0] as TextPartShape;
		const synthetic = parts[1] as TextPartShape;

		// visible part: full TextPart shape, NOT synthetic, human-readable summary.
		expect(visible.type).toBe("text");
		expect(visible.synthetic).toBeUndefined();
		expect(visible.sessionID).toBe("ses_parent");
		expect(visible.messageID).toBe("msg_user_1");
		expect(typeof visible.id).toBe("string");
		expect(visible.text).toContain("✅");
		expect(visible.text).toContain("bg_abc12345");
		expect(visible.text).toContain("do the thing");
		expect(visible.text).toContain("32s");

		// synthetic part: model-only retrieval hint.
		expect(synthetic.type).toBe("text");
		expect(synthetic.synthetic).toBe(true);
		expect(synthetic.sessionID).toBe("ses_parent");
		expect(synthetic.messageID).toBe("msg_user_1");
		expect(synthetic.text).toContain('bg_output(task_id="bg_abc12345")');
		// the two parts carry distinct ids.
		expect(visible.id).not.toBe(synthetic.id);
	});

	test("multiple notices batch into one visible part and one synthetic part", async () => {
		const hook = createChatMessageHook(
			makeQueue(() => [
				makeNotice({
					taskId: "bg_one11111",
					status: "completed",
					hint: 'Call bg_output(task_id="bg_one11111") for the full result.',
				}),
				makeNotice({
					taskId: "bg_two22222",
					status: "error",
					hint: 'Call bg_output(task_id="bg_two22222") for the full result.',
				}),
			]),
		);
		const output = makeOutput();
		await hook(input, output as never);

		expect(output.parts).toHaveLength(2);
		const parts = output.parts as TextPartShape[];
		const visible = parts[0] as TextPartShape;
		const synthetic = parts[1] as TextPartShape;
		// one visible part containing a line per notice.
		expect(visible.text).toContain("bg_one11111");
		expect(visible.text).toContain("bg_two22222");
		expect(visible.text.split("\n")).toHaveLength(2);
		// one synthetic part containing both hints.
		expect(synthetic.text).toContain('bg_output(task_id="bg_one11111")');
		expect(synthetic.text).toContain('bg_output(task_id="bg_two22222")');
	});

	test("status emoji mapping: completed/error/cancelled", async () => {
		const statuses: Array<[TaskStatus, string]> = [
			["completed", "✅"],
			["error", "❌"],
			["cancelled", "🚫"],
		];
		for (const [status, emoji] of statuses) {
			const hook = createChatMessageHook(
				makeQueue(() => [makeNotice({ status })]),
			);
			const output = makeOutput();
			await hook(input, output as never);
			const visible = (output.parts as TextPartShape[])[0] as TextPartShape;
			expect(visible.text).toContain(emoji);
		}
	});

	test("notice without durationMs omits the duration suffix", async () => {
		const hook = createChatMessageHook(
			makeQueue(() => [makeNotice({ durationMs: undefined })]),
		);
		const output = makeOutput();
		await hook(input, output as never);
		const visible = (output.parts as TextPartShape[])[0] as TextPartShape;
		expect(visible.text).not.toContain(" in ");
	});

	test("queue.flushFor throwing is swallowed and logged; parts untouched", async () => {
		const logger = makeLogger();
		const hook = createChatMessageHook(
			makeQueue(() => {
				throw new Error("flush boom");
			}),
			logger,
		);
		const output = makeOutput();
		await expect(hook(input, output as never)).resolves.toBeUndefined();
		expect(output.parts).toEqual([]);
		expect(logger.errors).toHaveLength(1);
		expect(logger.errors[0]?.[0]).toContain("chat.message");
	});
});

describe("createToastNotifier", () => {
	test("variant mapping per terminal status", () => {
		const calls: Array<{ message: string; variant: string }> = [];
		const showToast = (args: {
			body?: { title?: string; message: string; variant: string };
		}) => {
			if (args.body) {
				calls.push({ message: args.body.message, variant: args.body.variant });
			}
			return Promise.resolve();
		};
		const notify = createToastNotifier(showToast as never);

		notify(makeNotice({ status: "completed" }));
		notify(makeNotice({ status: "error" }));
		notify(makeNotice({ status: "cancelled" }));

		expect(calls.map((c) => c.variant)).toEqual(["success", "error", "info"]);
	});

	test("toast throw is swallowed and logged", () => {
		const logger = makeLogger();
		const showToast = () => {
			throw new Error("toast boom");
		};
		const notify = createToastNotifier(showToast as never, logger);
		expect(() => notify(makeNotice())).not.toThrow();
		expect(logger.errors).toHaveLength(1);
		expect(logger.errors[0]?.[0]).toContain("showToast");
	});

	test("rejected toast promise is swallowed and logged", async () => {
		const logger = makeLogger();
		const showToast = () => Promise.reject(new Error("async toast boom"));
		const notify = createToastNotifier(showToast as never, logger);
		notify(makeNotice());
		// let the microtask reject handler run.
		await Promise.resolve();
		await Promise.resolve();
		expect(logger.errors).toHaveLength(1);
		expect(logger.errors[0]?.[0]).toContain("showToast");
	});
});

// ---- Task 6.3.2: createWakeOnNotify — toast + active wake composition -------

describe("createWakeOnNotify", () => {
	/** A wake notifier double recording every notice it was asked to wake. */
	function makeWake(over?: { rejects?: boolean }): WakeNotifier & {
		seen: TaskNotice[];
	} {
		const seen: TaskNotice[] = [];
		return {
			seen,
			notify: (notice) => {
				seen.push(notice);
				return over?.rejects
					? Promise.reject(new Error("wake boom"))
					: Promise.resolve();
			},
		};
	}

	test("fires the toast AND the wake on a notice", () => {
		const toasted: TaskNotice[] = [];
		const wake = makeWake();
		const onNotify = createWakeOnNotify(
			(n) => toasted.push(n),
			() => wake,
		);
		const notice = makeNotice();
		onNotify(notice);
		expect(toasted).toHaveLength(1);
		expect(wake.seen).toHaveLength(1);
		expect(wake.seen[0]).toBe(notice);
	});

	test("fires the toast even when the wake is not yet wired (getWake undefined)", () => {
		const toasted: TaskNotice[] = [];
		const onNotify = createWakeOnNotify(
			(n) => toasted.push(n),
			() => undefined,
		);
		expect(() => onNotify(makeNotice())).not.toThrow();
		expect(toasted).toHaveLength(1);
	});

	test("a rejected wake is swallowed and logged; toast still fired", async () => {
		const logger = makeLogger();
		const toasted: TaskNotice[] = [];
		const wake = makeWake({ rejects: true });
		const onNotify = createWakeOnNotify(
			(n) => toasted.push(n),
			() => wake,
			logger,
		);
		onNotify(makeNotice());
		expect(toasted).toHaveLength(1);
		// let the microtask rejection handler run.
		await Promise.resolve();
		await Promise.resolve();
		expect(logger.errors).toHaveLength(1);
		expect(logger.errors[0]?.[0]).toContain("wake");
	});
});
