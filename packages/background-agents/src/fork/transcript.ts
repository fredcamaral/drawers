/**
 * Fork transcript builder (Task 2.3.1).
 *
 * Pure, linear-time function that turns a parent session's `session.messages`
 * payload into a compact text blob suitable for injecting as a synthetic
 * context part into a forked child session.
 *
 * ## Grounding (real SDK shapes — `@opencode-ai/sdk@1.16.2`)
 *
 * `session.messages` returns `Array<{ info: Message; parts: Part[] }>`
 * (see `dist/gen/types.gen.d.ts` `SessionMessagesResponses[200]`). The fields
 * this builder reads are typed below as minimal structural subsets so the real
 * SDK `Message`/`Part` objects satisfy them without us importing or restating
 * the full unions — and without inventing shapes the SDK does not have.
 *
 * Relevant real kinds:
 * - `TextPart`  : `{ type: "text"; text: string; synthetic?: boolean }`
 * - `ToolPart`  : `{ type: "tool"; tool: string; state: ToolState }` where
 *                 `ToolState` is a discriminated union on `status`:
 *                 `pending` | `running` | `completed` (`output: string`) |
 *                 `error` (`error: string`).
 * - step/file/reasoning/snapshot/patch/agent/retry parts : ignored.
 *
 * ## Compaction marker (what the schema actually marks)
 *
 * There are TWO real compaction signals in this SDK; we honor both:
 *   1. `AssistantMessage.summary === true` — a boolean flag on the *message*
 *      `info` marking it as a compaction summary message. (Note: `UserMessage`
 *      also has a `summary?` field, but it is an OBJECT, not a boolean — so the
 *      flag check is gated on `role === "assistant"` to avoid a false positive.)
 *   2. A `CompactionPart` — `{ type: "compaction"; auto: boolean }` — a *part*
 *      kind emitted at a compaction boundary.
 * The slice keeps only messages strictly AFTER the LAST message carrying either
 * marker. The marker message itself is dropped (it is a boundary, not content).
 *
 * ## Drift guard (the better-async failure this replaces)
 *
 * `.references/better-opencode-async-agents/src/fork/index.ts` filtered on
 * `part.type === "tool_result"` — a kind that does NOT exist in this schema
 * (the real kind is `"tool"`). When the schema used `"tool"`, that filter
 * matched nothing and the fork SILENTLY produced an empty transcript.
 *
 * Our defense: after mapping, if a NON-EMPTY input produced ZERO blocks AND at
 * least one part looked like it *should* have produced content, we THROW.
 *
 * Drift predicate (exact): a part is "drift-suspect" when it is NOT one of the
 * recognized-and-legitimately-skippable cases but still carries extractable
 * payload, specifically —
 *   (a) it has a non-empty `text` string but its `type` is not `"text"`
 *       (a renamed text kind), OR
 *   (b) it has `type === "tool"` with a `state` that carries a non-empty
 *       `output`/`error` string but whose `status` is none of the four known
 *       values (a renamed/added tool status).
 * If any drift-suspect part exists and the block list is empty, throw. An input
 * whose every part is legitimately skippable (all `synthetic`, all pending/
 * running tools, all step/file/etc. markers, all empty text) is NOT drift and
 * returns `""`.
 */

// --- structural input types (satisfied by the real SDK shapes) -------------

/** A tool part's state, narrowed to the fields we read. */
interface ForkToolState {
	status: string;
	output?: string;
	error?: string;
}

/** A part, narrowed to the fields we read across all kinds we care about. */
export interface ForkPart {
	type: string;
	/** present on text/reasoning parts */
	text?: string;
	/** present on text parts; injected context is flagged synthetic */
	synthetic?: boolean;
	/** present on tool parts */
	tool?: string;
	/** present on tool parts */
	state?: ForkToolState;
	/** present on the compaction part; field unused, presence implied by type */
	auto?: boolean;
}

/** A message, narrowed to the fields we read. */
export interface ForkMessageInfo {
	role: "user" | "assistant";
	/**
	 * On `AssistantMessage` this is a `boolean` compaction-summary flag; on
	 * `UserMessage` it is an object. Typed `unknown` so both real shapes fit;
	 * read only via the `=== true` guard below.
	 */
	summary?: unknown;
}

/** One `{ info, parts }` entry from `session.messages`. */
export interface ForkMessage {
	info: ForkMessageInfo;
	parts: ForkPart[];
}

export interface BuildForkTranscriptOptions {
	/** Total output budget in chars (header included). Default 24000. */
	budgetChars?: number;
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

/** Error-pattern head+tail preservation (mirrors core `readOutput`, Task 1.3.4). */
const ERROR_PATTERN = /error|fail|exception|denied|timeout/i;
const ERROR_HEAD = 1_200;
const ERROR_TAIL = 600;

/** Recognized tool statuses (per real `ToolState` union). */
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
					"payload under an unrecognized type/status. The SDK Part schema " +
					"likely changed; update the mapper in transcript.ts.",
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

	// step-start/step-finish/file/reasoning/snapshot/patch/agent/retry/
	// compaction/subtask — not transcript content.
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
