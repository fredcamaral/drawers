/**
 * Pure path/layout vocabulary + the cancel-sentinel writer for the `./tui` surface.
 *
 * This module is deliberately JSX-free and imports NO `solid-js`/`@opentui/*`, so it
 * is safe to import from plain `bun test` (no opentui runtime) AND from the `.tsx`
 * entry. Keeping it a `.ts` file is the whole point: the host's Solid transform only
 * processes `.tsx`/`.jsx` (filter `/\.(js|ts)x$/`), so a `.ts` that imported solid
 * runtime would resolve to THIS package's nested copy instead of the host's — the
 * dual-instance bug that crashed the viewer (see `index.tsx`'s header). The consts
 * here carry no runtime instance, so a `.ts` home is correct and intentional.
 */

import {
	mkdir as nodeMkdir,
	writeFile as nodeWriteFile,
} from "node:fs/promises";
import { join } from "node:path";

/** Plugin id — shared with the server module so both surfaces read as one drawer. */
export const TUI_PLUGIN_ID = "pi-drawer-workflows";

/** The route name the open command navigates to and the route registers under. */
export const ROUTE_WORKFLOWS = "workflows";

/**
 * Host slot order for the workflows sidebar summary (Task 8.3.4). The host renders
 * registered slots ascending by `order`; this sits just after the internal todo
 * slot (`order: 400`) so an active-runs glance lands below the session's todos.
 */
export const SIDEBAR_SLOT_ORDER = 410;

/** Feed dir leaf — MUST match the engine's `SUBDIR_FEED` (the viewer reads it). */
export const SUBDIR_FEED = "workflow-feed";

/** Control dir leaf — MUST match the engine's `SUBDIR_CONTROL` (sentinels land here). */
export const SUBDIR_CONTROL = "workflow-control";

/** Cancel-sentinel suffix — MUST match the engine watcher's `SENTINEL_SUFFIX`. */
export const SENTINEL_SUFFIX = ".cancel";

/** Save-sentinel suffix — MUST match the engine watcher's `SAVE_SUFFIX`. */
export const SAVE_SUFFIX = ".save";

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

/**
 * Coerce a run's display name into a filesystem-safe workflow name the engine's
 * validator will accept: invalid-char runs → `-`, leading/trailing `.`/`-`
 * stripped, empty → `"workflow"`. The TUI derives the save name from the run's
 * own `meta.name` (which allows spaces/unicode), so a spaced name like
 * "Deep Review" must become "Deep-Review" or the engine silently refuses it.
 * The `workflow_save_run` tool does NOT slug — it requires a valid name up front.
 */
export function slugifyWorkflowName(raw: string): string {
	const s = raw
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "");
	return s.length > 0 ? s : "workflow";
}

/**
 * Write the save sentinel for `runId`: `mkdir(<controlDir>)` then
 * `<controlDir>/<runId>.save` whose BODY is the target workflow name. The
 * engine's poll loop reads the body and copies the run's script to
 * `.opencode/workflows/<name>.js` (Epic 4.2). The channel is one-way, mirroring
 * cancel — the save outcome is logged engine-side, not returned here.
 */
export async function writeSaveSentinel(opts: {
	controlDir: string;
	runId: string;
	name: string;
	fs?: CancelFs;
}): Promise<void> {
	const fs = opts.fs ?? defaultCancelFs;
	await fs.mkdir(opts.controlDir, { recursive: true });
	await fs.writeFile(
		join(opts.controlDir, `${opts.runId}${SAVE_SUFFIX}`),
		opts.name,
	);
}
