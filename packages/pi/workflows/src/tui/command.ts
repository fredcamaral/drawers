/**
 * `/workflows` command wiring (Task 8.3.3, pi port).
 *
 * opencode exposed the viewer as a route + a `workflows.open` palette command +
 * `ctrl+o`. pi's native surface is a single slash command (`pi.registerCommand`)
 * whose handler opens the {@link WorkflowsViewer} via `ctx.ui.custom()`. Registered at
 * LOAD time in the factory body (gotcha #1: register-only at load), alongside the
 * `registerTool` calls — NOT inside `session_start`.
 *
 * Mode guard (mandatory, ui.md §8): `ctx.ui.custom()` only works in `"tui"` mode and
 * is a no-op returning `undefined` elsewhere. In non-tui modes (`rpc`/`json`/`print`)
 * the handler instead reads the freshest feed file straight off disk through the
 * already-ported data layer and surfaces a one-line text summary via `ctx.ui.notify`
 * — the viewer's information, degraded to a glance the headless caller can still see.
 *
 * Node-safe: no Bun.* APIs.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatDuration, formatRelativeTime } from "./format";
import {
	createRunStateReducer,
	parseFeedLine,
	type RunViewState,
} from "./reducer";
import { type RunsFs, resolveRunId } from "./runs";
import { activeRuns, type SidebarFs } from "./sidebar-data";
import { WorkflowsViewer, type WorkflowsViewerDirs } from "./viewer";

/** The fs seams the headless fallback reads the feed dir through (Node-safe). */
const runsFs: RunsFs = {
	readdir,
	stat: async (path) => {
		const { stat } = await import("node:fs/promises");
		return stat(path);
	},
};
const sidebarFs: SidebarFs = {
	readdir,
	readFile: (path) => readFile(path, "utf-8"),
};

/** The dirs the command resolves once at load and hands the viewer/fallback. */
export interface WorkflowsCommandDirs {
	/** `<dataDir>/workflow-feed` — the dir of `<runId>.jsonl` feed files. */
	feedDir: string;
	/** `<dataDir>/workflow-control` — where the `x`/`s` sentinels are written. */
	controlDir: string;
}

/**
 * One-line headless summary of a {@link RunViewState}: the run's identity, status, an
 * agent done/total count, and its age. Pure (the `nowMs` is a param) so it is testable.
 */
export function summaryLine(
	view: RunViewState,
	runId: string,
	nowMs: number,
): string {
	let done = 0;
	let total = 0;
	for (const phase of view.phases) {
		done += phase.done;
		total += phase.total;
	}
	const identity = view.name ?? runId;
	const age =
		view.startedAt !== undefined
			? ` · ${formatRelativeTime(view.startedAt, nowMs)}`
			: "";
	const dur =
		view.startedAt !== undefined && view.endedAt !== undefined
			? ` · ${formatDuration(view.endedAt - view.startedAt)}`
			: "";
	return `${identity}: ${view.status} · ${done}/${total} agents${age}${dur}`;
}

/**
 * Fold one whole feed file (read in full, one-shot — not tailed) into a
 * {@link RunViewState}. Returns `undefined` on a read/parse miss so the fallback degrades
 * to "no run" rather than throwing. Mirrors `summarizeFeedFile` but keeps the full view.
 */
async function readFeedView(
	feedDir: string,
	runId: string,
): Promise<RunViewState | undefined> {
	let text: string;
	try {
		text = await readFile(join(feedDir, `${runId}.jsonl`), "utf-8");
	} catch {
		return undefined;
	}
	const reducer = createRunStateReducer();
	for (const line of text.split("\n")) {
		if (line.length === 0) {
			continue;
		}
		const event = parseFeedLine(line);
		if (event !== undefined) {
			reducer.apply(event);
		}
	}
	return reducer.state();
}

/**
 * The headless (non-tui) fallback: summarize the freshest run plus the count of live
 * runs, surfaced via `ctx.ui.notify`. No custom component (it would be a no-op outside
 * tui); the caller in `rpc`/`json`/`print` still gets the glance.
 */
async function notifyHeadlessSummary(
	feedDir: string,
	notify: (message: string, type?: "info" | "warning" | "error") => void,
): Promise<void> {
	const now = Date.now();
	const freshest = await resolveRunId(feedDir, undefined, runsFs, join);
	if (freshest === undefined) {
		notify("No workflow runs yet.", "info");
		return;
	}
	const view = await readFeedView(feedDir, freshest);
	if (view === undefined) {
		notify("No workflow runs yet.", "info");
		return;
	}
	const live = await activeRuns(feedDir, sidebarFs, now);
	const liveSuffix = live.length > 0 ? ` · ${live.length} live` : "";
	notify(
		`Workflows — ${summaryLine(view, freshest, now)}${liveSuffix}`,
		"info",
	);
}

/**
 * Register the `/workflows` slash command. In TUI mode it opens the interactive
 * {@link WorkflowsViewer} via `ctx.ui.custom()` (resolving when the user quits with
 * `q`/`esc`); in non-tui modes it surfaces a text summary instead. The optional
 * `args` string is treated as an explicit run id to open first (else the freshest).
 */
export function registerWorkflowsCommand(
	pi: ExtensionAPI,
	dirs: WorkflowsCommandDirs,
): void {
	pi.registerCommand("workflows", {
		description: "Open the workflows run viewer (tree of phases/agents)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				await notifyHeadlessSummary(dirs.feedDir, (m, t) =>
					ctx.ui.notify(m, t),
				);
				return;
			}
			const runId = args.trim().length > 0 ? args.trim() : undefined;
			const viewerDirs: WorkflowsViewerDirs = {
				feedDir: dirs.feedDir,
				controlDir: dirs.controlDir,
				...(runId !== undefined ? { runId } : {}),
			};
			await ctx.ui.custom<undefined>(
				(tui, theme, _keybindings, done) =>
					new WorkflowsViewer(tui, theme, done, viewerDirs, (m, t) =>
						ctx.ui.notify(m, t),
					),
			);
		},
	});
}
