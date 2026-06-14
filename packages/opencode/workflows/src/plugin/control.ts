/**
 * External control-channel watcher — the file-based cancel sentinel poller
 * (Task 8.2.2). A process other than the opencode server (the native TUI viewer,
 * a shell `touch`) requests a run's cancel by dropping
 * `<dataDir>/workflow-control/<runId>.cancel`; the engine's watcher observes it on
 * its next poll, asks the engine to cancel that run, and consumes the sentinel.
 *
 * Mechanism: a POLL loop, not `fs.watch`. The injected {@link FsFacade} exposes
 * `readdir`/`rm` but NO `watch`, and there is no existing periodic loop in the
 * engine to piggyback on — a quiet run (slow child, no SDK events) would never tick
 * a piggybacked check. `readdir(dir)` + `rm(sentinelPath)` is the whole detection,
 * both already on the facade. The poll cadence and interval fns are injectable so
 * tests drive `tick()` directly with zero timers; the default real-`setInterval`
 * handle is UNREF'd so the loop never keeps the process alive on its own.
 *
 * Steady state is a MISSING control dir (no run has touched it): a `readdir` that
 * throws (ENOENT or otherwise) degrades to "no sentinels" and is logged ONCE at
 * debug, not per tick. Sentinels are ALWAYS consumed — even for an unknown or
 * already-terminal run — so a stale sentinel never accumulates or re-fires; the
 * engine's `onCancel` is idempotent (its `stopRun` no-ops a non-running run), so a
 * sentinel that resists removal simply retries next tick, harmlessly.
 */

import { join } from "node:path";

const SENTINEL_SUFFIX = ".cancel";
const SAVE_SUFFIX = ".save";

/** The minimal fs surface the watcher needs — a subset of the engine `FsFacade`. */
export interface ControlFs {
	readdir(path: string): Promise<string[]>;
	rm(path: string, opts: { force: true }): Promise<void>;
	/** Read a `.save` sentinel's body (the target workflow name). */
	readFile(path: string, encoding: "utf-8"): Promise<string>;
}

export interface ControlLogger {
	debug?(msg: string, meta?: Record<string, unknown>): void;
}

export interface ControlWatcherOptions {
	/** The control subdir polled for `<runId>.cancel` sentinels. */
	dir: string;
	/** Injectable fs facade (the engine reuses its own `FsFacade`). */
	fs: ControlFs;
	/** Poll cadence in ms; armed by {@link ControlWatcher.start}. */
	intervalMs: number;
	/**
	 * Cancel one run by id. Called once per observed sentinel; must be idempotent
	 * (the engine's `stopRun` no-ops a non-running run). May reject — the watcher
	 * swallows it and still consumes the sentinel.
	 */
	onCancel(runId: string): Promise<void>;
	/**
	 * Save one run's script as a named workflow, where `name` is the `.save`
	 * sentinel's body (Epic 4.2). Optional — absent → `.save` sentinels are still
	 * consumed but do nothing. Like {@link onCancel} it may reject; the watcher
	 * swallows it and still consumes the sentinel.
	 */
	onSave?(runId: string, name: string): Promise<void>;
	/** Injectable interval arming; defaults to `globalThis.setInterval`. */
	setIntervalFn?: (cb: () => void, ms: number) => unknown;
	/** Injectable interval clearing; defaults to `globalThis.clearInterval`. */
	clearIntervalFn?: (handle: unknown) => void;
	logger?: ControlLogger;
}

export interface ControlWatcher {
	/** Arm the poll loop exactly once (double-`start` is a no-op). */
	start(): void;
	/** Clear the poll loop (idempotent). */
	stop(): void;
	/** One poll: scan the dir, cancel each sentinel's run, consume the sentinels. */
	tick(): Promise<void>;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function createControlWatcher(
	opts: ControlWatcherOptions,
): ControlWatcher {
	// The default interval is UNREF'd: a referenced 1s repeating timer would hold the
	// event loop open, blocking the at-idle exit `opencode run` depends on (the engine
	// is never disposed on that path until process teardown) and ticking forever in a
	// long-lived serve/TUI process. Unref lets the loop exit naturally while the timer
	// still fires for as long as the process lives. Injected fns are left untouched —
	// tests drive `tick()` directly and never arm a real timer.
	const setIntervalFn =
		opts.setIntervalFn ??
		((cb, ms) => {
			const handle = setInterval(cb, ms);
			(handle as { unref?: () => void }).unref?.();
			return handle;
		});
	const clearIntervalFn =
		opts.clearIntervalFn ??
		((handle) => clearInterval(handle as ReturnType<typeof setInterval>));

	let handle: unknown;
	// Latches so the steady-state "no control dir" path logs once, not per tick.
	let readdirErrorLogged = false;

	async function tick(): Promise<void> {
		let names: string[];
		try {
			names = await opts.fs.readdir(opts.dir);
		} catch (err) {
			// A missing control dir is the normal steady state — degrade to "no
			// sentinels" and log once at debug, never per tick.
			if (!readdirErrorLogged) {
				readdirErrorLogged = true;
				opts.logger?.debug?.(
					"workflow control dir not readable — no sentinels",
					{
						dir: opts.dir,
						err: errorText(err),
					},
				);
			}
			return;
		}
		readdirErrorLogged = false;

		for (const name of names) {
			let handled = false;
			if (name.endsWith(SENTINEL_SUFFIX)) {
				handled = true;
				const runId = name.slice(0, -SENTINEL_SUFFIX.length);
				try {
					await opts.onCancel(runId);
				} catch (err) {
					// onCancel failures never stop the loop — the sentinel is still consumed.
					opts.logger?.debug?.("workflow control onCancel failed", {
						runId,
						err: errorText(err),
					});
				}
			} else if (name.endsWith(SAVE_SUFFIX)) {
				handled = true;
				const runId = name.slice(0, -SAVE_SUFFIX.length);
				try {
					// The sentinel body carries the target name; read it BEFORE consuming.
					const saveName = (
						await opts.fs.readFile(join(opts.dir, name), "utf-8")
					).trim();
					await opts.onSave?.(runId, saveName);
				} catch (err) {
					opts.logger?.debug?.("workflow control onSave failed", {
						runId,
						err: errorText(err),
					});
				}
			}
			if (!handled) {
				continue;
			}
			try {
				await opts.fs.rm(join(opts.dir, name), { force: true });
			} catch (err) {
				// Consume-and-forget: a sentinel that can't be removed retries next tick,
				// which is harmless because onCancel is idempotent and onSave is safe to
				// repeat (a duplicate save refuses on the existing-file guard).
				opts.logger?.debug?.("workflow control sentinel removal failed", {
					name,
					err: errorText(err),
				});
			}
		}
	}

	function start(): void {
		if (handle !== undefined) {
			return;
		}
		handle = setIntervalFn(() => {
			void tick();
		}, opts.intervalMs);
	}

	function stop(): void {
		if (handle === undefined) {
			return;
		}
		clearIntervalFn(handle);
		handle = undefined;
	}

	return { start, stop, tick };
}
