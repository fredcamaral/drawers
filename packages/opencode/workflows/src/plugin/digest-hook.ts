/**
 * `chat.message` digest hook (Task 6.2.4) — the passive LIVE-run surface.
 *
 * The core {@link createChatMessageHook} drains TERMINAL notices into the parent's
 * next message (exactly-once, dedup-guarded by `markNotified`). While a run is
 * LIVE there is no passive surface at all: the parent learns nothing until the run
 * settles. This factory closes that gap WITHOUT touching core.
 *
 * On each user message it prepends, per LIVE run owned by that parent session, one
 * line:
 *   `[workflow wf_x 'name' running 32s — 3/5 agents done]`
 * then delegates to the core terminal-notice hook so both surfaces compose. The
 * core hook keeps its exactly-once semantics; the digest is REPEATABLE by design
 * (a live run re-emits its line every turn until it settles), so it needs no
 * dedup and no persistence.
 *
 * CRITICAL: `chat.message` runs inside the prompt pipeline — a THROW kills the
 * user's message. The digest body is fully fenced; on any failure it logs and
 * falls through to the core hook, which is itself fenced. The core hook ALWAYS
 * runs, even if the digest path throws.
 */

import {
	createChatMessageHook,
	type NotificationQueueLogger,
	type TaskNotice,
} from "@drawers/core";
import type { Hooks } from "@opencode-ai/plugin";
import type { RunHandle, WorkflowEngine } from "./engine";
import { humanizeDuration } from "./format";
import { liveCounts } from "./tools/workflow-status";

type ChatMessageHook = NonNullable<Hooks["chat.message"]>;
type ChatMessageOutput = Parameters<ChatMessageHook>[1];
type Part = ChatMessageOutput["parts"][number];
type TextPart = Extract<Part, { type: "text" }>;

/** One digest line for a LIVE run handle (Task 6.2.4). */
export function digestLine(handle: RunHandle): string {
	const c = liveCounts(handle.progress);
	const done = c.done + c.failed + c.cached;
	const seen = done + c.running;
	// Elapsed needs the live clock view; a live run always carries one, but fall
	// back to 0ms defensively rather than emit NaN if it is ever absent.
	const elapsed =
		handle.now !== undefined ? handle.now() - handle.record.createdAt : 0;
	return (
		`[workflow ${handle.record.id} '${handle.record.description}' running ` +
		`${humanizeDuration(elapsed)} — ${done}/${seen} agents done]`
	);
}

/** Build the digest TextPart, sourcing ids from the message being emitted. */
function makeDigestPart(opts: {
	sessionID: string;
	messageID: string;
	text: string;
}): TextPart {
	return {
		id: `prt_wfdigest_${opts.messageID}`,
		sessionID: opts.sessionID,
		messageID: opts.messageID,
		type: "text",
		text: opts.text,
	};
}

/**
 * Build the workflows `chat.message` hook: prepend a live-run digest, then run the
 * core terminal-notice flush. Both are fenced; the core hook always runs.
 */
export function createWorkflowChatMessageHook(
	engine: WorkflowEngine,
	// Structurally the one member the terminal flush uses, so the engine's
	// RunRecord-typed queue passes without widening (finding #3).
	queue: { flushFor(parentSessionID: string): TaskNotice[] },
	logger?: NotificationQueueLogger,
): ChatMessageHook {
	const terminalHook = createChatMessageHook(queue, logger);
	return async (input, output) => {
		try {
			const live = engine.liveRunsFor(input.sessionID);
			if (live.length > 0) {
				const text = live.map(digestLine).join("\n");
				output.parts.push(
					makeDigestPart({
						sessionID: output.message.sessionID,
						messageID: output.message.id,
						text,
					}) as Part,
				);
			}
		} catch (err) {
			// Prompt-pipeline: never propagate. Log and fall through to the terminal
			// flush, which must still run.
			logger?.error?.("workflow live-run digest failed", {
				err: err instanceof Error ? err.message : String(err),
			});
		}
		await terminalHook(input, output);
	};
}
