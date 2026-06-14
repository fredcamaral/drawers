/**
 * Fork transcript builder — pi port.
 *
 * Pure, linear-time function that turns a parent pi session's transcript into a
 * compact text blob suitable for injecting as a synthetic context part into a
 * forked child session (via {@link LaunchRequest.contextParts}).
 *
 * ## Port shape (vs the opencode original)
 *
 * The opencode builder consumed `session.messages` (`Array<{ info, parts }>`)
 * where tool RESULTS were nested `ToolPart`s inside an assistant message. pi's
 * transcript is different: `SessionManager.getBranch()` returns `SessionEntry[]`,
 * and a message entry's `message` is a pi `AgentMessage` whose tool RESULTS are
 * SEPARATE `toolResult` messages (not nested parts), and whose assistant content
 * is a `PiAssistantContent[]` array.
 *
 * So the VALUABLE, tested pipeline — compaction-boundary slice, recency-tiered
 * per-block cap, error head+tail preservation, oldest-first budget drop, and the
 * drift guard — ports VERBATIM in shape. Only the INPUT ADAPTER is rewritten:
 * {@link piEntriesToForkMessages} maps `SessionEntry[]` → the internal
 * {@link ForkMessage[]} structural shape the pipeline already understands.
 *
 * ## Compaction marker (what pi actually marks)
 *
 * pi marks a compaction boundary with a dedicated `CompactionEntry`
 * (`type: "compaction"`), NOT a per-message `summary` flag. The adapter emits a
 * synthetic compaction-marker `ForkMessage` for each `CompactionEntry`, so the
 * existing `sliceAfterLastCompaction` (which honors a `compaction` part) keeps
 * working unchanged.
 *
 * ## Drift guard (the better-async failure this still defends)
 *
 * After mapping, if a NON-EMPTY input produced ZERO blocks AND at least one part
 * looked like it should have produced content, we THROW. The guard is MORE
 * valuable here because the input shape itself changed: a future pi
 * `AgentMessage` content rename would otherwise silently yield an empty fork.
 *
 * Node-safe: no Bun.* APIs.
 */

import type {
	PiAgentMessage,
	PiAssistantMessage,
	PiToolResultMessage,
	PiUserMessage,
} from "@drawers/pi-core";

// --- internal structural shapes the pure pipeline consumes ------------------

/** A tool part's state, narrowed to the fields the pipeline reads. */
interface ForkToolState {
	status: string;
	output?: string;
	error?: string;
}

/** A part, narrowed to the fields the pipeline reads across the kinds we map. */
export interface ForkPart {
	type: string;
	/** present on text parts */
	text?: string;
	/** model-only injected context (forked transcripts) — never re-forked */
	synthetic?: boolean;
	/** present on tool parts */
	tool?: string;
	/** present on tool parts */
	state?: ForkToolState;
}

/** A message, narrowed to the fields the pipeline reads. */
export interface ForkMessageInfo {
	role: "user" | "assistant";
	/** Compaction-summary flag (retained from the opencode pipeline; pi uses a
	 *  `compaction` part instead, but keeping the field costs nothing). */
	summary?: unknown;
}

/** One internal `{ info, parts }` entry the pipeline maps. */
export interface ForkMessage {
	info: ForkMessageInfo;
	parts: ForkPart[];
}

export interface BuildForkTranscriptOptions {
	/** Total output budget in chars (header included). Default 24000. */
	budgetChars?: number;
}

// --- pi input adapter (the rewritten seam) ----------------------------------

/**
 * One pi `SessionEntry` as read off `sessionManager.getBranch()`/`getEntries()`,
 * narrowed to the discriminant + the message payload. Kept loose (`message:
 * unknown`) so this module carries no value-level pi dependency: pi's real
 * `AgentMessage` union flows in without a cast and {@link piEntriesToForkMessages}
 * does the safe narrowing through the core `PiAgentMessage` structural copy.
 */
export interface PiSessionEntryLike {
	type: string;
	message?: unknown;
}

const TOOL_RESULT_PART_TYPE = "tool";

function contentToString(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter(
			(c): c is { type: "text"; text: string } =>
				!!c &&
				(c as { type?: unknown }).type === "text" &&
				typeof (c as { text?: unknown }).text === "string",
		)
		.map((c) => c.text)
		.join("");
}

/**
 * Map pi `SessionEntry[]` → the internal {@link ForkMessage[]} the pipeline
 * understands. Rules:
 *   - a `compaction` entry → a synthetic compaction-marker ForkMessage (an
 *     assistant message carrying one `{ type: "compaction" }` part), so
 *     `sliceAfterLastCompaction` finds the boundary;
 *   - a `message` entry with a USER message → a user ForkMessage with one text
 *     part (the concatenated text content);
 *   - a `message` entry with an ASSISTANT message → an assistant ForkMessage
 *     with one text part (assistant text content only; tool CALLS carry no
 *     payload to fork);
 *   - a `message` entry with a TOOLRESULT message → an assistant ForkMessage
 *     with one tool part shaped like the pipeline's `ForkPart` tool block (so
 *     the existing `blockForPart` renders `[tool: <name>] <payload>`);
 *   - everything else (thinking-level/model-change/custom/label/info entries) is
 *     dropped — not transcript content.
 */
export function piEntriesToForkMessages(
	entries: readonly PiSessionEntryLike[],
): ForkMessage[] {
	const out: ForkMessage[] = [];
	for (const entry of entries) {
		if (entry.type === "compaction") {
			// A boundary marker — the slice drops the marker itself.
			out.push({
				info: { role: "assistant" },
				parts: [{ type: "compaction" }],
			});
			continue;
		}
		if (entry.type !== "message") {
			continue;
		}
		const message = entry.message as PiAgentMessage | undefined;
		const role = (message as { role?: unknown } | undefined)?.role;

		if (role === "user") {
			const text = contentToString((message as PiUserMessage).content);
			out.push({ info: { role: "user" }, parts: [{ type: "text", text }] });
			continue;
		}
		if (role === "assistant") {
			const text = contentToString((message as PiAssistantMessage).content);
			out.push({
				info: { role: "assistant" },
				parts: [{ type: "text", text }],
			});
			continue;
		}
		if (role === "toolResult") {
			const tr = message as PiToolResultMessage;
			const payload = contentToString(tr.content);
			out.push({
				info: { role: "assistant" },
				parts: [
					{
						type: TOOL_RESULT_PART_TYPE,
						tool: tr.toolName,
						state: {
							status: tr.isError === true ? "error" : "completed",
							...(tr.isError === true
								? { error: payload }
								: { output: payload }),
						},
					},
				],
			});
		}
		// Unknown / non-message role: skip.
	}
	return out;
}

// --- tuning constants -------------------------------------------------------

const DEFAULT_BUDGET = 24_000;

const HEADER =
	"Context forked from the parent session — for reference only; follow the task prompt below.\n\n";

const BLOCK_SEPARATOR = "\n\n";

/** Newest N messages get the generous per-block cap; older get the tight one. */
const RECENT_COUNT = 5;
const RECENT_CAP = 4_000;
const OLDER_CAP = 600;

/** Error-pattern head+tail preservation (mirrors core `readOutput`). */
const ERROR_PATTERN = /error|fail|exception|denied|timeout/i;
const ERROR_HEAD = 1_200;
const ERROR_TAIL = 600;

/** Recognized tool statuses the adapter emits / the pipeline renders. */
const KNOWN_TOOL_STATUS = new Set(["pending", "running", "completed", "error"]);

// --- public API -------------------------------------------------------------

export function buildForkTranscript(
	messages: ForkMessage[],
	opts?: BuildForkTranscriptOptions,
): string {
	if (messages.length === 0) {
		return "";
	}

	const budget = opts?.budgetChars ?? DEFAULT_BUDGET;

	// (1) compaction-boundary slice
	const sliced = sliceAfterLastCompaction(messages);

	// (2)+(3)+(4) map to capped blocks, tracking drift suspicion as we go
	let driftSuspect = false;
	const blocks: string[] = [];
	const total = sliced.length;
	for (let i = 0; i < total; i += 1) {
		const msg = sliced[i];
		if (!msg) {
			continue;
		}
		// recency tier: distance from the END of the (sliced) list
		const fromEnd = total - 1 - i;
		const cap = fromEnd < RECENT_COUNT ? RECENT_CAP : OLDER_CAP;
		for (const part of msg.parts) {
			const block = blockForPart(msg.info.role, part, cap);
			if (block !== null) {
				blocks.push(block);
			} else if (isDriftSuspect(part)) {
				driftSuspect = true;
			}
		}
	}

	if (blocks.length === 0) {
		// Distinguish genuine emptiness from schema drift.
		if (driftSuspect) {
			throw new Error(
				"buildForkTranscript: schema drift — non-empty input yielded zero " +
					"extractable blocks but at least one part carried text/tool-output " +
					"payload under an unrecognized type/status. The pi AgentMessage " +
					"shape likely changed; update the adapter in fork/transcript.ts.",
			);
		}
		return "";
	}

	// (5) budget pass: drop OLDEST whole blocks until we fit, header included.
	const kept = dropOldestUntilUnderBudget(blocks, budget);
	if (kept.length === 0) {
		// Even the single newest block + header exceeds budget; keep that one
		// block anyway (truncation already happened at the per-block cap). A
		// header-only result would be misleading.
		const newest = blocks[blocks.length - 1];
		return HEADER + (newest ?? "");
	}

	// (6) header
	return HEADER + kept.join(BLOCK_SEPARATOR);
}

// --- pipeline stages --------------------------------------------------------

/**
 * (1) Keep only messages strictly after the LAST compaction marker. A marker is
 * either an assistant message with `summary === true` or any message carrying a
 * `compaction` part. Linear scan from the end for the boundary.
 */
function sliceAfterLastCompaction(messages: ForkMessage[]): ForkMessage[] {
	let boundary = -1;
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		if (isCompactionMarker(messages[i])) {
			boundary = i;
			break;
		}
	}
	return boundary === -1 ? messages : messages.slice(boundary + 1);
}

function isCompactionMarker(msg: ForkMessage | undefined): boolean {
	if (!msg) {
		return false;
	}
	if (msg.info.role === "assistant" && msg.info.summary === true) {
		return true;
	}
	for (const part of msg.parts) {
		if (part.type === "compaction") {
			return true;
		}
	}
	return false;
}

/**
 * (2) Map one part to a capped block, or `null` if the part is not extractable.
 * Applies the per-block recency cap (4) including error head+tail preservation.
 */
function blockForPart(
	role: "user" | "assistant",
	part: ForkPart,
	cap: number,
): string | null {
	if (part.type === "text") {
		if (part.synthetic === true) {
			return null;
		}
		const text = part.text ?? "";
		if (text.length === 0) {
			return null;
		}
		return `[${role}] ${capText(text, cap)}`;
	}

	if (part.type === "tool") {
		const state = part.state;
		if (!state) {
			return null;
		}
		// Only completed/errored states carry shown payload; skip pending/running.
		let payload: string | undefined;
		if (state.status === "completed") {
			payload = state.output;
		} else if (state.status === "error") {
			payload = state.error;
		} else {
			return null;
		}
		if (!payload) {
			return null;
		}
		const name = part.tool ?? "tool";
		return `[tool: ${name}] ${capText(payload, cap)}`;
	}

	// compaction / unknown marker parts — not transcript content.
	return null;
}

/**
 * (4) Cap a block's payload to `cap` chars. Plain head cut, except error-pattern
 * text which keeps head + tail with a marker so the failure (often at the end)
 * survives. Only kicks in when over cap.
 */
function capText(text: string, cap: number): string {
	if (text.length <= cap) {
		return text;
	}
	if (ERROR_PATTERN.test(text)) {
		// Only do head+tail when it actually saves space vs the cap.
		if (text.length > ERROR_HEAD + ERROR_TAIL) {
			const dropped = text.length - ERROR_HEAD - ERROR_TAIL;
			return `${text.slice(0, ERROR_HEAD)}…[truncated ${dropped} chars]…${text.slice(
				text.length - ERROR_TAIL,
			)}`;
		}
	}
	return text.slice(0, cap);
}

/**
 * (5) Drop OLDEST whole blocks until `HEADER + join(blocks)` fits `budget`.
 * Never cuts mid-block. Linear (single suffix accumulation from newest).
 */
function dropOldestUntilUnderBudget(
	blocks: string[],
	budget: number,
): string[] {
	const body = budget - HEADER.length;
	if (body <= 0) {
		return [];
	}
	// Walk newest→oldest, accumulating size; stop when the next block would not
	// fit (with its separator). The kept set is the newest contiguous run.
	let used = 0;
	let firstKept = blocks.length; // index of oldest kept block
	for (let i = blocks.length - 1; i >= 0; i -= 1) {
		const block = blocks[i];
		if (block === undefined) {
			continue;
		}
		const sep = i === blocks.length - 1 ? 0 : BLOCK_SEPARATOR.length;
		const cost = block.length + sep;
		if (used + cost > body) {
			break;
		}
		used += cost;
		firstKept = i;
	}
	return blocks.slice(firstKept);
}

// --- drift detection --------------------------------------------------------

/**
 * A part is drift-suspect when it carries extractable payload that the mapper
 * did NOT extract because its type/status is unrecognized. See the module
 * doc-comment for the exact predicate.
 */
function isDriftSuspect(part: ForkPart): boolean {
	// (a) renamed text kind: has real text but type isn't "text".
	if (
		part.type !== "text" &&
		typeof part.text === "string" &&
		part.text.length > 0
	) {
		return true;
	}
	// (b) tool with unknown status but carrying output/error payload.
	if (part.type === "tool" && part.state) {
		const { status, output, error } = part.state;
		const hasPayload =
			(typeof output === "string" && output.length > 0) ||
			(typeof error === "string" && error.length > 0);
		if (hasPayload && !KNOWN_TOOL_STATUS.has(status)) {
			return true;
		}
	}
	return false;
}
