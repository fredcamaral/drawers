/** @jsxImportSource @opentui/solid */
/**
 * The `sidebar_content` slot view (Task 8.3.4) — a passive one-line summary per
 * ACTIVE run, with a jump into the full-screen `workflows` route.
 *
 * The host renders this slot inside the session sidebar (keyed by `session_id`).
 * Active runs are discoverable from the feed dir ALONE (Phase 8 binding decision:
 * the feed file is the bus, the viewer holds no protocol with the server plugin):
 * each `<runId>.jsonl` is folded through a fresh 8.3.1 reducer and {@link summarize}d,
 * and a run is "active" while its top-level status is `running`/`cancelling` (no
 * terminal `run:end` seen). `<Show when={active().length > 0}>` collapses the slot to
 * nothing when no run is live (the `todo.tsx` idiom).
 *
 * This is a GLANCE, not a live ticker: the dir is rescanned on a coarse interval
 * (`POLL_MS`, default 1s), reading each whole feed file once per tick. The heavy
 * live updating — byte-offset tailing of ONE file — belongs to the route's tailer
 * (8.3.2), not here. Selecting a run navigates `api.route.navigate("workflows",
 * { runId })`, handing the chosen run to the route.
 *
 * Every derivation (active filter, agent counts, elapsed) comes from the pure
 * reducer/format modules; this file owns only the dir scan, the poll, and layout.
 */

import { readdir, readFile } from "node:fs/promises";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import {
	createResource,
	createSignal,
	For,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import { formatDuration } from "./format";
import type { RunSummary } from "./reducer";
import { activeRuns, type SidebarFs } from "./sidebar-data";

/** Coarse rescan cadence — the sidebar is a glance, not a live ticker. */
const POLL_MS = 1000;

/** The real readdir/readFile seam handed to the pure sidebar data layer. */
const sidebarFs: SidebarFs = {
	readdir,
	readFile: (path) => readFile(path, "utf-8"),
};

/** Shorten a run id for the one-line glance (the tail is the entropy CC shows). */
function shortRunId(runId: string | undefined): string {
	if (runId === undefined) {
		return "?";
	}
	return runId.length > 12 ? runId.slice(-12) : runId;
}

/** The marker glyph for an active run: `…` running, `⊘` mid-cancel. */
function summaryMarker(status: RunSummary["status"]): string {
	return status === "cancelling" ? "⊘" : "…";
}

export interface SidebarRunsProps {
	api: TuiPluginApi;
	/** `<dataDir>/workflow-feed` — the dir of `<runId>.jsonl` feed files. */
	feedDir: string;
}

/**
 * The slot body: a polled list of active runs, invisible when none are live. Each
 * line is `<marker> <short-runId>  <done>/<total> agents · <elapsed>` (CC's
 * `done/total` parity — the leading number is how many agents finished); selecting
 * one navigates into the `workflows` route with that `runId`.
 */
export default function SidebarRuns(props: SidebarRunsProps) {
	const theme = () => props.api.theme.current;

	// A coarse poll tick re-keys the resource so the dir is rescanned each interval;
	// the heavy byte-offset tailing of ONE file is the route's job, not the sidebar's.
	const [tick, setTick] = createSignal(0);
	let timer: ReturnType<typeof setInterval> | undefined;
	onMount(() => {
		timer = setInterval(() => setTick((t) => t + 1), POLL_MS);
		// Never hold the process open on the sidebar's glance timer alone.
		(timer as { unref?: () => void }).unref?.();
	});
	onCleanup(() => {
		if (timer !== undefined) {
			clearInterval(timer);
		}
	});

	const [runs] = createResource(
		tick,
		() => activeRuns(props.feedDir, sidebarFs, Date.now()),
		{ initialValue: [] },
	);
	const active = () => runs() ?? [];

	const open = (runId: string | undefined): void => {
		if (runId === undefined) {
			return;
		}
		// Thread the originating route as `returnRoute` so the route's `esc` restores
		// the session the user opened the viewer from (mirrors the open command).
		props.api.route.navigate("workflows", {
			runId,
			returnRoute: props.api.route.current,
		});
	};

	return (
		<Show when={active().length > 0}>
			<box flexDirection="column">
				<text fg={theme().text}>
					<b>Workflows</b>
				</text>
				<For each={active()}>
					{(run) => (
						// biome-ignore lint/a11y/noStaticElementInteractions: `text` is an opentui terminal-renderer element, not a DOM node — there is no accessibility tree, so the HTML-oriented a11y rule is a false positive (mirrors opencode's own `todo.tsx`/`diff-viewer.tsx` mouse handlers on these elements).
						<text fg={theme().textMuted} onMouseDown={() => open(run.runId)}>
							{summaryMarker(run.status)} {shortRunId(run.runId)}{" "}
							{run.doneAgents}/{run.totalAgents} agents ·{" "}
							{formatDuration(run.elapsedMs)}
						</text>
					)}
				</For>
			</box>
		</Show>
	);
}
