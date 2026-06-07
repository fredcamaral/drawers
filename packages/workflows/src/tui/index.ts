/**
 * The `./tui` surface entry (Task 8.3.3) — the native workflows viewer.
 *
 * opencode loads a TUI plugin from `pkg.json.exports["./tui"]` and `import()`s it
 * in the UNSANDBOXED TUI process (full Bun fs access). This module is the entry:
 * it registers a full-screen `workflows` route (Phases | Agents | Detail) and a
 * `palette`-namespace `workflows.open` command, both driven by the pure 8.3.1
 * reducer fed by the 8.3.2 tailer — the JSX (`route.tsx`) stays thin (layout +
 * signal wiring), every derivation comes from the pure modules.
 *
 * Data resolution: the viewer READS the same `<dataDir>/workflow-feed` the engine
 * WRITES, and the same `<dataDir>/workflow-control` the engine POLLS for cancel
 * sentinels — both off the ONE canonical base from `resolveDataBaseDir` (core), so
 * there is a single resolution algorithm across both plugin surfaces and no
 * protocol between them (Phase 8 binding decision: the feed file is the bus).
 *
 * Pinned-version note (Phase 8 TUI surface risk): this surface is built and tested
 * against opencode `1.16.2` (`@opencode-ai/plugin@1.16.2`) with opentui
 * `@opentui/core`/`@opentui/keymap`/`@opentui/solid` ALL pinned to EXACTLY `0.3.2`
 * (the versions the pinned opencode ships, read from its lockfile catalog). The
 * published `PluginModule.tui?: never` type pins `tui` OUT on the SERVER module,
 * but the runtime accepts it; the TUI-specific `TuiPluginModule` from
 * `@opencode-ai/plugin/tui` is the correct type and sidesteps the lag — which is
 * why the default export is typed `satisfies TuiPluginModule`, NOT the server
 * `PluginModule`. Treat breakage on host/opentui bumps as expected maintenance.
 */

import {
	mkdir as nodeMkdir,
	writeFile as nodeWriteFile,
} from "node:fs/promises";
import { join } from "node:path";
import { resolveDataBaseDir } from "@drawers/core";
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { createComponent, lazy } from "solid-js";

// The JSX route is loaded LAZILY: `import("./route")` only fires when the route first
// renders (inside the host, where opencode's `@opentui/solid` transform is active), so
// this `.ts` entry never pulls the untransformable `.tsx` into its static module graph
// (the smoke test imports this module without an opentui runtime).
const WorkflowsRoute = lazy(() => import("./route"));

/** Plugin id — shared with the server module so both surfaces read as one drawer. */
export const TUI_PLUGIN_ID = "opencode-drawer-workflows";

/** The route name the open command navigates to and the route registers under. */
export const ROUTE_WORKFLOWS = "workflows";

/** Feed dir leaf — MUST match the engine's `SUBDIR_FEED` (the viewer reads it). */
export const SUBDIR_FEED = "workflow-feed";

/** Control dir leaf — MUST match the engine's `SUBDIR_CONTROL` (sentinels land here). */
export const SUBDIR_CONTROL = "workflow-control";

/** Cancel-sentinel suffix — MUST match the engine watcher's `SENTINEL_SUFFIX`. */
export const SENTINEL_SUFFIX = ".cancel";

/** The minimal fs surface {@link writeCancelSentinel} writes through. Injectable. */
export interface CancelFs {
	mkdir(path: string, opts: { recursive: true }): Promise<unknown>;
	writeFile(path: string, data: string): Promise<void>;
}

const defaultCancelFs: CancelFs = {
	mkdir: (path, opts) => nodeMkdir(path, opts),
	writeFile: (path, data) => nodeWriteFile(path, data),
};

/**
 * Write the cancel sentinel for `runId` — the EXACT external touch Task 8.2.3 proved
 * end-to-end: `mkdir(<controlDir>)` then an empty `<controlDir>/<runId>.cancel`. The
 * engine's poll loop consumes it and the feed's `run:cancel-requested` line flips the
 * view to `cancelling`. The fs is injected so the route's `x` binding and the smoke
 * test exercise the same code path without a real disk.
 */
export async function writeCancelSentinel(opts: {
	controlDir: string;
	runId: string;
	fs?: CancelFs;
}): Promise<void> {
	const fs = opts.fs ?? defaultCancelFs;
	await fs.mkdir(opts.controlDir, { recursive: true });
	await fs.writeFile(
		join(opts.controlDir, `${opts.runId}${SENTINEL_SUFFIX}`),
		"",
	);
}

const tui: TuiPlugin = async (api) => {
	// One resolution shared with the engine (the viewer reads, the engine writes).
	const baseDir = resolveDataBaseDir();
	const feedDir = join(baseDir, SUBDIR_FEED);
	const controlDir = join(baseDir, SUBDIR_CONTROL);

	api.route.register([
		{
			name: ROUTE_WORKFLOWS,
			// `index.ts` carries NO JSX (it is a `.ts` under the base tsconfig with no
			// `jsx`); the lazily-loaded `route.tsx` owns the `@opentui/solid` pragma and
			// the layout tree. `createComponent` instantiates it without JSX syntax.
			render: (input) =>
				createComponent(WorkflowsRoute, {
					api,
					feedDir,
					controlDir,
					params: input.params,
				}),
		},
	]);

	api.keymap.registerLayer({
		commands: [
			{
				name: "workflows.open",
				title: "Open workflows viewer",
				slashName: ROUTE_WORKFLOWS,
				category: "Workflows",
				namespace: "palette",
				run() {
					// Navigate with a known `runId` when the caller supplied one (the
					// sidebar, Task 8.3.4); otherwise the route defaults to the most-
					// recently-modified feed file. `keybind`: open via the command palette
					// (`/workflows`); the route then owns `j/k/enter/esc/x` while focused.
					const current = api.route.current;
					const params =
						"params" in current
							? (current.params as Record<string, unknown> | undefined)
							: undefined;
					api.route.navigate(ROUTE_WORKFLOWS, { runId: params?.runId });
					api.ui.dialog.clear();
				},
			},
		],
	});
};

export default {
	id: TUI_PLUGIN_ID,
	tui,
} satisfies TuiPluginModule;
