/** @jsxImportSource @opentui/solid */
/**
 * The full-screen `workflows` route view (Task 8.3.3) — Phases | Agents | Detail.
 *
 * This is the ONLY JSX in the `./tui` surface, kept deliberately thin: layout plus
 * signal wiring. Every derivation — phase markers, agent rows, token/duration
 * formatting — comes from the pure 8.3.1 reducer/format modules; this file owns NO
 * reduction logic. One {@link createRunStateReducer} per open feed file is fed by ONE
 * {@link createFeedTailer} (8.3.2) started on mount and `stop()`ed on cleanup, so the
 * panes update live as the engine appends and replay a settled file after a restart.
 *
 * Keys (registered as a keymap layer while the route is mounted, the portable
 * equivalent of opencode's internal `useBindings`): `j/k` move selection within the
 * focused pane; `enter` drills Phases→Agents→Detail (advancing focus); `esc` backs
 * out one pane, then closes the route to the return route; `x` writes the cancel
 * sentinel for the selected run (the exact 8.2 external touch). Layout is a
 * `position:absolute` full-screen box mirroring `diff-viewer.tsx`.
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
import { writeCancelSentinel } from "./index";
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

/** Which pane currently owns `j/k/enter`. `esc` walks back left, then closes. */
type Focus = "phases" | "agents" | "detail";

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

/**
 * The route component, default-exported so `index.ts` can `lazy(() => import())` it:
 * the JSX module then loads ONLY when the route first renders (inside the host, with
 * opencode's solid transform active), keeping `index.ts` a JSX-free `.ts` and out of
 * the smoke test's module graph (the test never mounts the view).
 */
export default function WorkflowsRoute(props: WorkflowsRouteProps) {
	const dimensions = useTerminalDimensions();
	const theme = () => props.api.theme.current;

	// ONE reducer per open feed file, fed by ONE tailer (started on mount). The
	// signal is bumped on every applied event so the memos below recompute.
	const reducer = createRunStateReducer();
	const [version, setVersion] = createSignal(0);
	const view = createMemo<RunViewState>(() => {
		version();
		return reducer.state();
	});

	const [runId, setRunId] = createSignal<string | undefined>();
	const [focus, setFocus] = createSignal<Focus>("phases");
	const [phaseIndex, setPhaseIndex] = createSignal(0);
	const [agentIndex, setAgentIndex] = createSignal(0);

	const phases = createMemo<PhaseView[]>(() => view().phases);
	const selectedPhase = createMemo<PhaseView | undefined>(
		() => phases()[phaseIndex()],
	);
	const agents = createMemo<AgentView[]>(() => selectedPhase()?.agents ?? []);
	const selectedAgent = createMemo<AgentView | undefined>(
		() => agents()[agentIndex()],
	);

	let tailer: ReturnType<typeof createFeedTailer> | undefined;
	let disposeLayer: (() => void) | undefined;
	// Set in onCleanup. The mount IIFE awaits an async dir scan before it can assign
	// and start the tailer; if the route unmounts inside that window, onCleanup runs
	// with `tailer` still undefined (a no-op) and the IIFE would otherwise resume and
	// arm a watcher nobody stops. The flag lets the IIFE bail/stop after the await.
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
			// The route may have unmounted during start()'s initial read — if so,
			// onCleanup already ran (when `tailer` was undefined) and will never call
			// stop(), so stop the freshly-armed tailer here.
			if (disposed) {
				tailer.stop();
			}
		})();

		disposeLayer = props.api.keymap.registerLayer({
			priority: 2000,
			commands: [
				{
					name: "workflows.down",
					run() {
						moveSelection(1);
					},
				},
				{
					name: "workflows.up",
					run() {
						moveSelection(-1);
					},
				},
				{
					name: "workflows.enter",
					run() {
						drillIn();
					},
				},
				{
					name: "workflows.back",
					run() {
						back();
					},
				},
				{
					name: "workflows.cancel",
					run() {
						void cancelSelected();
					},
				},
			],
			bindings: [
				{ key: "j,down", cmd: "workflows.down" },
				{ key: "k,up", cmd: "workflows.up" },
				{ key: "enter", cmd: "workflows.enter" },
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

	/** `j/k` move selection within the focused pane, clamped to its length. */
	function moveSelection(delta: number): void {
		if (focus() === "phases") {
			const max = phases().length - 1;
			setPhaseIndex((i) => clamp(i + delta, 0, max));
			setAgentIndex(0);
			return;
		}
		if (focus() === "agents") {
			const max = agents().length - 1;
			setAgentIndex((i) => clamp(i + delta, 0, max));
		}
	}

	/** `enter` advances focus Phases→Agents→Detail (no-op past Detail). */
	function drillIn(): void {
		if (focus() === "phases" && agents().length > 0) {
			setFocus("agents");
			setAgentIndex(0);
			return;
		}
		if (focus() === "agents" && selectedAgent() !== undefined) {
			setFocus("detail");
		}
	}

	/** `esc` backs out one pane; from Phases it closes the route to the return route. */
	function back(): void {
		const current = focus();
		if (current === "detail") {
			setFocus("agents");
			return;
		}
		if (current === "agents") {
			setFocus("phases");
			return;
		}
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
	 * `x` writes the cancel sentinel for the open run (the exact 8.2 external touch).
	 * A failed sentinel write (read-only mount, permission denial, disk full) is
	 * surfaced as an error toast and never allowed to become an unhandled rejection —
	 * the user must know the cancel did not land, mirroring the tailer's `onError`
	 * fencing and the engine's "an fs failure must never break a run" stance.
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
			<box flexDirection="row" flexShrink={0} paddingLeft={1}>
				<text fg={theme().text}>Workflows </text>
				<text fg={theme().textMuted}>
					{runId() ?? "no active run"}
					{view().status !== "running" ? ` · ${view().status}` : ""}
				</text>
			</box>

			<box flexGrow={1} flexDirection="row" minHeight={0}>
				{/* Phases pane */}
				<box flexDirection="column" width={28} paddingLeft={1} paddingRight={1}>
					<text fg={focus() === "phases" ? theme().primary : theme().textMuted}>
						Phases
					</text>
					<Show
						when={phases().length > 0}
						fallback={<text fg={theme().textMuted}>(none yet)</text>}
					>
						<For each={phases()}>
							{(phase, index) => (
								<text
									fg={
										index() === phaseIndex() ? theme().text : theme().textMuted
									}
								>
									{phase.marker} {phase.name} {phase.done}/{phase.total}
								</text>
							)}
						</For>
					</Show>
				</box>

				{/* Agents pane */}
				<box flexGrow={1} flexDirection="column" paddingRight={1}>
					<text fg={focus() === "agents" ? theme().primary : theme().textMuted}>
						Agents
					</text>
					<Show
						when={agents().length > 0}
						fallback={<text fg={theme().textMuted}>(none)</text>}
					>
						<For each={agents()}>
							{(agent, index) => (
								<text
									fg={
										focus() === "agents" && index() === agentIndex()
											? theme().text
											: theme().textMuted
									}
								>
									{agentRowText(agent)}
								</text>
							)}
						</For>
					</Show>
				</box>

				{/* Detail pane */}
				<box flexDirection="column" width={40} paddingLeft={1}>
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

			<box flexShrink={0} paddingLeft={1}>
				<text fg={theme().textMuted}>
					j/k move · enter drill · esc back · x cancel
				</text>
			</box>
		</box>
	);
}

/** The Detail pane body for one agent — tools, note, token breakdown, sessionID. */
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
			<Show when={props.agent.tokens !== undefined}>
				<text fg={t.textMuted}>
					{formatTokens(props.agent.tokens ?? 0)} tok
				</text>
			</Show>
			<Show when={props.agent.toolCalls !== undefined}>
				<text fg={t.textMuted}>{props.agent.toolCalls} tool calls</text>
			</Show>
			<Show when={props.agent.durationMs !== undefined}>
				<text fg={t.textMuted}>
					{formatDuration(props.agent.durationMs ?? 0)}
				</text>
			</Show>
			<Show when={props.agent.lastTools && props.agent.lastTools.length > 0}>
				<For each={props.agent.lastTools ?? []}>
					{(tool) => <text fg={t.textMuted}>· {tool}</text>}
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

/** Clamp `value` into `[min, max]` (max may be negative when a pane is empty). */
function clamp(value: number, min: number, max: number): number {
	if (max < min) {
		return min;
	}
	return Math.min(Math.max(value, min), max);
}
