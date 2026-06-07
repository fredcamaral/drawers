/**
 * Run journal — the append-only record that powers deterministic resume (§7).
 *
 * Every `agent()` call whose result settles non-null is appended as one JSONL
 * line. On resume the runtime loads the journal and replays the longest unchanged
 * prefix of `(prompt, opts)` pairs (matched by {@link computeCallKey}) instead of
 * launching children; the first edited/new call and everything after runs live.
 *
 * Writes serialize through a single promise-chain queue (mirroring core's
 * persistence write-queue idiom) so concurrent `record()` calls never interleave
 * a half-line. `load()` tolerates a truncated FINAL line (crash mid-append): it
 * drops that line and logs, rather than detonating the whole resume.
 *
 * The fs surface is injected factory-DI (default `node:fs/promises` + `mkdir -p`
 * of the dirname), so tests run against a real temp dir or an in-memory facade.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { JournalEntry } from "../runtime/types";

// computeCallKey / stableStringify / CallKeyInput moved to ../runtime/keys (Task
// 4.3.2) so the runtime layer can hash without importing this plugin module. They
// are re-exported here for back-compat with existing plugin/library import sites.
export {
	type CallKeyInput,
	computeCallKey,
	stableStringify,
} from "../runtime/keys";
export type { JournalEntry };

/** The exact fs surface the journal uses. Defaults to `node:fs/promises`. */
export interface JournalFs {
	mkdir(path: string, opts: { recursive: true }): Promise<unknown>;
	readFile(path: string, enc: "utf-8"): Promise<string>;
	appendFile(path: string, data: string, enc: "utf-8"): Promise<void>;
}

const defaultFs: JournalFs = {
	mkdir: (path, opts) => mkdir(path, opts),
	readFile: (path, enc) => readFile(path, enc),
	appendFile: (path, data, enc) => appendFile(path, data, enc),
};

export interface JournalLogger {
	error?(msg: string, meta?: Record<string, unknown>): void;
}

export interface JournalOptions {
	/** Target JSONL file. Its parent dir is created (`mkdir -p`) on first write. */
	path: string;
	/** Injectable fs facade; defaults to `node:fs/promises`. */
	fs?: JournalFs;
	logger?: JournalLogger;
}

export interface Journal {
	/** Append one settled entry. Concurrent records serialize via the queue. */
	record(entry: JournalEntry): Promise<void>;
	/** Read every journaled entry. Missing file → []. Truncated last line dropped. */
	load(): Promise<JournalEntry[]>;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function createJournal(opts: JournalOptions): Journal {
	const { path } = opts;
	const fs = opts.fs ?? defaultFs;
	const logger = opts.logger;

	// Single serial write chain: each record runs after the prior settles (success
	// OR failure — a failed append must not wedge the chain). The caller observes
	// op's rejection; the stored chain swallows it so a later record still runs.
	let tail: Promise<void> = Promise.resolve();
	let dirEnsured = false;

	async function ensureDir(): Promise<void> {
		if (dirEnsured) {
			return;
		}
		await fs.mkdir(dirname(path), { recursive: true });
		dirEnsured = true;
	}

	async function appendLine(entry: JournalEntry): Promise<void> {
		await ensureDir();
		await fs.appendFile(path, `${JSON.stringify(entry)}\n`, "utf-8");
	}

	function record(entry: JournalEntry): Promise<void> {
		const op = () => appendLine(entry);
		const next = tail.then(op, op);
		tail = next.catch((err) => {
			logger?.error?.("journal append failed", { err: errorText(err) });
		});
		return next;
	}

	async function load(): Promise<JournalEntry[]> {
		let raw: string;
		try {
			raw = await fs.readFile(path, "utf-8");
		} catch (err) {
			const code = (err as { code?: string }).code;
			if (code !== "ENOENT") {
				logger?.error?.("journal read failed", { err: errorText(err) });
			}
			return [];
		}

		const lines = raw.split("\n").filter((l) => l.length > 0);
		const out: JournalEntry[] = [];
		for (let i = 0; i < lines.length; i += 1) {
			const line = lines[i] as string;
			try {
				out.push(JSON.parse(line) as JournalEntry);
			} catch (err) {
				// A parse failure is only tolerated for the FINAL line (crash
				// mid-append). A bad interior line means real corruption → propagate.
				if (i === lines.length - 1) {
					logger?.error?.("dropping truncated final journal line", {
						err: errorText(err),
					});
					break;
				}
				throw err;
			}
		}
		return out;
	}

	return { record, load };
}
