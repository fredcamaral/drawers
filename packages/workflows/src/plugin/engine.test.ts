import { describe, expect, test } from "bun:test";
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

		// run() resolves on the microtask queue; give it a turn.
		await Promise.resolve();
		await Promise.resolve();

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
		await Promise.resolve();
		await Promise.resolve();

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
		await Promise.resolve();
		await Promise.resolve();

		const status = engine.statusOf(handle.runId);
		const logs = (status?.progress ?? []).filter((e) => e.type === "log");
		expect(logs).toEqual([
			{ type: "log", message: "step one" },
			{ type: "log", message: "step two" },
		]);

		await engine.dispose();
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
							info: { role: "assistant" as const },
							parts: [{ type: "text", text: reply }],
						},
					],
				}),
				get: async () => ({ data: { id: "ses_child" } }),
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
