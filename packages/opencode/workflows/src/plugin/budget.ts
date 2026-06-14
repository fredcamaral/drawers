/**
 * Token budget provider for workflow runs (Task 4.3.1).
 *
 * `createTokenBudget` builds a {@link BudgetView} backed by a real accumulator
 * plus a `recordTask(sessionID)` the agent primitive calls once a child settles.
 * Each `recordTask` fetches the session's messages ONCE and sums the assistant
 * messages' `tokens.output + tokens.reasoning` into the accumulator.
 *
 * Pricing notes:
 *   - `reasoning` tokens are billed at the output rate, so they are folded into
 *     the same sum as `output` (audit row m: AssistantMessage.tokens carries
 *     `{ input, output, reasoning, cache }`).
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
 * The minimal structural slice of a `session.messages` entry the budget reads.
 * The full SDK message (audit row m) carries far more; we read defensively, so
 * every field is optional and a missing token is treated as 0.
 */
interface BudgetMessageSlice {
	info?: {
		role?: string;
		tokens?: {
			output?: number;
			reasoning?: number;
		};
	};
}

export interface CreateTokenBudgetOptions {
	/** The hard ceiling. MUST be a positive finite number — the factory throws otherwise. */
	total: number;
	/**
	 * Fetch one session's messages. The caller (engine) supplies a closure over
	 * the SDK client. The result is read through the {@link BudgetMessageSlice}
	 * lens; any non-array or malformed value contributes 0.
	 */
	fetchMessages: (sessionID: string) => Promise<unknown[]>;
	logger?: BudgetLogger;
}

/** A token budget: the runtime-facing {@link BudgetView} plus `recordTask`. */
export type TokenBudget = BudgetView & {
	/**
	 * Fetch `sessionID`'s messages ONCE and add its assistant output+reasoning
	 * tokens to the accumulator. Fenced: any failure warns and adds 0.
	 */
	recordTask(sessionID: string): Promise<void>;
};

/** Sum one fetched message list's assistant output+reasoning, read defensively. */
function sumAssistantTokens(messages: unknown[]): number {
	let sum = 0;
	for (const raw of messages) {
		const msg = raw as BudgetMessageSlice;
		if (msg.info?.role !== "assistant") {
			continue;
		}
		const tokens = msg.info.tokens;
		if (tokens === undefined) {
			continue;
		}
		// Missing/partial token fields contribute 0 (the Phase 2 NaN lesson:
		// coerce defensively, never let an absent number poison the sum).
		const output = typeof tokens.output === "number" ? tokens.output : 0;
		const reasoning =
			typeof tokens.reasoning === "number" ? tokens.reasoning : 0;
		sum += output + reasoning;
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
