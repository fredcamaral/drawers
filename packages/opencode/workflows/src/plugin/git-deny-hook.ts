/**
 * `tool.execute.before` deny hook (Epic 0.3) — the data-loss kill switch.
 *
 * #5's catastrophe was a workflow worker running `git restore`/`checkout --`/
 * `reset`/`stash`/`clean` while chasing a green gate, clobbering uncommitted work
 * the engine owns. This hook denies those verbs for a LIVE worker session.
 *
 * Three conditions must ALL hold to deny:
 *   1. The tool is the Bash/shell tool (`input.tool === "bash"`).
 *   2. The session is a live workflow worker (`engine.isWorkerSession(sessionID)` —
 *      Epic 0.1). The host hook payload carries only `{ tool, sessionID, callID }`,
 *      so this engine predicate is the only lineage signal available.
 *   3. The command is destructive git (`isDestructiveGit` — Epic 0.2).
 * Otherwise the hook returns and the call proceeds. The PARENT session, read-only
 * git, `git add`/`git commit`, and every non-Bash tool pass untouched.
 *
 * Denial is BY THROW — the SDK exposes no `deny` field for `tool.execute.before`;
 * a throw fails THIS tool call as a tool-error the worker sees ("you may not do
 * this"), and the turn survives (this is the intended veto seam; unlike the
 * prompt-pipeline hooks, a throw here does NOT crash the request). This is one
 * layer of defense-in-depth — the matcher's documented evasion gaps
 * (variable-indirection, native file clobbering) live above this seam, not here.
 */

import type { Hooks } from "@opencode-ai/plugin";
import type { WorkflowEngine } from "./engine";
import { isDestructiveGit } from "./git-deny";

type ExecuteBeforeHook = NonNullable<Hooks["tool.execute.before"]>;

/** opencode's native shell tool id — the only tool that runs raw git. */
const BASH_TOOL = "bash";

/**
 * Build the `tool.execute.before` deny hook over `engine`. The engine supplies the
 * worker-lineage predicate; the matcher is the pure {@link isDestructiveGit}. Both
 * are isolated, so the hook itself is a thin three-condition guard.
 */
export function createGitDenyHook(engine: WorkflowEngine): ExecuteBeforeHook {
	return async (input, output) => {
		if (input.tool !== BASH_TOOL) return;
		if (!engine.isWorkerSession(input.sessionID)) return;
		const command = (output.args as { command?: unknown }).command;
		if (typeof command !== "string") return;
		if (!isDestructiveGit(command)) return;
		throw new Error(
			"workflow worker may not run destructive git " +
				"(restore/checkout --/reset/stash/clean) — the engine owns version " +
				"control; use `git commit` or let the engine roll back.",
		);
	};
}
