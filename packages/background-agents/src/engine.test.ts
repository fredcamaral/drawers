import { describe, expect, test } from "bun:test";
import type { BgTask, FsFacade } from "@drawers/core";
import { createEngine } from "./engine";

/**
 * In-memory fs facade. The store writes one `<id>.json` per task and reads them
 * all back on `load()`. We pre-seed `files` with a terminal + a running task so
 * the engine's `store.load()` returns both, exercising recovery wiring end-to-end.
 */
function basename(path: string): string {
	const i = path.lastIndexOf("/");
	return i === -1 ? path : path.slice(i + 1);
}

function makeFs(initial: Record<string, string> = {}): FsFacade & {
	files: Map<string, string>;
} {
	const files = new Map<string, string>(Object.entries(initial));
	return {
		files,
		mkdir: async () => undefined,
		// The real node readdir returns BASENAMES; the store re-joins with baseDir.
		readdir: async () => [...files.keys()].map(basename),
		readFile: async (path) => {
			const f = files.get(path);
			if (f === undefined) {
				const err = new Error("ENOENT") as Error & { code: string };
				err.code = "ENOENT";
				throw err;
			}
			return f;
		},
		writeFile: async (path, data) => {
			files.set(path, data);
		},
		rename: async (from, to) => {
			const v = files.get(from);
			if (v !== undefined) {
				files.set(to, v);
				files.delete(from);
			}
		},
		rm: async (path) => {
			files.delete(path);
		},
	};
}

/** A scripted EngineClient-shaped fake — enough for construction + recovery. */
function makeClient(opts: { sessionAlive?: boolean } = {}) {
	const alive = opts.sessionAlive ?? true;
	return {
		session: {
			create: async () => ({ data: { id: "ses_created" } }),
			promptAsync: async () => undefined,
			abort: async () => undefined,
			messages: async () => ({ data: [] }),
			get: async () => {
				if (!alive) {
					throw new Error("session gone");
				}
				return { data: { id: "ses_x" } };
			},
			// Empty status map: every session absent = idle-equivalent (no liveness
			// veto), so these tests' completion behavior is unchanged (Task 7.1.1).
			status: async () => ({ data: {} }),
		},
	};
}

/** A logger that swallows everything (the engine never logs in these tests). */
const noopLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

const BASE = "/data";
// The engine resolves the task store under `<base>/tasks` (the canonical
// resolveDataBaseDir model), so seeded recovery files live there.
const TASKS = `${BASE}/tasks`;

// Recent timestamps so the store's 24h TTL sweep never expires the fixtures
// (the engine uses a real Date-backed clock).
const NOW = Date.now();

function terminalTask(over: Partial<BgTask> = {}): BgTask {
	return {
		id: "bg_terminal",
		parentSessionID: "ses_parent",
		description: "done one",
		agent: "build",
		status: "completed",
		createdAt: NOW - 3000,
		startedAt: NOW - 2900,
		completedAt: NOW - 2400,
		depth: 0,
		concurrencyKey: "k",
		...over,
	};
}

function runningTask(over: Partial<BgTask> = {}): BgTask {
	return {
		id: "bg_running",
		sessionID: "ses_running",
		parentSessionID: "ses_parent",
		description: "in flight",
		agent: "build",
		status: "running",
		createdAt: NOW - 1000,
		startedAt: NOW - 900,
		depth: 0,
		concurrencyKey: "k",
		...over,
	};
}

describe("createEngine", () => {
	test("recovers persisted tasks: terminal + running both visible via runner.list", async () => {
		const fs = makeFs(
			Object.fromEntries([
				[`${TASKS}/bg_terminal.json`, JSON.stringify(terminalTask())],
				[`${TASKS}/bg_running.json`, JSON.stringify(runningTask())],
			]),
		);
		const engine = await createEngine({
			client: makeClient({ sessionAlive: true }),
			dataDir: BASE,
			fs,
			logger: noopLogger,
		});

		const ids = engine.runner
			.list()
			.map((t) => t.id)
			.sort();
		expect(ids).toEqual(["bg_running", "bg_terminal"]);

		await engine.runner.dispose();
	});

	test("seeds the notification queue with the recovered terminal (un-notified) task", async () => {
		const fs = makeFs({
			[`${TASKS}/bg_terminal.json`]: JSON.stringify(terminalTask()),
			[`${TASKS}/bg_running.json`]: JSON.stringify(runningTask()),
		});

		const engine = await createEngine({
			client: makeClient(),
			dataDir: BASE,
			fs,
			logger: noopLogger,
		});

		// The terminal task is seeded into the queue (un-notified); the running one
		// is not (not terminal).
		const pending = engine.queue.pending("ses_parent");
		expect(pending.map((n) => n.taskId)).toEqual(["bg_terminal"]);

		await engine.runner.dispose();
	});

	test("already-notified terminal task is NOT re-seeded into the queue", async () => {
		const fs = makeFs({
			[`${TASKS}/bg_terminal.json`]: JSON.stringify(
				terminalTask({ notified: true }),
			),
		});

		const engine = await createEngine({
			client: makeClient(),
			dataDir: BASE,
			fs,
			logger: noopLogger,
		});

		expect(engine.queue.pending()).toHaveLength(0);
		await engine.runner.dispose();
	});

	test("flushing the queue persists notified=true via the store (markNotified wiring)", async () => {
		const initial = {
			[`${TASKS}/bg_terminal.json`]: JSON.stringify(terminalTask()),
		};
		const fs = makeFs(initial);

		const engine = await createEngine({
			client: makeClient(),
			dataDir: BASE,
			fs,
			logger: noopLogger,
		});

		const flushed = engine.queue.flushFor("ses_parent");
		expect(flushed.map((n) => n.taskId)).toEqual(["bg_terminal"]);

		// markNotified is fire-and-forget; let the store's write queue drain.
		await engine.store.dispose();

		const reloaded = await engine.store.load();
		const persisted = reloaded.find((t) => t.id === "bg_terminal");
		expect(persisted?.notified).toBe(true);

		await engine.runner.dispose();
	});

	test("persisted task files land under <base>/tasks/, not <base>/ directly", async () => {
		const fs = makeFs();
		const engine = await createEngine({
			client: makeClient(),
			dataDir: BASE,
			fs,
			logger: noopLogger,
		});

		// Recover-then-save round-trip: seed an un-notified terminal so flushing
		// triggers a markNotified store.save, exercising the write path.
		await engine.store.save(terminalTask({ id: "bg_layout001" }));
		await engine.store.dispose();

		const written = [...fs.files.keys()];
		// The file must be written under `<base>/tasks/`, never at `<base>/` directly.
		expect(written).toContain(`${TASKS}/bg_layout001.json`);
		expect(written).not.toContain(`${BASE}/bg_layout001.json`);

		await engine.runner.dispose();
	});

	test("no persisted tasks → empty engine, queue and list both empty", async () => {
		const engine = await createEngine({
			client: makeClient(),
			dataDir: BASE,
			fs: makeFs(),
			logger: noopLogger,
		});
		expect(engine.runner.list()).toHaveLength(0);
		expect(engine.queue.pending()).toHaveLength(0);
		await engine.runner.dispose();
	});
});
