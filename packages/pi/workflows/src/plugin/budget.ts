/**
 * Token budget provider for workflow runs (Task 4.3.1, pi port).
 *
 * `createTokenBudget` builds a {@link BudgetView} backed by a real accumulator
 * plus a `recordTask(sessionID)` the agent primitive calls once a child settles.
 * Each `recordTask` fetches the session's messages ONCE and sums the assistant
 * messages' OUTPUT tokens into the accumulator.
 *
 * pi token shape (verified against pi-ai 0.79.3 `Usage`): an assistant message
 * carries `usage: { input, output, cacheRead, cacheWrite, totalTokens, cost }`.
 * Unlike opencode there is NO separate `reasoning` field — pi folds reasoning into
 * `output` — so the budget sums `usage.output` alone (still the output-priced
 * surface the `budget_tokens` arg meters). The runner's narrowed `readOutput`
 * strips `usage`; the engine therefore wires `fetchMessages` to the RAW transcript
 * read (the `SessionTranscriptReader`), which preserves it.
 *
 * Pricing notes:
 *   - `spent()` counts ONLY the workflow's child agents (the sessions passed to
 *     `recordTask`), NOT the parent turn that invoked the workflow. The
 *     `budget_tokens` arg prices the WORKFLOW, not the surrounding turn
 *     (elaboration deviation d).
 *
 * Failure philosophy mirrors the runtime's "degrade, don't detonate": ANY fetch
 * or shape failure inside `recordTask` logs a warn and contributes 0 — a budget
 * accounting hiccup must never crash a live run.
 *
 * Sequential accuracy: `recordTask` is awaited at each call's settle, so the NEXT
 * `agent()` call's budget pre-check sees this call's spend. Concurrent calls are
 * best-effort by nature — two children settling in overlapping windows both
 * record, but a pre-check between them may not have seen the other yet.
 */

import type { BudgetView } from "../runtime/types";

/** A logger surface the budget warns through; only `warn` is used. */
export interface BudgetLogger {
	warn(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * The minimal structural slice of a pi transcript message the budget reads. The
 * full pi `AssistantMessage` (pi-ai `Usage`) carries far more; we read defensively,
 * so every field is optional and a missing token is treated as 0.
 */
interface BudgetMessageSlice {
	role?: string;
	usage?: {
		output?: number;
	};
}

export interface CreateTokenBudgetOptions {
	/** The hard ceiling. MUST be a positive finite number — the factory throws otherwise. */
	total: number;
	/**
	 * Fetch one session's transcript messages. The caller (engine) supplies a
	 * closure over the {@link SessionTranscriptReader}. The result is read through
	 * the {@link BudgetMessageSlice} lens; any non-array or malformed value
	 * contributes 0.
	 */
	fetchMessages: (sessionID: string) => Promise<unknown[]>;
	logger?: BudgetLogger;
}

/** A token budget: the runtime-facing {@link BudgetView} plus `recordTask`. */
export type TokenBudget = BudgetView & {
	/**
	 * Fetch `sessionID`'s messages ONCE and add its assistant output tokens to the
	 * accumulator. Fenced: any failure warns and adds 0.
	 */
	recordTask(sessionID: string): Promise<void>;
};

/** Sum one fetched message list's assistant output tokens, read defensively. */
function sumAssistantTokens(messages: unknown[]): number {
	let sum = 0;
	for (const raw of messages) {
		const msg = raw as BudgetMessageSlice;
		if (msg.role !== "assistant") {
			continue;
		}
		const usage = msg.usage;
		if (usage === undefined) {
			continue;
		}
		// Missing/partial token fields contribute 0 (the Phase 2 NaN lesson:
		// coerce defensively, never let an absent number poison the sum). pi has no
		// `reasoning` split — it folds into `output`, which is what we meter.
		const output = typeof usage.output === "number" ? usage.output : 0;
		sum += output;
	}
	return sum;
}

export function createTokenBudget(opts: CreateTokenBudgetOptions): TokenBudget {
	// The factory is strict: callers MUST coerce to a positive finite number
	// first (the workflow tool does — Number.isFinite gate). Anything else is a
	// programming error and detonates here rather than silently disabling caps.
	if (!Number.isFinite(opts.total) || opts.total <= 0) {
		throw new Error(
			`token budget total must be a positive finite number, got ${opts.total}`,
		);
	}

	const total = opts.total;
	let accumulated = 0;

	return {
		total,
		spent: () => accumulated,
		remaining: () => Math.max(0, total - accumulated),
		async recordTask(sessionID: string): Promise<void> {
			try {
				const messages = await opts.fetchMessages(sessionID);
				if (!Array.isArray(messages)) {
					return;
				}
				accumulated += sumAssistantTokens(messages);
			} catch (err) {
				opts.logger?.warn("budget recordTask failed; counting 0 tokens", {
					sessionID,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		},
	};
}
