/**
 * TaskStore — atomic per-record persistence with restart recovery.
 *
 * One file per record (`<id>.json`). A write serializes the FULL record to
 * `<id>.json.tmp` then `rename`s it over the target — atomic on POSIX, so
 * a crash mid-write never leaves a torn file (only a `.tmp` orphan, swept on
 * the next load). This deliberately avoids the defect catalog of the prior
 * implementation (.references/better-opencode-async-agents/src/storage.ts:77-121):
 *  - NO whole-file read-modify-write: each record is independent, so concurrent
 *    saves of different ids never clobber each other.
 *  - NO silent `{}` on corruption: a bad file is logged and SKIPPED individually,
 *    the rest still load.
 *  - NO dropped fields: the whole record is serialized and round-trips intact.
 *
 * The store is GENERIC over the persisted record type (review finding #3): it
 * only reads `id` (file naming), `status` (TTL sweep), and `completedAt` (TTL
 * sweep) — the {@link StoredRecord} constraint. The default record type is
 * {@link BgTask} with {@link isValidTask} as the load-time validator; a consumer
 * persisting a different shape (the workflows engine's RunRecord) passes its own
 * `validate` — the overloads REQUIRE one, so the asserted load type is honest.
 *
 * Collaborators (fs facade, logger, clock) are injected factory-DI so tests run
 * against a real temp dir without touching the host's XDG data home.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { type FsFacade, nodeFsFacade } from "./fs";
import type { BgTask, Clock, TaskStatus } from "./types";
import { isTerminal } from "./types";

// Re-exported for source compatibility: FsFacade lived here before its
// extraction into ./fs (review finding #6).
export type { FsFacade } from "./fs";

/**
 * The structural minimum the store itself reads off a persisted record:
 * `id` names the file, `status` + `completedAt` drive the TTL sweep.
 */
export interface StoredRecord {
	id: string;
	status: TaskStatus;
	completedAt?: number;
}

export interface TaskStoreLogger {
	debug?(msg: string, meta?: Record<string, unknown>): void;
	error?(msg: string, meta?: Record<string, unknown>): void;
}

export interface TaskStoreOptions<T extends StoredRecord = BgTask> {
	/** Override the storage directory (tests pass a temp dir). */
	baseDir?: string;
	/** Injectable fs facade; defaults to `node:fs/promises`. */
	fs?: FsFacade;
	logger?: TaskStoreLogger;
	clock?: Clock;
	/** Terminal tasks older than this (by `completedAt`) are swept on load. Default 24h. */
	ttlMs?: number;
	/**
	 * Load-time validator: a parsed file failing it is corrupt and skipped.
	 * Defaults to {@link isValidTask} (the BgTask validator); a store typed at a
	 * non-BgTask record MUST pass its own (enforced by the factory overloads).
	 */
	validate?: (value: unknown) => value is T;
}

export interface TaskStore<T extends StoredRecord = BgTask> {
	/** Persist the full record atomically. Concurrent saves of the SAME id serialize. */
	save(task: T): Promise<void>;
	/** Read every persisted record (for engine start). Sweeps debris + TTL-expired files. */
	load(): Promise<T[]>;
	/** Remove a record's file. Absent file → silent no-op. */
	delete(taskId: string): Promise<void>;
	/** Drain all queued writes. Call before process exit. */
	dispose(): Promise<void>;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const TASK_SUFFIX = ".json";
const TMP_SUFFIX = ".json.tmp";

const defaultClock: Clock = { now: () => Date.now() };

/**
 * Resolve the ONE canonical data BASE dir shared by every plugin (no leaf
 * segment). Resolution: `explicit` → `$PI_DRAWERS_DATA_DIR` (non-empty) →
 * `$XDG_DATA_HOME/pi-drawers` → `~/.local/share/pi-drawers`. Always
 * returns a string. Each consumer appends its own leaf (`tasks`, `workflow-*`).
 */
export function resolveDataBaseDir(explicit?: string): string {
	if (explicit !== undefined && explicit.length > 0) {
		return explicit;
	}
	const env = process.env.PI_DRAWERS_DATA_DIR;
	if (env && env.length > 0) {
		return env;
	}
	const xdg = process.env.XDG_DATA_HOME;
	const root = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share");
	return join(root, "pi-drawers");
}

/**
 * The store's default storage dir: the canonical base + the `tasks` leaf. Folding
 * it onto {@link resolveDataBaseDir} means one resolution algorithm everywhere —
 * the store default now ALSO honors `$PI_DRAWERS_DATA_DIR`, not just XDG.
 */
function defaultBaseDir(): string {
	return join(resolveDataBaseDir(), "tasks");
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isTaskStatus(value: unknown): value is TaskStatus {
	return (
		value === "pending" ||
		value === "running" ||
		value === "completed" ||
		value === "error" ||
		value === "cancelled"
	);
}

/** Optional field check: absent is fine; present must satisfy `check`. */
function optional(value: unknown, check: (v: unknown) => boolean): boolean {
	return value === undefined || check(value);
}

const isString = (v: unknown): boolean => typeof v === "string";
const isFiniteNumber = (v: unknown): boolean =>
	typeof v === "number" && Number.isFinite(v);
const isBoolean = (v: unknown): boolean => typeof v === "boolean";

/** A plain object whose every value is a boolean (the BgTask `tools` map). */
function isBooleanMap(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	return Object.values(value).every((v) => typeof v === "boolean");
}

/** An array of strings (the BgTask `agentTools` pi-native tool allow-list). */
function isStringArray(value: unknown): boolean {
	return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * Full validation of a parsed {@link BgTask} file (review finding #1). A file
 * failing this is corrupt and is skipped (not loaded). EVERY required field is
 * checked — a recovered task missing `createdAt` would otherwise produce NaN
 * activity math that permanently disables both completion and the stale sweep —
 * and every optional field is type-checked when present (wrong-typed optionals
 * are corruption, not data).
 */
export function isValidTask(value: unknown): value is BgTask {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const v = value as Record<string, unknown>;
	// Required fields.
	if (typeof v.id !== "string" || v.id.length === 0) {
		return false;
	}
	if (typeof v.parentSessionID !== "string") {
		return false;
	}
	if (!isTaskStatus(v.status)) {
		return false;
	}
	if (typeof v.description !== "string") {
		return false;
	}
	if (typeof v.agent !== "string") {
		return false;
	}
	if (!isFiniteNumber(v.createdAt)) {
		return false;
	}
	// `depth`/`concurrencyKey` have been stamped by every launch since the first
	// release, so they are validated as REQUIRED — the asserted `value is BgTask`
	// stays honest with no silent defaulting.
	if (!isFiniteNumber(v.depth)) {
		return false;
	}
	if (typeof v.concurrencyKey !== "string") {
		return false;
	}
	// Optional fields: absent is fine, wrong-typed presence is corruption.
	if (
		!optional(v.sessionID, isString) ||
		!optional(v.sessionFile, isString) ||
		!optional(v.model, isString) ||
		!optional(v.error, isString) ||
		!optional(v.startedAt, isFiniteNumber) ||
		!optional(v.completedAt, isFiniteNumber) ||
		!optional(v.notified, isBoolean) ||
		!optional(v.tools, isBooleanMap) ||
		!optional(v.appendSystemPrompt, isString) ||
		!optional(v.agentTools, isStringArray)
	) {
		return false;
	}
	return true;
}

/**
 * Factory overloads (review finding #3): omitting `validate` is only legal for
 * the default BgTask record type; any other record type must bring an honest
 * validator, so `load()`'s asserted element type is never a lie.
 */
export function createTaskStore(
	opts?: TaskStoreOptions<BgTask>,
): TaskStore<BgTask>;
export function createTaskStore<T extends StoredRecord>(
	opts: TaskStoreOptions<T> & { validate: (value: unknown) => value is T },
): TaskStore<T>;
export function createTaskStore<T extends StoredRecord>(
	opts: TaskStoreOptions<T> = {},
): TaskStore<T> {
	const baseDir = opts.baseDir ?? defaultBaseDir();
	const fs = opts.fs ?? nodeFsFacade();
	const logger = opts.logger;
	const clock = opts.clock ?? defaultClock;
	const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
	// Sound by the overload contract: `validate` may only be omitted through the
	// BgTask overload, so when this default applies, T IS BgTask.
	const validate =
		opts.validate ?? (isValidTask as unknown as (value: unknown) => value is T);

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
	async function writeAtomic(taskId: string, data: string): Promise<void> {
		await ensureDir();
		const target = pathFor(taskId);
		const tmp = `${target}.tmp`;
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

	async function save(task: T): Promise<void> {
		// Serialize AT CALL TIME (review finding #2): the JSON string is a DEEP
		// snapshot, so a later in-place mutation by the caller — including nested
		// arrays like the workflows engine's agents[]/checkpoints[] — cannot
		// retroactively change what THIS save writes. Last queued snapshot wins.
		const data = JSON.stringify(task);
		return enqueue(task.id, () => writeAtomic(task.id, data));
	}

	async function deleteTask(taskId: string): Promise<void> {
		return enqueue(taskId, async () => {
			await fs.rm(pathFor(taskId), { force: true });
		});
	}

	async function load(): Promise<T[]> {
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
		const out: T[] = [];

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

			if (!validate(parsed)) {
				logger?.error?.("skipping corrupt task file (failed validation)", {
					file: name,
				});
				continue;
			}

			// TTL sweep: only TERMINAL tasks with a `completedAt` past the TTL are
			// expired. A running/pending task is NEVER swept regardless of age.
			if (
				isTerminal(parsed.status) &&
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
