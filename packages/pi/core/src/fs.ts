/**
 * FsFacade — the repo-wide injectable filesystem seam, plus its production
 * `node:fs/promises`-backed implementation.
 *
 * Extracted from persistence.ts (review finding #6): the facade started as the
 * task store's private fs surface but became the seam every persistence-adjacent
 * subsystem programs against (task/run stores, workflow scripts, journals, the
 * live feed, the skill catalog). It now lives in its own module so consumers can
 * import BOTH the type and the production facade from core instead of shipping
 * per-package `nodeFs()` duplicates. persistence.ts re-exports the type for
 * source compatibility.
 */

import {
	appendFile,
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";

/**
 * The exact fs surface core's stores (and the workflows engine) use. Defaults to
 * `node:fs/promises` via {@link nodeFsFacade}; injectable so tests can swap an
 * in-memory or failure-injecting facade.
 */
export interface FsFacade {
	mkdir(path: string, opts: { recursive: true }): Promise<unknown>;
	readdir(path: string): Promise<string[]>;
	readFile(path: string, enc: "utf-8"): Promise<string>;
	writeFile(path: string, data: string, enc: "utf-8"): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	rm(path: string, opts: { force: true }): Promise<void>;
	/**
	 * Optional native append. `node:fs/promises` exposes an O(1) `appendFile`, so a
	 * facade backed by it gets append-only writers (the workflow feed) for free; an
	 * in-memory test facade may omit it and have callers synthesize a read-modify-
	 * write fallback. Optional so existing facades that never append still satisfy
	 * the type.
	 */
	appendFile?(path: string, data: string, enc: "utf-8"): Promise<void>;
	/**
	 * Optional stat probe (follows symlinks). The workflows engine's `probePath`
	 * uses it to classify a path as file/dir with one metadata syscall. In-memory
	 * test facades may omit it; callers must fall back.
	 */
	stat?(path: string): Promise<{ isDirectory(): boolean }>;
	/**
	 * Optional lstat probe (does NOT follow symlinks) — lets a directory walk
	 * tell a symlink from a real entry. Optional like {@link stat}.
	 */
	lstat?(path: string): Promise<{
		isDirectory(): boolean;
		isSymbolicLink(): boolean;
	}>;
	/**
	 * Optional canonical-path resolution. A recursive walk uses it to keep a
	 * visited-set of REAL paths, turning a cyclic symlink into a no-op revisit
	 * instead of an unbounded recursion. Facades without it must rely on a
	 * depth cap instead.
	 */
	realpath?(path: string): Promise<string>;
}

const productionFs: FsFacade = {
	mkdir: (path, opts) => mkdir(path, opts),
	readdir: (path) => readdir(path),
	readFile: (path, enc) => readFile(path, enc),
	writeFile: (path, data, enc) => writeFile(path, data, enc),
	rename: (from, to) => rename(from, to),
	rm: (path, opts) => rm(path, opts),
	appendFile: (path, data, enc) => appendFile(path, data, enc),
	stat: (path) => stat(path),
	lstat: (path) => lstat(path),
	realpath: (path) => realpath(path),
};

/**
 * The production `node:fs/promises`-backed {@link FsFacade}. ONE implementation,
 * exported so consumers (the task store's default, the workflows engine, the
 * workflow tools) stop shipping their own copies. Returns a module-level
 * singleton — the facade is stateless, so sharing it is free.
 */
export function nodeFsFacade(): FsFacade {
	return productionFs;
}
