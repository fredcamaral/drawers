/**
 * Statusline plugin entry — the server-side anchor.
 *
 * This drawer is TUI-only: all behaviour lives in the `./tui` surface (`src/tui`).
 * But OpenCode discovers a package's `./tui` export only when the package is listed
 * in the `plugin` array, and a `plugin` entry resolves to this `.` module first.
 * So this file exists to give the array something to point at; OpenCode then walks
 * up to the package's `exports["./tui"]` and loads the status line in its TUI
 * process. There is no server-side work to do, so the factory returns no hooks.
 *
 * OpenCode's loader calls EVERY export of this module as a function, so the entry
 * exposes exactly ONE export — the async {@link Plugin} factory returning `{}`.
 */

import type { Plugin } from "@opencode-ai/plugin";

export const StatuslinePlugin: Plugin = async () => ({});
