/**
 * TaskStore — atomic per-task persistence with restart recovery.
 *
 * One file per task (`<taskId>.json`). A write serializes the FULL {@link BgTask}
 * to `<taskId>.json.tmp` then `rename`s it over the target — atomic on POSIX, so
 * a crash mid-write never leaves a torn task file (only a `.tmp` orphan, swept on
 * the next load). This deliberately avoids the defect catalog of the prior
 * implementation (.references/better-opencode-async-agents/src/storage.ts:77-121):
 *  - NO whole-file read-modify-write: each task is independent, so concurrent
 *    saves of different tasks never clobber each other.
 *  - NO silent `{}` on corruption: a bad file is logged and SKIPPED individually,
 *    the rest still load.
 *  - NO dropped fields: the whole BgTask is serialized and round-trips intact.
 *
 * Collaborators (fs facade, logger, clock) are injected factory-DI so tests run
 * against a real temp dir without touching the host's XDG data home.
 */

import {
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BgTask, Clock, TaskStatus } from "./types";
import { isTerminal } from "./types";

/**
 * The exact fs surface the store uses. Defaults to `node:fs/promises`; injectable
 * so a test can swap an in-memory facade if it ever needs to (real temp dirs are
 * simpler and used by the suite, but the seam is here).
 */
export interface FsFacade {
	mkdir(path: string, opts: { recursive: true }): Promise<unknown>;
	readdir(path: string): Promise<string[]>;
	readFile(path: string, enc: "utf-8"): Promise<string>;
	writeFile(path: string, data: string, enc: "utf-8"): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	rm(path: string, opts: { force: true }): Promise<void>;
}

const defaultFs: FsFacade = {
	mkdir: (path, opts) => mkdir(path, opts),
	readdir: (path) => readdir(path),
	readFile: (path, enc) => readFile(path, enc),
	writeFile: (path, data, enc) => writeFile(path, data, enc),
	rename: (from, to) => rename(from, to),
	rm: (path, opts) => rm(path, opts),
};

export interface TaskStoreLogger {
	debug?(msg: string, meta?: Record<string, unknown>): void;
	error?(msg: string, meta?: Record<string, unknown>): void;
}

export interface TaskStoreOptions {
	/** Override the storage directory (tests pass a temp dir). */
	baseDir?: string;
	/** Injectable fs facade; defaults to `node:fs/promises`. */
	fs?: FsFacade;
	logger?: TaskStoreLogger;
	clock?: Clock;
	/** Terminal tasks older than this (by `completedAt`) are swept on load. Default 24h. */
	ttlMs?: number;
}

export interface TaskStore {
	/** Persist the full task atomically. Concurrent saves of the SAME id serialize. */
	save(task: BgTask): Promise<void>;
	/** Read every persisted task (for engine start). Sweeps debris + TTL-expired files. */
	load(): Promise<BgTask[]>;
	/** Remove a task's file. Absent file → silent no-op. */
	delete(taskId: string): Promise<void>;
	/** Drain all queued writes. Call before process exit. */
	dispose(): Promise<void>;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const TASK_SUFFIX = ".json";
const TMP_SUFFIX = ".json.tmp";

const defaultClock: Clock = { now: () => Date.now() };

/** Resolve the default storage dir, honoring `XDG_DATA_HOME`. */
function defaultBaseDir(): string {
	const xdg = process.env.XDG_DATA_HOME;
	const root = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share");
	return join(root, "opencode-drawers", "tasks");
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Minimal validation of a parsed task file. A file failing this is corrupt and
 * is skipped (not loaded). We require the discriminating fields the engine needs
 * to even register a task: id, parentSessionID, and a known status.
 */
function isValidTask(value: unknown): value is BgTask {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const v = value as Record<string, unknown>;
	if (typeof v.id !== "string" || v.id.length === 0) {
		return false;
	}
	if (typeof v.parentSessionID !== "string") {
		return false;
	}
	const status = v.status;
	if (
		status !== "pending" &&
		status !== "running" &&
		status !== "completed" &&
		status !== "error" &&
		status !== "cancelled"
	) {
		return false;
	}
	return true;
}

export function createTaskStore(opts: TaskStoreOptions = {}): TaskStore {
	const baseDir = opts.baseDir ?? defaultBaseDir();
	const fs = opts.fs ?? defaultFs;
	const logger = opts.logger;
	const clock = opts.clock ?? defaultClock;
	const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;

	// Per-task write queue: chains saves for the SAME id so they serialize in
	// call order (last queued payload wins, no interleaved/torn writes). Different
	// ids run concurrently because each has its own chain. `dispose` awaits the
	// union of every tail.
	const queues = new Map<string, Promise<void>>();
	let dirEnsured = false;

	function pathFor(taskId: string): string {
		return join(baseDir, `${taskId}${TASK_SUFFIX}`);
	}

	async function ensureDir(): Promise<void> {
		if (dirEnsured) {
			return;
		}
		await fs.mkdir(baseDir, { recursive: true });
		dirEnsured = true;
	}

	/** The atomic write: tmp file → rename over target. */
	async function writeAtomic(task: BgTask): Promise<void> {
		await ensureDir();
		const target = pathFor(task.id);
		const tmp = `${target}.tmp`;
		const data = JSON.stringify(task);
		await fs.writeFile(tmp, data, "utf-8");
		await fs.rename(tmp, target);
	}

	/** Enqueue an operation on a task's serial chain. */
	function enqueue(taskId: string, op: () => Promise<void>): Promise<void> {
		const prev = queues.get(taskId) ?? Promise.resolve();
		// Run `op` after the prior write settles (success OR failure — a failed
		// write must not wedge the chain). The chain itself never rejects.
		const next = prev.then(op, op);
		// The promise the caller observes DOES surface op's rejection; the stored
		// chain swallows it so a later save still runs.
		const settled = next.catch((err) => {
			logger?.error?.("task save failed", { id: taskId, err: errorText(err) });
		});
		queues.set(taskId, settled);
		// Detach the queue entry once it is the live tail and has settled, so the
		// map does not grow unbounded across a long-lived process.
		settled.then(() => {
			if (queues.get(taskId) === settled) {
				queues.delete(taskId);
			}
		});
		return next;
	}

	async function save(task: BgTask): Promise<void> {
		// Snapshot the task at call time so a later in-place mutation by the caller
		// cannot retroactively change what THIS save writes (the gate mutates the
		// shared BgTask object). Last queued snapshot wins.
		const snapshot: BgTask = { ...task };
		return enqueue(task.id, () => writeAtomic(snapshot));
	}

	async function deleteTask(taskId: string): Promise<void> {
		return enqueue(taskId, async () => {
			await fs.rm(pathFor(taskId), { force: true });
		});
	}

	async function load(): Promise<BgTask[]> {
		let entries: string[];
		try {
			entries = await fs.readdir(baseDir);
		} catch (err) {
			// Missing dir (ENOENT) → empty. Any other readdir failure is also
			// non-fatal for start: log and treat as empty.
			const code = (err as { code?: string }).code;
			if (code !== "ENOENT") {
				logger?.error?.("readdir failed during load", {
					baseDir,
					err: errorText(err),
				});
			}
			return [];
		}

		const now = clock.now();
		const out: BgTask[] = [];

		for (const name of entries) {
			// Crashed-write debris: delete silently, never parse.
			if (name.endsWith(TMP_SUFFIX)) {
				await fs.rm(join(baseDir, name), { force: true }).catch(() => {});
				continue;
			}
			if (!name.endsWith(TASK_SUFFIX)) {
				continue;
			}

			const full = join(baseDir, name);
			let parsed: unknown;
			try {
				parsed = JSON.parse(await fs.readFile(full, "utf-8"));
			} catch (err) {
				logger?.error?.("skipping unreadable task file", {
					file: name,
					err: errorText(err),
				});
				continue;
			}

			if (!isValidTask(parsed)) {
				logger?.error?.("skipping corrupt task file (failed validation)", {
					file: name,
				});
				continue;
			}

			// TTL sweep: only TERMINAL tasks with a `completedAt` past the TTL are
			// expired. A running/pending task is NEVER swept regardless of age.
			if (
				isTerminal(parsed.status as TaskStatus) &&
				typeof parsed.completedAt === "number" &&
				now - parsed.completedAt > ttlMs
			) {
				await fs.rm(full, { force: true }).catch((err) => {
					logger?.error?.("ttl sweep delete failed", {
						file: name,
						err: errorText(err),
					});
				});
				continue;
			}

			out.push(parsed);
		}

		return out;
	}

	async function dispose(): Promise<void> {
		// Await every live chain tail. New saves can be enqueued onto a chain while
		// we await; loop until the set is stable and drained.
		while (queues.size > 0) {
			await Promise.all([...queues.values()]);
		}
	}

	return { save, load, delete: deleteTask, dispose };
}
