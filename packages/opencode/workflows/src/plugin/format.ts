/**
 * Shared duration humanizer — re-exported from core (review finding #7).
 *
 * The implementation moved to `@drawers/core` so the SAME bands render every
 * elapsed across core's notify-hooks (toasts, visible summaries) and this
 * plugin's status render, live TUI title, and chat.message digest. This module
 * stays as a re-export because the TUI tsconfig and several plugin modules
 * import from here.
 */
export { humanizeDuration } from "@drawers/core";
