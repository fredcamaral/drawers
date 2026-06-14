/**
 * `before_agent_start` digest hook (Task 6.2.4, pi port) — the passive LIVE-run
 * surface plus the terminal-notice drain.
 *
 * In opencode this rode the `chat.message` hook (prepend a live digest, then flush
 * terminal notices). pi has no `chat.message`; the lifecycle equivalent is
 * `before_agent_start`, which returns an OPTIONAL model-only message injected into
 * the next turn's context. So this module produces ONE pi `before_agent_start`
 * contribution that combines two streams:
 *
 *   - the TERMINAL drain (a completion that landed while the parent was busy, so it
 *     was not actively woken) — `queue.flushFor(parentSessionID)`, the bg-agents
 *     notifier pattern; and
 *   - the LIVE-run digest — one line per `running` workflow owned by this parent,
 *     re-emitted every turn until the run settles (REPEATABLE by design, so no
 *     dedup, no persistence).
 *
 * Both compose into a single synthetic `{ message }` ( `display:false` — model-only,
 * the user's visible prompt is untouched ). When NEITHER stream has content the hook
 * returns `undefined` (no change). The whole body is fenced: `before_agent_start`
 * runs inside the prompt pipeline, so a THROW would break the user's turn — on any
 * failure it logs and the turn proceeds untouched.
 *
 * Node-safe: no Bun.* APIs.
 */

import { humanizeDuration, type TaskNotice } from "@drawers/pi-core";
import type {
	BeforeAgentStartEvent,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { EngineLogger, RunHandle, WorkflowEngine } from "./engine";
import { liveCounts } from "./tools/workflow-status";

/** The pi synthetic model-only message a `before_agent_start` handler injects. */
interface DigestMessage {
	customType: string;
	content: string;
	display: false;
}

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

/** The demarcated terminal-notice text — names the retrieval tool, says it is automated. */
function buildNoticeText(notices: readonly TaskNotice[]): string {
	const lines = notices.map((n) => n.hint).join("\n");
	return (
		"[workflow-notification]\n" +
		`${lines}\n` +
		"— automated notice, not the user; inspect the result with workflow_status. " +
		"Do not reply to this notice."
	);
}

export interface WorkflowBeforeAgentStartDeps {
	engine: WorkflowEngine;
	/** The parent session id this hook serves (captured at session_start). */
	parentSessionID: string;
	/**
	 * The terminal-notice queue — structurally just the per-parent flush the drain
	 * uses, so the engine's RunRecord-typed queue passes without widening.
	 */
	queue: { flushFor(parentSessionID: string): TaskNotice[] };
	logger?: EngineLogger;
}

/**
 * Build the workflows `before_agent_start` handler: drain terminal notices AND
 * prepend a live-run digest, combined into one model-only synthetic message. Returns
 * `{ message }` when there is content, else `undefined`. Fully fenced — a failure
 * never breaks the user's turn.
 */
export function createWorkflowBeforeAgentStart(
	deps: WorkflowBeforeAgentStartDeps,
): (
	event: BeforeAgentStartEvent,
	ctx: ExtensionContext,
) => { message: DigestMessage } | undefined {
	const { engine, parentSessionID, queue, logger } = deps;
	return (_event, _ctx) => {
		try {
			const segments: string[] = [];

			// (1) Terminal drain — completions that landed while the parent was busy.
			const notices = queue.flushFor(parentSessionID);
			if (notices.length > 0) {
				segments.push(buildNoticeText(notices));
			}

			// (2) Live-run digest — one line per running workflow owned by this parent.
			const live = engine.liveRunsFor(parentSessionID);
			if (live.length > 0) {
				segments.push(live.map(digestLine).join("\n"));
			}

			if (segments.length === 0) {
				return undefined;
			}
			return {
				message: {
					customType: "workflow_digest",
					content: segments.join("\n\n"),
					display: false,
				},
			};
		} catch (err) {
			// Prompt-pipeline: never propagate. Log and leave the turn untouched.
			logger?.error("workflow before_agent_start digest failed", {
				err: err instanceof Error ? err.message : String(err),
			});
			return undefined;
		}
	};
}
