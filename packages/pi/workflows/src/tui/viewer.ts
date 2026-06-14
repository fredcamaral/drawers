/**
 * The `/workflows` viewer (Task 8.3.3, pi port) — an imperative pi-tui render of
 * the CC-style run tree the opencode route drew with opentui/solid JSX.
 *
 * opencode shaped this as a persistent full-screen ROUTE (Phases tree | Detail) with
 * a passive sidebar slot. pi has no route/slot model: the pi-native surface is a
 * `/workflows` COMMAND whose handler opens ONE `ctx.ui.custom()` component (see
 * `command.ts`). That component is THIS class. It replaces the editor with a
 * full-width, two-pane viewer (a run TREE on the left, the selected agent's DETAIL
 * on the right) and resolves the `custom()` promise — restoring the chat screen —
 * when `done(undefined)` runs on `q`/`esc`.
 *
 * Reactivity translation (solid → imperative): every `createSignal`/`createMemo`
 * becomes a plain instance field or a pure private method computed inside
 * `render(width)` from a FRESH `reducer.state()` snapshot. There is NO cached themed
 * string, so `invalidate()` is a no-op (tui.md "Stateless render" — recompute every
 * frame, theme changes flow through automatically). The live-update lever is the
 * tailer: each appended feed line → `reducer.apply(event)` → `tui.requestRender()`,
 * and `render` reads the new state. A 1.5s poll re-scans the feed dir for the `←/→`
 * run switcher (the cross-session bus), and a 1s tick advances the header's
 * relative-age segment while a run sits idle with no new event.
 *
 * Scrolling replaces opentui's `<scrollbox>`/`scrollChildIntoView` with a manual
 * `scrollTop` offset over the flat tree-line list (same idiom as the example
 * `StreamingOverflowComponent`): the followed row (the live agent until the user
 * scrolls, then their selection) is kept inside the viewport by clamping `scrollTop`.
 *
 * The pure line-builders (`buildHeaderLine`, `buildTreeLines`, `buildDetailLines`,
 * `joinPanes`) are string-in/string-out and exported for `bun test` — the keyboard
 * /tailer/timer glue stays thin in the class, mirroring how the opencode file kept
 * "NO reduction logic" and the existing tui-data tests run without an opentui runtime.
 *
 * SCOPE CUT (deliberate, not an omission): opencode's passive `sidebar_content` slot
 * has no pi equivalent (pi has no slot registry). The "a run is live" glance it gave
 * is covered functionally by the engine's completion `ctx.ui.notify` toasts; a
 * persistent glance via `ctx.ui.setWidget` fed by `activeRuns()` is a fast-follow,
 * not part of this viewer.
 *
 * Node-safe: no Bun.* APIs (the tailer uses `node:fs`).
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Key,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	formatDuration,
	formatRelativeTime,
	formatTokens,
	shortModel,
	statusMarker,
} from "./format";
import {
	slugifyWorkflowName,
	writeCancelSentinel,
	writeSaveSentinel,
} from "./paths";
import {
	type AgentView,
	createRunStateReducer,
	type PhaseView,
	type RunStateReducer,
	type RunViewState,
} from "./reducer";
import { listRunIds, type RunsFs, resolveRunId } from "./runs";
import { createFeedTailer, type FeedTailer } from "./tailer";

/** The real readdir/stat seam the viewer hands {@link resolveRunId}/{@link listRunIds}. */
const runsFs: RunsFs = { readdir, stat };

/** Feed-file suffix — `<dataDir>/workflow-feed/<runId>.jsonl`. */
const FEED_SUFFIX = ".jsonl";

/**
 * How often the viewer re-scans the feed dir for the `←/→` run list. The feed dir is
 * the cross-session bus: a run started by ANOTHER pi session in the same repo appears
 * on the next scan. 1.5s is well under glance latency and a readdir+stat sweep is cheap.
 */
const RUN_POLL_MS = 1500;

/**
 * How often the header's relative-age segment (`· 3m`) re-ticks. The reducer holds no
 * clock, so the viewer owns "now": a 1s interval bumps `nowMs` and re-renders, advancing
 * the age while a run sits idle. 1s is the finest band {@link formatRelativeTime} shows.
 */
const NOW_TICK_MS = 1000;

/** Tree pane is ~3/5 of the width (opencode `flexGrow={3}` of 5); detail gets the rest. */
const TREE_FRACTION = 3 / 5;

/** Minimum columns for either pane before the split degrades to a single stacked view. */
const MIN_PANE_WIDTH = 16;

/** The feed/control dirs the viewer reads (feed) and writes sentinels to (control). */
export interface WorkflowsViewerDirs {
	/** `<dataDir>/workflow-feed` — the dir of `<runId>.jsonl` feed files. */
	feedDir: string;
	/** `<dataDir>/workflow-control` — where the `x`/`s` sentinels are written. */
	controlDir: string;
	/** Optional explicit run id to open first (else the freshest). */
	runId?: string;
}

/** A non-blocking notifier (`ctx.ui.notify`) the viewer surfaces save/cancel feedback on. */
export type Notify = (
	message: string,
	type?: "info" | "warning" | "error",
) => void;

/** One rendered tree line plus the flat agent index it maps to (`-1` for phase headers). */
interface TreeLine {
	text: string;
	/** Flat agent index for agent rows; `-1` for a phase header or fallback line. */
	agentIndex: number;
}

/**
 * Build one tree agent row's TEXT (uncolored) — the marker glyph + the step name,
 * nothing else (port of opencode `agentRowText`). Tokens/tools/duration/model live in
 * the Detail pane; the tree is the navigation rail (one clean name per row).
 */
function agentRowText(agent: AgentView): string {
	return `${statusMarker(agent.status)} ${agent.label}`;
}

/** The phase header row TEXT (marker + name + done/total; count dropped while pending). */
function phaseHeaderText(phase: PhaseView): string {
	const count = phase.total > 0 ? `  ${phase.done}/${phase.total}` : "";
	return `${phase.marker} ${phase.name}${count}`;
}

/** True for a SETTLED agent whose terminal status is a failure (not completed/cached). */
function isFailure(status: string | undefined): boolean {
	return status !== undefined && status !== "completed" && status !== "cached";
}

/** The flat agent list (phase order preserved) — the selection space. */
function flatAgents(view: RunViewState): AgentView[] {
	return view.phases.flatMap((p) => p.agents);
}

/**
 * The flat index of the first RUNNING agent (status `undefined`), or `undefined` when
 * none is live (port of opencode `runningIndex`). The reducer never sets a status until
 * `agent:end`, so `status === undefined` IS the "still running" query — no extra field.
 */
function runningIndex(agents: AgentView[]): number | undefined {
	const at = agents.findIndex((a) => a.status === undefined);
	return at === -1 ? undefined : at;
}

/** Clamp `value` into `[min, max]`; if `max < min` (empty list) return `min`. */
function clamp(value: number, min: number, max: number): number {
	if (max < min) {
		return min;
	}
	return Math.min(Math.max(value, min), max);
}

/**
 * The accent {@link ThemeColor} for the run status text in the header (port of
 * opencode `statusColor`, opencode `primary`/`textMuted` → pi `accent`/`muted`).
 */
function statusColor(
	status: RunViewState["status"],
): Parameters<Theme["fg"]>[0] {
	switch (status) {
		case "running":
			return "accent";
		case "completed":
			return "text";
		case "error":
			return "error";
		case "cancelled":
		case "cancelling":
			return "warning";
		default:
			return "muted";
	}
}

/**
 * Build the header line: `Workflows <identity>  ·  <status>  ·  run i/N  ·  <age>`.
 * The identity (name, else runId) is the only unbounded segment, so the whole line is
 * truncated to `width` (ANSI-aware) — a long name clips instead of wrapping the header.
 * Pure: takes the snapshot + the derived run position + the ticked `nowMs`.
 */
export function buildHeaderLine(
	theme: Theme,
	view: RunViewState,
	runId: string | undefined,
	runIndex: number,
	runCount: number,
	nowMs: number,
	width: number,
): string {
	const identity = view.name ?? runId ?? "no active run";
	const segments = [
		theme.fg("text", theme.bold("Workflows")),
		" ",
		theme.fg("muted", identity),
		theme.fg(statusColor(view.status), `  ·  ${view.status}`),
	];
	if (runCount > 1) {
		segments.push(theme.fg("muted", `  ·  run ${runIndex + 1}/${runCount}`));
	}
	if (view.startedAt !== undefined) {
		segments.push(
			theme.fg("muted", `  ·  ${formatRelativeTime(view.startedAt, nowMs)}`),
		);
	}
	return truncateToWidth(segments.join(""), width, "…");
}

/**
 * Build the tree pane's flat lines (port of opencode `rows()` + the `<For>` body +
 * `TreeFallback`). Each phase is a header line; its agents follow as indented rows
 * carrying their flat index. The followed row is highlighted with `▸ ` + `accent`;
 * others render `muted`. When there are no rows, the three DISTINCT fallback states
 * (no runs / errored / waiting / no run selected) render instead — never a generic
 * "waiting…". Returns `TreeLine`s so the scroller can map agent index → line index.
 */
export function buildTreeLines(
	theme: Theme,
	view: RunViewState,
	followed: number,
	hasRuns: boolean,
	hasRun: boolean,
	width: number,
): TreeLine[] {
	const lines: TreeLine[] = [];
	let index = 0;
	for (const phase of view.phases) {
		lines.push({
			text: truncateToWidth(
				theme.fg("text", phaseHeaderText(phase)),
				width,
				"…",
			),
			agentIndex: -1,
		});
		for (const agent of phase.agents) {
			const selected = index === followed;
			const prefix = selected ? "▸ " : "  ";
			const color = selected ? "accent" : "muted";
			lines.push({
				text: truncateToWidth(
					theme.fg(color, `${prefix}${agentRowText(agent)}`),
					width,
					"…",
				),
				agentIndex: index,
			});
			index += 1;
		}
	}
	if (lines.length > 0) {
		return lines;
	}
	// Fallback: three distinct empty states (port of opencode `TreeFallback`).
	let fallback: string;
	if (!hasRuns) {
		fallback = theme.fg(
			"muted",
			"No workflow runs yet — launch one with the workflow tool.",
		);
	} else if (view.status === "error") {
		fallback = theme.fg("error", "Run failed before reporting any agents.");
	} else if (!hasRun) {
		fallback = theme.fg("muted", "(no run selected)");
	} else {
		fallback = theme.fg("muted", "(waiting for the first event…)");
	}
	return [{ text: truncateToWidth(fallback, width, "…"), agentIndex: -1 }];
}

/** Push a labelled `── <label>` section header + each body line, wrapped to `width`. */
function pushSection(
	out: string[],
	theme: Theme,
	label: string,
	bodyLines: string[],
	bodyColor: Parameters<Theme["fg"]>[0],
	width: number,
): void {
	out.push("");
	out.push(truncateToWidth(theme.fg("border", `── ${label}`), width, "…"));
	for (const line of bodyLines) {
		out.push(truncateToWidth(theme.fg(bodyColor, line), width, "…"));
	}
}

/**
 * Build the detail pane lines for the selected agent (port of opencode `AgentDetail`).
 * Status-aware ordering: a RUNNING agent (status `undefined`) leads with its live
 * signal (running marker + stats + tools + prompt); a SETTLED one leads with status +
 * stats, then the CONCLUSION (the headline, in `text`), then note (error-prominent on
 * failure), tools, and prompt. Identity (label/model/session) leads in both. When no
 * agent is selected, a single `(no agent selected)` line renders.
 */
export function buildDetailLines(
	theme: Theme,
	agent: AgentView | undefined,
	width: number,
): string[] {
	const out: string[] = [theme.fg("muted", "Detail")];
	if (agent === undefined) {
		out.push(theme.fg("muted", "(no agent selected)"));
		return out.map((l) => truncateToWidth(l, width, "…"));
	}
	const running = agent.status === undefined;
	const failed = isFailure(agent.status);

	out.push(truncateToWidth(theme.fg("text", agent.label), width, "…"));
	if (agent.model !== undefined) {
		out.push(
			truncateToWidth(
				theme.fg("muted", `model: ${shortModel(agent.model)}`),
				width,
				"…",
			),
		);
	}
	if (agent.sessionID !== undefined) {
		out.push(
			truncateToWidth(
				theme.fg("muted", `session: ${agent.sessionID}`),
				width,
				"…",
			),
		);
	}

	// One compact `── stats` section: tokens · tools · duration on a single line, each
	// part included only when its field is present.
	const statsParts: string[] = [];
	if (agent.tokens !== undefined) {
		statsParts.push(`${formatTokens(agent.tokens)} tok`);
	}
	if (agent.toolCalls !== undefined) {
		statsParts.push(`${agent.toolCalls} tools`);
	}
	if (agent.durationMs !== undefined) {
		statsParts.push(formatDuration(agent.durationMs));
	}

	const stats = (): void => {
		if (statsParts.length > 0) {
			pushSection(
				out,
				theme,
				"stats",
				[statsParts.join(" · ")],
				"muted",
				width,
			);
		}
	};
	const tools = (): void => {
		if (agent.lastTools !== undefined && agent.lastTools.length > 0) {
			pushSection(
				out,
				theme,
				"tools",
				agent.lastTools.map((t) => `· ${t}`),
				"muted",
				width,
			);
		}
	};
	const prompt = (): void => {
		if (agent.prompt !== undefined) {
			pushSection(out, theme, "prompt", [agent.prompt], "muted", width);
		}
	};

	if (running) {
		out.push(
			truncateToWidth(
				theme.fg("accent", `status: ${statusMarker(undefined)} running`),
				width,
				"…",
			),
		);
		stats();
		tools();
		prompt();
	} else {
		if (agent.status !== undefined) {
			out.push(
				truncateToWidth(
					theme.fg(
						failed ? "error" : "muted",
						`status: ${statusMarker(agent.status)} ${agent.status}`,
					),
					width,
					"…",
				),
			);
		}
		stats();
		if (agent.result !== undefined) {
			pushSection(out, theme, "conclusion", [agent.result], "text", width);
		}
		if (agent.note !== undefined) {
			pushSection(
				out,
				theme,
				failed ? "error" : "note",
				[agent.note],
				failed ? "error" : "muted",
				width,
			);
		}
		tools();
		prompt();
	}
	return out;
}

/**
 * Join the tree pane (left) and detail pane (right) line-by-line with a `│` divider
 * (the imperative equivalent of opencode's `flexDirection="row"` + `border={["left"]}`).
 * Both panes are padded to `height` rows and to their pane widths (`visibleWidth`-aware,
 * so ANSI codes don't break the padding) before the join.
 */
export function joinPanes(
	theme: Theme,
	treeLines: string[],
	detailLines: string[],
	treeWidth: number,
	detailWidth: number,
	height: number,
): string[] {
	const divider = theme.fg("border", "│");
	const out: string[] = [];
	for (let i = 0; i < height; i += 1) {
		const left = padTo(treeLines[i] ?? "", treeWidth);
		const right = padTo(detailLines[i] ?? "", detailWidth);
		out.push(`${left}${divider}${right}`);
	}
	return out;
}

/** Pad a (possibly ANSI-styled) string to `width` visible columns with trailing spaces. */
function padTo(text: string, width: number): string {
	const w = visibleWidth(text);
	return w >= width ? text : text + " ".repeat(width - w);
}

/**
 * The `/workflows` viewer component. Instantiated by the `custom()` factory in
 * `command.ts`. Owns ONE reducer per open run (swapped wholesale in `openRun`), ONE
 * tailer feeding it, the `←/→` run list, the flat selection, the auto-follow latch,
 * the manual scroll offset, and the poll/tick timers. Implements pi-tui's `Component`
 * (`render`/`invalidate`/`handleInput`) plus `dispose` (called on overlay close).
 */
export class WorkflowsViewer implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly done: (value: undefined) => void;
	private readonly dirs: WorkflowsViewerDirs;
	private readonly notify: Notify;

	private reducer: RunStateReducer = createRunStateReducer();
	private tailer: FeedTailer | undefined;
	private runId: string | undefined;
	private runIds: string[] = [];
	/** Flat selection index across ALL agents of ALL phases. */
	private selected = 0;
	/** Auto-follow latch: false → follow the running agent; the first ↑/↓ flips it true. */
	private userHasScrolled = false;
	/** "Now" for the header relative-age segment, ticked on `NOW_TICK_MS`. */
	private nowMs = Date.now();
	/** Manual tree scroll offset (replaces opentui `<scrollbox>` `scrollTop`). */
	private scrollTop = 0;

	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private nowTimer: ReturnType<typeof setInterval> | undefined;
	/**
	 * Set in `dispose`. `openRun`'s async `tailer.start()` awaits; if the viewer is
	 * disposed mid-await, this lets the started tailer be stopped after the await.
	 */
	private disposed = false;

	constructor(
		tui: TUI,
		theme: Theme,
		done: (value: undefined) => void,
		dirs: WorkflowsViewerDirs,
		notify: Notify,
	) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.dirs = dirs;
		this.notify = notify;
		this.start();
	}

	/** Resolve the first run + arm the dir poll + the now tick (port of opencode `onMount`). */
	private start(): void {
		void (async () => {
			await this.refreshRuns();
			const id = await resolveRunId(
				this.dirs.feedDir,
				this.dirs.runId,
				runsFs,
				join,
			);
			if (id === undefined || this.disposed) {
				return;
			}
			this.openRun(id);
		})();
		// Poll the dir so a run started in ANOTHER session shows up in `←/→` live.
		this.pollTimer = setInterval(() => {
			void this.refreshRuns();
		}, RUN_POLL_MS);
		(this.pollTimer as { unref?: () => void }).unref?.();
		// Advance "now" so the header age re-renders on a live run with no new events.
		this.nowTimer = setInterval(() => {
			this.nowMs = Date.now();
			this.tui.requestRender();
		}, NOW_TICK_MS);
		(this.nowTimer as { unref?: () => void }).unref?.();
	}

	/**
	 * Tail a different run: stop the current tailer, start fresh on `id`'s feed with a
	 * brand-new reducer (no cross-run state bleed), reset selection + auto-follow + scroll.
	 * A no-op when `id` is already open. The async `start()` is fenced by `disposed` and by
	 * `this.tailer !== next` (a newer `openRun` superseded this one mid-await) so a stale
	 * tailer never lingers. Port of opencode `openRun`.
	 */
	private openRun(id: string): void {
		if (id === this.runId) {
			return;
		}
		this.tailer?.stop();
		this.reducer = createRunStateReducer();
		this.runId = id;
		this.selected = 0;
		this.userHasScrolled = false;
		this.scrollTop = 0;
		const next = createFeedTailer({
			path: join(this.dirs.feedDir, `${id}${FEED_SUFFIX}`),
			onEvent: (event) => {
				this.reducer.apply(event);
				this.tui.requestRender();
			},
		});
		this.tailer = next;
		this.tui.requestRender();
		void (async () => {
			await next.start();
			if (this.disposed || this.tailer !== next) {
				next.stop();
			}
		})();
	}

	/** Re-scan the feed dir into the `←/→` switch list (cross-session runs appear here). */
	private async refreshRuns(): Promise<void> {
		const ids = await listRunIds(this.dirs.feedDir, runsFs, join);
		if (this.disposed) {
			return;
		}
		this.runIds = ids;
		this.tui.requestRender();
	}

	/** `←/→` step through `runIds` (freshest at 0), clamped — opening the landed run. */
	private switchRun(delta: number): void {
		if (this.runIds.length === 0) {
			return;
		}
		const cur = this.runIds.indexOf(this.runId ?? "");
		const next = clamp(
			(cur === -1 ? 0 : cur) + delta,
			0,
			this.runIds.length - 1,
		);
		const target = this.runIds[next];
		if (target !== undefined) {
			this.openRun(target);
		}
	}

	/**
	 * The row the view follows + highlights: the live agent until the user scrolls, then
	 * their `selected` (port of opencode `followedIndex`). Falls back to `selected` when
	 * nothing is running (a settled run or pre-first-event).
	 */
	private followedIndex(agents: AgentView[]): number {
		if (this.userHasScrolled) {
			return this.selected;
		}
		return runningIndex(agents) ?? this.selected;
	}

	/**
	 * `↑/↓` move the selection through the flat agent list, clamped (port of opencode
	 * `moveSelection`). The first manual move ends auto-follow and seeds `selected` from
	 * the currently followed row, so the move steps off WHERE THE EYE IS (the live agent).
	 */
	private moveSelection(delta: number): void {
		const agents = flatAgents(this.reducer.state());
		if (!this.userHasScrolled) {
			this.userHasScrolled = true;
			this.selected = this.followedIndex(agents);
		}
		this.selected = clamp(this.selected + delta, 0, agents.length - 1);
	}

	/**
	 * `x` cancels the open run after an INLINE confirm (a `y/n` mode flag inside this
	 * component), not `ctx.ui.confirm` — an inline confirm is self-contained and avoids
	 * the focus-routing question of opening a dialog over a non-overlay `custom()`. The
	 * sentinel is the exact 8.2 external touch; the engine's poll consumes it and the
	 * feed's `run:cancel-requested` line flips the view to `cancelling`.
	 */
	private confirmingCancel = false;

	private async writeCancel(id: string): Promise<void> {
		try {
			await writeCancelSentinel({
				controlDir: this.dirs.controlDir,
				runId: id,
			});
		} catch (err) {
			this.notify(
				`Cancel failed for ${id}: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
		}
	}

	/**
	 * `s` saves the open run as a named workflow under its display name (slugified to a
	 * filesystem-safe name the engine validator accepts). Non-destructive (the engine
	 * refuses a collision), so no confirm. The channel is one-way: notify optimistically;
	 * the engine logs the actual outcome. Port of opencode `saveSelected`.
	 */
	private async saveSelected(id: string): Promise<void> {
		const view = this.reducer.state();
		const name = slugifyWorkflowName(view.name ?? id);
		try {
			await writeSaveSentinel({
				controlDir: this.dirs.controlDir,
				runId: id,
				name,
			});
			this.notify(`Saving "${name}" — see logs for the result.`, "info");
		} catch (err) {
			this.notify(
				`Save failed for ${id}: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
		}
	}

	handleInput(data: string): void {
		// Inline cancel confirm owns input while armed: y/enter writes the sentinel, any
		// other key dismisses (a destructive action never fires on a stray key).
		if (this.confirmingCancel) {
			this.confirmingCancel = false;
			if (matchesKey(data, "y") || matchesKey(data, Key.return)) {
				const id = this.runId;
				if (id !== undefined) {
					void this.writeCancel(id);
				}
			}
			this.tui.requestRender();
			return;
		}

		if (
			matchesKey(data, Key.escape) ||
			matchesKey(data, "q") ||
			matchesKey(data, Key.ctrl("c"))
		) {
			this.dispose();
			this.done(undefined);
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			this.moveSelection(1);
		} else if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			this.moveSelection(-1);
		} else if (matchesKey(data, Key.right) || matchesKey(data, "l")) {
			this.switchRun(1);
		} else if (matchesKey(data, Key.left) || matchesKey(data, "h")) {
			this.switchRun(-1);
		} else if (matchesKey(data, "x")) {
			if (this.runId !== undefined) {
				this.confirmingCancel = true;
			}
		} else if (matchesKey(data, "s")) {
			const id = this.runId;
			if (id !== undefined) {
				void this.saveSelected(id);
			}
		} else {
			return; // unhandled key: no re-render
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const theme = this.theme;
		const view = this.reducer.state();
		const agents = flatAgents(view);
		const followed = clamp(
			this.followedIndex(agents),
			0,
			Math.max(0, agents.length - 1),
		);
		const at = this.runIds.indexOf(this.runId ?? "");
		const runIndex = at === -1 ? 0 : at;

		// Vertical budget: total rows less header (1 line + 1 rule) and footer (1 rule + 1
		// hint). `terminal.rows` is the live height; clamp so a tiny terminal still renders.
		const totalRows = Math.max(6, this.tui.terminal.rows);
		const bodyHeight = Math.max(1, totalRows - 4);

		// Horizontal split: tree ~3/5, detail the rest, with 1 col for the `│` divider.
		const treeWidth = Math.max(
			MIN_PANE_WIDTH,
			Math.floor(width * TREE_FRACTION),
		);
		const detailWidth = Math.max(1, width - treeWidth - 1);

		const lines: string[] = [];
		lines.push(
			buildHeaderLine(
				theme,
				view,
				this.runId,
				runIndex,
				this.runIds.length,
				this.nowMs,
				width,
			),
		);
		lines.push(theme.fg("border", "─".repeat(width)));

		// Tree pane: build the flat lines, follow the selected row by clamping scrollTop so
		// its line index stays inside the viewport, then slice the visible window.
		const treeLines = buildTreeLines(
			theme,
			view,
			followed,
			this.runIds.length > 0,
			this.runId !== undefined,
			treeWidth,
		);
		this.scrollTop = this.followScroll(treeLines, followed, bodyHeight);
		const visibleTree = treeLines
			.slice(this.scrollTop, this.scrollTop + bodyHeight)
			.map((l) => l.text);

		// Detail pane: the selected agent's body, clipped to the body height.
		const selectedAgent = agents.length === 0 ? undefined : agents[followed];
		const detailLines = buildDetailLines(
			theme,
			selectedAgent,
			detailWidth,
		).slice(0, bodyHeight);

		for (const line of joinPanes(
			theme,
			visibleTree,
			detailLines,
			treeWidth,
			detailWidth,
			bodyHeight,
		)) {
			lines.push(line);
		}

		lines.push(theme.fg("border", "─".repeat(width)));
		const footer = this.confirmingCancel
			? theme.fg(
					"warning",
					`Cancel "${view.name ?? this.runId ?? "run"}"? y = confirm · any other key = abort`,
				)
			: theme.fg("dim", "↑↓ agent · ←→ run · x cancel · s save · q/esc quit");
		lines.push(truncateToWidth(footer, width, "…"));
		return lines;
	}

	/**
	 * Clamp `scrollTop` so the followed agent's LINE (accounting for phase-header lines
	 * above it) stays inside `[scrollTop, scrollTop + height)` — the minimal-delta scroll
	 * opentui's `scrollChildIntoView` gave for free. Maps the flat agent index to its line
	 * index in the interleaved tree list, then nudges the offset only if the line is off-fold.
	 */
	private followScroll(
		treeLines: TreeLine[],
		followed: number,
		height: number,
	): number {
		const lineIndex = treeLines.findIndex((l) => l.agentIndex === followed);
		const maxTop = Math.max(0, treeLines.length - height);
		let top = clamp(this.scrollTop, 0, maxTop);
		if (lineIndex === -1) {
			return top;
		}
		if (lineIndex < top) {
			top = lineIndex;
		} else if (lineIndex >= top + height) {
			top = lineIndex - height + 1;
		}
		return clamp(top, 0, maxTop);
	}

	/** Stateless render — nothing themed is cached, so invalidation is a no-op. */
	invalidate(): void {}

	/** Overlay/custom lifecycle close: clear timers + stop the tailer. Idempotent. */
	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.tailer?.stop();
		this.tailer = undefined;
		if (this.pollTimer !== undefined) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
		if (this.nowTimer !== undefined) {
			clearInterval(this.nowTimer);
			this.nowTimer = undefined;
		}
	}
}
