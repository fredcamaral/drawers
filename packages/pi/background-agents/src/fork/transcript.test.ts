/**
 * Unit tests for the pi fork transcript builder.
 *
 * Two layers:
 *   - the pure pipeline ({@link buildForkTranscript}) — ported from the opencode
 *     suite, since the slice/cap/budget/drift stages port verbatim in shape;
 *   - the pi input adapter ({@link piEntriesToForkMessages}) — the rewritten seam
 *     that maps pi `SessionEntry[]` (compaction / user / assistant / toolResult)
 *     into the internal ForkMessage shape, with the drift guard defending a future
 *     pi AgentMessage rename.
 */

import { describe, expect, test } from "bun:test";
import type { PiAgentMessage } from "@drawers/pi-core";
import {
	buildForkTranscript,
	type ForkMessage,
	type PiSessionEntryLike,
	piEntriesToForkMessages,
} from "./transcript";

const HEADER =
	"Context forked from the parent session — for reference only; follow the task prompt below.\n\n";

// --- internal ForkMessage fixtures (pipeline layer) -------------------------

function userText(text: string, synthetic?: boolean): ForkMessage {
	return {
		info: { role: "user" },
		parts: [{ type: "text", text, ...(synthetic ? { synthetic } : {}) }],
	};
}
function assistantText(text: string, synthetic?: boolean): ForkMessage {
	return {
		info: { role: "assistant" },
		parts: [{ type: "text", text, ...(synthetic ? { synthetic } : {}) }],
	};
}
function compactionPartMessage(): ForkMessage {
	return { info: { role: "assistant" }, parts: [{ type: "compaction" }] };
}
function completedTool(name: string, output: string): ForkMessage {
	return {
		info: { role: "assistant" },
		parts: [
			{ type: "tool", tool: name, state: { status: "completed", output } },
		],
	};
}
function erroredTool(name: string, error: string): ForkMessage {
	return {
		info: { role: "assistant" },
		parts: [{ type: "tool", tool: name, state: { status: "error", error } }],
	};
}

// --- compaction boundary slice ---------------------------------------------

describe("pipeline — compaction-boundary slice", () => {
	test("keeps only messages after the LAST compaction marker (summary flag)", () => {
		const out = buildForkTranscript([
			userText("ancient"),
			{
				info: { role: "assistant", summary: true },
				parts: [{ type: "text", text: "first summary" }],
			},
			userText("middle"),
			{
				info: { role: "assistant", summary: true },
				parts: [{ type: "text", text: "LATEST summary" }],
			},
			assistantText("after the boundary"),
		]);
		expect(out).not.toContain("ancient");
		expect(out).not.toContain("middle");
		expect(out).not.toContain("LATEST summary");
		expect(out).toContain("[assistant] after the boundary");
	});

	test("recognizes the compaction PART marker too", () => {
		const out = buildForkTranscript([
			userText("before compaction part"),
			compactionPartMessage(),
			assistantText("survivor"),
		]);
		expect(out).not.toContain("before compaction part");
		expect(out).toContain("[assistant] survivor");
	});

	test("no compaction marker → keeps everything", () => {
		const out = buildForkTranscript([userText("alpha"), assistantText("beta")]);
		expect(out).toContain("[user] alpha");
		expect(out).toContain("[assistant] beta");
	});
});

// --- block mapping ----------------------------------------------------------

describe("pipeline — block mapping", () => {
	test("user/assistant text become labelled blocks", () => {
		const out = buildForkTranscript([
			userText("hello"),
			assistantText("world"),
		]);
		expect(out).toContain("[user] hello");
		expect(out).toContain("[assistant] world");
	});

	test("completed tool output → [tool: NAME] output", () => {
		const out = buildForkTranscript([completedTool("read", "file contents")]);
		expect(out).toContain("[tool: read] file contents");
	});

	test("errored tool falls back to state.error", () => {
		const out = buildForkTranscript([erroredTool("bash", "boom happened")]);
		expect(out).toContain("[tool: bash] boom happened");
	});

	test("synthetic text parts are skipped", () => {
		const out = buildForkTranscript([
			assistantText("visible"),
			assistantText("INJECTED CONTEXT", true),
		]);
		expect(out).toContain("[assistant] visible");
		expect(out).not.toContain("INJECTED CONTEXT");
	});

	test("pending/running tool parts are skipped", () => {
		const pending: ForkMessage = {
			info: { role: "assistant" },
			parts: [{ type: "tool", tool: "slow", state: { status: "pending" } }],
		};
		const running: ForkMessage = {
			info: { role: "assistant" },
			parts: [{ type: "tool", tool: "slower", state: { status: "running" } }],
		};
		const out = buildForkTranscript([pending, running, assistantText("done")]);
		expect(out).not.toContain("[tool: slow]");
		expect(out).not.toContain("[tool: slower]");
		expect(out).toContain("[assistant] done");
	});
});

// --- recency tiers + error head/tail ---------------------------------------

describe("pipeline — recency-tiered truncation", () => {
	test("6th-from-end gets the tight cap, 5th-from-end gets the generous cap", () => {
		const big = "x".repeat(5000);
		const out = buildForkTranscript(
			[
				assistantText(`SIXTH ${big}`),
				assistantText(`FIFTH ${big}`),
				assistantText("a"),
				assistantText("b"),
				assistantText("c"),
				assistantText("d"),
			],
			{ budgetChars: 1_000_000 },
		);
		const sixth = blockFor(out, "SIXTH");
		const fifth = blockFor(out, "FIFTH");
		expect(sixth.length).toBeLessThan(700);
		expect(fifth.length).toBeGreaterThan(3000);
		expect(fifth.length).toBeLessThan(4100);
	});
});

describe("pipeline — error-pattern head+tail preservation", () => {
	test("oversized error tool output keeps head AND tail", () => {
		const errOutput = `HEAD_MARKER ${"n".repeat(5000)} TAIL_FAILURE exception`;
		const out = buildForkTranscript(
			[
				erroredTool("bash", errOutput),
				assistantText("1"),
				assistantText("2"),
				assistantText("3"),
				assistantText("4"),
				assistantText("5"),
			],
			{ budgetChars: 1_000_000 },
		);
		const block = blockFor(out, "bash");
		expect(block).toContain("HEAD_MARKER");
		expect(block).toContain("TAIL_FAILURE");
		expect(block).toContain("…[truncated");
	});

	test("non-error oversized output is a flat cut (no tail marker)", () => {
		const out = buildForkTranscript(
			[
				completedTool("read", "ok ".repeat(5000)),
				assistantText("1"),
				assistantText("2"),
				assistantText("3"),
				assistantText("4"),
				assistantText("5"),
			],
			{ budgetChars: 1_000_000 },
		);
		expect(blockFor(out, "read")).not.toContain("…[truncated");
	});
});

// --- budget drop order ------------------------------------------------------

describe("pipeline — final budget pass", () => {
	test("drops OLDEST whole blocks first, never mid-block", () => {
		const a = "A".repeat(100);
		const b = "B".repeat(100);
		const c = "C".repeat(100);
		const out = buildForkTranscript(
			[assistantText(a), assistantText(b), assistantText(c)],
			{ budgetChars: 260 + HEADER.length },
		);
		expect(out).not.toContain(a);
		expect(out).toContain(b);
		expect(out).toContain(c);
	});
});

// --- empty / skippable / drift ---------------------------------------------

describe("pipeline — empty and skippable inputs", () => {
	test("empty input → empty string (no header)", () => {
		expect(buildForkTranscript([])).toBe("");
	});

	test("all-synthetic input → empty string", () => {
		expect(
			buildForkTranscript([
				assistantText("ignored", true),
				userText("also ignored", true),
			]),
		).toBe("");
	});

	test("non-empty output gets the header exactly once", () => {
		const out = buildForkTranscript([assistantText("hi")]);
		expect(out.startsWith(HEADER)).toBe(true);
		expect(out.indexOf(HEADER)).toBe(out.lastIndexOf(HEADER));
	});
});

describe("pipeline — schema-drift guard", () => {
	test("text payload under an unrecognized part type → throws", () => {
		const drifted: ForkMessage = {
			info: { role: "assistant" },
			parts: [{ type: "text_v2", text: "I am real content the mapper missed" }],
		};
		expect(() => buildForkTranscript([drifted])).toThrow(/drift/i);
	});

	test("tool with output payload but unrecognized status → throws", () => {
		const drifted: ForkMessage = {
			info: { role: "assistant" },
			parts: [
				{
					type: "tool",
					tool: "bash",
					state: { status: "succeeded", output: "real output here" },
				},
			],
		};
		expect(() => buildForkTranscript([drifted])).toThrow(/drift/i);
	});
});

// --- pi input adapter -------------------------------------------------------

function userMsgEntry(text: string): PiSessionEntryLike {
	const message: PiAgentMessage = { role: "user", content: text };
	return { type: "message", message };
}
function assistantMsgEntry(text: string): PiSessionEntryLike {
	const message: PiAgentMessage = {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
	};
	return { type: "message", message };
}
function toolResultEntry(
	name: string,
	text: string,
	isError = false,
): PiSessionEntryLike {
	const message: PiAgentMessage = {
		role: "toolResult",
		toolCallId: "c1",
		toolName: name,
		content: [{ type: "text", text }],
		isError,
	};
	return { type: "message", message };
}

describe("adapter — piEntriesToForkMessages", () => {
	test("user / assistant entries map to labelled text ForkMessages", () => {
		const msgs = piEntriesToForkMessages([
			userMsgEntry("ask the question"),
			assistantMsgEntry("the answer"),
		]);
		const out = buildForkTranscript(msgs);
		expect(out).toContain("[user] ask the question");
		expect(out).toContain("[assistant] the answer");
	});

	test("toolResult (completed) → [tool: NAME] output", () => {
		const msgs = piEntriesToForkMessages([
			toolResultEntry("bash", "command stdout", false),
		]);
		const out = buildForkTranscript(msgs);
		expect(out).toContain("[tool: bash] command stdout");
	});

	test("toolResult (error) → [tool: NAME] error payload", () => {
		const msgs = piEntriesToForkMessages([
			toolResultEntry("bash", "it failed badly", true),
		]);
		const out = buildForkTranscript(msgs);
		expect(out).toContain("[tool: bash] it failed badly");
	});

	test("compaction entry becomes a boundary marker that slices earlier content", () => {
		const msgs = piEntriesToForkMessages([
			userMsgEntry("before the boundary"),
			{ type: "compaction" },
			assistantMsgEntry("after the boundary"),
		]);
		const out = buildForkTranscript(msgs);
		expect(out).not.toContain("before the boundary");
		expect(out).toContain("[assistant] after the boundary");
	});

	test("non-message / non-compaction entries are dropped", () => {
		const msgs = piEntriesToForkMessages([
			{ type: "model_change", message: undefined },
			{ type: "thinking_level", message: undefined },
			assistantMsgEntry("kept"),
		]);
		expect(msgs).toHaveLength(1);
		expect(buildForkTranscript(msgs)).toContain("[assistant] kept");
	});

	test("end-to-end: a real-ish pi transcript folds into a forked blob with the header", () => {
		const msgs = piEntriesToForkMessages([
			userMsgEntry("the secret is zanzibar"),
			assistantMsgEntry("noted"),
			toolResultEntry("read", "file body", false),
		]);
		const out = buildForkTranscript(msgs);
		expect(out.startsWith(HEADER)).toBe(true);
		expect(out).toContain("zanzibar");
		expect(out).toContain("[assistant] noted");
		expect(out).toContain("[tool: read] file body");
	});
});

// --- helpers ----------------------------------------------------------------

function blockFor(transcript: string, needle: string): string {
	const block = transcript.split("\n\n").find((b) => b.includes(needle));
	if (!block) {
		throw new Error(`no block containing ${needle}`);
	}
	return block;
}
