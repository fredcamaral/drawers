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
 * each other's runs here); `q`/`esc` quit the viewer (back to the return route); `x`
 * prompts a confirm dialog and writes the cancel sentinel for the open run (the 8.2
 * external touch) ONLY on confirm — a dismiss is a no-op. Single-key specs only —
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
	Match,
	onCleanup,
	onMount,
	Show,
	Switch,
} from "solid-js";
import {
	formatDuration,
	formatRelativeTime,
	formatTokens,
	shortModel,
	statusMarker,
	truncateLine,
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

/**
 * How often the header's relative-age segment (`· 3m`) re-ticks. The reducer holds no
 * clock, so the route owns "now": a 1s interval bumps a `nowMs` signal the header reads,
 * advancing the age while a run sits idle (no feed event would otherwise re-render it).
 * 1s is the finest band {@link formatRelativeTime} shows, so a faster tick buys nothing.
 */
const NOW_TICK_MS = 1000;

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
	// "Now" for the header's relative-age segment — ticked on an interval (the reducer
	// holds no clock) so the age advances even while a run sits idle with no new event.
	const [nowMs, setNowMs] = createSignal(Date.now());
	// Auto-follow latch: false means the view follows the running agent (CC's sticky-
	// bottom intent); the first ↑/↓ flips it true and selection takes over. Reset per
	// run in `openRun` so a run-switch re-arms auto-follow on the freshest live agent.
	const [userHasScrolled, setUserHasScrolled] = createSignal(false);

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
	// The flat index of the first RUNNING agent occurrence, or undefined when none is
	// live. A running occurrence is precisely `status === undefined` (the reducer never
	// sets a status until `agent:end`; `statusMarker(undefined)` → the `…` marker) —
	// the existing snapshot field IS the queryable signal, no reducer change needed.
	const runningIndex = createMemo<number | undefined>(() => {
		const at = flatAgents().findIndex((a) => a.status === undefined);
		return at === -1 ? undefined : at;
	});
	// The row the view follows + highlights. Until the user scrolls we track the live
	// agent (falling back to `selected` when nothing is running, e.g. a settled run or
	// pre-first-event); after the first ↑/↓ the user's `selected` wins outright.
	const followedIndex = createMemo<number>(() =>
		userHasScrolled() ? selected() : (runningIndex() ?? selected()),
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
		return list[clamp(followedIndex(), 0, list.length - 1)];
	});

	// Stable per-agent row id (`row-<flatIndex>`). The scroll-follow effect looks the
	// selected row up by this id in the scrollbox's real children and reads its laid-out
	// geometry — no index→line assumption, so wrapping or spacer rows never desync it.
	const rowId = (index: number): string => `row-${index}`;
	// Column budget for a tree row: the tree pane is flexGrow 3 of 5 (≈60% of width),
	// less its padding and the scrollbar gutter. Truncating to this keeps every row on
	// ONE line (the full stats live in the Detail pane); a small right gap is harmless.
	const treeWidth = createMemo<number>(() =>
		Math.max(8, Math.floor((dimensions().width * 3) / 5) - 4),
	);
	// Width budget for the header's run-identity segment: the terminal width less the
	// fixed segments ("Workflows " ≈ 10 + the bounded status/run i/N/age tail ≈ 30) and
	// the box padding. Keeps the identity on the header's single row instead of letting a
	// long name word-wrap the whole header onto a second line.
	const headerIdentityWidth = createMemo<number>(() =>
		Math.max(8, dimensions().width - 42),
	);

	let tailer: ReturnType<typeof createFeedTailer> | undefined;
	let disposeLayer: (() => void) | undefined;
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	// Ticks `nowMs` so the header's relative-age segment advances between feed events.
	let nowTimer: ReturnType<typeof setInterval> | undefined;
	// The tree's scroll viewport — its `scrollTop` is driven by the follow effect so the
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
		// Re-arm auto-follow: a freshly opened run should track its live agent until the
		// user takes over, even if they had scrolled in the previously open run.
		setUserHasScrolled(false);
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
		// Advance "now" so the header age re-renders on a live run with no new events.
		nowTimer = setInterval(() => {
			setNowMs(Date.now());
		}, NOW_TICK_MS);

		disposeLayer = props.api.keymap.registerLayer({
			priority: 2000,
			commands: [
				{ name: "workflows.down", run: () => moveSelection(1) },
				{ name: "workflows.up", run: () => moveSelection(-1) },
				{ name: "workflows.nextRun", run: () => switchRun(1) },
				{ name: "workflows.prevRun", run: () => switchRun(-1) },
				{ name: "workflows.quit", run: () => quit() },
				{ name: "workflows.cancel", run: () => cancelSelected() },
				{ name: "workflows.save", run: () => void saveSelected() },
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
				{ key: "q", cmd: "workflows.quit" },
				{ key: "escape", cmd: "workflows.quit" },
				{ key: "x", cmd: "workflows.cancel" },
				{ key: "s", cmd: "workflows.save" },
			],
		});
	});

	onCleanup(() => {
		disposed = true;
		tailer?.stop();
		if (pollTimer !== undefined) {
			clearInterval(pollTimer);
		}
		if (nowTimer !== undefined) {
			clearInterval(nowTimer);
		}
		disposeLayer?.();
	});

	// Scroll-follow: keep the selected row inside the viewport — scroll up to it when it
	// drifts above the fold, down when it falls below. Re-runs on selection, on each
	// applied event (rows grow live), and on resize. Delegated to the scrollbox's built-in
	// `scrollChildIntoView` (real-geometry lookup by row id), not an index→line guess.
	createEffect(() => {
		const sb = scrollRef;
		// Follow the SAME row the highlight + Detail pane track: the live agent until the
		// user scrolls, then their selection. As agents settle and the next one starts,
		// `runningIndex` advances and the viewport auto-scrolls to the new live row.
		const idx = followedIndex();
		version(); // re-follow as rows stream in
		dimensions(); // re-follow when the terminal resizes
		if (sb === undefined) {
			return;
		}
		// Defer to opentui's built-in scroll-follow: it finds the row by id and scrolls
		// the minimal delta to bring it fully into view. Hand-rolling the math is wrong
		// here — a child's `.y` is SCREEN-ABSOLUTE (it recursively sums each ancestor's
		// position + translateY; @opentui/core Renderable `get y()`), NOT a content-
		// relative row offset, so comparing it directly against `scrollTop` over-scrolls
		// by the scrollbox's own screen offset. `scrollChildIntoView` compares `child.y`
		// against `viewport.y` (same space) and drives `scrollBy` with the delta, which
		// is the only correct framing (mirrors opencode's session scrollbox idiom).
		sb.scrollChildIntoView(rowId(idx));
	});

	/** `↑/↓` move the selection through the flat agent list, clamped to its length. */
	function moveSelection(delta: number): void {
		// The first manual move ends auto-follow: from here `followedIndex` tracks the
		// user's `selected`, not the running agent. Seed `selected` from the currently
		// followed row so the move steps off WHERE THE EYE IS (the live agent), not a
		// stale `selected(0)` left from before auto-follow scrolled the view away.
		if (!userHasScrolled()) {
			setUserHasScrolled(true);
			setSelected(followedIndex());
		}
		const max = flatAgents().length - 1;
		setSelected((i) => clamp(i + delta, 0, max));
	}

	/** `q`/`esc` quit the viewer — navigate to the return route (originating screen, or `home`). */
	function quit(): void {
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
	 * `x` asks before cancelling — cancel is destructive and `x` is a bare letter, so it
	 * is guarded by a confirm dialog (the TUI UX rule: never wire a destructive action to
	 * a muscle-memory key). The sentinel is written ONLY on confirm; dismissing the dialog
	 * is a no-op. The dialog names the run by its display identity (name, else runId).
	 */
	function cancelSelected(): void {
		const id = runId();
		if (id === undefined) {
			return;
		}
		const label = view().name ?? id;
		// Pass `onClose` too: an ESC/overlay dismiss routes through the dialog stack's
		// onClose, NOT onCancel, so without it a dismissed dialog would leave the mode on
		// the stack. The sentinel is written ONLY on explicit confirm — both cancel and a
		// bare dismiss are no-ops beyond clearing the dialog.
		props.api.ui.dialog.replace(
			() =>
				props.api.ui.DialogConfirm({
					title: "Cancel run?",
					message: `Cancel "${label}"? This writes the cancel sentinel the engine consumes — the run stops at its next checkpoint.`,
					onConfirm: () => {
						props.api.ui.dialog.clear();
						void writeCancel(id);
					},
					onCancel: () => props.api.ui.dialog.clear(),
				}),
			() => props.api.ui.dialog.clear(),
		);
	}

	/**
	 * Write the cancel sentinel for the open run (the exact 8.2 external touch). A failed
	 * write is surfaced as an error toast and never allowed to become an unhandled
	 * rejection — mirroring the tailer's `onError` fencing.
	 */
	async function writeCancel(id: string): Promise<void> {
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

	/**
	 * `s` saves the open run as a named workflow under the run's own display name.
	 * Non-destructive (it writes a file, never overwrites without the tool's
	 * overwrite flag — the engine refuses a collision), so no confirm dialog. The
	 * control channel is one-way: we toast optimistically here and the engine logs
	 * the actual outcome; the `workflow_save_run` tool is the path with full result
	 * feedback. A failed sentinel write is fenced into an error toast.
	 */
	async function saveSelected(): Promise<void> {
		const id = runId();
		if (id === undefined) {
			return;
		}
		// Derive a filesystem-safe name from the run's display name (which may carry
		// spaces) so the engine's validator accepts it — the one-way channel can't
		// report a rejection back, so we must not hand it a name it will refuse.
		const name = slugifyWorkflowName(view().name ?? id);
		try {
			await writeSaveSentinel({ controlDir: props.controlDir, runId: id, name });
			props.api.ui.toast({
				variant: "info",
				title: "Saving run",
				message: `Saving "${name}" to .opencode/workflows/${name}.js — see logs for the result.`,
			});
		} catch (err) {
			props.api.ui.toast({
				variant: "error",
				title: "Save failed",
				message: `Could not write the save sentinel for ${id}: ${
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
			{/* Header: title + run identity (name, falling back to runId) + status + run
			    i/N + relative age, with a full-width rule below it. The age segment ticks
			    off `nowMs` and only renders once the run has a `startedAt` stamp. The
			    identity is the only unbounded segment, so it is truncated to a width budget
			    (mirroring the tree rows) — a long run name clips instead of word-wrapping the
			    header onto a second row and pushing the panes down. */}
			<box flexDirection="row" flexShrink={0} paddingLeft={1} paddingRight={1}>
				<text flexShrink={0} fg={theme().text}>
					Workflows{" "}
				</text>
				<text flexShrink={0} fg={theme().textMuted}>
					{truncateLine(
						view().name ?? runId() ?? "no active run",
						headerIdentityWidth(),
					)}
				</text>
				<text flexShrink={0} fg={statusColor()}>
					{`  ·  ${statusLabel(view().status)}`}
				</text>
				<Show when={runIds().length > 1}>
					<text flexShrink={0} fg={theme().textMuted}>
						{`  ·  run ${runIndex() + 1}/${runIds().length}`}
					</text>
				</Show>
				<Show when={view().startedAt !== undefined}>
					<text flexShrink={0} fg={theme().textMuted}>
						{`  ·  ${formatRelativeTime(view().startedAt ?? 0, nowMs())}`}
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
					// Let the pane shrink below its rows' min-content width so flexGrow splits
					// the row cleanly with the Detail pane — keeps the scrollbar flush to the
					// right of the agent rows instead of drifting to the screen edge.
					minWidth={0}
					flexDirection="column"
					// Render every row (no background-culling of off-fold rows): the tree is at
					// most a few dozen lines, and culling was dropping in-box rows to black.
					viewportCulling={false}
					paddingLeft={1}
					paddingRight={1}
				>
					<Show
						when={rows().length > 0}
						fallback={
							<TreeFallback
								theme={theme()}
								hasRuns={runIds().length > 0}
								hasRun={runId() !== undefined}
								status={view().status}
							/>
						}
					>
						<For each={rows()}>
							{(row) =>
								row.kind === "phase" ? (
									<text flexShrink={0} fg={theme().text}>
										{truncateLine(phaseHeaderText(row.phase), treeWidth())}
									</text>
								) : (
									<text
										id={rowId(row.index)}
										flexShrink={0}
										fg={
											row.index === followedIndex()
												? theme().primary
												: theme().textMuted
										}
									>
										{truncateLine(
											`${row.index === followedIndex() ? "▸ " : "  "}${agentRowText(row.agent)}`,
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
					minWidth={0}
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
					↑↓ agent · ←→ run · x cancel · s save · q/esc quit
				</text>
			</box>
		</box>
	);
}

/** True for a SETTLED agent whose terminal status is a failure (not completed/cached). */
function isFailure(status: string | undefined): boolean {
	return status !== undefined && status !== "completed" && status !== "cached";
}

/**
 * The Detail pane body for one agent. Every field is LABELLED (`session …`, `note: …`)
 * so it identifies by name, not bare id, and the field ORDER is status-aware:
 *
 * - RUNNING (`status === undefined`): lead with the live signal — the running marker,
 *   live tokens, and the tool activity ring — since that is what a glance wants while
 *   the agent works.
 * - SETTLED: lead with the terminal stats (status, tokens, tool calls, duration) and
 *   surface the note prominently — in {@link theme.error} for a failure, where the note
 *   IS the failure reason — before the long prompt.
 *
 * The whole body is wrapped in a `<scrollbox>` so a long prompt or tool ring stays
 * readable without pushing the labelled stats off-screen; it is display-only (the route
 * keymap owns ↑/↓ for the tree, so this scrollbox takes no focus) and `viewportCulling`
 * is off with `flexShrink={0}` rows, matching the tree pane's clipping discipline.
 */
function AgentDetail(props: {
	agent: AgentView;
	theme: TuiPluginApi["theme"]["current"];
}) {
	const t = props.theme;
	const running = () => props.agent.status === undefined;
	const failed = () => isFailure(props.agent.status);

	const StatusLine = () => (
		<Show when={props.agent.status}>
			{(status) => (
				<text fg={failed() ? t.error : t.textMuted}>
					{`status: ${statusMarker(status())} ${status()}`}
				</text>
			)}
		</Show>
	);
	const Tokens = () => (
		<Show when={props.agent.tokens !== undefined}>
			<text fg={t.textMuted}>
				{`tokens: ${formatTokens(props.agent.tokens ?? 0)}`}
			</text>
		</Show>
	);
	const ToolCalls = () => (
		<Show when={props.agent.toolCalls !== undefined}>
			<text fg={t.textMuted}>{`tool calls: ${props.agent.toolCalls}`}</text>
		</Show>
	);
	const Duration = () => (
		<Show when={props.agent.durationMs !== undefined}>
			<text fg={t.textMuted}>
				{`duration: ${formatDuration(props.agent.durationMs ?? 0)}`}
			</text>
		</Show>
	);
	const Note = () => (
		<Show when={props.agent.note}>
			{(note) => (
				<box flexShrink={0} flexDirection="column" paddingTop={1}>
					<text fg={failed() ? t.error : t.textMuted}>{`note: ${note()}`}</text>
				</box>
			)}
		</Show>
	);
	const Tools = () => (
		<Show when={props.agent.lastTools && props.agent.lastTools.length > 0}>
			<box flexShrink={0} flexDirection="column" paddingTop={1}>
				<text fg={t.border}>── tools</text>
				<For each={props.agent.lastTools ?? []}>
					{(tool) => <text flexShrink={0} fg={t.textMuted}>{`· ${tool}`}</text>}
				</For>
			</box>
		</Show>
	);
	const Prompt = () => (
		<Show when={props.agent.prompt}>
			{(prompt) => (
				<box flexShrink={0} flexDirection="column" paddingTop={1}>
					<text fg={t.border}>── prompt</text>
					<text fg={t.textMuted}>{prompt()}</text>
				</box>
			)}
		</Show>
	);

	return (
		<scrollbox flexGrow={1} minWidth={0} minHeight={0} viewportCulling={false}>
			<box flexShrink={0} flexDirection="column">
				<text flexShrink={0} fg={t.text}>
					{props.agent.label}
				</text>
				<Show when={props.agent.model}>
					{(model) => (
						<text flexShrink={0} fg={t.textMuted}>
							{`model: ${shortModel(model())}`}
						</text>
					)}
				</Show>
				<Show when={props.agent.sessionID}>
					{(id) => (
						<text flexShrink={0} fg={t.textMuted}>
							{`session: ${id()}`}
						</text>
					)}
				</Show>
				{/* Status-aware ordering: a running agent leads with its live signal; a
				    settled one leads with terminal stats + the (error-prominent) note. */}
				<Show
					when={running()}
					fallback={
						<>
							<StatusLine />
							<Tokens />
							<ToolCalls />
							<Duration />
							<Note />
							<Tools />
							<Prompt />
						</>
					}
				>
					<text
						fg={t.primary}
					>{`status: ${statusMarker(undefined)} running`}</text>
					<Tokens />
					<Tools />
					<ToolCalls />
					<Prompt />
				</Show>
			</box>
		</scrollbox>
	);
}

/**
 * The tree-pane fallback when no agent rows render yet — three DISTINCT states, never a
 * single generic "waiting…": no runs in the feed dir at all, a run selected but its first
 * event not yet tailed, and a run that ended in error. Non-contradictory with the header
 * (which carries the run identity + status separately).
 */
function TreeFallback(props: {
	theme: TuiPluginApi["theme"]["current"];
	hasRuns: boolean;
	hasRun: boolean;
	status: RunViewState["status"];
}) {
	const t = props.theme;
	return (
		<Switch
			fallback={<text fg={t.textMuted}>(waiting for the first event…)</text>}
		>
			<Match when={!props.hasRuns}>
				<text fg={t.textMuted}>
					No workflow runs yet — launch one with the workflow tool.
				</text>
			</Match>
			<Match when={props.status === "error"}>
				<text fg={t.error}>Run failed before reporting any agents.</text>
			</Match>
			<Match when={!props.hasRun}>
				<text fg={t.textMuted}>(no run selected)</text>
			</Match>
		</Switch>
	);
}

/** Clamp `value` into `[min, max]` (max may be negative when the list is empty). */
function clamp(value: number, min: number, max: number): number {
	if (max < min) {
		return min;
	}
	return Math.min(Math.max(value, min), max);
}
