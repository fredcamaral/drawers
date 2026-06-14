import { describe, expect, test } from "bun:test";
import { createSessionStatsCollector } from "./session-stats";

/**
 * Session stats collector tests (Task 8.1.3). Synthetic v1 SDK event sequences —
 * no real opencode. The collector tracks ONLY registered sessions; everything
 * else is dropped at the first key check (the `event` hook is hot).
 *
 * Token accounting: `message.updated` fires repeatedly per message, so the latest
 * `tokens` REPLACES per messageID and the snapshot SUMS across messages.
 * Tool accounting: each completed/error tool part is counted ONCE keyed by part
 * id; a 3-deep ring keeps `toolName(inputPreview≤60chars)` labels.
 */

/** A mutable clock box — `updatedAt` and the throttle window read from it. */
function box(start = 1_000) {
	const t = { v: start };
	return { clock: { now: () => t.v }, set: (v: number) => (t.v = v) };
}

/** Build a `message.updated` event for an assistant message with given tokens. */
function msgUpdated(
	sessionID: string,
	messageID: string,
	tokens: {
		input: number;
		output: number;
		reasoning: number;
		cache: { read: number; write: number };
	},
	// biome-ignore lint/suspicious/noExplicitAny: the collector reads a structural slice only.
): any {
	return {
		type: "message.updated",
		properties: {
			info: {
				id: messageID,
				sessionID,
				role: "assistant",
				tokens,
			},
		},
	};
}

/** Build a `message.part.updated` event for a tool part. */
function toolPart(
	sessionID: string,
	partID: string,
	tool: string,
	status: "pending" | "running" | "completed" | "error",
	input: Record<string, unknown> = {},
	// biome-ignore lint/suspicious/noExplicitAny: structural slice only.
): any {
	return {
		type: "message.part.updated",
		properties: {
			part: {
				id: partID,
				sessionID,
				messageID: "msg_x",
				type: "tool",
				callID: `call_${partID}`,
				tool,
				state: { status, input },
			},
		},
	};
}

describe("createSessionStatsCollector — registration", () => {
	test("snapshot is undefined for an unregistered session", () => {
		const { clock } = box();
		const c = createSessionStatsCollector({ clock });
		expect(c.snapshot("ses_unknown")).toBeUndefined();
	});

	test("register seeds a zeroed snapshot", () => {
		const { clock } = box(5_000);
		const c = createSessionStatsCollector({ clock });
		c.register("ses_a", { runId: "wf_1", label: "impl" });
		expect(c.snapshot("ses_a")).toEqual({
			tokens: {
				input: 0,
				output: 0,
				reasoning: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			toolCalls: 0,
			lastTools: [],
			updatedAt: 5_000,
		});
	});

	test("unregister drops the session", () => {
		const { clock } = box();
		const c = createSessionStatsCollector({ clock });
		c.register("ses_a", { runId: "wf_1", label: "impl" });
		c.unregister("ses_a");
		expect(c.snapshot("ses_a")).toBeUndefined();
	});
});

describe("createSessionStatsCollector — token accounting", () => {
	test("repeated message.updated for ONE message replaces, never double-counts", () => {
		const b = box();
		const c = createSessionStatsCollector({ clock: b.clock });
		c.register("ses_a", { runId: "wf_1", label: "impl" });

		c.handleEvent(
			msgUpdated("ses_a", "msg_1", {
				input: 100,
				output: 10,
				reasoning: 0,
				cache: { read: 0, write: 0 },
			}),
		);
		c.handleEvent(
			msgUpdated("ses_a", "msg_1", {
				input: 100,
				output: 50,
				reasoning: 5,
				cache: { read: 20, write: 3 },
			}),
		);

		expect(c.snapshot("ses_a")?.tokens).toEqual({
			input: 100,
			output: 50,
			reasoning: 5,
			cacheRead: 20,
			cacheWrite: 3,
		});
	});

	test("tokens SUM across multiple messages in the same session", () => {
		const b = box();
		const c = createSessionStatsCollector({ clock: b.clock });
		c.register("ses_a", { runId: "wf_1", label: "impl" });

		c.handleEvent(
			msgUpdated("ses_a", "msg_1", {
				input: 100,
				output: 10,
				reasoning: 1,
				cache: { read: 2, write: 1 },
			}),
		);
		c.handleEvent(
			msgUpdated("ses_a", "msg_2", {
				input: 200,
				output: 30,
				reasoning: 4,
				cache: { read: 8, write: 9 },
			}),
		);

		expect(c.snapshot("ses_a")?.tokens).toEqual({
			input: 300,
			output: 40,
			reasoning: 5,
			cacheRead: 10,
			cacheWrite: 10,
		});
	});

	test("message.updated for an UNREGISTERED session is ignored", () => {
		const b = box();
		const c = createSessionStatsCollector({ clock: b.clock });
		c.register("ses_a", { runId: "wf_1", label: "impl" });
		c.handleEvent(
			msgUpdated("ses_other", "msg_1", {
				input: 999,
				output: 999,
				reasoning: 0,
				cache: { read: 0, write: 0 },
			}),
		);
		expect(c.snapshot("ses_a")?.tokens).toEqual({
			input: 0,
			output: 0,
			reasoning: 0,
			cacheRead: 0,
			cacheWrite: 0,
		});
	});

	test("a non-assistant message.updated contributes no tokens", () => {
		const b = box();
		const c = createSessionStatsCollector({ clock: b.clock });
		c.register("ses_a", { runId: "wf_1", label: "impl" });
		c.handleEvent({
			type: "message.updated",
			properties: { info: { id: "msg_u", sessionID: "ses_a", role: "user" } },
			// biome-ignore lint/suspicious/noExplicitAny: structural slice only.
		} as any);
		expect(c.snapshot("ses_a")?.tokens.output).toBe(0);
	});
});

describe("createSessionStatsCollector — tool accounting", () => {
	test("a tool part counts ONCE across repeated updates, on first completed sight", () => {
		const b = box();
		const c = createSessionStatsCollector({ clock: b.clock });
		c.register("ses_a", { runId: "wf_1", label: "impl" });

		// pending/running do not count.
		c.handleEvent(toolPart("ses_a", "prt_1", "bash", "pending"));
		c.handleEvent(toolPart("ses_a", "prt_1", "bash", "running"));
		expect(c.snapshot("ses_a")?.toolCalls).toBe(0);

		// first completed counts.
		c.handleEvent(toolPart("ses_a", "prt_1", "bash", "completed"));
		expect(c.snapshot("ses_a")?.toolCalls).toBe(1);

		// a repeat of the same part id does not re-count.
		c.handleEvent(toolPart("ses_a", "prt_1", "bash", "completed"));
		expect(c.snapshot("ses_a")?.toolCalls).toBe(1);
	});

	test("an errored tool part also counts once", () => {
		const b = box();
		const c = createSessionStatsCollector({ clock: b.clock });
		c.register("ses_a", { runId: "wf_1", label: "impl" });
		c.handleEvent(toolPart("ses_a", "prt_1", "read", "error"));
		c.handleEvent(toolPart("ses_a", "prt_1", "read", "error"));
		expect(c.snapshot("ses_a")?.toolCalls).toBe(1);
	});

	test("lastTools holds the last 3 labels with inputs truncated to 60 chars", () => {
		const b = box();
		const c = createSessionStatsCollector({ clock: b.clock });
		c.register("ses_a", { runId: "wf_1", label: "impl" });

		c.handleEvent(
			toolPart("ses_a", "p1", "bash", "completed", { command: "ls" }),
		);
		c.handleEvent(
			toolPart("ses_a", "p2", "read", "completed", { filePath: "/a.ts" }),
		);
		c.handleEvent(
			toolPart("ses_a", "p3", "grep", "completed", { pattern: "x" }),
		);
		const long = "y".repeat(200);
		c.handleEvent(
			toolPart("ses_a", "p4", "write", "completed", { content: long }),
		);

		const last = c.snapshot("ses_a")?.lastTools ?? [];
		// Ring keeps only the latest 3.
		expect(last).toHaveLength(3);
		expect(last[0]).toBe('read({"filePath":"/a.ts"})');
		expect(last[1]).toBe('grep({"pattern":"x"})');
		// The 4th label's input preview is capped at 60 chars.
		expect(last[2]?.startsWith("write(")).toBe(true);
		const preview = last[2]?.slice("write(".length, -1) ?? "";
		expect(preview.length).toBeLessThanOrEqual(60);
	});

	test("tool parts for an UNREGISTERED session are ignored", () => {
		const b = box();
		const c = createSessionStatsCollector({ clock: b.clock });
		c.register("ses_a", { runId: "wf_1", label: "impl" });
		c.handleEvent(toolPart("ses_other", "p1", "bash", "completed"));
		expect(c.snapshot("ses_a")?.toolCalls).toBe(0);
	});
});

describe("createSessionStatsCollector — updatedAt + change detection", () => {
	test("updatedAt advances on a stats change", () => {
		const b = box(1_000);
		const c = createSessionStatsCollector({ clock: b.clock });
		c.register("ses_a", { runId: "wf_1", label: "impl" });
		b.set(2_500);
		c.handleEvent(
			msgUpdated("ses_a", "msg_1", {
				input: 1,
				output: 1,
				reasoning: 0,
				cache: { read: 0, write: 0 },
			}),
		);
		expect(c.snapshot("ses_a")?.updatedAt).toBe(2_500);
	});

	test("handleEvent returns the sessionID on a registered stats change, undefined otherwise", () => {
		const b = box();
		const c = createSessionStatsCollector({ clock: b.clock });
		c.register("ses_a", { runId: "wf_1", label: "impl" });

		// registered + real change → sessionID, so the engine knows whom to maybe-emit for.
		expect(c.handleEvent(toolPart("ses_a", "p1", "bash", "completed"))).toBe(
			"ses_a",
		);
		// unregistered → undefined (dropped at the first key check).
		expect(
			c.handleEvent(toolPart("ses_zz", "p1", "bash", "completed")),
		).toBeUndefined();
		// registered but no-op (running) → undefined (nothing changed).
		expect(
			c.handleEvent(toolPart("ses_a", "p2", "bash", "running")),
		).toBeUndefined();
	});
});
