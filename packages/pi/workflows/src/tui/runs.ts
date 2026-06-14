/**
 * Feed-dir run resolution (Task 8.3.3) — the open-command's "default to the freshest
 * run" contract, extracted as a pure, io-injectable helper so it is unit-testable
 * under plain `bun test` without mounting the route's JSX.
 *
 * The route opens an explicit `runId` when one is supplied (the sidebar hands one
 * over); otherwise it scans `<dataDir>/workflow-feed` for `<runId>.jsonl` files and
 * picks the most-recently-modified one (a glance defaults to the freshest run). The
 * readdir/stat seam is injectable — the route wires the real `node:fs/promises`
 * functions, a test feeds an in-memory dir.
 */

/** The minimal fs surface {@link resolveRunId} reads through. Injectable for tests. */
export interface RunsFs {
	/** Directory entries (basenames) of the feed dir; rejects when the dir is absent. */
	readdir(path: string): Promise<string[]>;
	/** Modification time (ms) of a feed file; may reject if the file vanished mid-scan. */
	stat(path: string): Promise<{ mtimeMs: number }>;
}

/** Feed-file suffix — `<dataDir>/workflow-feed/<runId>.jsonl`. */
const FEED_SUFFIX = ".jsonl";

/**
 * Resolve which feed file to open: the explicit `runId` when present, else the
 * most-recently-modified `<runId>.jsonl` in `feedDir`. A missing/empty dir yields
 * `undefined` — the route renders an empty state and the tailer waits for a file.
 * Non-`.jsonl` entries are ignored; a file that vanishes mid-scan is skipped.
 */
export async function resolveRunId(
	feedDir: string,
	explicit: unknown,
	fs: RunsFs,
	join: (...parts: string[]) => string,
): Promise<string | undefined> {
	if (typeof explicit === "string" && explicit.length > 0) {
		return explicit;
	}
	let names: string[];
	try {
		names = await fs.readdir(feedDir);
	} catch {
		return undefined;
	}
	let newest: { runId: string; mtimeMs: number } | undefined;
	for (const name of names) {
		if (!name.endsWith(FEED_SUFFIX)) {
			continue;
		}
		try {
			const info = await fs.stat(join(feedDir, name));
			const mtimeMs = info.mtimeMs;
			if (newest === undefined || mtimeMs > newest.mtimeMs) {
				newest = { runId: name.slice(0, -FEED_SUFFIX.length), mtimeMs };
			}
		} catch {
			// A file vanishing mid-scan is harmless — skip it.
		}
	}
	return newest?.runId;
}

/**
 * List EVERY run in `feedDir` (settled and live alike), most-recently-modified first.
 *
 * Backs the route's `←/→` run switcher (Phase 8 cross-session ask): a glance over the
 * dir is the bus, so a run started by ANOTHER opencode session in the same repo shows
 * up here the next time the route re-scans — no shared in-process state required. The
 * freshest run sits at index 0, matching {@link resolveRunId}'s "default to the freshest"
 * contract (the first entry is what a bare open lands on). Non-`.jsonl` entries are
 * ignored; a file that vanishes mid-scan is skipped; a missing dir yields `[]`.
 */
export async function listRunIds(
	feedDir: string,
	fs: RunsFs,
	join: (...parts: string[]) => string,
): Promise<string[]> {
	let names: string[];
	try {
		names = await fs.readdir(feedDir);
	} catch {
		return [];
	}
	const entries: { runId: string; mtimeMs: number }[] = [];
	for (const name of names) {
		if (!name.endsWith(FEED_SUFFIX)) {
			continue;
		}
		try {
			const info = await fs.stat(join(feedDir, name));
			entries.push({
				runId: name.slice(0, -FEED_SUFFIX.length),
				mtimeMs: info.mtimeMs,
			});
		} catch {
			// A file vanishing mid-scan is harmless — skip it.
		}
	}
	entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return entries.map((e) => e.runId);
}
