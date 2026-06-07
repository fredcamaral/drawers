import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FsFacade, IdGenerator } from "@drawers/core";
import type { ToolContext } from "@opencode-ai/plugin";
import { createStructuredOutputTool } from "../runtime/structured/tool";
import { compileSchema } from "../runtime/structured/validate";
import type { JournalEntry } from "../runtime/types";
import { createWorkflowEngine } from "./engine";
import { computeCallKey } from "./journal";

/**
 * Engine tests for the workflows plugin (Task 4.1.2). Everything is faked: the
 * SDK surface is an inert {@link makeClient}, persistence runs over an in-memory
 * {@link makeFs}, and the clock is fixed. No real opencode, no real timers.
 *
 * The run store and the workflow-tasks store both live under the SAME in-memory
 * fs but in DIFFERENT subdirectories (`workflow-runs`, `workflow-tasks`,
 * `workflow-scripts`), so a single fs fake exercises the whole layout.
 */

function basename(path: string): string {
	const i = path.lastIndexOf("/");
	return i === -1 ? path : path.slice(i + 1);
}
function dirname(path: string): string {
	const i = path.lastIndexOf("/");
	return i === -1 ? "" : path.slice(0, i);
}

/**
 * In-memory fs. `readdir` returns BASENAMES of files whose PARENT dir matches the
 * requested dir (the store re-joins with baseDir), mirroring node's readdir.
 * `writeFileSync`/`mkdirSync`-equivalents are folded into the async facade since
 * the engine only ever uses the async surface for scripts too.
 */
function makeFs(initial: Record<string, string> = {}) {
	const files = new Map<string, string>(Object.entries(initial));
	const facade: FsFacade = {
		mkdir: async () => undefined,
		readdir: async (dir: string) => {
			const out: string[] = [];
			for (const key of files.keys()) {
				if (dirname(key) === dir) {
					out.push(basename(key));
				}
			}
			return out;
		},
		readFile: async (path: string) => {
			const f = files.get(path);
			if (f === undefined) {
				const err = new Error("ENOENT") as Error & { code: string };
				err.code = "ENOENT";
				throw err;
			}
			return f;
		},
		writeFile: async (path: string, data: string) => {
			files.set(path, data);
		},
		rename: async (from: string, to: string) => {
			const v = files.get(from);
			if (v !== undefined) {
				files.set(to, v);
				files.delete(from);
			}
		},
		rm: async (path: string) => {
			files.delete(path);
		},
	};
	return { facade, files };
}

/**
 * A scripted EngineClient-shaped fake. `idleAfterPrompt` controls whether a
 * launched child ever "completes": when false (the default), the inert client
 * never emits an idle, so an `agent()` call stays in flight — letting us assert
 * `startRun` returns BEFORE the run settles.
 */
function makeClient() {
	return {
		session: {
			create: async () => ({ data: { id: "ses_child" } }),
			promptAsync: async () => undefined,
			abort: async () => undefined,
			messages: async () => ({ data: [] }),
			get: async () => ({ data: { id: "ses_child" } }),
			// Empty status map: absent = idle-equivalent, no liveness veto (Task 7.1.1).
			status: async () => ({ data: {} }),
		},
	};
}

const noopLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

const BASE = "/wf-data";
const NOW = 1_000_000;
const clock = { now: () => NOW };

/** Deterministic wf_ id generator over a fixed list. */
function fixedIds(...ids: string[]): IdGenerator {
	let i = 0;
	return {
		next: () => {
			const id = ids[i] ?? `wf_overflow${i}`;
			i += 1;
			return id;
		},
	};
}

const META = `export const meta = { name: "demo", description: "d" };\n`;

/** A script that hangs forever: launches a child the inert client never idles. */
const HANGING = `${META}await agent("do work");\nreturn "done";\n`;
/** A script that returns immediately with no agent calls. */
const INSTANT = `${META}return args;\n`;
/** A syntactically broken script (TypeScript annotation → acorn parse failure). */
const BROKEN = `${META}const x: number = 1;\nreturn x;\n`;

describe("createWorkflowEngine — startRun returns immediately", () => {
	test("returns runId + scriptPath before the run settles, and persists the script", async () => {
		const { facade, files } = makeFs();
		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock,
			logger: noopLogger,
			ids: fixedIds("wf_aaaa1111"),
		});

		// HANGING never settles against the inert client, so this resolves while the
		// run is still in flight.
		const handle = await engine.startRun({
			source: HANGING,
			parentSessionID: "ses_parent",
		});

		expect(handle.runId).toBe("wf_aaaa1111");
		expect(handle.scriptPath).toBe(`${BASE}/workflow-scripts/wf_aaaa1111.js`);
		expect(handle.name).toBe("demo");

		// Script source persisted to disk before execution.
		expect(files.get(handle.scriptPath)).toBe(HANGING);

		// In-memory handle exists and is still running (never settled).
		const status = engine.statusOf("wf_aaaa1111");
		expect(status?.record.status).toBe("running");

		await engine.dispose();
	});

	test("description falls back to 'workflow' when meta name cannot be extracted", async () => {
		const { facade } = makeFs();
		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock,
			logger: noopLogger,
			ids: fixedIds("wf_bbbb2222"),
		});

		// No meta → name extraction throws internally; description falls back.
		const handle = await engine.startRun({
			source: "return 1;\n",
			parentSessionID: "ses_parent",
		});
		expect(handle.name).toBe("workflow");
		const status = engine.statusOf("wf_bbbb2222");
		expect(status?.record.description).toBe("workflow");

		await engine.dispose();
	});
});

describe("createWorkflowEngine — settle updates record + queues notice", () => {
	test("an instant run completes: record flips, returnValue captured, notice queued with hint", async () => {
		const { facade } = makeFs();
		const notices: { taskId: string; status: string }[] = [];
		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock,
			logger: noopLogger,
			ids: fixedIds("wf_cccc3333"),
			onNotify: (n) => notices.push({ taskId: n.taskId, status: n.status }),
		});

		const handle = await engine.startRun({
			source: INSTANT,
			args: { hello: "world" },
			parentSessionID: "ses_parent",
		});

		// Await the run's settle sync point (the journal-drain step adds microtask
		// hops, so counting fixed ticks no longer suffices).
		await engine.statusOf(handle.runId)?.settled;

		const status = engine.statusOf(handle.runId);
		expect(status?.record.status).toBe("completed");
		expect(status?.record.returnValue).toEqual({ hello: "world" });
		expect(status?.record.completedAt).toBe(NOW);

		// A terminal notice is queued for the parent, with the workflow_status hint.
		const pending = engine.queue.pending("ses_parent");
		expect(pending).toHaveLength(1);
		expect(pending[0]?.taskId).toBe("wf_cccc3333");
		expect(pending[0]?.status).toBe("completed");
		expect(pending[0]?.hint).toContain("workflow_status");
		expect(pending[0]?.hint).toContain("wf_cccc3333");

		// onNotify fired (the toast path).
		expect(notices).toEqual([{ taskId: "wf_cccc3333", status: "completed" }]);

		await engine.dispose();
	});

	test("a syntactically broken script settles to error: record + notice both error", async () => {
		const { facade } = makeFs();
		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock,
			logger: noopLogger,
			ids: fixedIds("wf_dddd4444"),
		});

		const handle = await engine.startRun({
			source: BROKEN,
			parentSessionID: "ses_parent",
		});
		// Await the run's settle sync point (the journal-drain step adds microtask
		// hops, so counting fixed ticks no longer suffices).
		await engine.statusOf(handle.runId)?.settled;

		const status = engine.statusOf(handle.runId);
		expect(status?.record.status).toBe("error");
		expect(status?.record.error).toBeTruthy();

		const pending = engine.queue.pending("ses_parent");
		expect(pending[0]?.status).toBe("error");

		await engine.dispose();
	});
});

describe("createWorkflowEngine — statusOf progress accumulation", () => {
	test("onProgress events accumulate onto the handle and are visible via statusOf", async () => {
		const { facade } = makeFs();
		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock,
			logger: noopLogger,
			ids: fixedIds("wf_eeee5555"),
		});

		const handle = await engine.startRun({
			source: `${META}log("step one");\nlog("step two");\nreturn null;\n`,
			parentSessionID: "ses_parent",
		});
		await engine.statusOf(handle.runId)?.settled;

		const status = engine.statusOf(handle.runId);
		const logs = (status?.progress ?? []).filter((e) => e.type === "log");
		// Events are engine-stamped at the onProgress boundary (Task 6.2.1): each
		// carries `at = clock.now()` (the fixed NOW here).
		expect(logs).toEqual([
			{ type: "log", message: "step one", at: NOW },
			{ type: "log", message: "step two", at: NOW },
		]);

		await engine.dispose();
	});
});

describe("createWorkflowEngine — sub-workflow resolver wiring (spec §8)", () => {
	test("a top-level run resolves a saved workflow by name and returns its value", async () => {
		// The saved child lives at <dir>/.opencode/workflows/helper.js — the engine's
		// resolver reads it off the SAME in-memory fs. The child returns instantly
		// (no agents), so the parent settles without the inert client ever idling.
		const CHILD = `export const meta = { name: "helper", description: "h" };\nreturn { marker: "HELPER_OK", got: args };\n`;
		const { facade } = makeFs({
			"/proj/.opencode/workflows/helper.js": CHILD,
		});
		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock,
			logger: noopLogger,
			ids: fixedIds("wf_sub00001"),
		});

		const PARENT = `${META}const r = await workflow("helper", { n: 1 });\nreturn r;\n`;
		const handle = await engine.startRun({
			source: PARENT,
			parentSessionID: "ses_parent",
		});
		// Await the run's settle directly (it has no live agents → resolves promptly).
		await engine.statusOf(handle.runId)?.settled;

		const status = engine.statusOf(handle.runId);
		expect(status?.record.status).toBe("completed");
		expect(status?.record.returnValue).toEqual({
			marker: "HELPER_OK",
			got: { n: 1 },
		});

		await engine.dispose();
	});

	test("an unknown sub-workflow name surfaces as a catchable script error", async () => {
		const { facade } = makeFs();
		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock,
			logger: noopLogger,
			ids: fixedIds("wf_sub00002"),
		});
		// The script catches the resolver throw and returns a sentinel — proving the
		// error is catchable (not a detonation).
		const PARENT = `${META}try { await workflow("ghost"); return "NOT_THROWN"; } catch (e) { return "CAUGHT:" + e.message; }\n`;
		const handle = await engine.startRun({
			source: PARENT,
			parentSessionID: "ses_parent",
		});
		await engine.statusOf(handle.runId)?.settled;

		const status = engine.statusOf(handle.runId);
		expect(status?.record.status).toBe("completed");
		expect(String(status?.record.returnValue)).toContain("CAUGHT");
		expect(String(status?.record.returnValue)).toContain("ghost");

		await engine.dispose();
	});
});

describe("createWorkflowEngine — settled promise on the handle (Task 4.3.2)", () => {
	test("an instant run exposes a settled promise that resolves after the record flips", async () => {
		const { facade } = makeFs();
		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock,
			logger: noopLogger,
			ids: fixedIds("wf_settle01"),
		});

		const handle = await engine.startRun({
			source: INSTANT,
			args: { v: 1 },
			parentSessionID: "ses_parent",
		});
		const live = engine.statusOf(handle.runId);
		expect(live?.settled).toBeInstanceOf(Promise);

		await live?.settled;
		// After settle resolves, the record is terminal.
		expect(engine.statusOf(handle.runId)?.record.status).toBe("completed");

		await engine.dispose();
	});
});

describe("createWorkflowEngine — default fs (no injected facade)", () => {
	// Regression for the live-harness Scenario C bug: the production plugin entry
	// builds the engine WITHOUT an fs, and the old engine gated script-persist /
	// journal-write / resume-read on `if (fs)` — so in production scripts were never
	// written and resume could not read the prior script ("no fs configured").
	// The engine must default fs to a real node facade so all three paths work.
	test("with no injected fs, the script is persisted to disk and a resume reads it back", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wf-engine-defaultfs-"));
		try {
			const engine = createWorkflowEngine({
				client: makeClient(),
				directory: "/proj",
				dataDir: dir,
				clock,
				logger: noopLogger,
				ids: fixedIds("wf_real00001", "wf_real00002"),
				// NO fs — exercise the production default.
			});

			const h1 = await engine.startRun({
				source: INSTANT,
				args: { v: 1 },
				parentSessionID: "ses_parent",
			});
			await engine.statusOf(h1.runId)?.settled;

			// The script was actually written to disk (the bug: it never was).
			const persisted = await readFile(h1.scriptPath, "utf-8");
			expect(persisted).toBe(INSTANT);

			// A resume with no explicit source reads that persisted script back — the
			// path that threw "no fs configured" before the fix.
			const h2 = await engine.startRun({
				resumeFromRunId: h1.runId,
				parentSessionID: "ses_parent",
			});
			await engine.statusOf(h2.runId)?.settled;
			const status = engine.statusOf(h2.runId);
			expect(status?.record.status).toBe("completed");
			expect(status?.record.resumedFrom).toBe(h1.runId);

			await engine.dispose();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("createWorkflowEngine — default-install resolution (no dataDir, no env)", () => {
	// Regression: with NO dataDir and NO OPENCODE_DRAWERS_DATA_DIR, the old engine
	// resolved `base` to undefined, so scriptsDir/journalsDir were undefined and
	// script persistence + journal writes silently no-op'd — breaking restart resume
	// for DEFAULT installs. The canonical resolveDataBaseDir always returns a string
	// (XDG-namespaced), so scripts and journals must persist under
	// `$XDG/opencode-drawers/workflow-*`.
	test("with no dataDir and no env var, scripts + journals persist under $XDG/opencode-drawers/workflow-*", async () => {
		const xdg = await mkdtemp(join(tmpdir(), "wf-xdg-"));
		const prevEnv = process.env.OPENCODE_DRAWERS_DATA_DIR;
		const prevXdg = process.env.XDG_DATA_HOME;
		delete process.env.OPENCODE_DRAWERS_DATA_DIR;
		process.env.XDG_DATA_HOME = xdg;
		try {
			const base = join(xdg, "opencode-drawers");
			const { writeFile, mkdir } = await import("node:fs/promises");
			const SCRIPT = `export const meta = { name: "j", description: "d" };\nconst r = await agent("do work", { label: "a" });\nreturn r;\n`;
			const key = computeCallKey({ prompt: "do work", label: "a" });
			const entry: JournalEntry = {
				index: 0,
				key,
				status: "ok",
				result: "CACHED_RESULT",
			};

			// Seed a terminal prior run (record + script + journal) directly under the
			// XDG-resolved base so a resume replays the cached entry into a NEW journal.
			await mkdir(join(base, "workflow-runs"), { recursive: true });
			await mkdir(join(base, "workflow-scripts"), { recursive: true });
			await mkdir(join(base, "workflow-journals"), { recursive: true });
			await writeFile(
				join(base, "workflow-scripts", "wf_prior0001.js"),
				SCRIPT,
				"utf-8",
			);
			await writeFile(
				join(base, "workflow-journals", "wf_prior0001.jsonl"),
				`${JSON.stringify(entry)}\n`,
				"utf-8",
			);
			await writeFile(
				join(base, "workflow-runs", "wf_prior0001.json"),
				JSON.stringify({
					id: "wf_prior0001",
					parentSessionID: "ses_parent",
					status: "completed",
					description: "j",
					createdAt: NOW - 1000,
					completedAt: NOW - 500,
					scriptPath: join(base, "workflow-scripts", "wf_prior0001.js"),
				}),
				"utf-8",
			);

			// NO dataDir, NO fs — the engine must resolve XDG and use a real node facade.
			const engine = createWorkflowEngine({
				client: makeClient(),
				directory: "/proj",
				clock,
				logger: noopLogger,
				ids: fixedIds("wf_resume0001"),
			});
			await engine.ready();

			const h2 = await engine.startRun({
				resumeFromRunId: "wf_prior0001",
				parentSessionID: "ses_parent",
			});
			await engine.statusOf(h2.runId)?.settled;

			// The new run's script was persisted (resume re-persists the prior script).
			const persistedScript = await readFile(
				join(base, "workflow-scripts", "wf_resume0001.js"),
				"utf-8",
			);
			expect(persistedScript).toBe(SCRIPT);

			// The new run's journal was written under the XDG-resolved journals dir —
			// the path that silently no-op'd for default installs before the fix.
			const newJournal = await readFile(
				join(base, "workflow-journals", "wf_resume0001.jsonl"),
				"utf-8",
			);
			const lines = newJournal
				.split("\n")
				.filter((l) => l.length > 0)
				.map((l) => JSON.parse(l) as JournalEntry);
			expect(lines).toHaveLength(1);
			expect(lines[0]?.result).toBe("CACHED_RESULT");
			expect(engine.statusOf(h2.runId)?.record.status).toBe("completed");

			await engine.dispose();
		} finally {
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
			await rm(xdg, { recursive: true, force: true });
		}
	});
});

describe("createWorkflowEngine — journal is drained before settle (Task 4.3.2)", () => {
	// Regression for the live-harness Scenario C SECOND bug: journal appends were
	// fire-and-forget (`void journal?.record(e)`), so when a single-turn `opencode
	// run` exited the instant the turn ended, the last appends had not flushed — a
	// later resume then replayed NOTHING ("0 cached / N live"). The fix drains all
	// journal writes before `handle.settled` resolves, so wait_ms guarantees a
	// durable journal. Driven deterministically via the replay re-record path: a
	// seeded prior journal replays as cached (no live agent needed against the inert
	// client) and re-records into the NEW journal, which must be on disk after settle.
	test("a resumed run's re-recorded journal is durable on disk by the time settled resolves", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wf-engine-journaldrain-"));
		try {
			const { writeFile, mkdir } = await import("node:fs/promises");
			const SCRIPT = `export const meta = { name: "j", description: "d" };\nconst r = await agent("do work", { label: "a" });\nreturn r;\n`;
			const key = computeCallKey({ prompt: "do work", label: "a" });
			const entry: JournalEntry = {
				index: 0,
				key,
				status: "ok",
				result: "CACHED_RESULT",
			};

			// Seed a TERMINAL prior run (record + script + journal) directly on disk so
			// startup recovery loads it and the resume guard passes. The journal carries
			// our matching cached entry.
			await mkdir(join(dir, "workflow-runs"), { recursive: true });
			await mkdir(join(dir, "workflow-scripts"), { recursive: true });
			await mkdir(join(dir, "workflow-journals"), { recursive: true });
			await writeFile(
				join(dir, "workflow-scripts", "wf_prior0001.js"),
				SCRIPT,
				"utf-8",
			);
			await writeFile(
				join(dir, "workflow-journals", "wf_prior0001.jsonl"),
				`${JSON.stringify(entry)}\n`,
				"utf-8",
			);
			await writeFile(
				join(dir, "workflow-runs", "wf_prior0001.json"),
				JSON.stringify({
					id: "wf_prior0001",
					parentSessionID: "ses_parent",
					status: "completed",
					description: "j",
					createdAt: NOW - 1000,
					completedAt: NOW - 500,
					scriptPath: join(dir, "workflow-scripts", "wf_prior0001.js"),
				}),
				"utf-8",
			);

			const engine = createWorkflowEngine({
				client: makeClient(),
				directory: "/proj",
				dataDir: dir,
				clock,
				logger: noopLogger,
				ids: fixedIds("wf_resume0001"),
			});
			await engine.ready();

			// Resume: the seeded entry replays as cached; onRecord re-records into the
			// NEW journal. After settled resolves, that file MUST be on disk (drained).
			const h2 = await engine.startRun({
				resumeFromRunId: "wf_prior0001",
				parentSessionID: "ses_parent",
			});
			await engine.statusOf(h2.runId)?.settled;

			const newJournal = await readFile(
				join(dir, "workflow-journals", "wf_resume0001.jsonl"),
				"utf-8",
			);
			const lines = newJournal
				.split("\n")
				.filter((l) => l.length > 0)
				.map((l) => JSON.parse(l) as JournalEntry);
			expect(lines).toHaveLength(1);
			expect(lines[0]?.key).toBe(key);
			expect(lines[0]?.result).toBe("CACHED_RESULT");
			// The resumed run completed with the cached value (fully replayed).
			expect(engine.statusOf(h2.runId)?.record.status).toBe("completed");
			expect(engine.statusOf(h2.runId)?.record.returnValue).toBe(
				"CACHED_RESULT",
			);

			await engine.dispose();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("createWorkflowEngine — startup recovery", () => {
	test("a record left 'running' by a dead process flips to error 'interrupted by restart'", async () => {
		const runsDir = `${BASE}/workflow-runs`;
		const staleRecord = {
			id: "wf_stale001",
			parentSessionID: "ses_parent",
			status: "running",
			description: "interrupted",
			createdAt: NOW - 5000,
			scriptPath: `${BASE}/workflow-scripts/wf_stale001.js`,
		};
		const terminalRecord = {
			id: "wf_done0001",
			parentSessionID: "ses_parent",
			status: "completed",
			description: "finished earlier",
			createdAt: NOW - 9000,
			completedAt: NOW - 8000,
			scriptPath: `${BASE}/workflow-scripts/wf_done0001.js`,
		};
		const { facade } = makeFs({
			[`${runsDir}/wf_stale001.json`]: JSON.stringify(staleRecord),
			[`${runsDir}/wf_done0001.json`]: JSON.stringify(terminalRecord),
		});

		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock,
			logger: noopLogger,
		});
		await engine.ready();

		// Stale running record flipped to error.
		const stale = engine.statusOf("wf_stale001");
		expect(stale?.record.status).toBe("error");
		expect(stale?.record.error).toContain("interrupted by restart");
		expect(stale?.progress).toEqual([]);

		// Terminal record remains readable, unchanged.
		const done = engine.statusOf("wf_done0001");
		expect(done?.record.status).toBe("completed");

		// Terminal record seeded the notification queue (un-notified); the recovered
		// error from the stale run is also a terminal notice.
		const pendingIds = engine.queue
			.pending("ses_parent")
			.map((n) => n.taskId)
			.sort();
		expect(pendingIds).toContain("wf_done0001");

		await engine.dispose();
	});
});

describe("createWorkflowEngine — shared registry, no crosstalk", () => {
	test("two sessions route structured results through the engine's one registry independently", async () => {
		const { facade } = makeFs();
		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock,
			logger: noopLogger,
		});

		// The single global structured_output tool over the engine registry — the
		// same instance every run shares.
		const toolDef = createStructuredOutputTool(engine.registry);

		const schemaA = compileSchema({ type: "object", required: ["a"] });
		const schemaB = compileSchema({ type: "object", required: ["b"] });
		engine.registry.register("ses_one", schemaA);
		engine.registry.register("ses_two", schemaB);

		const ctx = (sessionID: string) =>
			({ sessionID }) as unknown as ToolContext;

		// Session one stores its result; session two its own — no crosstalk.
		const r1 = await toolDef.execute(
			{ result: JSON.stringify({ a: 1 }) },
			ctx("ses_one"),
		);
		const r2 = await toolDef.execute(
			{ result: JSON.stringify({ b: 2 }) },
			ctx("ses_two"),
		);
		expect(r1).toBe("accepted");
		expect(r2).toBe("accepted");

		expect(engine.registry.resultFor("ses_one")).toEqual({
			present: true,
			value: { a: 1 },
		});
		expect(engine.registry.resultFor("ses_two")).toEqual({
			present: true,
			value: { b: 2 },
		});

		await engine.dispose();
	});
});

describe("createWorkflowEngine — stopRun", () => {
	test("stopRun aborts a live run, flips the record to cancelled, and queues a notice", async () => {
		const { facade } = makeFs();
		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock,
			logger: noopLogger,
			ids: fixedIds("wf_ffff6666"),
		});

		const handle = await engine.startRun({
			source: HANGING,
			parentSessionID: "ses_parent",
		});
		expect(engine.statusOf(handle.runId)?.record.status).toBe("running");

		engine.stopRun(handle.runId);

		const status = engine.statusOf(handle.runId);
		expect(status?.record.status).toBe("cancelled");

		const pending = engine.queue.pending("ses_parent");
		expect(pending.some((n) => n.taskId === handle.runId)).toBe(true);

		await engine.dispose();
	});
});

// ---- Task 4.2.2: resume wiring -------------------------------------------

/**
 * An auto-completing client: every launched child reaches `completed` the moment
 * a `session.idle` event is driven through `engine.handleEvent`, AND its single
 * assistant message text is `reply`. Combined with a MUTABLE clock bumped past
 * the 5s min-idle grace, completion fires synchronously with no real timers.
 *
 * `session.create` hands out incrementing ids so a multi-agent script gets
 * distinct child sessions (the completion gate + registry track by sessionID).
 */
function makeCompletingClient(reply = "AGENT_RESULT") {
	const sessions: string[] = [];
	let seq = 0;
	return {
		sessions,
		client: {
			session: {
				create: async () => {
					seq += 1;
					const id = `ses_child_${seq}`;
					sessions.push(id);
					return { data: { id } };
				},
				promptAsync: async () => undefined,
				abort: async () => undefined,
				messages: async () => ({
					data: [
						{
							info: {
								role: "assistant" as const,
								time: { created: NOW, completed: NOW },
							},
							parts: [{ type: "text", text: reply }],
						},
					],
				}),
				get: async () => ({ data: { id: "ses_child" } }),
				// Absent status = idle-equivalent; completed message = finished turn.
				status: async () => ({ data: {} }),
			},
		},
	};
}

/**
 * A completing client whose child assistant message carries a completed TOOL part
 * but NO text (Task 7.2.1 test seam). The gate's hasValidOutput accepts the tool
 * part so the turn completes, yet lastAssistantText is "" → the agent primitive
 * resolves "" and reports an `empty_output` diagnostic.
 */
function makeToolOnlyCompletingClient() {
	const sessions: string[] = [];
	let seq = 0;
	return {
		sessions,
		client: {
			session: {
				create: async () => {
					seq += 1;
					const id = `ses_child_${seq}`;
					sessions.push(id);
					return { data: { id } };
				},
				promptAsync: async () => undefined,
				abort: async () => undefined,
				messages: async () => ({
					data: [
						{
							info: {
								role: "assistant" as const,
								time: { created: NOW, completed: NOW },
							},
							parts: [
								{ type: "tool", state: { status: "completed", output: "ran" } },
							],
						},
					],
				}),
				get: async () => ({ data: { id: "ses_child" } }),
				status: async () => ({ data: {} }),
			},
		},
	};
}

/** A clock whose `now` is a mutable box; bump past 5000ms to clear idle grace. */
function bumpClock(start: number) {
	const box = { t: start };
	return {
		clock: { now: () => box.t },
		bump: (ms: number) => {
			box.t += ms;
		},
	};
}

/** Drain the microtask queue: the async parse→eval→acquire→create chain plus
 * the settle continuations take many turns to propagate before asserting. */
async function flush(turns = 60): Promise<void> {
	for (let i = 0; i < turns; i += 1) {
		await Promise.resolve();
	}
}

const JOURNALS = (id: string) => `${BASE}/workflow-journals/${id}.jsonl`;

/** Serialize journal entries to the JSONL file format the journal writes. */
function jsonl(entries: JournalEntry[]): string {
	return `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

/** Read a journal file's entries from the fake fs (missing → []). */
function readJournal(files: Map<string, string>, id: string): JournalEntry[] {
	const raw = files.get(JOURNALS(id));
	if (raw === undefined) {
		return [];
	}
	return raw
		.split("\n")
		.filter((l) => l.length > 0)
		.map((l) => JSON.parse(l) as JournalEntry);
}

const FEED = (id: string) => `${BASE}/workflow-feed/${id}.jsonl`;

/** Read a feed file's parsed lines from the fake fs (missing → []) (Task 8.1.2). */
function readFeed(
	files: Map<string, string>,
	id: string,
): Array<Record<string, unknown>> {
	const raw = files.get(FEED(id));
	if (raw === undefined) {
		return [];
	}
	return raw
		.split("\n")
		.filter((l) => l.length > 0)
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

/**
 * Drive a single-agent child to completion: launch dispatched the prompt async,
 * so bump the clock past the grace and emit the child's idle event. Returns once
 * the run's settle microtasks have drained.
 */
async function driveIdle(
	engine: ReturnType<typeof createWorkflowEngine>,
	sessionID: string,
	bump: (ms: number) => void,
): Promise<void> {
	bump(6000);
	await engine.handleEvent({
		type: "session.idle",
		properties: { sessionID },
		// biome-ignore lint/suspicious/noExplicitAny: the gate reads only type+properties.
	} as any);
	await flush();
}

const ONE_AGENT = `${META}const r = await agent("do work");\nreturn r;\n`;

describe("createWorkflowEngine — fresh run journals to disk", () => {
	test("a fresh run's settled agent result lands in <dataDir>/workflow-journals/<runId>.jsonl", async () => {
		const { facade, files } = makeFs();
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeCompletingClient("HELLO");
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_fresh001"),
		});
		await engine.ready();

		const handle = await engine.startRun({
			source: ONE_AGENT,
			parentSessionID: "ses_parent",
		});
		await flush();
		await driveIdle(engine, sessions[0] as string, bump);

		const status = engine.statusOf(handle.runId);
		expect(status?.record.status).toBe("completed");
		expect(status?.record.returnValue).toBe("HELLO");

		const entries = readJournal(files, "wf_fresh001");
		expect(entries.length).toBe(1);
		expect(entries[0]).toMatchObject({
			index: 0,
			key: computeCallKey({ prompt: "do work" }),
			status: "ok",
			result: "HELLO",
		});

		await engine.dispose();
	});
});

describe("createWorkflowEngine — agent diagnostics persist on the record (Task 7.2.1)", () => {
	test("an empty-output agent settles with an empty_output diagnostic on the run record", async () => {
		const { facade, files } = makeFs();
		const { clock: mclock, bump } = bumpClock(NOW);
		// A child whose assistant message carries a TOOL part but NO text: the gate's
		// hasValidOutput accepts the tool part (turn completes), yet lastAssistantText
		// is "" — the realistic empty_output path (an empty-text message never
		// completes on idle alone, by Phase 7.1's valid-output requirement).
		const { client, sessions } = makeToolOnlyCompletingClient();
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_diag001"),
		});
		await engine.ready();

		const handle = await engine.startRun({
			source: `${META}const r = await agent("do work", { label: "worker" });\nreturn r;\n`,
			parentSessionID: "ses_parent",
		});
		await flush();
		await driveIdle(engine, sessions[0] as string, bump);

		const record = engine.statusOf(handle.runId)?.record;
		expect(record?.status).toBe("completed");
		// The empty "" result is still returned to the script (byte-identical).
		expect(record?.returnValue).toBe("");
		// And the diagnostic is persisted for post-mortem.
		expect(record?.diagnostics).toBeDefined();
		expect(record?.diagnostics).toHaveLength(1);
		expect(record?.diagnostics?.[0]).toMatchObject({
			label: "worker",
			index: 0,
			reason: "empty_output",
		});

		// It round-trips through the persisted JSON on disk too.
		const persisted = JSON.parse(
			files.get(`${BASE}/workflow-runs/wf_diag001.json`) ?? "{}",
		);
		expect(persisted.diagnostics?.[0]?.reason).toBe("empty_output");

		await engine.dispose();
	});

	test("a clean run persists NO diagnostics field", async () => {
		const { facade } = makeFs();
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeCompletingClient("HELLO");
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_clean001"),
		});
		await engine.ready();

		const handle = await engine.startRun({
			source: ONE_AGENT,
			parentSessionID: "ses_parent",
		});
		await flush();
		await driveIdle(engine, sessions[0] as string, bump);

		const record = engine.statusOf(handle.runId)?.record;
		expect(record?.status).toBe("completed");
		expect(record?.diagnostics).toBeUndefined();

		await engine.dispose();
	});
});

/** Seed a completed prior run: its record + a one-entry journal on disk. */
function seedPrior(
	files: Record<string, string>,
	opts: { id: string; result: unknown; args?: unknown; prompt?: string },
): Record<string, string> {
	const prompt = opts.prompt ?? "do work";
	const record = {
		id: opts.id,
		parentSessionID: "ses_parent",
		status: "completed",
		description: "demo",
		createdAt: NOW - 1000,
		completedAt: NOW - 500,
		scriptPath: `${BASE}/workflow-scripts/${opts.id}.js`,
		args: opts.args,
		returnValue: opts.result,
	};
	const entries: JournalEntry[] = [
		{
			index: 0,
			key: computeCallKey({ prompt }),
			status: "ok",
			result: opts.result,
		},
	];
	return {
		...files,
		[`${BASE}/workflow-runs/${opts.id}.json`]: JSON.stringify(record),
		[`${BASE}/workflow-scripts/${opts.id}.js`]: ONE_AGENT,
		[JOURNALS(opts.id)]: jsonl(entries),
	};
}

describe("createWorkflowEngine — resume (same instance)", () => {
	test("same script + same args resume → ZERO launches, identical returnValue, complete new journal", async () => {
		const seeded = seedPrior({}, { id: "wf_prior001", result: "CACHED" });
		const { facade, files } = makeFs(seeded);
		const { clock: mclock } = bumpClock(NOW);
		let creates = 0;
		const { client } = makeCompletingClient();
		const wrapped = {
			session: {
				...client.session,
				create: async () => {
					creates += 1;
					return { data: { id: "ses_unused" } };
				},
			},
		};
		const engine = createWorkflowEngine({
			client: wrapped,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_new00001"),
		});
		await engine.ready();

		const handle = await engine.startRun({
			resumeFromRunId: "wf_prior001",
			parentSessionID: "ses_parent",
		});
		await flush();

		const status = engine.statusOf(handle.runId);
		expect(status?.record.status).toBe("completed");
		expect(status?.record.returnValue).toBe("CACHED");
		expect(status?.record.resumedFrom).toBe("wf_prior001");
		expect(creates).toBe(0);

		const prior = readJournal(files, "wf_prior001");
		const fresh = readJournal(files, "wf_new00001");
		expect(fresh.length).toBe(prior.length);
		expect(fresh[0]).toMatchObject({
			index: 0,
			key: computeCallKey({ prompt: "do work" }),
			status: "ok",
			result: "CACHED",
		});

		await engine.dispose();
	});

	test("edited script: earlier calls cached, the edited call and ALL subsequent run live", async () => {
		const id = "wf_prior003";
		const entries: JournalEntry[] = [
			{
				index: 0,
				key: computeCallKey({ prompt: "first" }),
				status: "ok",
				result: "c0",
			},
			{
				index: 1,
				key: computeCallKey({ prompt: "second" }),
				status: "ok",
				result: "c1",
			},
		];
		const priorScript = `${META}await agent("first");\nawait agent("second");\nreturn null;\n`;
		const editedScript = `${META}await agent("first");\nawait agent("CHANGED");\nreturn "edited";\n`;
		const seeded: Record<string, string> = {
			[`${BASE}/workflow-runs/${id}.json`]: JSON.stringify({
				id,
				parentSessionID: "ses_parent",
				status: "completed",
				description: "demo",
				createdAt: NOW - 1000,
				completedAt: NOW - 500,
				scriptPath: `${BASE}/workflow-scripts/${id}.js`,
			}),
			[`${BASE}/workflow-scripts/${id}.js`]: priorScript,
			[JOURNALS(id)]: jsonl(entries),
		};
		const { facade } = makeFs(seeded);
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeCompletingClient("LIVE");
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_new00003"),
		});
		await engine.ready();

		const handle = await engine.startRun({
			resumeFromRunId: id,
			source: editedScript,
			parentSessionID: "ses_parent",
		});
		await flush();
		await driveIdle(engine, sessions[0] as string, bump);

		const status = engine.statusOf(handle.runId);
		expect(status?.record.status).toBe("completed");
		expect(status?.record.returnValue).toBe("edited");
		expect(sessions.length).toBe(1);

		await engine.dispose();
	});

	test("R4: editing parallel item 0 reruns ONLY item 0; unchanged item 1 replays cached", async () => {
		// Field finding R4 (report §4.3) end-to-end: a parallel() set where item 0's
		// prompt is edited on resume must replay the UNCHANGED, expensive item 1 from
		// the journal — not re-execute it. The old prefix latch re-ran item 1 (4m17s,
		// different answer); per-key occurrence matching keeps it cached. Asserted via
		// exactly ONE live child session (item 0 only).
		const id = "wf_priorR4";
		const entries: JournalEntry[] = [
			{
				index: 0,
				key: computeCallKey({ prompt: "item0-OLD" }),
				status: "ok",
				result: "stale-0",
			},
			{
				index: 1,
				key: computeCallKey({ prompt: "item1-expensive" }),
				status: "ok",
				result: "CACHED-EXPENSIVE",
			},
		];
		const priorScript = `${META}const r = await parallel([\n() => agent("item0-OLD"),\n() => agent("item1-expensive"),\n]);\nreturn r;\n`;
		const editedScript = `${META}const r = await parallel([\n() => agent("item0-EDITED"),\n() => agent("item1-expensive"),\n]);\nreturn r;\n`;
		const seeded: Record<string, string> = {
			[`${BASE}/workflow-runs/${id}.json`]: JSON.stringify({
				id,
				parentSessionID: "ses_parent",
				status: "completed",
				description: "demo",
				createdAt: NOW - 1000,
				completedAt: NOW - 500,
				scriptPath: `${BASE}/workflow-scripts/${id}.js`,
			}),
			[`${BASE}/workflow-scripts/${id}.js`]: priorScript,
			[JOURNALS(id)]: jsonl(entries),
		};
		const { facade } = makeFs(seeded);
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeCompletingClient("LIVE-0");
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_newR4"),
		});
		await engine.ready();

		const handle = await engine.startRun({
			resumeFromRunId: id,
			source: editedScript,
			parentSessionID: "ses_parent",
		});
		await flush();
		// Only item 0 launches a live child; item 1 replays from the journal.
		await driveIdle(engine, sessions[0] as string, bump);

		const status = engine.statusOf(handle.runId);
		expect(status?.record.status).toBe("completed");
		// Item 0 ran live → "LIVE-0"; item 1 replayed its frozen journaled result.
		expect(status?.record.returnValue).toEqual(["LIVE-0", "CACHED-EXPENSIVE"]);
		// The expensive item was NEVER re-executed: exactly one live session.
		expect(sessions.length).toBe(1);

		await engine.dispose();
	});

	test("resume of a still-running run is refused with a stop hint", async () => {
		const { facade } = makeFs();
		const { clock: mclock } = bumpClock(NOW);
		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_live0001", "wf_resume001"),
		});
		await engine.ready();

		const live = await engine.startRun({
			source: HANGING,
			parentSessionID: "ses_parent",
		});
		expect(engine.statusOf(live.runId)?.record.status).toBe("running");

		await expect(
			engine.startRun({
				resumeFromRunId: live.runId,
				parentSessionID: "ses_parent",
			}),
		).rejects.toThrow(/still running/);

		await engine.dispose();
	});

	test("resume with an unknown id errors, listing known run ids", async () => {
		const seeded = seedPrior({}, { id: "wf_known999", result: "Y" });
		const { facade } = makeFs(seeded);
		const { clock: mclock } = bumpClock(NOW);
		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
		});
		await engine.ready();

		await expect(
			engine.startRun({
				resumeFromRunId: "wf_nope",
				parentSessionID: "ses_parent",
			}),
		).rejects.toThrow(/wf_known999/);

		await engine.dispose();
	});

	test("missing prior journal → run goes live with a warn (resume still works)", async () => {
		const id = "wf_nojour01";
		const seeded: Record<string, string> = {
			[`${BASE}/workflow-runs/${id}.json`]: JSON.stringify({
				id,
				parentSessionID: "ses_parent",
				status: "completed",
				description: "demo",
				createdAt: NOW - 1000,
				completedAt: NOW - 500,
				scriptPath: `${BASE}/workflow-scripts/${id}.js`,
			}),
			[`${BASE}/workflow-scripts/${id}.js`]: ONE_AGENT,
		};
		const { facade } = makeFs(seeded);
		const { clock: mclock, bump } = bumpClock(NOW);
		const warns: string[] = [];
		const logger = { ...noopLogger, warn: (m: string) => warns.push(m) };
		const { client, sessions } = makeCompletingClient("LIVERESULT");
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger,
			ids: fixedIds("wf_new00004"),
		});
		await engine.ready();

		const handle = await engine.startRun({
			resumeFromRunId: id,
			parentSessionID: "ses_parent",
		});
		await flush();
		await driveIdle(engine, sessions[0] as string, bump);

		const status = engine.statusOf(handle.runId);
		expect(status?.record.status).toBe("completed");
		expect(status?.record.returnValue).toBe("LIVERESULT");
		expect(sessions.length).toBe(1);
		expect(warns.some((w) => w.toLowerCase().includes("journal"))).toBe(true);

		await engine.dispose();
	});

	test("explicit args override prior args and break the cache at an args-bearing prompt", async () => {
		const id = "wf_priorarg";
		const oldPrompt = "use old";
		const entries: JournalEntry[] = [
			{
				index: 0,
				key: computeCallKey({ prompt: oldPrompt }),
				status: "ok",
				result: "OLD",
			},
		];
		const script = `${META}const r = await agent("use " + args.x);\nreturn r;\n`;
		const seeded: Record<string, string> = {
			[`${BASE}/workflow-runs/${id}.json`]: JSON.stringify({
				id,
				parentSessionID: "ses_parent",
				status: "completed",
				description: "demo",
				createdAt: NOW - 1000,
				completedAt: NOW - 500,
				scriptPath: `${BASE}/workflow-scripts/${id}.js`,
				args: { x: "old" },
			}),
			[`${BASE}/workflow-scripts/${id}.js`]: script,
			[JOURNALS(id)]: jsonl(entries),
		};
		const { facade } = makeFs(seeded);
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeCompletingClient("NEWRESULT");
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_new00005"),
		});
		await engine.ready();

		const handle = await engine.startRun({
			resumeFromRunId: id,
			args: { x: "new" },
			parentSessionID: "ses_parent",
		});
		await flush();
		await driveIdle(engine, sessions[0] as string, bump);

		const status = engine.statusOf(handle.runId);
		expect(status?.record.status).toBe("completed");
		expect(status?.record.returnValue).toBe("NEWRESULT");
		expect(status?.record.args).toEqual({ x: "new" });
		expect(sessions.length).toBe(1);

		await engine.dispose();
	});
});

// ---- Task 4.3.1: token budget --------------------------------------------

/**
 * A completing client whose assistant messages carry `tokens` metadata, so the
 * budget provider can sum real output+reasoning spend. Each launched child gets
 * a distinct session id; `session.messages` returns one assistant message with
 * the scripted token counts.
 */
function makeBudgetClient(tokens: { output: number; reasoning: number }) {
	const sessions: string[] = [];
	let seq = 0;
	return {
		sessions,
		client: {
			session: {
				create: async () => {
					seq += 1;
					const id = `ses_child_${seq}`;
					sessions.push(id);
					return { data: { id } };
				},
				promptAsync: async () => undefined,
				abort: async () => undefined,
				messages: async () => ({
					data: [
						{
							info: {
								role: "assistant" as const,
								tokens,
								time: { created: NOW, completed: NOW },
							},
							parts: [{ type: "text", text: "REPLY" }],
						},
					],
				}),
				get: async () => ({ data: { id: "ses_child" } }),
				// Absent status = idle-equivalent; completed message = finished turn.
				status: async () => ({ data: {} }),
			},
		},
	};
}

describe("createWorkflowEngine — token budget", () => {
	test("budgetTokens threads a budget; settle fills budgetTotal/budgetSpent", async () => {
		const { facade } = makeFs();
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeBudgetClient({ output: 30, reasoning: 5 });
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_budget01"),
		});
		await engine.ready();

		const handle = await engine.startRun({
			source: ONE_AGENT,
			parentSessionID: "ses_parent",
			budgetTokens: 1000,
		});
		await flush();
		await driveIdle(engine, sessions[0] as string, bump);

		const status = engine.statusOf(handle.runId);
		expect(status?.record.status).toBe("completed");
		// One child spent 30 output + 5 reasoning = 35 against a 1000 ceiling.
		expect(status?.record.budgetTotal).toBe(1000);
		expect(status?.record.budgetSpent).toBe(35);

		await engine.dispose();
	});

	test("a live run exposes the budget view on its handle for live spend reads", async () => {
		const { facade } = makeFs();
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeBudgetClient({ output: 30, reasoning: 5 });
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_budget02"),
		});
		await engine.ready();

		const handle = await engine.startRun({
			source: ONE_AGENT,
			parentSessionID: "ses_parent",
			budgetTokens: 1000,
		});
		await flush();
		await driveIdle(engine, sessions[0] as string, bump);

		// The handle carries a live budget view reading the SAME accumulator.
		const h = engine.statusOf(handle.runId);
		expect(h?.budget?.total).toBe(1000);
		expect(h?.budget?.spent()).toBe(35);
		expect(h?.budget?.remaining()).toBe(965);

		await engine.dispose();
	});

	test("absent budgetTokens → no budget on the handle, no budget fields on the record", async () => {
		const { facade } = makeFs();
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeBudgetClient({ output: 30, reasoning: 5 });
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_budget03"),
		});
		await engine.ready();

		const handle = await engine.startRun({
			source: ONE_AGENT,
			parentSessionID: "ses_parent",
		});
		await flush();
		await driveIdle(engine, sessions[0] as string, bump);

		const status = engine.statusOf(handle.runId);
		expect(status?.record.status).toBe("completed");
		expect(status?.budget).toBeUndefined();
		expect(status?.record.budgetTotal).toBeUndefined();
		expect(status?.record.budgetSpent).toBeUndefined();

		await engine.dispose();
	});
});

describe("createWorkflowEngine — resume across restart", () => {
	test("a second engine instance over the SAME fake-fs resumes to an all-cache replay", async () => {
		const { facade, files } = makeFs();
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeCompletingClient("RESTART");
		const engine1 = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_restart01"),
		});
		await engine1.ready();
		await engine1.startRun({
			source: ONE_AGENT,
			parentSessionID: "ses_parent",
		});
		await flush();
		await driveIdle(engine1, sessions[0] as string, bump);
		expect(engine1.statusOf("wf_restart01")?.record.status).toBe("completed");
		expect(readJournal(files, "wf_restart01").length).toBe(1);
		await engine1.dispose();

		let creates2 = 0;
		const client2 = {
			session: {
				create: async () => {
					creates2 += 1;
					return { data: { id: "ses_c2" } };
				},
				promptAsync: async () => undefined,
				abort: async () => undefined,
				messages: async () => ({ data: [] }),
				get: async () => ({ data: { id: "ses_c2" } }),
				status: async () => ({ data: {} }),
			},
		};
		const engine2 = createWorkflowEngine({
			client: client2,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: { now: () => NOW },
			logger: noopLogger,
			ids: fixedIds("wf_restart02"),
		});
		await engine2.ready();

		const handle = await engine2.startRun({
			resumeFromRunId: "wf_restart01",
			parentSessionID: "ses_parent",
		});
		await flush();

		const status = engine2.statusOf(handle.runId);
		expect(status?.record.status).toBe("completed");
		expect(status?.record.returnValue).toBe("RESTART");
		expect(status?.record.resumedFrom).toBe("wf_restart01");
		expect(creates2).toBe(0);

		await engine2.dispose();
	});
});

describe("createWorkflowEngine — live progress feed (Task 8.1.2)", () => {
	// A completed run must leave a parseable JSONL feed bracketed by run:start /
	// run:end, with every engine-stamped progress event in between mirroring
	// handle.progress (same enriched stream, one source of truth). Driven via the
	// all-cache resume path: a seeded journal replays as cached against the inert
	// client, so the run completes deterministically with agent:start/agent:end
	// progress events and no live child needed.
	test("a completed run leaves run:start … events … run:end matching handle.progress", async () => {
		const SCRIPT = `${META}const r = await agent("do work", { label: "a" });\nreturn r;\n`;
		const key = computeCallKey({ prompt: "do work", label: "a" });
		const seeded: JournalEntry[] = [
			{ index: 0, key, status: "ok", result: "CACHED" },
		];
		const priorRecord = {
			id: "wf_prior001",
			parentSessionID: "ses_parent",
			status: "completed",
			description: "demo",
			createdAt: NOW - 1000,
			completedAt: NOW - 500,
			scriptPath: `${BASE}/workflow-scripts/wf_prior001.js`,
		};
		const { facade, files } = makeFs({
			[`${BASE}/workflow-scripts/wf_prior001.js`]: SCRIPT,
			[JOURNALS("wf_prior001")]: jsonl(seeded),
			[`${BASE}/workflow-runs/wf_prior001.json`]: JSON.stringify(priorRecord),
		});
		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock,
			logger: noopLogger,
			ids: fixedIds("wf_feed0001"),
		});
		await engine.ready();

		const handle = await engine.startRun({
			resumeFromRunId: "wf_prior001",
			parentSessionID: "ses_parent",
		});
		await engine.statusOf(handle.runId)?.settled;
		expect(engine.statusOf(handle.runId)?.record.status).toBe("completed");

		const lines = readFeed(files, "wf_feed0001");
		// First line frames the run; last line settles it.
		expect(lines[0]?.type).toBe("run:start");
		expect(lines[0]?.runId).toBe("wf_feed0001");
		expect(lines[0]?.parentSessionID).toBe("ses_parent");
		expect(lines[0]?.scriptPath).toBe(handle.scriptPath);
		expect(lines.at(-1)?.type).toBe("run:end");
		expect(lines.at(-1)?.status).toBe("completed");

		// The interior lines are exactly the stamped progress events the handle
		// carries, in order — feed and handle.progress are the same stream.
		const interior = lines.slice(1, -1);
		const progress = engine.statusOf(handle.runId)?.progress ?? [];
		expect(interior).toEqual(progress as unknown as typeof interior);
		// The cached call emitted agent:start + agent:end (no agent:launched).
		expect(interior.some((l) => l.type === "agent:start")).toBe(true);
		expect(interior.some((l) => l.type === "agent:end")).toBe(true);

		await engine.dispose();
	});

	test("a feed-write failure cannot fail the run (fenced): run still completes", async () => {
		// An fs whose writeFile/append synthesis throws for the feed file only would
		// be brittle to target; instead inject a feed fs via a facade whose appendFile
		// path always errors. The simplest deterministic seam: a facade whose
		// readFile/writeFile work for scripts/journals/records but whose feed writes
		// blow up. We model that by making writeFile throw for any feed path.
		const SCRIPT = `${META}const r = await agent("do work", { label: "a" });\nreturn r;\n`;
		const key = computeCallKey({ prompt: "do work", label: "a" });
		const seeded: JournalEntry[] = [
			{ index: 0, key, status: "ok", result: "CACHED" },
		];
		const priorRecord = {
			id: "wf_prior002",
			parentSessionID: "ses_parent",
			status: "completed",
			description: "demo",
			createdAt: NOW - 1000,
			completedAt: NOW - 500,
			scriptPath: `${BASE}/workflow-scripts/wf_prior002.js`,
		};
		const { facade, files } = makeFs({
			[`${BASE}/workflow-scripts/wf_prior002.js`]: SCRIPT,
			[JOURNALS("wf_prior002")]: jsonl(seeded),
			[`${BASE}/workflow-runs/wf_prior002.json`]: JSON.stringify(priorRecord),
		});
		// Wrap writeFile so any feed-path write throws — the run must survive.
		const baseWrite = facade.writeFile.bind(facade);
		facade.writeFile = async (path: string, data: string, enc: "utf-8") => {
			if (path.includes("/workflow-feed/")) {
				throw new Error("EIO: feed disk on fire");
			}
			return baseWrite(path, data, enc);
		};
		const errors: string[] = [];
		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock,
			logger: { ...noopLogger, error: (msg) => errors.push(msg) },
			ids: fixedIds("wf_feed0002"),
		});
		await engine.ready();

		const handle = await engine.startRun({
			resumeFromRunId: "wf_prior002",
			parentSessionID: "ses_parent",
		});
		await engine.statusOf(handle.runId)?.settled;

		// The run completes despite the feed disk being on fire.
		expect(engine.statusOf(handle.runId)?.record.status).toBe("completed");
		expect(engine.statusOf(handle.runId)?.record.returnValue).toBe("CACHED");
		// Nothing was written; the writer logged its single failure line.
		expect(readFeed(files, "wf_feed0002")).toEqual([]);
		expect(errors.some((e) => e.includes("feed"))).toBe(true);

		await engine.dispose();
	});
});
