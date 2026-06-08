/** @jsxImportSource @opentui/solid */
/**
 * The full-screen `workflows` route view (Task 8.3.3, reworked) — a CC-style tree.
 *
 * LEFT pane is the whole run as a TREE: every phase is a header row and its agents
 * are rendered indented beneath it, ALL phases and agents visible top-to-bottom from
 * the first frame (no phase-gated reveal). RIGHT pane is the selected agent's Detail.
 * This is the only JSX in the `./tui` surface and stays thin: layout + signal wiring.
 * Every derivation — phase markers, agent rows, token/duration formatting — comes
 * from the pure 8.3.1 reducer/format modules; this file owns NO reduction logic. One
 * {@link createRunStateReducer} per open feed file is fed by ONE {@link createFeedTailer}
 * (8.3.2) started on mount and `stop()`ed on cleanup, so the tree updates live as the
 * engine appends and replays a settled file after a restart.
 *
 * Keys (a keymap layer mounted while the route is focused): `↑/↓` (or `k/j`) move the
 * selection through agent rows across all phases; `←/→` (or `h/l`) switch between runs
 * (every run in the feed dir, settled or live, freshest first — the cross-session
 * switcher: two opencode sessions running two workflows in the same repo flip between
 * each other's runs here); `esc` closes the route to the return route; `x` writes the
 * cancel sentinel for the open run (the 8.2 external touch). Single-key specs only —
 * `@opentui/keymap` does NOT comma-split a binding `key`, so each alternate is its own
 * entry.
 *
 * ⚠️ Every solid/opentui import here is fine because this is a `.tsx` (the host
 * transform rewrites them to the host's runtime instance). NEVER move this logic into
 * a `.ts` — see `index.tsx`'s header (the dual-instance crash).
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TuiPluginApi, TuiRouteCurrent } from "@opencode-ai/plugin/tui";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import {
	formatDuration,
	formatTokens,
	shortModel,
	statusMarker,
	truncateLine,
} from "./format";
import { writeCancelSentinel } from "./paths";
import {
	type AgentView,
	createRunStateReducer,
	type PhaseView,
	type RunViewState,
} from "./reducer";
import { listRunIds, type RunsFs, resolveRunId } from "./runs";
import { createFeedTailer } from "./tailer";

/** The real readdir/stat seam the route hands {@link resolveRunId}/{@link listRunIds}. */
const runsFs: RunsFs = { readdir, stat };

const FEED_SUFFIX = ".jsonl";

/**
 * How often the route re-scans the feed dir for the `←/→` run list. The feed dir is the
 * cross-session bus: a run started by ANOTHER opencode session in the same repo appears
 * on the next scan. 1.5s is well under human glance latency and a readdir+stat sweep is
 * cheap (no per-file reduce — the route only needs the ids, not their summaries).
 */
const RUN_POLL_MS = 1500;

/** One rendered tree line: a phase header, or an agent at a flat selection index. */
type TreeRow =
	| { kind: "phase"; phase: PhaseView }
	| { kind: "agent"; agent: AgentView; index: number };

export interface WorkflowsRouteProps {
	api: TuiPluginApi;
	/** `<dataDir>/workflow-feed` — the dir of `<runId>.jsonl` feed files. */
	feedDir: string;
	/** `<dataDir>/workflow-control` — where the `x` cancel sentinel is written. */
	controlDir: string;
	/** Route params; `runId` selects the feed file (else most-recently-modified). */
	params?: Record<string, unknown>;
}

/** Build one CC-style agent row string (marker + label + model + stats). */
function agentRowText(agent: AgentView): string {
	const marker = statusMarker(agent.status);
	const model = agent.model !== undefined ? shortModel(agent.model) : "";
	if (agent.status === "cached") {
		return `${marker} ${agent.label}${model ? `  ${model}` : ""}  cached`;
	}
	const stats: string[] = [];
	if (agent.tokens !== undefined) {
		stats.push(`${formatTokens(agent.tokens)} tok`);
	}
	if (agent.toolCalls !== undefined) {
		stats.push(`${agent.toolCalls} tools`);
	}
	if (agent.durationMs !== undefined) {
		stats.push(formatDuration(agent.durationMs));
	}
	const tail = stats.length > 0 ? `  ${stats.join(" · ")}` : "";
	return `${marker} ${agent.label}${model ? `  ${model}` : ""}${tail}`;
}

/** The phase header row text (marker + name + done/total; count dropped while pending). */
function phaseHeaderText(phase: PhaseView): string {
	const count = phase.total > 0 ? `  ${phase.done}/${phase.total}` : "";
	return `${phase.marker} ${phase.name}${count}`;
}

/** A short human label for the run's terminal/live status shown in the header. */
function statusLabel(status: RunViewState["status"]): string {
	return status;
}

/**
 * The route component, default-exported so the `./tui` entry can render it as inline
 * JSX (`<WorkflowsRoute … />`) — the host transform then creates it in the HOST's solid
 * instance (never `createComponent` from a nested copy; see `index.tsx`).
 */
export default function WorkflowsRoute(props: WorkflowsRouteProps) {
	const dimensions = useTerminalDimensions();
	const theme = () => props.api.theme.current;

	// ONE reducer per open feed file, fed by ONE tailer. Both are swapped wholesale by
	// `openRun` when `←/→` switches runs (a fresh reducer per file — no cross-run state
	// bleed). The signal is bumped on every applied event AND on every switch so the
	// memos below recompute; `reducer` is a `let` because the memo reads it by reference.
	let reducer = createRunStateReducer();
	const [version, setVersion] = createSignal(0);
	const view = createMemo<RunViewState>(() => {
		version();
		return reducer.state();
	});

	const [runId, setRunId] = createSignal<string | undefined>();
	// Every run in the feed dir (freshest first) — the `←/→` switch space, refreshed on
	// a poll so cross-session runs appear without restarting the viewer.
	const [runIds, setRunIds] = createSignal<string[]>([]);
	// Selection is a flat index across ALL agents of ALL phases (the tree is one list).
	const [selected, setSelected] = createSignal(0);

	// 0-based position of the open run within `runIds` (the freshest is 0); -1 collapses
	// to 0 so the header reads `run 1/N` before the first scan binds an index.
	const runIndex = createMemo<number>(() => {
		const at = runIds().indexOf(runId() ?? "");
		return at === -1 ? 0 : at;
	});

	const phases = createMemo<PhaseView[]>(() => view().phases);
	// Flat agent list (phase order preserved) — the selection space.
	const flatAgents = createMemo<AgentView[]>(() =>
		phases().flatMap((p) => p.agents),
	);
	// The interleaved render rows: a phase header, then its agents (carrying the flat
	// index so a row can tell whether it is the selected one).
	const rows = createMemo<TreeRow[]>(() => {
		const out: TreeRow[] = [];
		let index = 0;
		for (const phase of phases()) {
			out.push({ kind: "phase", phase });
			for (const agent of phase.agents) {
				out.push({ kind: "agent", agent, index });
				index += 1;
			}
		}
		return out;
	});
	const selectedAgent = createMemo<AgentView | undefined>(() => {
		const list = flatAgents();
		if (list.length === 0) {
			return undefined;
		}
		return list[clamp(selected(), 0, list.length - 1)];
	});

	// Tree rows are ONE line each (truncated, never wrapped), so a row's index in
	// `rows()` IS its line offset in the scroll content — the scroll-follow math below
	// is exact. The selected agent's line is where the viewport must keep in view.
	const selectedLine = createMemo<number>(() => {
		const list = rows();
		for (let i = 0; i < list.length; i += 1) {
			const row = list[i];
			if (row?.kind === "agent" && row.index === selected()) {
				return i;
			}
		}
		return 0;
	});
	// Column budget for a tree row: the tree pane is flexGrow 3 of 5 (≈60% of width),
	// less its padding and the scrollbar gutter. Truncating to this keeps every row on
	// ONE line (the full stats live in the Detail pane); a small right gap is harmless.
	const treeWidth = createMemo<number>(() =>
		Math.max(8, Math.floor((dimensions().width * 3) / 5) - 4),
	);

	let tailer: ReturnType<typeof createFeedTailer> | undefined;
	let disposeLayer: (() => void) | undefined;
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	// The tree's scroll viewport — its `scrollY` is driven by the follow effect so the
	// selected row stays visible as `↑/↓` walks past the fold.
	let scrollRef: ScrollBoxRenderable | undefined;
	// Set in onCleanup. The mount IIFE awaits an async dir scan before it can assign and
	// start the tailer; if the route unmounts inside that window, onCleanup runs with
	// `tailer` still undefined (a no-op) and the IIFE would otherwise arm a watcher
	// nobody stops. The flag lets the IIFE bail/stop after the await.
	let disposed = false;

	/**
	 * Tail a different run: stop the current tailer, start fresh on `id`'s feed with a
	 * brand-new reducer (no cross-run state bleed), and reset the selection to the top.
	 * A no-op when `id` is already open. The async `start()` is fenced two ways — by
	 * `disposed` (the route unmounted) and by `tailer !== next` (a newer `openRun`
	 * superseded this one mid-await, e.g. rapid `←/→`) — so a stale tailer never lingers.
	 */
	function openRun(id: string): void {
		if (id === runId()) {
			return;
		}
		tailer?.stop();
		reducer = createRunStateReducer();
		setRunId(id);
		setSelected(0);
		setVersion((v) => v + 1);
		const next = createFeedTailer({
			path: join(props.feedDir, `${id}${FEED_SUFFIX}`),
			onEvent(event) {
				reducer.apply(event);
				setVersion((v) => v + 1);
			},
		});
		tailer = next;
		void (async () => {
			await next.start();
			if (disposed || tailer !== next) {
				next.stop();
			}
		})();
	}

	/** Re-scan the feed dir into the `←/→` switch list (cross-session runs appear here). */
	async function refreshRuns(): Promise<void> {
		const ids = await listRunIds(props.feedDir, runsFs, join);
		if (disposed) {
			return;
		}
		setRunIds(ids);
	}

	/** `←/→` step through `runIds` (freshest at 0), clamped — opening the landed run. */
	function switchRun(delta: number): void {
		const ids = runIds();
		if (ids.length === 0) {
			return;
		}
		const cur = ids.indexOf(runId() ?? "");
		const next = clamp((cur === -1 ? 0 : cur) + delta, 0, ids.length - 1);
		const target = ids[next];
		if (target !== undefined) {
			openRun(target);
		}
	}

	onMount(() => {
		void (async () => {
			await refreshRuns();
			const id = await resolveRunId(
				props.feedDir,
				props.params?.runId,
				runsFs,
				join,
			);
			if (id === undefined || disposed) {
				return;
			}
			openRun(id);
		})();
		// Poll the dir so a run started in ANOTHER session shows up in `←/→` live.
		pollTimer = setInterval(() => {
			void refreshRuns();
		}, RUN_POLL_MS);

		disposeLayer = props.api.keymap.registerLayer({
			priority: 2000,
			commands: [
				{ name: "workflows.down", run: () => moveSelection(1) },
				{ name: "workflows.up", run: () => moveSelection(-1) },
				{ name: "workflows.nextRun", run: () => switchRun(1) },
				{ name: "workflows.prevRun", run: () => switchRun(-1) },
				{ name: "workflows.back", run: () => back() },
				{ name: "workflows.cancel", run: () => void cancelSelected() },
			],
			// One entry PER key — `@opentui/keymap` does not comma-split a binding key.
			bindings: [
				{ key: "down", cmd: "workflows.down" },
				{ key: "j", cmd: "workflows.down" },
				{ key: "up", cmd: "workflows.up" },
				{ key: "k", cmd: "workflows.up" },
				{ key: "right", cmd: "workflows.nextRun" },
				{ key: "l", cmd: "workflows.nextRun" },
				{ key: "left", cmd: "workflows.prevRun" },
				{ key: "h", cmd: "workflows.prevRun" },
				{ key: "escape", cmd: "workflows.back" },
				{ key: "x", cmd: "workflows.cancel" },
				{ key: "s", cmd: "workflows.cancel" },
			],
		});
	});

	onCleanup(() => {
		disposed = true;
		tailer?.stop();
		if (pollTimer !== undefined) {
			clearInterval(pollTimer);
		}
		disposeLayer?.();
	});

	// Scroll-follow: keep the selected row inside the viewport — scroll up to it when it
	// drifts above the fold, down when it falls below. Re-runs on selection or resize.
	createEffect(() => {
		const sb = scrollRef;
		const line = selectedLine();
		dimensions(); // re-follow when the terminal resizes
		if (sb === undefined) {
			return;
		}
		// `scrollTop` is in rows (1 cell = 1 line); `viewport.height` is the visible row
		// count (the scrollbox box minus its scrollbar gutter). Both line-based, so the
		// clamp keeps the selected line within [top, top + viewport).
		const viewport = sb.viewport.height;
		if (viewport <= 0) {
			return;
		}
		const top = sb.scrollTop;
		if (line < top) {
			sb.scrollTop = line;
		} else if (line >= top + viewport) {
			sb.scrollTop = line - viewport + 1;
		}
	});

	/** `↑/↓` move the selection through the flat agent list, clamped to its length. */
	function moveSelection(delta: number): void {
		const max = flatAgents().length - 1;
		setSelected((i) => clamp(i + delta, 0, max));
	}

	/** `esc` closes the route to the return route (the originating screen, or `home`). */
	function back(): void {
		const returnRoute = props.params?.returnRoute as
			| TuiRouteCurrent
			| undefined;
		props.api.route.navigate(
			returnRoute?.name ?? "home",
			returnRoute !== undefined && "params" in returnRoute
				? returnRoute.params
				: undefined,
		);
	}

	/**
	 * `x` writes the cancel sentinel for the open run (the exact 8.2 external touch). A
	 * failed sentinel write is surfaced as an error toast and never allowed to become an
	 * unhandled rejection — mirroring the tailer's `onError` fencing.
	 */
	async function cancelSelected(): Promise<void> {
		const id = runId();
		if (id === undefined) {
			return;
		}
		try {
			await writeCancelSentinel({ controlDir: props.controlDir, runId: id });
		} catch (err) {
			props.api.ui.toast({
				variant: "error",
				title: "Cancel failed",
				message: `Could not write the cancel sentinel for ${id}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			});
		}
	}

	/** The accent for the run status text in the header. */
	const statusColor = () => {
		const t = theme();
		switch (view().status) {
			case "running":
				return t.primary;
			case "completed":
				return t.text;
			case "error":
				return t.error;
			case "cancelled":
			case "cancelling":
				return t.warning;
			default:
				return t.textMuted;
		}
	};

	return (
		<box
			position="absolute"
			zIndex={2500}
			left={0}
			top={0}
			width={dimensions().width}
			height={dimensions().height}
			backgroundColor={theme().background}
			flexDirection="column"
		>
			{/* Header: title + run id + status, with a full-width rule below it. */}
			<box flexDirection="row" flexShrink={0} paddingLeft={1} paddingRight={1}>
				<text fg={theme().text}>Workflows </text>
				<text fg={theme().textMuted}>{runId() ?? "no active run"}</text>
				<text fg={statusColor()}>{`  ·  ${statusLabel(view().status)}`}</text>
				<Show when={runIds().length > 1}>
					<text fg={theme().textMuted}>
						{`  ·  run ${runIndex() + 1}/${runIds().length}`}
					</text>
				</Show>
			</box>
			<box flexShrink={0} paddingLeft={1} paddingRight={1}>
				<text fg={theme().border}>
					{"─".repeat(Math.max(0, dimensions().width - 2))}
				</text>
			</box>

			<box flexGrow={1} flexDirection="row" minHeight={0}>
				{/* Tree pane: a scroll viewport over all phases + their agents. Each row is
				    ONE truncated line, so the row index equals its scroll line and the
				    follow effect keeps the selection visible as it walks past the fold. */}
				<scrollbox
					ref={(el) => {
						scrollRef = el as unknown as ScrollBoxRenderable;
					}}
					flexGrow={3}
					flexDirection="column"
					paddingLeft={1}
					paddingRight={1}
				>
					<Show
						when={rows().length > 0}
						fallback={
							<text fg={theme().textMuted}>
								(waiting for the run to start…)
							</text>
						}
					>
						<For each={rows()}>
							{(row) =>
								row.kind === "phase" ? (
									<text fg={theme().text}>
										{truncateLine(phaseHeaderText(row.phase), treeWidth())}
									</text>
								) : (
									<text
										fg={
											row.index === selected()
												? theme().primary
												: theme().textMuted
										}
									>
										{truncateLine(
											`${row.index === selected() ? "▸ " : "  "}${agentRowText(row.agent)}`,
											treeWidth(),
										)}
									</text>
								)
							}
						</For>
					</Show>
				</scrollbox>

				{/* Detail pane: the selected agent, with a left border as the divider. */}
				<box
					flexGrow={2}
					flexDirection="column"
					paddingLeft={2}
					paddingRight={1}
					border={["left"]}
					borderColor={theme().border}
				>
					<text fg={theme().textMuted}>Detail</text>
					<Show
						when={selectedAgent()}
						fallback={<text fg={theme().textMuted}>(no agent selected)</text>}
					>
						{(agent) => <AgentDetail agent={agent()} theme={theme()} />}
					</Show>
				</box>
			</box>

			{/* Footer: the active key hints. */}
			<box flexShrink={0} paddingLeft={1} paddingRight={1}>
				<text fg={theme().border}>
					{"─".repeat(Math.max(0, dimensions().width - 2))}
				</text>
			</box>
			<box flexShrink={0} paddingLeft={1}>
				<text fg={theme().textMuted}>
					↑↓ agent · ←→ run · x cancel · esc back
				</text>
			</box>
		</box>
	);
}

/** The Detail pane body for one agent — status, tokens, tools, note, sessionID. */
function AgentDetail(props: {
	agent: AgentView;
	theme: TuiPluginApi["theme"]["current"];
}) {
	const t = props.theme;
	return (
		<box flexDirection="column">
			<text fg={t.text}>{props.agent.label}</text>
			<Show when={props.agent.model}>
				{(model) => <text fg={t.textMuted}>{shortModel(model())}</text>}
			</Show>
			<Show when={props.agent.status}>
				{(status) => (
					<text
						fg={t.textMuted}
					>{`${statusMarker(status())} ${status()}`}</text>
				)}
			</Show>
			<Show when={props.agent.tokens !== undefined}>
				<text fg={t.textMuted}>
					{`${formatTokens(props.agent.tokens ?? 0)} tok`}
				</text>
			</Show>
			<Show when={props.agent.toolCalls !== undefined}>
				<text fg={t.textMuted}>{`${props.agent.toolCalls} tool calls`}</text>
			</Show>
			<Show when={props.agent.durationMs !== undefined}>
				<text fg={t.textMuted}>
					{formatDuration(props.agent.durationMs ?? 0)}
				</text>
			</Show>
			<Show when={props.agent.prompt}>
				{(prompt) => (
					<box flexDirection="column" paddingTop={1}>
						<text fg={t.border}>── prompt</text>
						<text fg={t.textMuted}>{prompt()}</text>
					</box>
				)}
			</Show>
			<Show when={props.agent.lastTools && props.agent.lastTools.length > 0}>
				<For each={props.agent.lastTools ?? []}>
					{(tool) => <text fg={t.textMuted}>{`· ${tool}`}</text>}
				</For>
			</Show>
			<Show when={props.agent.note}>
				{(note) => <text fg={t.textMuted}>{note()}</text>}
			</Show>
			<Show when={props.agent.sessionID}>
				{(id) => <text fg={t.textMuted}>{id()}</text>}
			</Show>
		</box>
	);
}

/** Clamp `value` into `[min, max]` (max may be negative when the list is empty). */
function clamp(value: number, min: number, max: number): number {
	if (max < min) {
		return min;
	}
	return Math.min(Math.max(value, min), max);
}
