/**
 * Cadence directive store — the persistence layer for `loop`/`goal` directives.
 *
 * Persistence model: an injectable {@link FsFacade} (default `node:fs/promises`),
 * one JSON file per directive under `<dataDir>/cadence/`, written via a UNIQUE tmp
 * file (`<target>.<n>.tmp`) then atomically renamed over the target. The unique
 * tmp suffix means two concurrent writes for the same id never share a tmp path
 * and so never tear each other; the rename is the atomic publish (last writer
 * wins). The store itself does NOT serialize same-id writes — the engine's
 * per-directive in-flight guard already guarantees at most one write per id in
 * flight, so a serialization queue would be redundant.
 *
 * `load()` reads every `*.json`, skipping debris (`.json.tmp`) and any file that
 * fails JSON.parse or the minimal shape check, rather than failing the whole
 * recovery. A missing dir is the normal cold-start state → `load()` degrades to
 * `[]`. The store holds NO timers and NO engine state; it is pure persistence so
 * the engine (and its tests) can drive it with an in-memory facade.
 */

import {
	appendFile,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { type FsFacade, resolveDataBaseDir } from "@drawers/core";

/** A loop re-prompts a session on an interval; a goal re-prompts on idle. */
export type CadenceKind = "loop" | "goal";

/** A directive's lifecycle: live, satisfied/given-up, or explicitly halted. */
export type CadenceStatus = "active" | "done" | "stopped";

/** One persisted orchestration directive. */
export interface Directive {
	id: string;
	sessionID: string;
	kind: CadenceKind;
	instruction: string;
	intervalMs?: number;
	until?: string;
	iterations: number;
	maxIterations: number;
	status: CadenceStatus;
	createdAt: number;
}

const JSON_SUFFIX = ".json";

// Module-level monotonic counter: makes every tmp filename unique across the
// process so two concurrent writes (even for the same id) never collide on the
// same tmp path. The rename over the target stays atomic; last writer wins.
let tmpCounter = 0;

const defaultFs: FsFacade = {
	mkdir: (path, opts) => mkdir(path, opts),
	readdir: (path) => readdir(path),
	readFile: (path, enc) => readFile(path, enc),
	writeFile: (path, data, enc) => writeFile(path, data, enc),
	rename: (from, to) => rename(from, to),
	rm: (path, opts) => rm(path, opts),
	appendFile: (path, data, enc) => appendFile(path, data, enc),
};

export interface CadenceStoreLogger {
	debug?(msg: string, meta?: Record<string, unknown>): void;
	error?(msg: string, meta?: Record<string, unknown>): void;
}

export interface CadenceStoreOptions {
	/** Override the storage directory (tests pass a temp dir). */
	baseDir?: string;
	/** Injectable fs facade; defaults to `node:fs/promises`. */
	fs?: FsFacade;
	logger?: CadenceStoreLogger;
}

export interface CadenceStore {
	/** Persist the directive atomically (tmp file → rename over target). */
	save(directive: Directive): Promise<void>;
	/** Read every persisted directive. Missing dir / debris → skipped, never throws. */
	load(): Promise<Directive[]>;
	/** Remove a directive's file. Absent file → silent no-op. */
	delete(id: string): Promise<void>;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** The canonical cadence storage dir: the shared data base + the `cadence` leaf. */
function defaultBaseDir(): string {
	return join(resolveDataBaseDir(), "cadence");
}

/**
 * Minimal validation of a parsed directive file. A file failing this is corrupt
 * and is skipped (not loaded). We require the discriminating fields the engine
 * needs to re-arm or evaluate: id, sessionID, a known kind, and a known status.
 */
function isValidDirective(value: unknown): value is Directive {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const v = value as Record<string, unknown>;
	if (typeof v.id !== "string" || v.id.length === 0) {
		return false;
	}
	if (typeof v.sessionID !== "string") {
		return false;
	}
	if (v.kind !== "loop" && v.kind !== "goal") {
		return false;
	}
	if (v.status !== "active" && v.status !== "done" && v.status !== "stopped") {
		return false;
	}
	if (typeof v.instruction !== "string") {
		return false;
	}
	return true;
}

export function createCadenceStore(
	opts: CadenceStoreOptions = {},
): CadenceStore {
	const baseDir = opts.baseDir ?? defaultBaseDir();
	const fs = opts.fs ?? defaultFs;
	const logger = opts.logger;
	let dirEnsured = false;

	function pathFor(id: string): string {
		return join(baseDir, `${id}${JSON_SUFFIX}`);
	}

	async function ensureDir(): Promise<void> {
		if (dirEnsured) {
			return;
		}
		await fs.mkdir(baseDir, { recursive: true });
		dirEnsured = true;
	}

	async function save(directive: Directive): Promise<void> {
		// Snapshot at call time so a later in-place mutation by the engine cannot
		// retroactively change what THIS save writes.
		const snapshot: Directive = { ...directive };
		await ensureDir();
		const target = pathFor(snapshot.id);
		tmpCounter += 1;
		const tmp = `${target}.${tmpCounter}.tmp`;
		await fs.writeFile(tmp, JSON.stringify(snapshot), "utf-8");
		await fs.rename(tmp, target);
	}

	async function load(): Promise<Directive[]> {
		let entries: string[];
		try {
			entries = await fs.readdir(baseDir);
		} catch (err) {
			// Missing dir (ENOENT) is the cold-start steady state → empty. Any other
			// readdir failure is also non-fatal for recovery: log and treat as empty.
			const code = (err as { code?: string }).code;
			if (code !== "ENOENT") {
				logger?.error?.("readdir failed during load", {
					baseDir,
					err: errorText(err),
				});
			}
			return [];
		}

		const directives: Directive[] = [];
		for (const name of entries) {
			// Only published `<id>.json` files are directives; tmp debris
			// (`<id>.json.<n>.tmp`) ends in `.tmp`, never `.json`, so it is excluded.
			if (!name.endsWith(JSON_SUFFIX)) {
				continue;
			}
			try {
				const raw = await fs.readFile(join(baseDir, name), "utf-8");
				const parsed: unknown = JSON.parse(raw);
				if (isValidDirective(parsed)) {
					directives.push(parsed);
				} else {
					logger?.debug?.("skipped invalid directive file", { name });
				}
			} catch (err) {
				logger?.debug?.("skipped unreadable directive file", {
					name,
					err: errorText(err),
				});
			}
		}
		return directives;
	}

	async function deleteDirective(id: string): Promise<void> {
		await fs.rm(pathFor(id), { force: true });
	}

	return { save, load, delete: deleteDirective };
}
