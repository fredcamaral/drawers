import { describe, expect, test } from "bun:test";
import { type ControlFs, createControlWatcher } from "./control";

/**
 * Control-watcher unit tests (Task 8.2.2). The watcher is driven through its
 * exposed `tick()` so timers never enter the picture; `start()`/`stop()` are
 * exercised against injectable interval fns. The fs is a tiny in-memory facade
 * mirroring the readdir/rm subset the engine's {@link FsFacade} exposes.
 */

const DIR = "/wf-data/workflow-control";

function makeFs(names: string[] = []) {
	const present = new Set(names);
	const calls: { readdir: number; rm: string[] } = { readdir: 0, rm: [] };
	const fs: ControlFs = {
		readdir: async (dir: string) => {
			calls.readdir += 1;
			if (dir !== DIR) {
				return [];
			}
			return [...present];
		},
		rm: async (path: string) => {
			calls.rm.push(path);
			present.delete(path.slice(`${DIR}/`.length));
		},
	};
	return { fs, present, calls };
}

function enoentFs() {
	const fs: ControlFs = {
		readdir: async () => {
			const err = new Error("ENOENT") as Error & { code: string };
			err.code = "ENOENT";
			throw err;
		},
		rm: async () => {},
	};
	return fs;
}

/**
 * Yield the microtask queue repeatedly so a fire-and-forget async `tick()` settles
 * to quiescence, regardless of how many awaits its internal chain has. Ten turns is
 * generous slack over the current readdir → onCancel → rm depth.
 */
async function drainMicrotasks(turns = 10): Promise<void> {
	for (let i = 0; i < turns; i += 1) {
		await Promise.resolve();
	}
}

interface LoggedDebug {
	msg: string;
	meta?: Record<string, unknown>;
}

function makeLogger() {
	const debug: LoggedDebug[] = [];
	return {
		logger: {
			debug: (msg: string, meta?: Record<string, unknown>) =>
				debug.push({ msg, meta }),
		},
		debug,
	};
}

describe("createControlWatcher — tick", () => {
	test("a `<runId>.cancel` sentinel triggers onCancel once and is removed", async () => {
		const { fs, present, calls } = makeFs(["wf_abc.cancel"]);
		const cancelled: string[] = [];
		const watcher = createControlWatcher({
			dir: DIR,
			fs,
			intervalMs: 1000,
			onCancel: async (runId) => {
				cancelled.push(runId);
			},
		});

		await watcher.tick();

		expect(cancelled).toEqual(["wf_abc"]);
		expect(calls.rm).toEqual([`${DIR}/wf_abc.cancel`]);
		expect(present.has("wf_abc.cancel")).toBe(false);
	});

	test("a missing control dir (ENOENT) yields no cancels and does not throw", async () => {
		const { logger, debug } = makeLogger();
		const cancelled: string[] = [];
		const watcher = createControlWatcher({
			dir: DIR,
			fs: enoentFs(),
			intervalMs: 1000,
			onCancel: async (runId) => {
				cancelled.push(runId);
			},
			logger,
		});

		await watcher.tick();
		await watcher.tick();

		expect(cancelled).toEqual([]);
		// Logged once across repeated ticks (steady state, not noise).
		expect(debug.length).toBe(1);
	});

	test("a file without a .cancel suffix is ignored", async () => {
		const { fs, present, calls } = makeFs(["wf_abc.txt", "notes"]);
		const cancelled: string[] = [];
		const watcher = createControlWatcher({
			dir: DIR,
			fs,
			intervalMs: 1000,
			onCancel: async (runId) => {
				cancelled.push(runId);
			},
		});

		await watcher.tick();

		expect(cancelled).toEqual([]);
		expect(calls.rm).toEqual([]);
		expect(present.has("wf_abc.txt")).toBe(true);
	});

	test("consumes the sentinel even when onCancel rejects (loop survives)", async () => {
		const { logger } = makeLogger();
		const { fs, present, calls } = makeFs(["wf_boom.cancel"]);
		const watcher = createControlWatcher({
			dir: DIR,
			fs,
			intervalMs: 1000,
			onCancel: async () => {
				throw new Error("onCancel blew up");
			},
			logger,
		});

		// Must not reject.
		await watcher.tick();

		expect(calls.rm).toEqual([`${DIR}/wf_boom.cancel`]);
		expect(present.has("wf_boom.cancel")).toBe(false);
	});

	test("an rm failure is swallowed and the tick survives", async () => {
		const { logger, debug } = makeLogger();
		const cancelled: string[] = [];
		const fs: ControlFs = {
			readdir: async () => ["wf_stuck.cancel"],
			rm: async () => {
				throw new Error("EBUSY");
			},
		};
		const watcher = createControlWatcher({
			dir: DIR,
			fs,
			intervalMs: 1000,
			onCancel: async (runId) => {
				cancelled.push(runId);
			},
			logger,
		});

		await watcher.tick();

		expect(cancelled).toEqual(["wf_stuck"]);
		// rm failure logged at least once; the tick did not throw.
		expect(debug.length).toBeGreaterThanOrEqual(1);
	});
});

describe("createControlWatcher — start/stop", () => {
	test("start arms exactly one interval and is idempotent; stop clears it", () => {
		const armed: Array<{ ms: number }> = [];
		const cleared: unknown[] = [];
		let handleSeq = 0;
		const watcher = createControlWatcher({
			dir: DIR,
			fs: makeFs().fs,
			intervalMs: 1500,
			onCancel: async () => {},
			setIntervalFn: (_cb, ms) => {
				armed.push({ ms });
				handleSeq += 1;
				return handleSeq;
			},
			clearIntervalFn: (handle) => {
				cleared.push(handle);
			},
		});

		watcher.start();
		watcher.start();

		expect(armed).toEqual([{ ms: 1500 }]);

		watcher.stop();
		expect(cleared).toEqual([1]);

		// stop is idempotent — a second clear is a no-op.
		watcher.stop();
		expect(cleared).toEqual([1]);
	});

	test("the armed interval callback drives tick", async () => {
		const { fs, present } = makeFs(["wf_timer.cancel"]);
		const cancelled: string[] = [];
		let armedCb: (() => void) | undefined;
		const watcher = createControlWatcher({
			dir: DIR,
			fs,
			intervalMs: 1000,
			onCancel: async (runId) => {
				cancelled.push(runId);
			},
			setIntervalFn: (cb) => {
				armedCb = cb;
				return 1;
			},
			clearIntervalFn: () => {},
		});

		watcher.start();
		expect(armedCb).toBeDefined();
		armedCb?.();
		// Drain to quiescence rather than counting `tick()`'s internal awaits — the
		// callback is fire-and-forget (`void tick()`), and tick() has a multi-await
		// chain (readdir → onCancel → rm). A fixed turn count would couple this test
		// to that depth and flake if a future await (or a real-microtask fs fake) is
		// added; looping until the work has settled does not.
		await drainMicrotasks();

		expect(cancelled).toEqual(["wf_timer"]);
		expect(present.has("wf_timer.cancel")).toBe(false);
	});

	test("the default interval is unref'd so it never holds the process open", () => {
		// In production no one injects setIntervalFn, so createControlWatcher arms a
		// real `setInterval`. A REFERENCED 1s repeating timer would keep the event
		// loop alive — blocking the at-idle exit `opencode run` depends on, and
		// ticking forever in a long-lived serve/TUI process. The default MUST call
		// `.unref()` on the handle. Spy on the global to capture the timer it returns.
		const realSetInterval = globalThis.setInterval;
		const realClearInterval = globalThis.clearInterval;
		let unrefCalls = 0;
		let captured: ReturnType<typeof realSetInterval> | undefined;
		globalThis.setInterval = ((cb: () => void, ms: number) => {
			const handle = realSetInterval(cb, ms);
			const realUnref = handle.unref.bind(handle);
			handle.unref = () => {
				unrefCalls += 1;
				return realUnref();
			};
			captured = handle;
			return handle;
		}) as typeof globalThis.setInterval;
		try {
			const watcher = createControlWatcher({
				dir: DIR,
				fs: makeFs().fs,
				intervalMs: 1000,
				onCancel: async () => {},
			});
			watcher.start();
			expect(unrefCalls).toBe(1);
			watcher.stop();
		} finally {
			if (captured !== undefined) {
				realClearInterval(captured);
			}
			globalThis.setInterval = realSetInterval;
		}
	});
});
