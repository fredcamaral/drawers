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
 * selection through agent rows across all phases; `←/→` (or `h/l`, and `enter` as a
 * right-alias) move focus between the tree and the Detail pane; `esc` closes the route
 * to the return route; `x` writes the cancel sentinel for the open run (the 8.2
 * external touch). Single-key specs only — `@opentui/keymap` does NOT comma-split a
 * binding `key`, so each alternate is its own entry.
 *
 * ⚠️ Every solid/opentui import here is fine because this is a `.tsx` (the host
 * transform rewrites them to the host's runtime instance). NEVER move this logic into
 * a `.ts` — see `index.tsx`'s header (the dual-instance crash).
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TuiPluginApi, TuiRouteCurrent } from "@opencode-ai/plugin/tui";
import { useTerminalDimensions } from "@opentui/solid";
import {
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
} from "./format";
import { writeCancelSentinel } from "./paths";
import {
	type AgentView,
	createRunStateReducer,
	type PhaseView,
	type RunViewState,
} from "./reducer";
import { type RunsFs, resolveRunId } from "./runs";
import { createFeedTailer } from "./tailer";

/** The real readdir/stat seam the route hands {@link resolveRunId}. */
const runsFs: RunsFs = { readdir, stat };

const FEED_SUFFIX = ".jsonl";

/** Which pane currently owns navigation. `esc` from `tree` closes the route. */
type Focus = "tree" | "detail";

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

/** The phase header row text (marker + name + done/total). */
function phaseHeaderText(phase: PhaseView): string {
	return `${phase.marker} ${phase.name}  ${phase.done}/${phase.total}`;
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

	// ONE reducer per open feed file, fed by ONE tailer (started on mount). The signal
	// is bumped on every applied event so the memos below recompute.
	const reducer = createRunStateReducer();
	const [version, setVersion] = createSignal(0);
	const view = createMemo<RunViewState>(() => {
		version();
		return reducer.state();
	});

	const [runId, setRunId] = createSignal<string | undefined>();
	const [focus, setFocus] = createSignal<Focus>("tree");
	// Selection is a flat index across ALL agents of ALL phases (the tree is one list).
	const [selected, setSelected] = createSignal(0);

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

	let tailer: ReturnType<typeof createFeedTailer> | undefined;
	let disposeLayer: (() => void) | undefined;
	// Set in onCleanup. The mount IIFE awaits an async dir scan before it can assign and
	// start the tailer; if the route unmounts inside that window, onCleanup runs with
	// `tailer` still undefined (a no-op) and the IIFE would otherwise arm a watcher
	// nobody stops. The flag lets the IIFE bail/stop after the await.
	let disposed = false;

	onMount(() => {
		void (async () => {
			const id = await resolveRunId(
				props.feedDir,
				props.params?.runId,
				runsFs,
				join,
			);
			if (id === undefined || disposed) {
				return;
			}
			setRunId(id);
			tailer = createFeedTailer({
				path: join(props.feedDir, `${id}${FEED_SUFFIX}`),
				onEvent(event) {
					reducer.apply(event);
					setVersion((v) => v + 1);
				},
			});
			await tailer.start();
			if (disposed) {
				tailer.stop();
			}
		})();

		disposeLayer = props.api.keymap.registerLayer({
			priority: 2000,
			commands: [
				{ name: "workflows.down", run: () => moveSelection(1) },
				{ name: "workflows.up", run: () => moveSelection(-1) },
				{ name: "workflows.focusDetail", run: () => setFocus("detail") },
				{ name: "workflows.focusTree", run: () => setFocus("tree") },
				{ name: "workflows.back", run: () => back() },
				{ name: "workflows.cancel", run: () => void cancelSelected() },
			],
			// One entry PER key — `@opentui/keymap` does not comma-split a binding key.
			bindings: [
				{ key: "down", cmd: "workflows.down" },
				{ key: "j", cmd: "workflows.down" },
				{ key: "up", cmd: "workflows.up" },
				{ key: "k", cmd: "workflows.up" },
				{ key: "right", cmd: "workflows.focusDetail" },
				{ key: "l", cmd: "workflows.focusDetail" },
				{ key: "enter", cmd: "workflows.focusDetail" },
				{ key: "left", cmd: "workflows.focusTree" },
				{ key: "h", cmd: "workflows.focusTree" },
				{ key: "escape", cmd: "workflows.back" },
				{ key: "x", cmd: "workflows.cancel" },
			],
		});
	});

	onCleanup(() => {
		disposed = true;
		tailer?.stop();
		disposeLayer?.();
	});

	/** `↑/↓` move the selection through the flat agent list, clamped to its length. */
	function moveSelection(delta: number): void {
		const max = flatAgents().length - 1;
		setSelected((i) => clamp(i + delta, 0, max));
		// Moving the selection implies focusing the tree (where the selection lives).
		setFocus("tree");
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
			</box>
			<box flexShrink={0} paddingLeft={1} paddingRight={1}>
				<text fg={theme().border}>
					{"─".repeat(Math.max(0, dimensions().width - 2))}
				</text>
			</box>

			<box flexGrow={1} flexDirection="row" minHeight={0}>
				{/* Tree pane: all phases + their agents, rendered top-to-bottom. */}
				<box
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
									<text fg={theme().text}>{phaseHeaderText(row.phase)}</text>
								) : (
									<text
										fg={
											row.index === selected()
												? focus() === "tree"
													? theme().primary
													: theme().text
												: theme().textMuted
										}
									>
										{`${row.index === selected() ? "▸ " : "  "}${agentRowText(row.agent)}`}
									</text>
								)
							}
						</For>
					</Show>
				</box>

				{/* Detail pane: the selected agent, with a left border as the divider. */}
				<box
					flexGrow={2}
					flexDirection="column"
					paddingLeft={2}
					paddingRight={1}
					border={["left"]}
					borderColor={theme().border}
				>
					<text fg={focus() === "detail" ? theme().primary : theme().textMuted}>
						Detail
					</text>
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
					↑↓ move · ←→ pane · x cancel · esc back
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
