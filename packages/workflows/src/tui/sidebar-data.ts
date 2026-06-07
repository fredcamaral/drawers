/**
 * Sidebar data layer (Task 8.3.4) — the pure dir-scan + summarize fold behind the
 * `sidebar_content` slot, extracted from `sidebar.tsx` so it is unit-testable under
 * plain `bun test` (no JSX, no opentui). The slot view wires the real
 * `node:fs/promises` readFile/readdir; a test feeds an in-memory dir.
 *
 * The two correctness invariants this layer owns: a settled run must NOT appear in
 * the sidebar (only `running`/`cancelling` are active), and the survivors are
 * ordered longest-running first (elapsed-desc) so the run that has been going longest
 * sits on top. Both are asserted in `sidebar-data.test.ts`.
 */

import { join } from "node:path";
import {
	createRunStateReducer,
	parseFeedLine,
	type RunSummary,
	summarize,
} from "./reducer";

/** Feed-file suffix — `<dataDir>/workflow-feed/<runId>.jsonl`. */
const FEED_SUFFIX = ".jsonl";

/** The minimal fs surface the sidebar data layer reads through. Injectable for tests. */
export interface SidebarFs {
	/** Directory entries (basenames) of the feed dir; rejects when the dir is absent. */
	readdir(path: string): Promise<string[]>;
	/** Whole feed file as UTF-8; rejects if the file vanished mid-scan. */
	readFile(path: string): Promise<string>;
}

/** A run is shown in the sidebar while it has not reached a terminal `run:end`. */
export function isActive(status: RunSummary["status"]): boolean {
	return status === "running" || status === "cancelling";
}

/**
 * Read one whole feed file and fold it through a fresh reducer into a
 * {@link RunSummary}. A read failure (the file vanished mid-scan, a permission
 * hiccup) yields `undefined` and is dropped by the caller — a sidebar glance must
 * never throw. The file is read in full each tick: a glance over settled-vs-live is
 * cheap, and byte-offset tailing is the route's job, not the sidebar's.
 */
export async function summarizeFeedFile(
	path: string,
	now: number,
	fs: SidebarFs,
): Promise<RunSummary | undefined> {
	let text: string;
	try {
		text = await fs.readFile(path);
	} catch {
		return undefined;
	}
	const reducer = createRunStateReducer();
	for (const line of text.split("\n")) {
		if (line.length === 0) {
			continue;
		}
		const event = parseFeedLine(line);
		if (event !== undefined) {
			reducer.apply(event);
		}
	}
	return summarize(reducer.state(), now);
}

/**
 * Scan the feed dir, summarize every `<runId>.jsonl`, and keep only the active runs,
 * newest-elapsed first (the longest-running glance sits on top). A missing dir (no
 * run has ever produced a feed) yields an empty list — never an error.
 */
export async function activeRuns(
	feedDir: string,
	fs: SidebarFs,
	now: number,
): Promise<RunSummary[]> {
	let names: string[];
	try {
		names = await fs.readdir(feedDir);
	} catch {
		return [];
	}
	const summaries: RunSummary[] = [];
	for (const name of names) {
		if (!name.endsWith(FEED_SUFFIX)) {
			continue;
		}
		const summary = await summarizeFeedFile(join(feedDir, name), now, fs);
		if (summary !== undefined && isActive(summary.status)) {
			summaries.push(summary);
		}
	}
	summaries.sort((a, b) => b.elapsedMs - a.elapsedMs);
	return summaries;
}
