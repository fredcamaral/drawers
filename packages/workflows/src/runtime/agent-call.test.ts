import { describe, expect, test } from "bun:test";
import {
	type BgTask,
	ConcurrencyManager,
	type LaunchRequest,
	type ReadOpts,
	type SessionRunner,
	type TaskOutput,
	type TaskStatus,
} from "@drawers/core";
import { computeCallKey } from "../plugin/journal";
import { createAgentPrimitive } from "./agent-call";
import {
	createSchemaRegistry,
	type SchemaRegistry,
} from "./structured/registry";
import { SchemaCompileError } from "./structured/validate";
import {
	AgentCapError,
	BudgetExhaustedError,
	type BudgetView,
	type JournalEntry,
	type ProgressEvent,
} from "./types";

/**
 * A deferred completion handle: lets a test control exactly when a launched
 * task transitions to terminal, so concurrency overlap can be observed.
 */
interface Deferred {
	resolve: (status: TaskStatus) => void;
}

interface FakeRunnerOpts {
	/** Status returned by awaitCompletion for every task (when not deferred). */
	status?: TaskStatus;
	/** summaryText returned by readOutput. */
	summaryText?: string;
	/** When set, launch() throws this. */
	launchThrows?: Error;
	/** When set, awaitCompletion() throws this. */
	awaitThrows?: Error;
	/** When true, awaitCompletion blocks until the test resolves it. */
	deferred?: boolean;
	/** When set, the synthetic sessionID assigned to the launched task. */
	sessionID?: string;
	/** When set, resume() throws this (e.g. sessionExpired). */
	resumeThrows?: Error;
	/** Invoked when launch() runs, BEFORE awaitCompletion, with the sessionID. */
	onLaunched?: (sessionID: string) => void;
}

/** Minimal SessionRunner fake covering only what the primitive touches. */
class FakeRunner implements SessionRunner {
	launches: LaunchRequest[] = [];
	private seq = 0;
	private inFlight = 0;
	maxInFlight = 0;
	private deferreds: Deferred[] = [];

	constructor(private readonly opts: FakeRunnerOpts = {}) {}

	resumes: { id: string; prompt: string }[] = [];

	async launch(req: LaunchRequest): Promise<BgTask> {
		if (this.opts.launchThrows) {
			throw this.opts.launchThrows;
		}
		this.launches.push(req);
		this.seq += 1;
		this.inFlight += 1;
		this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
		const sessionID = this.opts.sessionID ?? `ses_${this.seq}`;
		// Mirror core's synchronous onSessionCreated hook (registers schema).
		req.onSessionCreated?.(sessionID);
		this.opts.onLaunched?.(sessionID);
		const task = makeTask(`bg_${this.seq}`, req);
		task.sessionID = sessionID;
		return task;
	}

	async awaitCompletion(taskId: string): Promise<BgTask> {
		if (this.opts.awaitThrows) {
			this.inFlight -= 1;
			throw this.opts.awaitThrows;
		}
		if (this.opts.deferred) {
			const status = await new Promise<TaskStatus>((resolve) => {
				this.deferreds.push({ resolve });
			});
			this.inFlight -= 1;
			return makeTaskWithStatus(taskId, status);
		}
		this.inFlight -= 1;
		return makeTaskWithStatus(taskId, this.opts.status ?? "completed");
	}

	/** Resolve the oldest still-blocked deferred completion. */
	releaseOne(status: TaskStatus = "completed"): void {
		const next = this.deferreds.shift();
		if (!next) {
			throw new Error("no deferred completion to release");
		}
		next.resolve(status);
	}

	pending(): number {
		return this.deferreds.length;
	}

	async readOutput(_taskId: string, _opts?: ReadOpts): Promise<TaskOutput> {
		return {
			status: this.opts.status ?? "completed",
			summaryText: this.opts.summaryText ?? "the final text",
		};
	}

	async cancel(taskId: string): Promise<BgTask> {
		return makeTaskWithStatus(taskId, "cancelled");
	}

	async resume(taskId: string, prompt: string): Promise<BgTask> {
		if (this.opts.resumeThrows) {
			throw this.opts.resumeThrows;
		}
		this.resumes.push({ id: taskId, prompt });
		return makeTaskWithStatus(taskId, "running");
	}

	list(): BgTask[] {
		return [];
	}

	async handleEvent(): Promise<void> {}

	async dispose(): Promise<void> {}
}

function makeTask(id: string, req: LaunchRequest): BgTask {
	return {
		id,
		parentSessionID: req.parentSessionID,
		description: req.description,
		agent: req.agent,
		status: "running",
		createdAt: 0,
		depth: req.depth,
		concurrencyKey: "k",
		model: req.model,
	};
}

function makeTaskWithStatus(id: string, status: TaskStatus): BgTask {
	return {
		id,
		parentSessionID: "parent",
		description: "d",
		agent: "build",
		status,
		createdAt: 0,
		depth: 0,
		concurrencyKey: "k",
	};
}

/** Drain the microtask queue so settled promises propagate before asserting. */
async function flush(): Promise<void> {
	for (let i = 0; i < 5; i += 1) {
		await Promise.resolve();
	}
}

function budget(total: number | null, remaining = 0): BudgetView {
	return {
		total,
		spent: () => 0,
		remaining: () => remaining,
	};
}

interface HarnessOverrides {
	runner?: SessionRunner;
	gate?: ConcurrencyManager;
	counters?: { agents: number };
	budget?: BudgetView;
	currentPhase?: () => string | undefined;
	liveTasks?: Set<string>;
	defaults?: { agent: string; awaitTimeoutMs?: number };
	registry?: SchemaRegistry;
	replay?: {
		entries: JournalEntry[];
		onRecord: (e: JournalEntry) => void;
	};
	prefixIntact?: { value: boolean };
	callIndex?: { value: number };
}

function harness(overrides: HarnessOverrides = {}) {
	const events: ProgressEvent[] = [];
	const runner = overrides.runner ?? new FakeRunner();
	const gate =
		overrides.gate ?? new ConcurrencyManager({ defaultConcurrency: 5 });
	const counters = overrides.counters ?? { agents: 0 };
	const liveTasks = overrides.liveTasks ?? new Set<string>();
	const registry = overrides.registry ?? createSchemaRegistry();
	const prefixIntact = overrides.prefixIntact ?? { value: true };
	const callIndex = overrides.callIndex ?? { value: 0 };
	const agent = createAgentPrimitive({
		runner,
		parentSessionID: "parent",
		runId: "run-1",
		gate,
		counters,
		budget: overrides.budget ?? budget(null, Number.POSITIVE_INFINITY),
		emit: (e) => events.push(e),
		currentPhase: overrides.currentPhase ?? (() => undefined),
		liveTasks,
		defaults: overrides.defaults ?? { agent: "build" },
		registry,
		replay: overrides.replay,
		prefixIntact,
		callIndex,
	});
	return {
		agent,
		events,
		runner,
		gate,
		counters,
		liveTasks,
		registry,
		prefixIntact,
		callIndex,
	};
}

describe("createAgentPrimitive — result mapping", () => {
	test("completed status resolves to summaryText string", async () => {
		const runner = new FakeRunner({ status: "completed", summaryText: "DONE" });
		const { agent } = harness({ runner });
		expect(await agent("do it")).toBe("DONE");
	});

	test("error status resolves to null", async () => {
		const runner = new FakeRunner({ status: "error" });
		const { agent } = harness({ runner });
		expect(await agent("do it")).toBeNull();
	});

	test("cancelled status resolves to null", async () => {
		const runner = new FakeRunner({ status: "cancelled" });
		const { agent } = harness({ runner });
		expect(await agent("do it")).toBeNull();
	});

	test("launch throwing resolves to null and emits a warn", async () => {
		const runner = new FakeRunner({ launchThrows: new Error("spawn failed") });
		const { agent, events } = harness({ runner });
		expect(await agent("do it")).toBeNull();
		expect(events.some((e) => e.type === "warn")).toBe(true);
	});

	test("awaitCompletion throwing resolves to null and emits a warn", async () => {
		const runner = new FakeRunner({ awaitThrows: new Error("timeout") });
		const { agent, events } = harness({ runner });
		expect(await agent("do it")).toBeNull();
		expect(events.some((e) => e.type === "warn")).toBe(true);
	});
});

describe("createAgentPrimitive — caps and budget throw", () => {
	test("the 1001st call throws AgentCapError", async () => {
		const { agent } = harness({ counters: { agents: 1000 } });
		await expect(agent("do it")).rejects.toBeInstanceOf(AgentCapError);
	});

	test("budget exhaustion throws BudgetExhaustedError", async () => {
		const { agent } = harness({ budget: budget(100, 0) });
		await expect(agent("do it")).rejects.toBeInstanceOf(BudgetExhaustedError);
	});
});

describe("createAgentPrimitive — structured output (schema)", () => {
	const SCHEMA = {
		type: "object",
		properties: { n: { type: "number" } },
		required: ["n"],
	} as const;

	test("a malformed schema detonates with SchemaCompileError (script bug)", async () => {
		const { agent } = harness();
		// `type: "bogus"` is not a valid JSON Schema keyword value — ajv rejects it.
		await expect(
			agent("do it", { schema: { type: "bogus" } }),
		).rejects.toBeInstanceOf(SchemaCompileError);
	});

	test("registers the compiled schema and overrides tools on launch", async () => {
		const registry = createSchemaRegistry();
		const runner = new FakeRunner({
			status: "completed",
			sessionID: "ses_x",
			// Pre-store a result so completion resolves the object (no nudge).
			onLaunched: () => registry.store("ses_x", { n: 7 }),
		});
		const { agent } = harness({ runner, registry });
		const result = await agent("do it", { schema: SCHEMA });
		expect(result).toEqual({ n: 7 });
		const launch = runner.launches[0];
		expect(launch?.toolsOverride).toEqual({ structured_output: true });
		expect(launch?.onSessionCreated).toBeDefined();
		// Prompt carries the schema-instruction suffix.
		expect(launch?.prompt).toContain("structured_output");
		expect(launch?.prompt).toContain(JSON.stringify(SCHEMA));
	});

	test("resolves the stored object when a result is present", async () => {
		const registry = createSchemaRegistry();
		const runner = new FakeRunner({
			status: "completed",
			sessionID: "ses_y",
			onLaunched: () => registry.store("ses_y", { n: 9 }),
		});
		const { agent } = harness({ runner, registry });
		expect(await agent("do it", { schema: SCHEMA })).toEqual({ n: 9 });
		// Cleared in finally.
		expect(registry.resultFor("ses_y").present).toBe(false);
		expect(registry.lookup("ses_y")).toBeUndefined();
	});

	test("no result on completion → nudges once then resolves null", async () => {
		const registry = createSchemaRegistry();
		const runner = new FakeRunner({ status: "completed", sessionID: "ses_z" });
		const { agent } = harness({ runner, registry });
		expect(await agent("do it", { schema: SCHEMA })).toBeNull();
		expect(runner.resumes.length).toBe(1);
		expect(runner.resumes[0]?.prompt).toContain("have not returned");
	});

	test("no result after the nudge → resolves null", async () => {
		const registry = createSchemaRegistry();
		const runner = new FakeRunner({ status: "completed", sessionID: "ses_n" });
		const { agent } = harness({ runner, registry });
		expect(await agent("do it", { schema: SCHEMA })).toBeNull();
		expect(runner.resumes.length).toBe(1);
	});

	test("error status → null with no nudge", async () => {
		const registry = createSchemaRegistry();
		const runner = new FakeRunner({ status: "error", sessionID: "ses_e" });
		const { agent } = harness({ runner, registry });
		expect(await agent("do it", { schema: SCHEMA })).toBeNull();
		expect(runner.resumes.length).toBe(0);
	});

	test("resume throwing (sessionExpired) → null, degrade, warn", async () => {
		const registry = createSchemaRegistry();
		const runner = new FakeRunner({
			status: "completed",
			sessionID: "ses_r",
			resumeThrows: new Error("sessionExpired"),
		});
		const { agent, events } = harness({ runner, registry });
		expect(await agent("do it", { schema: SCHEMA })).toBeNull();
		expect(events.some((e) => e.type === "warn")).toBe(true);
	});

	test("clears the registry entry on completion regardless of outcome", async () => {
		const registry = createSchemaRegistry();
		const runner = new FakeRunner({ status: "completed", sessionID: "ses_c" });
		const { agent } = harness({ runner, registry });
		await agent("do it", { schema: SCHEMA });
		expect(registry.lookup("ses_c")).toBeUndefined();
		expect(registry.resultFor("ses_c").present).toBe(false);
	});
});

describe("createAgentPrimitive — concurrency gate", () => {
	test("the gate slot is released after the error path", async () => {
		// Limit-1 gate: if the error path leaked its slot, the next acquire blocks.
		const gate = new ConcurrencyManager({ defaultConcurrency: 1 });
		const runner = new FakeRunner({ awaitThrows: new Error("boom") });
		const { agent } = harness({ runner, gate });
		expect(await agent("first")).toBeNull();
		// A direct acquire must succeed synchronously if the slot was freed.
		expect(gate.runningCount("run-1")).toBe(0);
		expect(await agent("second")).toBeNull();
	});

	test("max in-flight launches never exceed the gate limit", async () => {
		const gate = new ConcurrencyManager({ defaultConcurrency: 2 });
		const runner = new FakeRunner({ deferred: true });
		const { agent } = harness({ runner, gate });

		const calls = [agent("a"), agent("b"), agent("c"), agent("d")];
		// Let microtasks settle so the first two launch and the rest queue.
		await flush();
		expect(runner.maxInFlight).toBe(2);
		expect(runner.launches.length).toBe(2);
		expect(runner.pending()).toBe(2);

		// Drain: each release frees a slot. The slot is handed to a queued call,
		// which launches on a later microtask — flush() waits for that chain.
		for (let i = 0; i < 4; i += 1) {
			runner.releaseOne();
			await flush();
		}

		await Promise.all(calls);
		// Never more than 2 concurrent launches across the whole drain.
		expect(runner.maxInFlight).toBe(2);
		expect(runner.launches.length).toBe(4);
	});
});

describe("createAgentPrimitive — progress events", () => {
	test("start and end events carry label and phase", async () => {
		const { agent, events } = harness({ currentPhase: () => "Analyze" });
		await agent("prompt text", { label: "my-label" });
		const start = events.find((e) => e.type === "agent:start");
		const end = events.find((e) => e.type === "agent:end");
		expect(start).toEqual({
			type: "agent:start",
			label: "my-label",
			phase: "Analyze",
		});
		expect(end).toEqual({
			type: "agent:end",
			label: "my-label",
			status: "completed",
		});
	});

	test("label defaults to the first 60 chars of the prompt", async () => {
		const long = "x".repeat(100);
		const { agent, events } = harness();
		await agent(long);
		const start = events.find((e) => e.type === "agent:start");
		expect(start).toEqual({
			type: "agent:start",
			label: "x".repeat(60),
			phase: undefined,
		});
	});

	test("explicit opts.phase beats currentPhase()", async () => {
		const { agent, events } = harness({ currentPhase: () => "Global" });
		await agent("p", { phase: "Local" });
		const start = events.find((e) => e.type === "agent:start");
		expect(start).toMatchObject({ type: "agent:start", phase: "Local" });
	});
});

describe("createAgentPrimitive — launch wiring and live tasks", () => {
	test("launch receives agentType, model, and parent session", async () => {
		const runner = new FakeRunner();
		const { agent } = harness({ runner });
		await agent("prompt", {
			label: "L",
			model: "anthropic/claude",
			agentType: "reviewer",
		});
		expect(runner.launches[0]).toEqual({
			parentSessionID: "parent",
			description: "L",
			prompt: "prompt",
			agent: "reviewer",
			model: "anthropic/claude",
			depth: 0,
		});
	});

	test("agent defaults to deps.defaults.agent when agentType absent", async () => {
		const runner = new FakeRunner();
		const { agent } = harness({ runner, defaults: { agent: "general" } });
		await agent("prompt");
		expect(runner.launches[0]?.agent).toBe("general");
	});

	test("liveTasks holds the id during the call and is empty after", async () => {
		const runner = new FakeRunner({ deferred: true });
		const liveTasks = new Set<string>();
		const { agent } = harness({ runner, liveTasks });
		const call = agent("p");
		await Promise.resolve();
		await Promise.resolve();
		expect(liveTasks.size).toBe(1);
		runner.releaseOne();
		await call;
		expect(liveTasks.size).toBe(0);
	});

	test("isolation:worktree emits a warn but still runs", async () => {
		const runner = new FakeRunner({ summaryText: "OK" });
		const { agent, events } = harness({ runner });
		expect(await agent("p", { isolation: "worktree" })).toBe("OK");
		expect(events.some((e) => e.type === "warn")).toBe(true);
		expect(runner.launches.length).toBe(1);
	});
});

// ---- replay / journal seam -----------------------------------------------

describe("createAgentPrimitive — live path records non-null results", () => {
	test("a non-null text result is journaled via onRecord with index+key", async () => {
		const recorded: JournalEntry[] = [];
		const runner = new FakeRunner({ status: "completed", summaryText: "TEXT" });
		const { agent } = harness({
			runner,
			replay: { entries: [], onRecord: (e) => recorded.push(e) },
		});
		const out = await agent("prompt one");
		expect(out).toBe("TEXT");
		expect(recorded).toEqual([
			{
				index: 0,
				key: computeCallKey({ prompt: "prompt one" }),
				status: "ok",
				result: "TEXT",
			},
		]);
	});

	test("a structured OBJECT result is journaled too", async () => {
		const recorded: JournalEntry[] = [];
		const registry = createSchemaRegistry();
		const runner = new FakeRunner({
			status: "completed",
			sessionID: "ses_obj",
			onLaunched: () => registry.store("ses_obj", { n: 5 }),
		});
		const SCHEMA = {
			type: "object",
			properties: { n: { type: "number" } },
			required: ["n"],
		} as const;
		const { agent } = harness({
			runner,
			registry,
			replay: { entries: [], onRecord: (e) => recorded.push(e) },
		});
		const out = await agent("prompt", { schema: SCHEMA });
		expect(out).toEqual({ n: 5 });
		expect(recorded.length).toBe(1);
		expect(recorded[0]?.result).toEqual({ n: 5 });
	});

	test("a null result (failed agent) is NOT journaled", async () => {
		const recorded: JournalEntry[] = [];
		const runner = new FakeRunner({ status: "error" });
		const { agent } = harness({
			runner,
			replay: { entries: [], onRecord: (e) => recorded.push(e) },
		});
		expect(await agent("prompt")).toBeNull();
		expect(recorded).toEqual([]);
	});

	test("callIndex advances once per live call", async () => {
		const recorded: JournalEntry[] = [];
		const runner = new FakeRunner({ status: "completed", summaryText: "T" });
		const callIndex = { value: 0 };
		const { agent } = harness({
			runner,
			callIndex,
			replay: { entries: [], onRecord: (e) => recorded.push(e) },
		});
		await agent("a");
		await agent("b");
		expect(callIndex.value).toBe(2);
		expect(recorded.map((e) => e.index)).toEqual([0, 1]);
	});
});

describe("createAgentPrimitive — cached replay path", () => {
	test("full-prefix replay returns cached results with ZERO launches and status cached", async () => {
		const runner = new FakeRunner({ status: "completed", summaryText: "LIVE" });
		const entries: JournalEntry[] = [
			{
				index: 0,
				key: computeCallKey({ prompt: "a" }),
				status: "ok",
				result: "cached-a",
			},
			{
				index: 1,
				key: computeCallKey({ prompt: "b" }),
				status: "ok",
				result: "cached-b",
			},
		];
		const {
			agent,
			events,
			runner: r,
		} = harness({
			runner,
			replay: { entries, onRecord: () => {} },
		});
		expect(await agent("a")).toBe("cached-a");
		expect(await agent("b")).toBe("cached-b");
		expect((r as FakeRunner).launches.length).toBe(0);
		const ends = events.filter((e) => e.type === "agent:end");
		expect(
			ends.every((e) => e.type === "agent:end" && e.status === "cached"),
		).toBe(true);
		const starts = events.filter((e) => e.type === "agent:start");
		expect(starts.length).toBe(2);
	});

	test("entries recorded OUT OF INDEX ORDER (concurrent journal) still replay cached", async () => {
		// Live-harness regression: concurrent agents (pipeline/parallel) record into
		// the journal in COMPLETION order, not call-index order — so entries[0] may
		// carry index 1. Replay MUST look up by the `index` field, not array position,
		// or the very first replayed call mismatches and the whole prefix breaks live.
		const runner = new FakeRunner({ status: "completed", summaryText: "LIVE" });
		const entries: JournalEntry[] = [
			// index 1 first (it settled first under concurrency), then index 0.
			{
				index: 1,
				key: computeCallKey({ prompt: "b" }),
				status: "ok",
				result: "cached-b",
			},
			{
				index: 0,
				key: computeCallKey({ prompt: "a" }),
				status: "ok",
				result: "cached-a",
			},
		];
		const { agent, runner: r } = harness({
			runner,
			replay: { entries, onRecord: () => {} },
		});
		// Calls happen in index order; each must find ITS entry regardless of position.
		expect(await agent("a")).toBe("cached-a");
		expect(await agent("b")).toBe("cached-b");
		expect((r as FakeRunner).launches.length).toBe(0);
	});

	test("a cached hit re-records the entry via onRecord (journals stay self-contained on resume)", async () => {
		const recorded: JournalEntry[] = [];
		const runner = new FakeRunner({ status: "completed", summaryText: "LIVE" });
		const entries: JournalEntry[] = [
			{
				index: 0,
				key: computeCallKey({ prompt: "a" }),
				status: "ok",
				result: "cached-a",
			},
			{
				index: 1,
				key: computeCallKey({ prompt: "b" }),
				status: "ok",
				result: "cached-b",
			},
		];
		const { agent, runner: r } = harness({
			runner,
			replay: { entries, onRecord: (e) => recorded.push(e) },
		});
		expect(await agent("a")).toBe("cached-a");
		expect(await agent("b")).toBe("cached-b");
		// Zero launches, yet both cached hits were re-recorded verbatim so the new
		// run's journal is standalone (no engine-layer bookkeeping needed).
		expect((r as FakeRunner).launches.length).toBe(0);
		expect(recorded).toEqual([
			{
				index: 0,
				key: computeCallKey({ prompt: "a" }),
				status: "ok",
				result: "cached-a",
			},
			{
				index: 1,
				key: computeCallKey({ prompt: "b" }),
				status: "ok",
				result: "cached-b",
			},
		]);
	});

	test("cached calls still advance counters.agents and hit the 1000 cap", async () => {
		const runner = new FakeRunner({ status: "completed" });
		const entries: JournalEntry[] = [
			{
				index: 1000,
				key: computeCallKey({ prompt: "x" }),
				status: "ok",
				result: "cached",
			},
		];
		// counters already at the cap: a cached call must STILL throw.
		const { agent } = harness({
			runner,
			counters: { agents: 1000 },
			callIndex: { value: 1000 },
			replay: { entries, onRecord: () => {} },
		});
		await expect(agent("x")).rejects.toBeInstanceOf(AgentCapError);
	});

	test("divergence: key mismatch flips prefixIntact and runs live from there", async () => {
		const runner = new FakeRunner({ status: "completed", summaryText: "LIVE" });
		const entries: JournalEntry[] = [
			{
				index: 0,
				key: computeCallKey({ prompt: "a" }),
				status: "ok",
				result: "cached-a",
			},
			{
				index: 1,
				key: computeCallKey({ prompt: "EDITED" }),
				status: "ok",
				result: "cached-b",
			},
		];
		const prefixIntact = { value: true };
		const { agent, prefixIntact: pi } = harness({
			runner,
			prefixIntact,
			replay: { entries, onRecord: () => {} },
		});
		// First call matches → cached.
		expect(await agent("a")).toBe("cached-a");
		expect(pi.value).toBe(true);
		// Second call's prompt was edited → key mismatch → runs LIVE.
		expect(await agent("b")).toBe("LIVE");
		expect(pi.value).toBe(false);
		expect((runner as FakeRunner).launches.length).toBe(1);
	});

	test("a later coincidentally-matching key still runs live once prefix is broken", async () => {
		const runner = new FakeRunner({ status: "completed", summaryText: "LIVE" });
		const entries: JournalEntry[] = [
			{
				index: 0,
				key: computeCallKey({ prompt: "EDITED" }), // call 0 will mismatch
				status: "ok",
				result: "cached-0",
			},
			{
				index: 1,
				key: computeCallKey({ prompt: "b" }), // call 1 WOULD match coincidentally
				status: "ok",
				result: "cached-1",
			},
		];
		const { agent } = harness({
			runner,
			replay: { entries, onRecord: () => {} },
		});
		// Call 0 diverges immediately (prompt "a" != journaled "EDITED").
		expect(await agent("a")).toBe("LIVE");
		// Call 1's key matches entries[1], but the prefix is already broken → LIVE.
		expect(await agent("b")).toBe("LIVE");
		expect((runner as FakeRunner).launches.length).toBe(2);
	});

	test("index past entries.length runs live (no entry for that index)", async () => {
		const runner = new FakeRunner({ status: "completed", summaryText: "LIVE" });
		const entries: JournalEntry[] = [
			{
				index: 0,
				key: computeCallKey({ prompt: "a" }),
				status: "ok",
				result: "cached-a",
			},
		];
		const { agent, prefixIntact } = harness({
			runner,
			replay: { entries, onRecord: () => {} },
		});
		expect(await agent("a")).toBe("cached-a"); // index 0 cached
		expect(await agent("b")).toBe("LIVE"); // index 1 >= length → live
		expect(prefixIntact.value).toBe(false);
		expect((runner as FakeRunner).launches.length).toBe(1);
	});
});

// ---- Task 4.3.1: settle-path budget recordTask ---------------------------

/**
 * A BudgetView that ALSO exposes `recordTask` and a scripted per-session spend.
 * `spend` maps a sessionID to the tokens that session "cost"; `recordTask` folds
 * it into the accumulator, so a later call's pre-check sees the prior spend.
 */
function recordingBudget(
	total: number,
	spend: Record<string, number>,
): BudgetView & {
	recordTask(sessionID: string): Promise<void>;
	recorded: string[];
} {
	let accumulated = 0;
	const recorded: string[] = [];
	return {
		total,
		spent: () => accumulated,
		remaining: () => Math.max(0, total - accumulated),
		recorded,
		async recordTask(sessionID: string): Promise<void> {
			recorded.push(sessionID);
			accumulated += spend[sessionID] ?? 0;
		},
	};
}

describe("createAgentPrimitive — budget recordTask at settle", () => {
	test("records the settled task's sessionID so the NEXT call's pre-check sees its spend", async () => {
		// Two sequential calls, scripted per-session token costs. After call 1
		// settles, recordTask folds its spend in; call 2's budget pre-check reads it.
		let seq = 0;
		const runner = new FakeRunner({ status: "completed", summaryText: "OK" });
		// Override launch's sessionID per call deterministically.
		const origLaunch = runner.launch.bind(runner);
		runner.launch = async (req) => {
			seq += 1;
			(runner as unknown as { opts: FakeRunnerOpts }).opts.sessionID =
				`ses_call_${seq}`;
			return origLaunch(req);
		};
		const b = recordingBudget(100, { ses_call_1: 40, ses_call_2: 40 });
		const { agent } = harness({ runner, budget: b });

		expect(await agent("first")).toBe("OK");
		// Call 1 settled → its session recorded → spend now 40.
		expect(b.recorded).toEqual(["ses_call_1"]);
		expect(b.spent()).toBe(40);

		expect(await agent("second")).toBe("OK");
		expect(b.recorded).toEqual(["ses_call_1", "ses_call_2"]);
		expect(b.spent()).toBe(80);
	});

	test("exhaustion mid-loop: pre-check halts the loop with BudgetExhaustedError", async () => {
		// Conformance-style ceiling loop: each call costs 40 against a 100 budget.
		// After two calls (80 spent) a third would exceed, but the gate is
		// `remaining() > 0`, so the THIRD call's pre-check (remaining 20 > 0) still
		// runs; the FOURTH (remaining 0) throws. We script all sessions at 40.
		let seq = 0;
		const runner = new FakeRunner({ status: "completed", summaryText: "OK" });
		const origLaunch = runner.launch.bind(runner);
		runner.launch = async (req) => {
			seq += 1;
			(runner as unknown as { opts: FakeRunnerOpts }).opts.sessionID =
				`ses_${seq}`;
			return origLaunch(req);
		};
		const b = recordingBudget(100, {
			ses_1: 40,
			ses_2: 40,
			ses_3: 40,
			ses_4: 40,
		});
		const { agent } = harness({ runner, budget: b });

		// Drive the conformance loop: keep calling while remaining > 0.
		const calls: number[] = [];
		let threw = false;
		try {
			while (b.remaining() > 0) {
				await agent(`call ${calls.length}`);
				calls.push(b.spent());
			}
		} catch (err) {
			threw = err instanceof BudgetExhaustedError;
		}
		// 40, 80, 120 spent across three live calls; the loop re-checks remaining()
		// == 0 after the third and exits WITHOUT a throw (gate is remaining > 0).
		expect(calls).toEqual([40, 80, 120]);
		// No throw needed — the loop's own guard halted at the ceiling. But a direct
		// extra call now MUST throw (remaining 0).
		expect(threw).toBe(false);
		await expect(agent("over")).rejects.toBeInstanceOf(BudgetExhaustedError);
	});

	test("records on a FAILED terminal status too (any terminal status)", async () => {
		const runner = new FakeRunner({ status: "error", sessionID: "ses_failed" });
		const b = recordingBudget(100, { ses_failed: 10 });
		const { agent } = harness({ runner, budget: b });
		expect(await agent("x")).toBeNull();
		// Even though the result was null (failed), the session's tokens are recorded.
		expect(b.recorded).toEqual(["ses_failed"]);
		expect(b.spent()).toBe(10);
	});

	test("cached replay records NOTHING (no session to charge)", async () => {
		const runner = new FakeRunner({ status: "completed", summaryText: "LIVE" });
		const entries: JournalEntry[] = [
			{
				index: 0,
				key: computeCallKey({ prompt: "a" }),
				status: "ok",
				result: "cached-a",
			},
		];
		const b = recordingBudget(100, {});
		const { agent } = harness({
			runner,
			budget: b,
			replay: { entries, onRecord: () => {} },
		});
		expect(await agent("a")).toBe("cached-a");
		expect(b.recorded).toEqual([]);
		expect(b.spent()).toBe(0);
	});

	test("a budget WITHOUT recordTask (plain BudgetView) is left untouched", async () => {
		// The runtime keeps zero plugin knowledge: recordTask is a structural
		// optional. A plain BudgetView must not crash the settle path.
		const runner = new FakeRunner({ status: "completed", summaryText: "OK" });
		const { agent } = harness({ runner, budget: budget(100, 100) });
		expect(await agent("x")).toBe("OK");
	});
});
