import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskStore, resolveDataBaseDir } from "./persistence";
import type { BgTask, Clock } from "./types";

// ---- helpers --------------------------------------------------------------

function fixedClock(t = 1_000_000): Clock {
	return { now: () => t };
}

interface LoggedError {
	msg: string;
	meta?: Record<string, unknown>;
}

/** Capturing logger so tests can assert the corrupt-file warning fired. */
function makeLogger() {
	const errors: LoggedError[] = [];
	const debugs: LoggedError[] = [];
	return {
		logger: {
			error: (msg: string, meta?: Record<string, unknown>) =>
				errors.push({ msg, meta }),
			debug: (msg: string, meta?: Record<string, unknown>) =>
				debugs.push({ msg, meta }),
		},
		errors,
		debugs,
	};
}

/** A fully-populated terminal task: EVERY BgTask field set. */
function fullTask(over: Partial<BgTask> = {}): BgTask {
	return {
		id: "bg_full0001",
		sessionID: "ses_child_1",
		parentSessionID: "ses_parent_1",
		description: "do the thing",
		agent: "build",
		status: "completed",
		createdAt: 1000,
		startedAt: 1100,
		completedAt: 1200,
		error: "some recorded error text",
		depth: 1,
		concurrencyKey: "anthropic/opus",
		model: "anthropic/opus",
		notified: true,
		...over,
	};
}

// ---- suite ----------------------------------------------------------------

describe("createTaskStore", () => {
	let baseDir: string;

	beforeEach(async () => {
		baseDir = await mkdtemp(join(tmpdir(), "drawers-tasks-"));
	});

	afterEach(async () => {
		await rm(baseDir, { recursive: true, force: true });
	});

	// 1. round-trip preserves EVERY field
	test("save→load round-trip preserves every BgTask field", async () => {
		const store = createTaskStore({ baseDir, clock: fixedClock() });
		const task = fullTask();
		await store.save(task);
		await store.dispose();

		const reopened = createTaskStore({ baseDir, clock: fixedClock() });
		const loaded = await reopened.load();
		await reopened.dispose();

		expect(loaded).toHaveLength(1);
		expect(loaded[0]).toEqual(task);
	});

	// 9. missing dir → []
	test("load on a missing directory returns an empty array", async () => {
		const missing = join(baseDir, "does", "not", "exist");
		const store = createTaskStore({ baseDir: missing, clock: fixedClock() });
		const loaded = await store.load();
		await store.dispose();
		expect(loaded).toEqual([]);
	});

	// 2. corrupt file among valid → others load, corrupt skipped + logged
	test("a corrupt file is skipped and logged; valid files still load", async () => {
		const { logger, errors } = makeLogger();
		const store = createTaskStore({ baseDir, clock: fixedClock(), logger });
		const good1 = fullTask({ id: "bg_good0001" });
		const good2 = fullTask({ id: "bg_good0002", sessionID: "ses_2" });
		await store.save(good1);
		await store.save(good2);
		await store.dispose();

		// bad JSON
		await writeFile(join(baseDir, "bg_bad00001.json"), "{ not json ", "utf-8");
		// valid JSON but missing required fields (no status)
		await writeFile(
			join(baseDir, "bg_bad00002.json"),
			JSON.stringify({ id: "bg_bad00002", parentSessionID: "p" }),
			"utf-8",
		);

		const reopened = createTaskStore({ baseDir, clock: fixedClock(), logger });
		const loaded = await reopened.load();
		await reopened.dispose();

		const ids = loaded.map((t) => t.id).sort();
		expect(ids).toEqual(["bg_good0001", "bg_good0002"]);
		// two corrupt files each logged
		expect(errors.length).toBeGreaterThanOrEqual(2);
	});

	// 3. tmp-file leftover → cleaned, not loaded
	test("leftover .json.tmp debris is deleted on load and never parsed", async () => {
		const store = createTaskStore({ baseDir, clock: fixedClock() });
		await store.save(fullTask({ id: "bg_real0001" }));
		await store.dispose();

		// crashed-write debris
		const tmpPath = join(baseDir, "bg_crash001.json.tmp");
		await writeFile(tmpPath, "partial garbage", "utf-8");

		const reopened = createTaskStore({ baseDir, clock: fixedClock() });
		const loaded = await reopened.load();
		await reopened.dispose();

		expect(loaded.map((t) => t.id)).toEqual(["bg_real0001"]);
		const remaining = await readdir(baseDir);
		expect(remaining.some((f) => f.endsWith(".tmp"))).toBe(false);
	});

	// 4. concurrent saves to same task → last call wins, no torn file
	test("concurrent saves to the same task serialize to the last payload, no torn file", async () => {
		const store = createTaskStore({ baseDir, clock: fixedClock() });
		// Fire many saves without awaiting in between; queue must serialize them.
		const writes: Promise<void>[] = [];
		for (let i = 0; i < 25; i++) {
			writes.push(
				store.save(fullTask({ id: "bg_same0001", description: `desc-${i}` })),
			);
		}
		await Promise.all(writes);
		await store.dispose();

		// File must be valid JSON (not torn) and reflect the LAST queued payload.
		const raw = await readFile(join(baseDir, "bg_same0001.json"), "utf-8");
		const parsed = JSON.parse(raw) as BgTask;
		expect(parsed.description).toBe("desc-24");
	});

	// 5. TTL sweep
	test("TTL sweep deletes old terminal tasks, keeps fresh terminal and old non-terminal", async () => {
		const now = 1_000_000_000;
		const ttlMs = 24 * 60 * 60 * 1000; // 24h
		const store = createTaskStore({
			baseDir,
			clock: fixedClock(now),
			ttlMs,
		});

		const oldTerminal = fullTask({
			id: "bg_oldterm01",
			status: "completed",
			completedAt: now - ttlMs - 1, // just past TTL
		});
		const freshTerminal = fullTask({
			id: "bg_freshterm",
			status: "completed",
			completedAt: now - 1000, // well within TTL
		});
		const oldRunning = fullTask({
			id: "bg_oldrun001",
			status: "running",
			completedAt: undefined,
			startedAt: now - ttlMs - 5000, // older than TTL but NOT terminal
		});
		await store.save(oldTerminal);
		await store.save(freshTerminal);
		await store.save(oldRunning);
		await store.dispose();

		const reopened = createTaskStore({
			baseDir,
			clock: fixedClock(now),
			ttlMs,
		});
		const loaded = await reopened.load();
		await reopened.dispose();

		const ids = loaded.map((t) => t.id).sort();
		expect(ids).toEqual(["bg_freshterm", "bg_oldrun001"]);
		// old terminal file physically deleted
		const remaining = await readdir(baseDir);
		expect(remaining).not.toContain("bg_oldterm01.json");
	});

	// delete()
	test("delete removes a task file", async () => {
		const store = createTaskStore({ baseDir, clock: fixedClock() });
		await store.save(fullTask({ id: "bg_del00001" }));
		await store.delete("bg_del00001");
		const loaded = await store.load();
		await store.dispose();
		expect(loaded).toEqual([]);
	});

	test("delete of an absent task is a silent no-op", async () => {
		const store = createTaskStore({ baseDir, clock: fixedClock() });
		await expect(store.delete("bg_nope0001")).resolves.toBeUndefined();
		await store.dispose();
	});

	test("default baseDir honors OPENCODE_DRAWERS_DATA_DIR (now folded into resolveDataBaseDir)", async () => {
		const prevEnv = process.env.OPENCODE_DRAWERS_DATA_DIR;
		const envDir = await mkdtemp(join(tmpdir(), "env-"));
		process.env.OPENCODE_DRAWERS_DATA_DIR = envDir;
		try {
			const store = createTaskStore({ clock: fixedClock() });
			await store.save(fullTask({ id: "bg_env000001" }));
			await store.dispose();
			// Env var is a BASE dir; the store default appends the `tasks` leaf.
			const expectedDir = join(envDir, "tasks");
			const files = await readdir(expectedDir);
			expect(files).toContain("bg_env000001.json");
			await rm(envDir, { recursive: true, force: true });
		} finally {
			if (prevEnv === undefined) {
				delete process.env.OPENCODE_DRAWERS_DATA_DIR;
			} else {
				process.env.OPENCODE_DRAWERS_DATA_DIR = prevEnv;
			}
		}
	});

	test("default baseDir honors XDG_DATA_HOME", async () => {
		const prev = process.env.XDG_DATA_HOME;
		const xdg = await mkdtemp(join(tmpdir(), "xdg-"));
		process.env.XDG_DATA_HOME = xdg;
		try {
			const store = createTaskStore({ clock: fixedClock() });
			await store.save(fullTask({ id: "bg_xdg00001" }));
			await store.dispose();
			const expectedDir = join(xdg, "opencode-drawers", "tasks");
			const files = await readdir(expectedDir);
			expect(files).toContain("bg_xdg00001.json");
			await rm(xdg, { recursive: true, force: true });
		} finally {
			if (prev === undefined) {
				delete process.env.XDG_DATA_HOME;
			} else {
				process.env.XDG_DATA_HOME = prev;
			}
		}
	});
});

describe("resolveDataBaseDir", () => {
	let prevEnv: string | undefined;
	let prevXdg: string | undefined;

	beforeEach(() => {
		prevEnv = process.env.OPENCODE_DRAWERS_DATA_DIR;
		prevXdg = process.env.XDG_DATA_HOME;
	});

	afterEach(() => {
		if (prevEnv === undefined) {
			delete process.env.OPENCODE_DRAWERS_DATA_DIR;
		} else {
			process.env.OPENCODE_DRAWERS_DATA_DIR = prevEnv;
		}
		if (prevXdg === undefined) {
			delete process.env.XDG_DATA_HOME;
		} else {
			process.env.XDG_DATA_HOME = prevXdg;
		}
	});

	test("explicit wins over env and XDG", () => {
		process.env.OPENCODE_DRAWERS_DATA_DIR = "/env/base";
		process.env.XDG_DATA_HOME = "/xdg";
		expect(resolveDataBaseDir("/explicit/base")).toBe("/explicit/base");
	});

	test("env wins over XDG", () => {
		process.env.OPENCODE_DRAWERS_DATA_DIR = "/env/base";
		process.env.XDG_DATA_HOME = "/xdg";
		expect(resolveDataBaseDir()).toBe("/env/base");
	});

	test("XDG fallback when env is unset, namespaced under opencode-drawers", () => {
		delete process.env.OPENCODE_DRAWERS_DATA_DIR;
		process.env.XDG_DATA_HOME = "/xdg";
		expect(resolveDataBaseDir()).toBe(join("/xdg", "opencode-drawers"));
	});

	test("home fallback when neither env nor XDG is set", () => {
		delete process.env.OPENCODE_DRAWERS_DATA_DIR;
		delete process.env.XDG_DATA_HOME;
		expect(resolveDataBaseDir()).toBe(
			join(homedir(), ".local", "share", "opencode-drawers"),
		);
	});

	test("empty-string env is ignored, falling through to XDG", () => {
		process.env.OPENCODE_DRAWERS_DATA_DIR = "";
		process.env.XDG_DATA_HOME = "/xdg";
		expect(resolveDataBaseDir()).toBe(join("/xdg", "opencode-drawers"));
	});

	test("always returns a string (never undefined)", () => {
		delete process.env.OPENCODE_DRAWERS_DATA_DIR;
		delete process.env.XDG_DATA_HOME;
		expect(typeof resolveDataBaseDir()).toBe("string");
	});
});
