/**
 * Per-session stats deriver — token + tool-call accounting from a pi transcript.
 *
 * pi-native redesign vs opencode. In opencode a live `event` hook folded EVERY SDK
 * `message.updated` / `message.part.updated` into a running per-session accumulator,
 * so the status tool could read live mid-flight token counts. pi has NO shared event
 * bus and the parent sees only `agent_start` / `agent_end` for a child (the runner's
 * completion fuser) — there is NO per-token stream to the parent. So there is no live
 * collector here: stats are DERIVED ONCE, at `agent:end`, from the child's settled
 * transcript (`PiAgentMessage[]`, read by the engine via the runner's
 * `SessionTranscriptReader`). In-flight agents therefore carry NO token numbers
 * (`statsSnapshot` returns `undefined` for them) — the honest pi port; final stats
 * live on the enriched `agent:end` / the run record.
 *
 * Token accounting (verified against pi-ai 0.79.3 `Usage`): a pi assistant message
 * carries `usage: { input, output, cacheRead, cacheWrite, totalTokens, cost }`. Each
 * assistant message's usage is the CUMULATIVE turn usage at that point, so — matching
 * opencode's "latest reading per message, summed across messages" — we SUM each
 * assistant message's usage (one entry per assistant message in the transcript).
 * Unlike opencode there is NO `reasoning` split; `reasoning` stays in the snapshot
 * shape (consumed by `tui/format`) but is always 0 for pi.
 *
 * Tool accounting: each `role:"toolResult"` message in the transcript is one terminal
 * tool call (pi materializes a tool result per completed tool use). A 3-deep ring keeps
 * `toolName(inputPreview≤60chars)` labels for the status tool's `lastTools`.
 *
 * Reads are DEFENSIVE throughout (the Phase 2 NaN lesson): every token field is
 * coerced, a missing number contributes 0, and a malformed message is skipped. A
 * telemetry hiccup must never perturb a live run.
 *
 * Node-safe: no Bun.* APIs.
 */

/** The rolled-up per-session token totals (one human-facing number per field). */
export interface SessionTokenSnapshot {
	input: number;
	output: number;
	/** Always 0 for pi (no reasoning split); retained for the shared snapshot shape. */
	reasoning: number;
	cacheRead: number;
	cacheWrite: number;
}

/** A point-in-time view of one tracked session's stats. */
export interface SessionStatsSnapshot {
	tokens: SessionTokenSnapshot;
	/** Count of terminal tool-result messages seen. */
	toolCalls: number;
	/** The last ≤3 `toolName(inputPreview≤60chars)` labels, oldest → newest. */
	lastTools: string[];
	/** Wall-clock (engine clock) the snapshot was derived. */
	updatedAt: number;
}

const TOOL_RING_DEPTH = 3;
const INPUT_PREVIEW_MAX = 60;

/** Coerce a possibly-missing numeric field to a finite number, else 0. */
function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** The structural slice of a pi assistant message's usage the deriver reads. */
interface RawUsage {
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
}

/** A pi transcript message, read defensively (the runner's `PiAgentMessage`). */
interface RawMessage {
	role?: unknown;
	usage?: RawUsage;
	toolName?: unknown;
	content?: unknown;
}

/** Build the `toolName(inputPreview≤60chars)` ring label from a tool-result message. */
function toolLabel(tool: string, content: unknown): string {
	let preview = "";
	try {
		// pi tool-result content is a parts array; a compact stringification gives a
		// usable, length-bounded preview without binding to the exact part shape.
		preview = JSON.stringify(content ?? {});
	} catch {
		// A non-serializable content (cycles, etc.) still yields a usable label.
		preview = "";
	}
	if (preview.length > INPUT_PREVIEW_MAX) {
		preview = preview.slice(0, INPUT_PREVIEW_MAX);
	}
	return `${tool}(${preview})`;
}

/**
 * Derive a {@link SessionStatsSnapshot} from a child's settled pi transcript. Sums
 * every assistant message's output/input/cache usage and counts every tool-result
 * message; the last 3 tool labels feed `lastTools`. `updatedAt` is stamped by the
 * caller's clock. Returns `undefined` when the transcript is empty (no assistant
 * message AND no tool result) — an honest "nothing to report" for a child that never
 * produced a turn.
 */
export function deriveSessionStats(
	messages: readonly unknown[],
	now: number,
): SessionStatsSnapshot | undefined {
	const tokens: SessionTokenSnapshot = {
		input: 0,
		output: 0,
		reasoning: 0,
		cacheRead: 0,
		cacheWrite: 0,
	};
	let toolCalls = 0;
	const lastTools: string[] = [];
	let sawAny = false;

	for (const raw of messages) {
		const msg = raw as RawMessage;
		if (msg.role === "assistant") {
			sawAny = true;
			const usage = msg.usage;
			if (usage !== undefined) {
				tokens.input += num(usage.input);
				tokens.output += num(usage.output);
				tokens.cacheRead += num(usage.cacheRead);
				tokens.cacheWrite += num(usage.cacheWrite);
			}
			continue;
		}
		if (msg.role === "toolResult") {
			sawAny = true;
			toolCalls += 1;
			const tool = typeof msg.toolName === "string" ? msg.toolName : "tool";
			lastTools.push(toolLabel(tool, msg.content));
			if (lastTools.length > TOOL_RING_DEPTH) {
				lastTools.shift();
			}
		}
	}

	if (!sawAny) {
		return undefined;
	}
	return { tokens, toolCalls, lastTools, updatedAt: now };
}
