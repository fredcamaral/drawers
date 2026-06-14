/**
 * `tool_call` deny hook (Epic 0.3, pi port) — the data-loss kill switch.
 *
 * #5's catastrophe was a workflow worker running `git restore`/`checkout --`/
 * `reset`/`stash`/`clean` while chasing a green gate, clobbering uncommitted work
 * the engine owns. This hook denies those verbs for a worker child.
 *
 * pi vs opencode — the worker-discrimination redesign (plan Risk #2). opencode's
 * `tool.execute.before` payload carried a `sessionID`, so the hook keyed on
 * `engine.isWorkerSession(sessionID)` to fire ONLY on a live worker's Bash and
 * leave the PARENT's own git untouched. pi's {@link ToolCallEvent} carries NO
 * `sessionID` — only `{ type, toolCallId, toolName, input }` — so that predicate
 * is unavailable in the hook. BUT the architecture saves it: a workflow worker is
 * its OWN `pi --mode rpc` subprocess that loads THIS extension, so the hook fires
 * INSIDE the worker. The discriminator is therefore the PROCESS, not a session id:
 *   - a worker child always runs in `rpc` mode (the runner spawns `pi --mode rpc`);
 *   - the top-level human session runs in `tui` / `print` / `json`.
 * So the hook arms only when `ctx.mode === "rpc"` and denies destructive git
 * UNCONDITIONALLY there — every git the worker's model issues is, by construction,
 * a worker tool call. The parent (the privileged VCS actor) commits via the host
 * BunShell adapter, NOT through pi's `tool_call` path, so the engine's own commits
 * never reach this hook regardless.
 *
 * Denial is BY `{ block: true, reason }` (pi's `tool_call` veto seam) — NOT by
 * throw: returning `{ block }` fails THIS tool call as a tool-error the worker
 * sees ("you may not do this") and the turn survives, the documented contract.
 * This is one layer of defense-in-depth — the matcher's documented evasion gaps
 * (variable-indirection, native file clobbering) live above this seam, not here.
 *
 * Node-safe: no Bun.* APIs.
 */

import {
	type ExtensionContext,
	isToolCallEventType,
	type ToolCallEvent,
	type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { isDestructiveGit } from "./git-deny";

const DENY_REASON =
	"workflow worker may not run destructive git " +
	"(restore/checkout --/reset/stash/clean) — the engine owns version control; " +
	"use `git commit` or let the engine roll back.";

/**
 * Build the `tool_call` deny handler. It fires in every process that loads the
 * extension; it only ACTS in a worker child (`ctx.mode === "rpc"`), where it
 * blocks a destructive-git Bash call via {@link isDestructiveGit}. Returns
 * `undefined` (no opinion) on everything else.
 */
export function createGitDenyHook(): (
	event: ToolCallEvent,
	ctx: ExtensionContext,
) => ToolCallEventResult | undefined {
	return (event, ctx) => {
		// Only a worker child (a `pi --mode rpc` subprocess) is governed: the parent's
		// own git is the user's deliberate action, never denied.
		if (ctx.mode !== "rpc") {
			return undefined;
		}
		// Only the Bash tool runs raw git; `isToolCallEventType` narrows `event.input`.
		if (!isToolCallEventType("bash", event)) {
			return undefined;
		}
		const command = event.input.command;
		if (typeof command !== "string") {
			return undefined;
		}
		if (!isDestructiveGit(command)) {
			return undefined;
		}
		return { block: true, reason: DENY_REASON };
	};
}
