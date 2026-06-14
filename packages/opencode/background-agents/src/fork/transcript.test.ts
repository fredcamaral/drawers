import { describe, expect, test } from "bun:test";
import {
	buildForkTranscript,
	type ForkMessage,
	type ForkPart,
} from "./transcript";

// --- real-shape grounding ---------------------------------------------------
//
// The SDK package (`@opencode-ai/sdk`) is a transitive dep of
// `@opencode-ai/plugin` and is NOT a resolvable bare specifier under `tsc` in
// this package (only `@opencode-ai/plugin` is hoisted into node_modules).
// Importing it here would make this file fail typecheck on a package.json we do
// not own. Instead we restate the EXACT real shapes (verified against
// `@opencode-ai/sdk@1.16.2` `dist/gen/types.gen.d.ts`) as local types, build
// fixtures with those, and prove — at compile time — that the real shapes are
// assignable to the builder's structural input (`ForkMessage`/`ForkPart`).
//
// types.gen.d.ts references (1.16.2):
//   UserMessage           : line 39   (role:"user", summary?: {title?;body?;diffs})
//   AssistantMessage      : line 98   (role:"assistant", summary?: boolean)
//   TextPart              : line 142  (type:"text", text, synthetic?)
//   ToolStateCompleted    : line 231  (status:"completed", output: string)
//   ToolStateError        : line 248  (status:"error", error: string)
//   ToolPart              : line 263  (type:"tool", tool, state)
//   CompactionPart        : line 338  (type:"compaction", auto: boolean)
//   SessionMessagesResponses[200] : { info: Message; parts: Part[] }[]  (line 2238)

// Minimal faithful restatements of the real SDK shapes used by fixtures. These
// are NOT the builder's input type — they are the SDK's own shapes, which the
// `satisfies ReadonlyArray<ForkMessage>` proof below shows are assignable.
interface SdkUserMessage {
	id: string;
	sessionID: string;
	role: "user";
	time: { created: number };
	agent: string;
	model: { providerID: string; modelID: string };
	summary?: { title?: string; body?: string; diffs: unknown[] };
}
interface SdkAssistantMessage {
	id: string;
	sessionID: string;
	role: "assistant";
	time: { created: number; completed?: number };
	parentID: string;
	modelID: string;
	providerID: string;
	mode: string;
	path: { cwd: string; root: string };
	summary?: boolean;
	cost: number;
	tokens: {
		input: number;
		output: number;
		reasoning: number;
		cache: { read: number; write: number };
	};
}
type SdkMessage = SdkUserMessage | SdkAssistantMessage;
interface SdkTextPart {
	id: string;
	sessionID: string;
	messageID: string;
	type: "text";
	text: string;
	synthetic?: boolean;
}
type SdkToolState =
	| { status: "pending"; input: Record<string, unknown>; raw: string }
	| {
			status: "running";
			input: Record<string, unknown>;
			time: { start: number };
	  }
	| {
			status: "completed";
			input: Record<string, unknown>;
			output: string;
			title: string;
			metadata: Record<string, unknown>;
			time: { start: number; end: number };
	  }
	| {
			status: "error";
			input: Record<string, unknown>;
			error: string;
			time: { start: number; end: number };
	  };
interface SdkToolPart {
	id: string;
	sessionID: string;
	messageID: string;
	type: "tool";
	callID: string;
	tool: string;
	state: SdkToolState;
}
interface SdkCompactionPart {
	id: string;
	sessionID: string;
	messageID: string;
	type: "compaction";
	auto: boolean;
}
type SdkPart = SdkTextPart | SdkToolPart | SdkCompactionPart;
interface SdkEntry {
	info: SdkMessage;
	parts: SdkPart[];
}

let seq = 0;
function nextId(): string {
	seq += 1;
	return `id-${seq}`;
}

function userText(text: string, synthetic?: boolean): SdkEntry {
	const mid = nextId();
	const part: SdkTextPart = {
		id: nextId(),
		sessionID: "s",
		messageID: mid,
		type: "text",
		text,
		...(synthetic === undefined ? {} : { synthetic }),
	};
	const info: SdkUserMessage = {
		id: mid,
		sessionID: "s",
		role: "user",
		time: { created: 0 },
		agent: "build",
		model: { providerID: "p", modelID: "m" },
	};
	return { info, parts: [part] };
}

function assistantText(text: string, synthetic?: boolean): SdkEntry {
	const mid = nextId();
	const part: SdkTextPart = {
		id: nextId(),
		sessionID: "s",
		messageID: mid,
		type: "text",
		text,
		...(synthetic === undefined ? {} : { synthetic }),
	};
	return { info: assistantInfo(mid), parts: [part] };
}

function assistantInfo(id: string, summary?: boolean): SdkAssistantMessage {
	return {
		id,
		sessionID: "s",
		role: "assistant",
		time: { created: 0 },
		parentID: "root",
		modelID: "m",
		providerID: "p",
		mode: "build",
		path: { cwd: "/", root: "/" },
		cost: 0,
		tokens: {
			input: 0,
			output: 0,
			reasoning: 0,
			cache: { read: 0, write: 0 },
		},
		...(summary === undefined ? {} : { summary }),
	};
}

/** An assistant message flagged as a compaction summary (`summary: true`). */
function compactionSummaryMessage(text: string): SdkEntry {
	const mid = nextId();
	const part: SdkTextPart = {
		id: nextId(),
		sessionID: "s",
		messageID: mid,
		type: "text",
		text,
	};
	return { info: assistantInfo(mid, true), parts: [part] };
}

/** An assistant message carrying a `compaction` part. */
function compactionPartMessage(): SdkEntry {
	const mid = nextId();
	const part: SdkCompactionPart = {
		id: nextId(),
		sessionID: "s",
		messageID: mid,
		type: "compaction",
		auto: false,
	};
	return { info: assistantInfo(mid), parts: [part] };
}

function toolMessage(name: string, state: SdkToolState): SdkEntry {
	const mid = nextId();
	const part: SdkToolPart = {
		id: nextId(),
		sessionID: "s",
		messageID: mid,
		type: "tool",
		callID: "c",
		tool: name,
		state,
	};
	return { info: assistantInfo(mid), parts: [part] };
}

// COMPILE-TIME PROOF: the real SDK entry shape is assignable to the builder's
// structural input. If `buildForkTranscript`'s param type ever narrows below
// what the SDK actually returns, this line stops compiling.
const _grounding = ((): readonly ForkMessage[] => {
	const sample: SdkEntry[] = [userText("x"), assistantText("y")];
	return sample satisfies readonly ForkMessage[];
})();
void _grounding;
const _partGrounding: ForkPart = {
	type: "text",
	text: "x",
} satisfies SdkTextPart extends ForkPart ? ForkPart : never;
void _partGrounding;

function completedTool(name: string, output: string): SdkEntry {
	return toolMessage(name, {
		status: "completed",
		input: {},
		output,
		title: name,
		metadata: {},
		time: { start: 0, end: 1 },
	});
}

function erroredTool(name: string, error: string): SdkEntry {
	return toolMessage(name, {
		status: "error",
		input: {},
		error,
		time: { start: 0, end: 1 },
	});
}

const HEADER =
	"Context forked from the parent session — for reference only; follow the task prompt below.\n\n";

// --- compaction boundary slice ---------------------------------------------

describe("compaction-boundary slice", () => {
	test("keeps only messages after the LAST summary-flagged message", () => {
		const out = buildForkTranscript([
			userText("ancient"),
			compactionSummaryMessage("first summary"),
			userText("middle"),
			compactionSummaryMessage("LATEST summary"),
			assistantText("after the boundary"),
		]);
		expect(out).not.toContain("ancient");
		expect(out).not.toContain("middle");
		expect(out).not.toContain("first summary");
		// the summary marker itself is a boundary, not content
		expect(out).not.toContain("LATEST summary");
		expect(out).toContain("[assistant] after the boundary");
	});

	test("recognizes the CompactionPart marker too", () => {
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

describe("block mapping", () => {
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
		const pending = toolMessage("slow", {
			status: "pending",
			input: {},
			raw: "{}",
		});
		const running = toolMessage("slower", {
			status: "running",
			input: {},
			time: { start: 0 },
		});
		const out = buildForkTranscript([pending, running, assistantText("done")]);
		expect(out).not.toContain("[tool: slow]");
		expect(out).not.toContain("[tool: slower]");
		expect(out).toContain("[assistant] done");
	});
});

// --- recency tiers ----------------------------------------------------------

describe("recency-tiered truncation", () => {
	test("message 5-from-end gets the generous cap, 6-from-end gets the tight cap", () => {
		// Build 6 messages. Index 0 is 6th-from-end (tight 600), index 1 is
		// 5th-from-end (generous 4000). Use plain non-error text so the only
		// truncation in play is the flat per-block cap.
		const big = "x".repeat(5000);
		const msgs = [
			assistantText(`SIXTH ${big}`), // 6th from end → tight 600
			assistantText(`FIFTH ${big}`), // 5th from end → generous 4000
			assistantText("a"),
			assistantText("b"),
			assistantText("c"),
			assistantText("d"),
		];
		const out = buildForkTranscript(msgs, { budgetChars: 1_000_000 });
		// Tight block: label + 600 chars of content, nowhere near 5000.
		const sixth = blockFor(out, "SIXTH");
		const fifth = blockFor(out, "FIFTH");
		expect(sixth.length).toBeLessThan(700);
		expect(fifth.length).toBeGreaterThan(3000);
		expect(fifth.length).toBeLessThan(4100);
	});
});

// --- error head+tail vs flat cut -------------------------------------------

describe("error-pattern head+tail preservation", () => {
	test("oversized error tool output keeps head AND tail, not a flat cut", () => {
		// Put an error tool in an OLDER tier (tight cap) so truncation triggers.
		const head = "HEAD_MARKER ";
		const filler = "n".repeat(5000);
		const tail = " TAIL_FAILURE exception";
		const errOutput = head + filler + tail;
		const msgs = [
			erroredTool("bash", errOutput), // 6th from end (oldest tier)
			assistantText("1"),
			assistantText("2"),
			assistantText("3"),
			assistantText("4"),
			assistantText("5"),
		];
		const out = buildForkTranscript(msgs, { budgetChars: 1_000_000 });
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
		const block = blockFor(out, "read");
		expect(block).not.toContain("…[truncated");
	});
});

// --- budget drop order ------------------------------------------------------

describe("final budget pass", () => {
	test("drops OLDEST whole blocks first, never mid-block", () => {
		// 3 blocks of ~100 chars; budget that fits only the 2 newest.
		const a = "A".repeat(100);
		const b = "B".repeat(100);
		const c = "C".repeat(100);
		const out = buildForkTranscript(
			[assistantText(a), assistantText(b), assistantText(c)],
			{ budgetChars: 260 + HEADER.length },
		);
		// oldest dropped whole
		expect(out).not.toContain(a);
		// newest two survive whole (no mid-block cut)
		expect(out).toContain(b);
		expect(out).toContain(c);
	});

	test("never cuts mid-block: a surviving block is intact", () => {
		const keep = "K".repeat(200);
		const drop = "D".repeat(200);
		const out = buildForkTranscript(
			[assistantText(drop), assistantText(keep)],
			{ budgetChars: 230 + HEADER.length },
		);
		expect(out).not.toContain(drop);
		expect(out).toContain(`[assistant] ${keep}`);
	});
});

// --- empty / all-skippable / drift -----------------------------------------

describe("empty and skippable inputs", () => {
	test("empty input → empty string (no header)", () => {
		expect(buildForkTranscript([])).toBe("");
	});

	test("all-synthetic input → empty string (legitimately skippable)", () => {
		const out = buildForkTranscript([
			assistantText("ignored", true),
			userText("also ignored", true),
		]);
		expect(out).toBe("");
	});

	test("all-pending-tools input → empty string (legitimately skippable)", () => {
		const pending = toolMessage("x", {
			status: "pending",
			input: {},
			raw: "{}",
		});
		expect(buildForkTranscript([pending])).toBe("");
	});

	test("non-empty output gets the header exactly once", () => {
		const out = buildForkTranscript([assistantText("hi")]);
		expect(out.startsWith(HEADER)).toBe(true);
		expect(out.indexOf(HEADER)).toBe(out.lastIndexOf(HEADER));
	});
});

describe("schema-drift guard", () => {
	test("text part with non-empty text that yields no block → throws", () => {
		// Simulate drift: a part that LOOKS like extractable content (a text part
		// with real text) but whose `type` the mapper does not recognize. This is
		// the better-async failure mode: the schema renamed the kind, the mapper
		// silently produced nothing. We must throw, not return "".
		const drifted: ForkMessage = {
			info: { role: "assistant" },
			parts: [{ type: "text_v2", text: "I am real content the mapper missed" }],
		};
		expect(() => buildForkTranscript([drifted])).toThrow(/drift/i);
	});

	test("tool part claiming completed-with-output but unrecognized status → throws", () => {
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

// --- linear-time sanity -----------------------------------------------------

describe("linear behavior", () => {
	test("1000-message input completes quickly (array join, no quadratic concat)", () => {
		const msgs: ForkMessage[] = [];
		for (let i = 0; i < 1000; i += 1) {
			msgs.push(assistantText(`msg ${i} ${"y".repeat(200)}`));
		}
		const start = performance.now();
		const out = buildForkTranscript(msgs);
		const elapsed = performance.now() - start;
		expect(out.length).toBeGreaterThan(0);
		// Generous ceiling; quadratic concat on 1000×~200-char blocks would blow
		// past this. Real run is sub-millisecond.
		expect(elapsed).toBeLessThan(250);
	});
});

// --- helpers ----------------------------------------------------------------

/**
 * Extract the single block that contains `needle` from the joined transcript.
 * Blocks are separated by blank lines in the output.
 */
function blockFor(transcript: string, needle: string): string {
	const block = transcript.split("\n\n").find((b) => b.includes(needle));
	if (!block) {
		throw new Error(`no block containing ${needle}`);
	}
	return block;
}
