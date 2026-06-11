/** @jsxImportSource @opentui/solid */
/**
 * The `./tui` surface — a compact status line rendered under the session prompt.
 *
 * It registers a `session_prompt` slot that wraps the host's `<Prompt>` and appends
 * one muted line: `<dir> | wt <worktree> | branch <branch> | status <type> | oc <ver>`.
 * Everything is read live from `api.state`; the slot holds no state of its own.
 *
 * ⚠️ This entry is a `.tsx`, NOT a `.ts`, and that is LOAD-BEARING. The host runs the
 * Solid transform on every loaded `.tsx`/`.jsx` (filter `/\.(js|ts)x$/`) and rewrites
 * its `solid-js`/`@opentui/*` imports to the HOST's already-loaded runtime instance.
 * A `.ts` entry is NOT transformed, so any `solid-js`/`@opentui` value import in it
 * would resolve to this package's nested copy — a SECOND solid/opentui instance — and
 * mounting host JSX built from a second instance throws `Orphan text error` at render
 * time. The fix mirrors OpenCode's own `cwd-status.tsx`: register with inline JSX
 * render callbacks so the host transform owns component creation.
 *
 * Pinned-version note: targets OpenCode `1.16.2` (`@opencode-ai/plugin@1.16.2`), which
 * bundles opentui `0.3.2`; this package pins `@opentui/solid` to `0.3.2` to match for
 * typecheck. The published `PluginModule.tui?: never` type pins `tui` OUT on the SERVER
 * module, but the runtime accepts it — `TuiPluginModule` from `@opencode-ai/plugin/tui`
 * is the correct type, which is why the default export is `satisfies TuiPluginModule`.
 */

import type { TuiPluginModule } from "@opencode-ai/plugin/tui";
import type { JSX } from "@opentui/solid";

/** Plugin id — shared with the server anchor so both surfaces read as one drawer. */
const TUI_PLUGIN_ID = "opencode-drawer-statusline";

/** Host slot order. The prompt slot is a single registration; order is cosmetic here. */
const STATUS_SLOT_ORDER = 75;

function basename(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, "");
	const parts = trimmed.split(/[\\/]+/);

	return parts.at(-1) || path;
}

function compactStatus(
	api: Parameters<TuiPluginModule["tui"]>[0],
	sessionID?: string,
): string {
	const directory = api.state.path.directory;
	const worktree = api.state.path.worktree;
	const segments = [basename(directory) || directory];
	const worktreeName = basename(worktree);

	if (worktreeName && worktreeName !== segments[0]) {
		segments.push(`wt ${worktreeName}`);
	}

	const branch = api.state.vcs?.branch;
	if (branch) {
		segments.push(`branch ${branch}`);
	}

	const status = sessionID
		? api.state.session.status(sessionID)?.type
		: undefined;
	if (status) {
		segments.push(`status ${status}`);
	}

	segments.push(`oc ${api.app.version}`);

	return segments.join(" | ");
}

const module: TuiPluginModule = {
	id: TUI_PLUGIN_ID,
	tui: async (api) => {
		const StatusLine = (props: {
			sessionID?: string;
			justifyContent?: "center" | "flex-end";
		}): JSX.Element => (
			<box
				width="100%"
				height={1}
				flexDirection="row"
				justifyContent={props.justifyContent ?? "flex-end"}
			>
				<text fg={api.theme.current.textMuted} wrapMode="none" truncate>
					{compactStatus(api, props.sessionID)}
				</text>
			</box>
		);

		api.slots.register({
			order: STATUS_SLOT_ORDER,
			slots: {
				// Inline JSX so the HOST transform creates the component in the host's
				// solid instance (NOT a nested copy — the dual-instance crash the header
				// documents). The render fires on every prompt re-render.
				session_prompt: (_ctx, props) => (
					<box width="100%" flexDirection="column">
						<api.ui.Prompt
							sessionID={props.session_id}
							visible={props.visible}
							disabled={props.disabled}
							onSubmit={props.on_submit}
							ref={props.ref}
						/>
						<StatusLine sessionID={props.session_id} />
					</box>
				),
			},
		});
	},
};

export default module;
