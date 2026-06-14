/**
 * Shared text helpers for model-facing renderers (the settle-time run digest,
 * the `workflow_skills` listing). Hoisted here so every preview line in the
 * package truncates with the SAME arithmetic as the TUI's `truncateLine`
 * (`slice(0, max - 1)` + a single trailing `…`) — one source, no drift.
 */

/**
 * Collapse all whitespace runs (including newlines) to single spaces, trim, and
 * truncate to at most `max` chars with a trailing ellipsis marking a cut.
 */
export function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
