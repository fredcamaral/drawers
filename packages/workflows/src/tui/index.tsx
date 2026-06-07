/** @jsxImportSource @opentui/solid */
/**
 * The `./tui` surface entry (Task 8.3.3) — the native workflows viewer.
 *
 * opencode loads a TUI plugin from `pkg.json.exports["./tui"]` and `import()`s it in
 * the UNSANDBOXED TUI process (full Bun fs access). This module registers a full-
 * screen `workflows` route (Phases | Agents | Detail) and a `palette`-namespace
 * `workflows.open` command, both driven by the pure 8.3.1 reducer fed by the 8.3.2
 * tailer — the JSX in `route.tsx`/`sidebar.tsx` stays thin (layout + signal wiring),
 * every derivation comes from the pure modules.
 *
 * ⚠️ This entry is a `.tsx`, NOT a `.ts`, and that is LOAD-BEARING. The host runs the
 * Solid transform on every loaded `.tsx`/`.jsx` (filter `/\.(js|ts)x$/`) and rewrites
 * its `solid-js`/`@opentui/*` imports to the HOST's already-loaded runtime instance
 * (via opentui's runtime-plugin support). A `.ts` entry is NOT transformed, so any
 * `solid-js`/`@opentui` value import in it would resolve to THIS package's nested copy
 * — a SECOND solid/opentui instance. Mounting host JSX built from a second instance
 * makes the host renderer's `node instanceof TextRenderable` check fail and throw
 * `Orphan text error: "" must have a <text> as a parent` at navigate time (this is
 * exactly what crashed the viewer when the registration lived in a `.ts` entry that
 * called `createComponent`/`lazy` from the nested `solid-js`). The fix mirrors the
 * canonical external-plugin shape (opencode's own `cwd-status.tsx`): register with
 * inline JSX render callbacks (`<WorkflowsRoute … />`) so the host transform owns
 * component creation — no `createComponent`/`lazy` from a nested instance. Pure,
 * instance-free helpers (path consts, the cancel-sentinel writer) live in the JSX-free
 * `./paths.ts` so plain `bun test` can import them without an opentui runtime.
 *
 * Pinned-version note: targets opencode `1.16.2` (`@opencode-ai/plugin@1.16.2`) which
 * bundles opentui `0.3.2`; this package pins `@opentui/*` to `0.3.2` to match for
 * typecheck. The published `PluginModule.tui?: never` type pins `tui` OUT on the
 * SERVER module, but the runtime accepts it — `TuiPluginModule` from
 * `@opencode-ai/plugin/tui` is the correct type and sidesteps the lag, which is why
 * the default export is `satisfies TuiPluginModule`.
 */

import { join } from "node:path";
import { resolveDataBaseDir } from "@drawers/core";
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import {
	ROUTE_WORKFLOWS,
	SIDEBAR_SLOT_ORDER,
	SUBDIR_CONTROL,
	SUBDIR_FEED,
	TUI_PLUGIN_ID,
} from "./paths";
import WorkflowsRoute from "./route";
import SidebarRuns from "./sidebar";

// Re-export the pure surface so existing importers (`./index`) keep resolving; the
// canonical home is `./paths` (JSX-free, `bun test`-safe).
export {
	type CancelFs,
	ROUTE_WORKFLOWS,
	SENTINEL_SUFFIX,
	SIDEBAR_SLOT_ORDER,
	SUBDIR_CONTROL,
	SUBDIR_FEED,
	TUI_PLUGIN_ID,
	writeCancelSentinel,
} from "./paths";

const tui: TuiPlugin = async (api) => {
	// One resolution shared with the engine (the viewer reads, the engine writes).
	const baseDir = resolveDataBaseDir();
	const feedDir = join(baseDir, SUBDIR_FEED);
	const controlDir = join(baseDir, SUBDIR_CONTROL);

	api.route.register([
		{
			name: ROUTE_WORKFLOWS,
			// Inline JSX so the HOST transform creates the component in the host's solid
			// instance (NOT `createComponent` from a nested copy — that is the dual-
			// instance crash this file's header documents). The render fires on navigate.
			render: (input) => (
				<WorkflowsRoute
					api={api}
					feedDir={feedDir}
					controlDir={controlDir}
					params={input.params}
				/>
			),
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
					// recently-modified feed file. Capture the originating route as
					// `returnRoute` so the route's `esc` restores the caller's screen
					// instead of always dumping to `home` (mirrors the diff-viewer open).
					const current = api.route.current;
					const params =
						"params" in current
							? (current.params as Record<string, unknown> | undefined)
							: undefined;
					api.route.navigate(ROUTE_WORKFLOWS, {
						runId: params?.runId,
						returnRoute: current,
					});
					api.ui.dialog.clear();
				},
			},
		],
	});

	// The `sidebar_content` slot (Task 8.3.4): a passive one-line glance per ACTIVE
	// run, discovered from the feed dir alone (the feed is the bus). Collapses to
	// nothing when no run is live and navigates into the route on selection. Inline
	// JSX for the same host-instance reason as the route above.
	api.slots.register({
		order: SIDEBAR_SLOT_ORDER,
		slots: {
			sidebar_content(_ctx, _props) {
				return <SidebarRuns api={api} feedDir={feedDir} />;
			},
		},
	});
};

export default {
	id: TUI_PLUGIN_ID,
	tui,
} satisfies TuiPluginModule;
