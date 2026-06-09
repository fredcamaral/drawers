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
	type AgentDiagnostic,
	BudgetExhaustedError,
	type BudgetView,
	type IntentJournalEntry,
	type JournalEntry,
	type ProgressEvent,
	type WorktreeManagerSeam,
} from "./types";

/** A no-op worktree manager satisfying the opaque seam (Epic H.1.6 plumbing test). */
function noopWorktreeManager(): WorktreeManagerSeam {
	return {
		create: async () => null,
		mergeBack: async () => ({ merged: true }),
		isUnchanged: async () => true,
		cleanup: async () => undefined,
		sweep: async () => undefined,
	};
}

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
	defaults?: { agent: string };
	registry?: SchemaRegistry;
	replay?: {
		entries: JournalEntry[];
		onRecord: (e: JournalEntry) => void;
		onIntent?: (e: IntentJournalEntry) => Promise<void> | void;
	};
	callIndex?: { value: number };
	onDiagnostic?: (d: AgentDiagnostic) => void;
	awaitCheckpointClear?: () => Promise<void>;
	resolveContextDiff?: () => Promise<{
		text: string;
		isEmpty: boolean;
		available: boolean;
	}>;
	verifyResult?: (opts: {
		verifyDiff: boolean | { check?: string };
		sessionId?: string;
		directory?: string;
	}) => Promise<{ passed: boolean; available: boolean; reason?: string }>;
	directory?: string;
	worktreeManager?: WorktreeManagerSeam;
	serializeOnCheckpoint?: <T>(task: () => Promise<T>) => Promise<T>;
}

function harness(overrides: HarnessOverrides = {}) {
	const events: ProgressEvent[] = [];
	const diags: AgentDiagnostic[] = [];
	const runner = overrides.runner ?? new FakeRunner();
	const gate =
		overrides.gate ?? new ConcurrencyManager({ defaultConcurrency: 5 });
	const counters = overrides.counters ?? { agents: 0 };
	const liveTasks = overrides.liveTasks ?? new Set<string>();
	const registry = overrides.registry ?? createSchemaRegistry();
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
		callIndex,
		onDiagnostic:
			overrides.onDiagnostic ?? ((d: AgentDiagnostic) => diags.push(d)),
		...(overrides.awaitCheckpointClear !== undefined
			? { awaitCheckpointClear: overrides.awaitCheckpointClear }
			: {}),
		...(overrides.resolveContextDiff !== undefined
			? { resolveContextDiff: overrides.resolveContextDiff }
			: {}),
		...(overrides.verifyResult !== undefined
			? { verifyResult: overrides.verifyResult }
			: {}),
		...(overrides.directory !== undefined
			? { directory: overrides.directory }
			: {}),
		...(overrides.worktreeManager !== undefined
			? { worktreeManager: overrides.worktreeManager }
			: {}),
		...(overrides.serializeOnCheckpoint !== undefined
			? { serializeOnCheckpoint: overrides.serializeOnCheckpoint }
			: {}),
	});
	return {
		agent,
		events,
		diags,
		runner,
		gate,
		counters,
		liveTasks,
		registry,
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

describe("createAgentPrimitive — prompt preview on agent:start", () => {
	test("agent:start carries the prompt as promptPreview (live path)", async () => {
		const { agent, events } = harness();
		await agent("explain the repo structure");
		const start = events.find((e) => e.type === "agent:start");
		expect(start).toBeDefined();
		expect(
			(start as Extract<ProgressEvent, { type: "agent:start" }>).promptPreview,
		).toBe("explain the repo structure");
	});

	test("a long prompt is truncated with an ellipsis", async () => {
		const { agent, events } = harness();
		const long = "x".repeat(5000);
		await agent(long);
		const start = events.find((e) => e.type === "agent:start") as Extract<
			ProgressEvent,
			{ type: "agent:start" }
		>;
		expect(start.promptPreview).toBeDefined();
		const preview = start.promptPreview as string;
		// Capped well under the raw length, and marked as truncated.
		expect(preview.length).toBeLessThan(long.length);
		expect(preview.endsWith("…")).toBe(true);
	});

	test("the preview reflects the USER prompt, not the schema-suffixed launch prompt", async () => {
		const { agent, events } = harness();
		await agent("classify this", {
			schema: { type: "object", properties: {}, additionalProperties: true },
		});
		const start = events.find((e) => e.type === "agent:start") as Extract<
			ProgressEvent,
			{ type: "agent:start" }
		>;
		expect(start.promptPreview).toBe("classify this");
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

	test("deps.directory forwards onto runner.launch (Epic H.1 inert seam)", async () => {
		const runner = new FakeRunner({ status: "completed", summaryText: "ok" });
		const { agent } = harness({ runner, directory: "/tmp/wt-abc" });
		await agent("do it");
		expect(runner.launches[0]?.directory).toBe("/tmp/wt-abc");
	});

	test("opts.tools enables the named tools on launch (Task 2.1.1)", async () => {
		const runner = new FakeRunner({ status: "completed", summaryText: "ok" });
		const { agent } = harness({ runner });
		await agent("research it", { tools: ["websearch", "webfetch"] });
		expect(runner.launches[0]?.toolsOverride).toEqual({
			websearch: true,
			webfetch: true,
		});
	});

	test("opts.tools composes with the structured-output override (Task 2.1.1)", async () => {
		const registry = createSchemaRegistry();
		const runner = new FakeRunner({
			status: "completed",
			sessionID: "ses_t",
			onLaunched: () => registry.store("ses_t", { n: 1 }),
		});
		const { agent } = harness({ runner, registry });
		await agent("do it", { schema: SCHEMA, tools: ["websearch"] });
		expect(runner.launches[0]?.toolsOverride).toEqual({
			structured_output: true,
			websearch: true,
		});
	});

	test("no schema and no tools leaves toolsOverride absent (inert)", async () => {
		const runner = new FakeRunner({ status: "completed", summaryText: "ok" });
		const { agent } = harness({ runner });
		await agent("do it");
		expect(runner.launches[0]?.toolsOverride).toBeUndefined();
	});

	test("absent deps.directory leaves runner.launch directory undefined", async () => {
		const runner = new FakeRunner({ status: "completed", summaryText: "ok" });
		const { agent } = harness({ runner });
		await agent("do it");
		expect(runner.launches[0]?.directory).toBeUndefined();
	});

	test("deps.worktreeManager is accepted and inert today (Epic H.1.6 plumbing)", async () => {
		// H.1.6 threads the manager handle only; H.1.2 will consume it. A non-isolated
		// agent runs identically whether or not a manager is injected — no launch is
		// re-rooted and nothing degrades.
		const runner = new FakeRunner({ status: "completed", summaryText: "ok" });
		const { agent } = harness({
			runner,
			worktreeManager: noopWorktreeManager(),
		});
		expect(await agent("do it")).toBe("ok");
		expect(runner.launches).toHaveLength(1);
		expect(runner.launches[0]?.directory).toBeUndefined();
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

describe("createAgentPrimitive — diagnostics (Task 7.2.1)", () => {
	const SCHEMA = {
		type: "object",
		properties: { n: { type: "number" } },
		required: ["n"],
	} as const;

	test("error status → status_error diagnostic + agent:end note; agent() still null", async () => {
		const runner = new FakeRunner({ status: "error" });
		const { agent, diags, events } = harness({ runner });
		expect(await agent("do it", { label: "L" })).toBeNull();
		expect(diags).toHaveLength(1);
		expect(diags[0]).toMatchObject({
			label: "L",
			index: 0,
			reason: "status_error",
		});
		const end = events.find((e) => e.type === "agent:end");
		expect(end?.type === "agent:end" && end.note).toContain("status_error");
	});

	test("cancelled status → status_cancelled diagnostic", async () => {
		const runner = new FakeRunner({ status: "cancelled" });
		const { agent, diags } = harness({ runner });
		expect(await agent("do it")).toBeNull();
		expect(diags[0]?.reason).toBe("status_cancelled");
	});

	test("launch throw → await_failed diagnostic, no childSessionID", async () => {
		const runner = new FakeRunner({ launchThrows: new Error("spawn failed") });
		const { agent, diags } = harness({ runner });
		expect(await agent("do it")).toBeNull();
		expect(diags[0]?.reason).toBe("await_failed");
		expect(diags[0]?.childSessionID).toBeUndefined();
	});

	test("awaitCompletion throw → await_failed diagnostic", async () => {
		const runner = new FakeRunner({ awaitThrows: new Error("timeout") });
		const { agent, diags } = harness({ runner });
		expect(await agent("do it")).toBeNull();
		expect(diags[0]?.reason).toBe("await_failed");
	});

	test("completed but empty final text → empty_output diagnostic + note; agent() returns ''", async () => {
		const runner = new FakeRunner({ status: "completed", summaryText: "" });
		const { agent, diags, events } = harness({ runner });
		expect(await agent("do it")).toBe("");
		expect(diags[0]?.reason).toBe("empty_output");
		const end = events.find((e) => e.type === "agent:end");
		expect(end?.type === "agent:end" && end.note).toContain("empty output");
	});

	test("structured: tool never called → schema_no_call + raw text captured", async () => {
		const registry = createSchemaRegistry();
		const runner = new FakeRunner({
			status: "completed",
			sessionID: "ses_nc",
			summaryText: "I forgot to call the tool, here is prose instead.",
		});
		const { agent, diags } = harness({ runner, registry });
		expect(await agent("do it", { schema: SCHEMA })).toBeNull();
		expect(diags[0]?.reason).toBe("schema_no_call");
		expect(diags[0]?.rawText).toContain("prose instead");
		expect(diags[0]?.childSessionID).toBe("ses_nc");
	});

	test("structured: tool called but rejected → schema_invalid + raw text captured", async () => {
		const registry = createSchemaRegistry();
		const runner = new FakeRunner({
			status: "completed",
			sessionID: "ses_inv",
			summaryText: "my final prose",
			// Simulate the tool having recorded a validation rejection.
			onLaunched: (sid) => registry.recordFailure(sid, "missing required 'n'"),
		});
		const { agent, diags } = harness({ runner, registry });
		expect(await agent("do it", { schema: SCHEMA })).toBeNull();
		expect(diags[0]?.reason).toBe("schema_invalid");
		expect(diags[0]?.rawText).toContain("my final prose");
	});

	test("raw text capture is capped at 20_000 chars with a marker", async () => {
		const registry = createSchemaRegistry();
		const huge = "x".repeat(25_000);
		const runner = new FakeRunner({
			status: "completed",
			sessionID: "ses_big",
			summaryText: huge,
		});
		const { agent, diags } = harness({ runner, registry });
		await agent("do it", { schema: SCHEMA });
		const raw = diags[0]?.rawText ?? "";
		expect(raw.length).toBeLessThanOrEqual(20_000 + "…[capped]".length);
		expect(raw).toContain("…[capped]");
		expect(raw.startsWith("x".repeat(100))).toBe(true);
	});

	test("a readOutput throw during capture does not mask the null flow", async () => {
		const registry = createSchemaRegistry();
		class ThrowingReadRunner extends FakeRunner {
			override async readOutput(): Promise<never> {
				throw new Error("readOutput exploded");
			}
		}
		const runner = new ThrowingReadRunner({
			status: "completed",
			sessionID: "ses_thr",
		});
		const { agent, diags } = harness({ runner, registry });
		// The original schema_no_call flow still resolves null; capture is fenced.
		expect(await agent("do it", { schema: SCHEMA })).toBeNull();
		expect(diags[0]?.reason).toBe("schema_no_call");
		expect(diags[0]?.rawText).toBeUndefined();
	});

	test("a completed non-empty plain result emits NO diagnostic", async () => {
		const runner = new FakeRunner({ status: "completed", summaryText: "ok" });
		const { agent, diags } = harness({ runner });
		expect(await agent("do it")).toBe("ok");
		expect(diags).toHaveLength(0);
	});

	test("a successful structured result emits NO diagnostic", async () => {
		const registry = createSchemaRegistry();
		const runner = new FakeRunner({
			status: "completed",
			sessionID: "ses_ok",
			onLaunched: () => registry.store("ses_ok", { n: 1 }),
		});
		const { agent, diags } = harness({ runner, registry });
		expect(await agent("do it", { schema: SCHEMA })).toEqual({ n: 1 });
		expect(diags).toHaveLength(0);
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
			// promptPreview is now carried for the viewer's Detail (Task 8.3.x).
			promptPreview: "prompt text",
		});
		expect(end).toEqual({
			type: "agent:end",
			label: "my-label",
			status: "completed",
			// sessionID is now carried on the live path (Task 8.1.1); the default fake
			// runner assigns "ses_1" to the first launch.
			sessionID: "ses_1",
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
			promptPreview: "x".repeat(100),
		});
	});

	test("explicit opts.phase beats currentPhase()", async () => {
		const { agent, events } = harness({ currentPhase: () => "Global" });
		await agent("p", { phase: "Local" });
		const start = events.find((e) => e.type === "agent:start");
		expect(start).toMatchObject({ type: "agent:start", phase: "Local" });
	});
});

describe("createAgentPrimitive — agent:launched + sessionID (Task 8.1.1)", () => {
	test("a live call emits start → launched → end in order with a session binding", async () => {
		const runner = new FakeRunner({
			status: "completed",
			sessionID: "ses_live",
		});
		const { agent, events } = harness({
			runner,
			currentPhase: () => "Analyze",
		});
		await agent("prompt text", { label: "my-label" });
		expect(events.map((e) => e.type)).toEqual([
			"agent:start",
			"agent:launched",
			"agent:end",
		]);
		const launched = events.find((e) => e.type === "agent:launched");
		expect(launched).toEqual({
			type: "agent:launched",
			label: "my-label",
			phase: "Analyze",
			sessionID: "ses_live",
			// agentType always resolves (opts.agentType ?? defaults.agent); no model
			// requested and the fake task carries none, so model is omitted.
			agentType: "build",
		});
	});

	test("agent:launched carries the resolved model and agentType", async () => {
		const runner = new FakeRunner({
			status: "completed",
			sessionID: "ses_m",
		});
		const { agent, events } = harness({ runner });
		await agent("p", {
			label: "L",
			model: "anthropic/claude",
			agentType: "reviewer",
		});
		const launched = events.find((e) => e.type === "agent:launched");
		expect(launched).toEqual({
			type: "agent:launched",
			label: "L",
			phase: undefined,
			sessionID: "ses_m",
			model: "anthropic/claude",
			agentType: "reviewer",
		});
	});

	test("model falls back to the launched task's model, agentType to defaults.agent", async () => {
		// No opts.model/opts.agentType: model resolves from the BgTask the runner
		// returns (which mirrors req.model — here undefined), agentType from defaults.
		const runner = new FakeRunner({
			status: "completed",
			sessionID: "ses_d",
		});
		const { agent, events } = harness({
			runner,
			defaults: { agent: "general" },
		});
		await agent("p");
		const launched = events.find((e) => e.type === "agent:launched");
		expect(launched).toMatchObject({
			type: "agent:launched",
			sessionID: "ses_d",
			agentType: "general",
		});
	});

	test("agent:end carries the same sessionID as agent:launched on a live call", async () => {
		const runner = new FakeRunner({
			status: "completed",
			sessionID: "ses_end",
		});
		const { agent, events } = harness({ runner });
		await agent("p", { label: "L" });
		const launched = events.find((e) => e.type === "agent:launched");
		const end = events.find((e) => e.type === "agent:end");
		expect(launched?.type === "agent:launched" && launched.sessionID).toBe(
			"ses_end",
		);
		expect(end?.type === "agent:end" && end.sessionID).toBe("ses_end");
	});

	test("a cached call emits only start/end with no sessionID and no agent:launched", async () => {
		const runner = new FakeRunner({ status: "completed", summaryText: "LIVE" });
		const entries: JournalEntry[] = [
			{
				index: 0,
				key: computeCallKey({ prompt: "a" }),
				status: "ok",
				result: "cached-a",
			},
		];
		const { agent, events } = harness({
			runner,
			replay: { entries, onRecord: () => {} },
		});
		expect(await agent("a")).toBe("cached-a");
		expect(events.map((e) => e.type)).toEqual(["agent:start", "agent:end"]);
		const end = events.find((e) => e.type === "agent:end");
		expect(end?.type === "agent:end" && end.sessionID).toBeUndefined();
	});

	test("a launch-throw path emits agent:end without a sessionID and no agent:launched", async () => {
		const runner = new FakeRunner({ launchThrows: new Error("spawn failed") });
		const { agent, events } = harness({ runner });
		expect(await agent("p")).toBeNull();
		expect(events.some((e) => e.type === "agent:launched")).toBe(false);
		const end = events.find((e) => e.type === "agent:end");
		expect(end?.type === "agent:end" && end.sessionID).toBeUndefined();
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

	test("isolation:worktree fails loud: degrades to null, warns + diagnoses, never launches (Epic 0.4)", async () => {
		const runner = new FakeRunner({ summaryText: "OK" });
		const { agent, events, diags } = harness({ runner });

		// The agent degrades to null rather than running unisolated.
		expect(await agent("p", { isolation: "worktree" })).toBeNull();

		// Loud on the progress stream: a warn naming the unsupported isolation, and a
		// visible start/end pair with status error (no silent vanish).
		const warn = events.find((e) => e.type === "warn");
		expect(warn).toBeDefined();
		expect((warn as { message: string }).message).toContain("worktree");
		const end = events.find((e) => e.type === "agent:end");
		expect((end as { status: string }).status).toBe("error");
		expect((end as { note?: string }).note).toContain("isolation_unsupported");

		// A typed post-mortem diagnostic is recorded.
		expect(diags).toHaveLength(1);
		expect(diags[0]?.reason).toBe("isolation_unsupported");

		// Crucially: NO child session was launched (it did not run unisolated), and
		// no agent:launched event was emitted before the degrade.
		expect(runner.launches.length).toBe(0);
		expect(events.some((e) => e.type === "agent:launched")).toBe(false);
	});

	test("a worktree request does NOT detonate its parallel() batch — a sibling completes (Epic 0.4)", async () => {
		const runner = new FakeRunner({ summaryText: "SIBLING_OK" });
		const { agent } = harness({ runner });

		// Both run in the same batch (degrade, don't detonate): the worktree request
		// resolves null, the sibling resolves its real result — neither rejects.
		const [bad, good] = await Promise.all([
			agent("needs-isolation", { isolation: "worktree" }),
			agent("plain-sibling"),
		]);
		expect(bad).toBeNull();
		expect(good).toBe("SIBLING_OK");
	});
});

// ---- Task H.1.2: mint a per-agent worktree (replace P0.4 degrade-to-null) -

/** A worktree manager that records every call and mints a fixed handle. */
function recordingWorktreeManager(
	overrides: Partial<WorktreeManagerSeam> & {
		createReturns?: { dir: string; branch: string } | null;
	} = {},
): WorktreeManagerSeam & {
	creates: { runId: string; label: string }[];
	cleanups: { dir: string; branch: string }[];
	mergeBacks: { dir: string; branch: string }[];
	unchangedChecks: string[];
} {
	const creates: { runId: string; label: string }[] = [];
	const cleanups: { dir: string; branch: string }[] = [];
	const mergeBacks: { dir: string; branch: string }[] = [];
	const unchangedChecks: string[] = [];
	const handle =
		overrides.createReturns !== undefined
			? overrides.createReturns
			: { dir: "/tmp/wf/run-1/L", branch: "wf/run-1/L" };
	return {
		creates,
		cleanups,
		mergeBacks,
		unchangedChecks,
		create:
			overrides.create ??
			(async (key) => {
				creates.push(key);
				return handle;
			}),
		mergeBack:
			overrides.mergeBack ??
			(async (dir, branch) => {
				mergeBacks.push({ dir, branch });
				return { merged: true };
			}),
		isUnchanged:
			overrides.isUnchanged ??
			(async (dir) => {
				unchangedChecks.push(dir);
				return true;
			}),
		cleanup:
			overrides.cleanup ??
			(async (dir, branch) => {
				cleanups.push({ dir, branch });
			}),
		sweep: overrides.sweep ?? (async () => undefined),
	};
}

describe("createAgentPrimitive — worktree isolation mint (Task H.1.2)", () => {
	test("an isolated agent launches with directory=<worktree>, overriding run-wide directory", async () => {
		const runner = new FakeRunner({ status: "completed", summaryText: "OK" });
		const manager = recordingWorktreeManager({
			createReturns: { dir: "/tmp/wf/run-1/iso", branch: "wf/run-1/iso" },
		});
		const { agent } = harness({
			runner,
			worktreeManager: manager,
			// A run-wide directory the per-agent worktree must override.
			directory: "/repo/main",
		});

		expect(await agent("mutate files", { isolation: "worktree" })).toBe("OK");

		// One launch, re-rooted to the minted worktree (NOT the run-wide directory).
		expect(runner.launches).toHaveLength(1);
		expect(runner.launches[0]?.directory).toBe("/tmp/wf/run-1/iso");

		// create() was called with the run key and a per-call-unique label segment:
		// the display label folded with this call's deterministic index (collision-proof).
		expect(manager.creates).toEqual([
			{ runId: "run-1", label: "mutate files-0" },
		]);

		// Teardown registered in the finally: the minted worktree is cleaned up.
		expect(manager.cleanups).toEqual([
			{ dir: "/tmp/wf/run-1/iso", branch: "wf/run-1/iso" },
		]);
	});

	test("create() runs AFTER gate.acquire (a created worktree holds a real resource)", async () => {
		const runner = new FakeRunner({ deferred: true });
		const order: string[] = [];
		const gate = new ConcurrencyManager({ defaultConcurrency: 5 });
		const realAcquire = gate.acquire.bind(gate);
		gate.acquire = (k: string) => {
			order.push("acquire");
			return realAcquire(k);
		};
		const manager = recordingWorktreeManager({
			createReturns: { dir: "/tmp/wf/run-1/iso", branch: "wf/run-1/iso" },
			create: async () => {
				order.push("create");
				return { dir: "/tmp/wf/run-1/iso", branch: "wf/run-1/iso" };
			},
		});
		const { agent } = harness({ runner, gate, worktreeManager: manager });

		const call = agent("mutate", { isolation: "worktree" });
		await flush();
		// create must not run before the gate slot is held.
		expect(order).toEqual(["acquire", "create"]);

		runner.releaseOne("completed");
		await call;
	});

	test("create() returning null (manager present) degrades with worktree_mint_failed, NOT isolation_unsupported", async () => {
		const runner = new FakeRunner({ summaryText: "OK" });
		const manager = recordingWorktreeManager({ create: async () => null });
		const { agent, events, diags } = harness({
			runner,
			worktreeManager: manager,
		});

		expect(await agent("p", { isolation: "worktree" })).toBeNull();

		// Loud: warn + agent:end error. Because a manager IS threaded, the mint failure
		// must be reported as worktree_mint_failed (isolation IS supported, the mint
		// failed) and MUST NOT masquerade as isolation_unsupported.
		expect(events.some((e) => e.type === "warn")).toBe(true);
		const end = events.find((e) => e.type === "agent:end");
		expect((end as { status: string }).status).toBe("error");
		expect((end as { note?: string }).note).toContain("worktree_mint_failed");
		expect((end as { note?: string }).note).not.toContain(
			"isolation_unsupported",
		);
		expect(diags).toHaveLength(1);
		expect(diags[0]?.reason).toBe("worktree_mint_failed");

		// The warn names the true cause (a mint failure), not "not supported".
		const warn = events.find((e) => e.type === "warn") as { message: string };
		expect(warn.message.toLowerCase()).toContain("mint failed");
		expect(warn.message).not.toContain("not supported");

		// It did NOT run unisolated: no child session launched.
		expect(runner.launches).toHaveLength(0);
		expect(events.some((e) => e.type === "agent:launched")).toBe(false);
	});

	test("NO manager threaded keeps the genuine isolation_unsupported degrade", async () => {
		const runner = new FakeRunner({ summaryText: "OK" });
		// No worktreeManager at all: the feature has no primitive here.
		const { agent, events, diags } = harness({ runner });

		expect(await agent("p", { isolation: "worktree" })).toBeNull();

		const end = events.find((e) => e.type === "agent:end");
		expect((end as { status: string }).status).toBe("error");
		expect((end as { note?: string }).note).toContain("isolation_unsupported");
		expect(diags).toHaveLength(1);
		expect(diags[0]?.reason).toBe("isolation_unsupported");
		expect(runner.launches).toHaveLength(0);
	});

	test("colliding labels mint DISTINCT branches/dirs — the per-call index disambiguates", async () => {
		// Two parallel isolated agents with the SAME label. The manager (git-worktree.ts)
		// does NOT de-dup: identical labels would derive an identical branch+dir and the
		// second create would fail. Folding the per-call index into the mint key makes
		// each call's path/branch identity unique, so both creates carry distinct labels.
		const runner = new FakeRunner({ status: "completed", summaryText: "OK" });
		const manager = recordingWorktreeManager({
			create: async (key) => {
				manager.creates.push(key);
				return {
					dir: `/tmp/wf/run-1/${key.label}`,
					branch: `wf/run-1/${key.label}`,
				};
			},
		});
		const { agent } = harness({ runner, worktreeManager: manager });

		const [a, b] = await Promise.all([
			agent("mutate", { isolation: "worktree", label: "refuter" }),
			agent("mutate", { isolation: "worktree", label: "refuter" }),
		]);
		expect(a).toBe("OK");
		expect(b).toBe("OK");

		// Same display label, but the index-folded mint labels are distinct → no collision.
		const labels = manager.creates.map((c) => c.label).sort();
		expect(labels).toEqual(["refuter-0", "refuter-1"]);
		expect(labels[0]).not.toBe(labels[1]);
	});

	test("a null-create worktree request does NOT detonate its parallel() batch", async () => {
		const runner = new FakeRunner({ summaryText: "SIBLING_OK" });
		const manager = recordingWorktreeManager({ create: async () => null });
		const { agent } = harness({ runner, worktreeManager: manager });

		const [bad, good] = await Promise.all([
			agent("needs-isolation", { isolation: "worktree" }),
			agent("plain-sibling"),
		]);
		expect(bad).toBeNull();
		expect(good).toBe("SIBLING_OK");
	});

	test("a throwing cleanup is fenced — the agent still resolves its result", async () => {
		// The finally wraps worktreeManager.cleanup() in try/catch (degrade-don't-
		// detonate). A teardown failure must neither reject the agent nor change its
		// non-null result. A regression that removed the catch would surface here.
		const runner = new FakeRunner({ status: "completed", summaryText: "OK" });
		const manager = recordingWorktreeManager({
			create: async () => ({
				dir: "/tmp/wf/run-1/iso",
				branch: "wf/run-1/iso",
			}),
			cleanup: async () => {
				throw new Error("worktree remove failed");
			},
		});
		const { agent } = harness({ runner, worktreeManager: manager });

		expect(await agent("mutate", { isolation: "worktree" })).toBe("OK");
		expect(runner.launches).toHaveLength(1);
	});

	test("create() is gated under back-pressure — no mint without a held slot (limit-1)", async () => {
		// A defaultConcurrency:1 gate: a deferred first isolated agent holds the only
		// slot. A second isolated agent's create() must NOT fire until the first
		// releases — proving the mint sits strictly BEHIND gate.acquire under contention
		// (not merely after acquire on an always-available gate).
		const runner = new FakeRunner({ deferred: true });
		const gate = new ConcurrencyManager({ defaultConcurrency: 1 });
		const manager = recordingWorktreeManager({
			create: async (key) => {
				manager.creates.push(key);
				return {
					dir: `/tmp/wf/run-1/${key.label}`,
					branch: `wf/run-1/${key.label}`,
				};
			},
		});
		const { agent } = harness({ runner, gate, worktreeManager: manager });

		const first = agent("a", { isolation: "worktree", label: "one" });
		const second = agent("b", { isolation: "worktree", label: "two" });
		await flush();
		// The first holds the only slot and has minted; the second is parked on
		// gate.acquire and has NOT minted.
		expect(manager.creates).toHaveLength(1);
		expect(manager.creates[0]?.label).toBe("one-0");

		// Release the first; its slot frees and the second can finally mint + launch.
		runner.releaseOne("completed");
		await first;
		await flush();
		expect(manager.creates).toHaveLength(2);

		runner.releaseOne("completed");
		await second;
	});

	test("a non-isolated agent never mints a worktree even with a manager present", async () => {
		const runner = new FakeRunner({ status: "completed", summaryText: "OK" });
		const manager = recordingWorktreeManager();
		const { agent } = harness({
			runner,
			worktreeManager: manager,
			directory: "/repo/main",
		});

		expect(await agent("plain")).toBe("OK");
		expect(manager.creates).toHaveLength(0);
		expect(manager.cleanups).toHaveLength(0);
		// The run-wide directory still applies on the non-isolated path.
		expect(runner.launches[0]?.directory).toBe("/repo/main");
	});
});

// ---- Task H.1.3: verifyDiff + merge-back on agent:end --------------------

describe("createAgentPrimitive — worktree merge-back on settle (Task H.1.3)", () => {
	test("a CHANGED isolated agent merges back, THEN cleans up (merged path)", async () => {
		// isUnchanged:false → the worktree carries real work. The settle path must
		// mergeBack the scratch branch into the main tree, and on a clean merge tear the
		// worktree down. The merge must run BEFORE cleanup (merge-then-reclaim).
		const runner = new FakeRunner({ status: "completed", summaryText: "OK" });
		const order: string[] = [];
		const manager = recordingWorktreeManager({
			createReturns: { dir: "/tmp/wf/run-1/iso", branch: "wf/run-1/iso" },
			isUnchanged: async () => false,
			mergeBack: async (dir, branch) => {
				order.push(`merge:${dir}:${branch}`);
				return { merged: true };
			},
			cleanup: async (dir, branch) => {
				order.push(`cleanup:${dir}:${branch}`);
			},
		});
		const { agent } = harness({ runner, worktreeManager: manager });

		expect(await agent("mutate", { isolation: "worktree" })).toBe("OK");

		// mergeBack ran against the minted worktree's dir+branch, THEN cleanup.
		expect(order).toEqual([
			"merge:/tmp/wf/run-1/iso:wf/run-1/iso",
			"cleanup:/tmp/wf/run-1/iso:wf/run-1/iso",
		]);
	});

	test("an UNCHANGED isolated agent cleans up WITHOUT merging (auto-cleanup-if-unchanged)", async () => {
		// isUnchanged:true → CC's cleanup-if-unchanged: no merge commit pollutes the main
		// tree for a worktree that did nothing; the worktree is simply reclaimed.
		const runner = new FakeRunner({ status: "completed", summaryText: "OK" });
		const manager = recordingWorktreeManager({
			createReturns: { dir: "/tmp/wf/run-1/iso", branch: "wf/run-1/iso" },
			isUnchanged: async () => true,
		});
		const { agent } = harness({ runner, worktreeManager: manager });

		expect(await agent("noop", { isolation: "worktree" })).toBe("OK");

		expect(manager.mergeBacks).toHaveLength(0);
		expect(manager.cleanups).toEqual([
			{ dir: "/tmp/wf/run-1/iso", branch: "wf/run-1/iso" },
		]);
	});

	test("a merge CONFLICT preserves the worktree (SKIP cleanup) + emits merge_conflict", async () => {
		// Locked design decision #2: a conflict is Tier 1 — loud, first-class, NOT
		// auto-resolved. The worktree+branch are PRESERVED (not cleaned) so a Tier 2
		// resolver script can act on them, and a merge_conflict diagnostic surfaces.
		const runner = new FakeRunner({ status: "completed", summaryText: "OK" });
		const manager = recordingWorktreeManager({
			createReturns: { dir: "/tmp/wf/run-1/iso", branch: "wf/run-1/iso" },
			isUnchanged: async () => false,
			mergeBack: async () => ({
				conflict: true,
				branch: "wf/run-1/iso",
				files: ["src/A.ts"],
				baseRef: "base0000",
			}),
		});
		const { agent, diags } = harness({ runner, worktreeManager: manager });

		await agent("mutate", { isolation: "worktree" });

		// The conflicted worktree is PRESERVED for inspection / Tier 2 resolution.
		expect(manager.cleanups).toHaveLength(0);
		// A merge_conflict diagnostic surfaces (loud), naming the conflicted files.
		const conflict = diags.find((d) => d.reason === "merge_conflict");
		expect(conflict).toBeDefined();
	});

	test("a merge CONFLICT makes the agent result a first-class {status:'conflict'} value (Task H.1.4)", async () => {
		// Tier 1: the conflict is not a thrown error and not the agent's text — it is a
		// STRUCTURED result the script can branch on (status/branch/files/baseRef), so a
		// Tier 2 resolver step can act on the preserved worktree deterministically.
		const runner = new FakeRunner({ status: "completed", summaryText: "OK" });
		const manager = recordingWorktreeManager({
			createReturns: { dir: "/tmp/wf/run-1/iso", branch: "wf/run-1/iso" },
			isUnchanged: async () => false,
			mergeBack: async () => ({
				conflict: true,
				branch: "wf/run-1/iso",
				files: ["src/A.ts", "src/B.ts"],
				baseRef: "base0000",
			}),
		});
		const { agent, events } = harness({ runner, worktreeManager: manager });

		const result = await agent("mutate", { isolation: "worktree" });

		// The result is the first-class conflict value — NOT the agent's "OK" text.
		expect(result).toEqual({
			status: "conflict",
			branch: "wf/run-1/iso",
			files: ["src/A.ts", "src/B.ts"],
			baseRef: "base0000",
		});
		// A loud warn surfaces the conflict (mirrors P0.4's non-detonating discipline).
		const warn = events.find(
			(e) => e.type === "warn" && /conflict/i.test(e.message),
		);
		expect(warn).toBeDefined();
	});

	test("a CONFLICT does not detonate the batch — a sibling still settles (Task H.1.4)", async () => {
		// The conflicting agent returns its structured value; a sibling agent in the same
		// logical batch resolves normally (degrade-don't-detonate, mirroring P0.4).
		const runner = new FakeRunner({ status: "completed", summaryText: "OK" });
		const manager = recordingWorktreeManager({
			createReturns: { dir: "/tmp/wf/run-1/iso", branch: "wf/run-1/iso" },
			isUnchanged: async () => false,
			mergeBack: async () => ({
				conflict: true,
				branch: "wf/run-1/iso",
				files: ["src/A.ts"],
				baseRef: "base0000",
			}),
		});
		const { agent } = harness({ runner, worktreeManager: manager });

		const [conflicted, sibling] = await Promise.all([
			agent("mutate", { isolation: "worktree" }),
			agent("plain sibling"),
		]);

		expect(conflicted).toMatchObject({ status: "conflict" });
		// The non-isolated sibling completed normally — the conflict did not throw.
		expect(sibling).toBe("OK");
	});

	test("a FAILED (non-conflict) merge PRESERVES the worktree and degrades the agent to null", async () => {
		// {failed} is a NON-conflict merge failure (operator dirtied the main tree mid-run,
		// a transient failure, a lock-loss). The agent's edits are committed on the scratch
		// branch but did NOT reach the main tree. Silently cleaning up here would DROP that
		// work — the #5 lost-work catastrophe re-entering through the isolation path. So the
		// worktree+branch are PRESERVED (recoverable), a LOUD merge_failed diagnostic fires,
		// and the agent degrades to null so a resumed run re-attempts (nothing journaled).
		const runner = new FakeRunner({ status: "completed", summaryText: "OK" });
		const manager = recordingWorktreeManager({
			createReturns: { dir: "/tmp/wf/run-1/iso", branch: "wf/run-1/iso" },
			isUnchanged: async () => false,
			mergeBack: async () => ({ failed: true }),
		});
		const { agent, diags } = harness({ runner, worktreeManager: manager });

		const result = await agent("mutate", { isolation: "worktree" });

		// Degraded to null (the work did not land) — NOT the agent's "OK" text.
		expect(result).toBeNull();
		// PRESERVED: no cleanup ran, so the scratch branch still holds the recoverable work.
		expect(manager.cleanups).toEqual([]);
		// Surfaced LOUD as merge_failed; it is NOT a Tier 1 merge_conflict.
		expect(diags.some((d) => d.reason === "merge_failed")).toBe(true);
		expect(diags.some((d) => d.reason === "merge_conflict")).toBe(false);
	});

	test("BOTH the create and the merge-back are serialized on serializeOnCheckpoint", async () => {
		// H.1.2/H.1.3: the `git worktree add` (create, at mint) AND the merge-back (at
		// settle) both run on the SAME checkpointTail that serializes commits. An
		// UNSERIALIZED create races a sibling's merge/commit for the `.git` ref locks → the
		// loser's merge exits non-zero with zero unmerged files → a phantom {failed} →
		// dropped work (the #5 tail through a lock race). Each runs inside its own barrier.
		const runner = new FakeRunner({ status: "completed", summaryText: "OK" });
		const trace: string[] = [];
		const manager = recordingWorktreeManager({
			create: async () => {
				trace.push("create");
				return { dir: "/tmp/wf/run-1/iso", branch: "wf/run-1/iso" };
			},
			isUnchanged: async () => false,
			mergeBack: async () => {
				trace.push("merge");
				return { merged: true };
			},
		});
		const serializeOnCheckpoint = async <T>(
			task: () => Promise<T>,
		): Promise<T> => {
			trace.push("enter-serialize");
			const out = await task();
			trace.push("exit-serialize");
			return out;
		};
		const { agent } = harness({
			runner,
			worktreeManager: manager,
			serializeOnCheckpoint,
		});

		expect(await agent("mutate", { isolation: "worktree" })).toBe("OK");

		// Create AND merge each ran strictly inside a serialize barrier, in separate cycles
		// (create at mint, merge at settle) — never racing each other or a sibling.
		expect(trace).toEqual([
			"enter-serialize",
			"create",
			"exit-serialize",
			"enter-serialize",
			"merge",
			"exit-serialize",
		]);
	});

	test("verifyDiff for a worktree agent is checked against the WORKTREE dir", async () => {
		// H.1.3 re-roots the verify shell to the worktree: the engine's verifyResult must
		// receive the worktree dir so a `{check}` command runs in the isolated checkout,
		// not the main tree (where the agent's edits do not yet exist).
		const runner = new FakeRunner({ status: "completed", summaryText: "OK" });
		const manager = recordingWorktreeManager({
			createReturns: { dir: "/tmp/wf/run-1/iso", branch: "wf/run-1/iso" },
			isUnchanged: async () => false,
		});
		const verifyCalls: Array<{ directory?: string }> = [];
		const { agent } = harness({
			runner,
			worktreeManager: manager,
			directory: "/repo/main",
			verifyResult: async (opts) => {
				verifyCalls.push({ directory: opts.directory });
				return { passed: true, available: true };
			},
		});

		await agent("mutate", {
			isolation: "worktree",
			verifyDiff: { check: "bun test" },
		});

		expect(verifyCalls).toHaveLength(1);
		expect(verifyCalls[0]?.directory).toBe("/tmp/wf/run-1/iso");
	});

	test("a throwing mergeBack is fenced — the agent still resolves its result", async () => {
		// Merge-back is best-effort wrt the agent's resolution (degrade-don't-detonate): a
		// thrown mergeBack must neither reject the agent nor change its non-null result.
		const runner = new FakeRunner({ status: "completed", summaryText: "OK" });
		const manager = recordingWorktreeManager({
			createReturns: { dir: "/tmp/wf/run-1/iso", branch: "wf/run-1/iso" },
			isUnchanged: async () => false,
			mergeBack: async () => {
				throw new Error("merge exploded");
			},
		});
		const { agent } = harness({ runner, worktreeManager: manager });

		expect(await agent("mutate", { isolation: "worktree" })).toBe("OK");
	});
});

// ---- Task 2.1.5: pre-launch checkpoint barrier ---------------------------

describe("createAgentPrimitive — awaitCheckpointClear barrier (Task 2.1.5)", () => {
	test("the barrier blocks runner.launch until it resolves (commit-before-next-unit)", async () => {
		const runner = new FakeRunner({ summaryText: "OK" });
		// A controllable deferred barrier: launch must NOT fire until release() runs.
		let release!: () => void;
		const barrier = new Promise<void>((r) => {
			release = r;
		});
		const { agent } = harness({
			runner,
			awaitCheckpointClear: () => barrier,
		});

		const call = agent("p");
		// Drain microtasks: the call has passed gate.acquire and is parked on the
		// barrier — it must NOT have launched yet.
		await flush();
		expect(runner.launches.length).toBe(0);

		// Releasing the barrier lets the launch proceed.
		release();
		expect(await call).toBe("OK");
		expect(runner.launches.length).toBe(1);
	});

	test("absent barrier → launch proceeds immediately (optional, existing tests green)", async () => {
		const runner = new FakeRunner({ summaryText: "OK" });
		const { agent } = harness({ runner });
		expect(await agent("p")).toBe("OK");
		expect(runner.launches.length).toBe(1);
	});

	test("the barrier is awaited AFTER gate.acquire, not before (it holds a slot while draining)", async () => {
		// A limit-1 gate. The barrier resolves immediately; correctness here is just
		// that the call completes and releases the slot for a second call.
		const gate = new ConcurrencyManager({ defaultConcurrency: 1 });
		const runner = new FakeRunner({ summaryText: "OK" });
		let cleared = 0;
		const { agent } = harness({
			runner,
			gate,
			awaitCheckpointClear: async () => {
				cleared += 1;
			},
		});
		expect(await agent("a")).toBe("OK");
		expect(await agent("b")).toBe("OK");
		// The barrier was consulted on each launch.
		expect(cleared).toBe(2);
		expect(gate.runningCount("run-1")).toBe(0);
	});
});

// ---- Epic 4.1: contextDiff injection + empty-diff refusal -----------------

describe("createAgentPrimitive — contextDiff injection (Task 4.1.2)", () => {
	const okDiff = (text: string) => async () => ({
		text,
		isEmpty: text.trim().length === 0,
		available: true,
	});

	test("contextDiff:true + non-empty diff → launches with a synthetic contextPart carrying the diff", async () => {
		const runner = new FakeRunner({ summaryText: "REVIEWED" });
		const { agent } = harness({
			runner,
			resolveContextDiff: okDiff("diff --git a/x b/x\n+line"),
		});
		expect(await agent("review the unit", { contextDiff: true })).toBe(
			"REVIEWED",
		);
		const launch = runner.launches[0];
		expect(launch?.contextParts).toEqual([
			{ type: "text", text: "diff --git a/x b/x\n+line", synthetic: true },
		]);
	});

	test("computeCallKey is byte-identical with and without contextDiff (replay identity stable)", async () => {
		const a = computeCallKey({ prompt: "review the unit" });
		// The key the live path computes for a contextDiff call must match a plain call:
		// contextDiff is NOT a CallKeyInput field, and the diff rides a contextPart, not
		// the prompt. Assert via the journaled key.
		const recorded: JournalEntry[] = [];
		const runner = new FakeRunner({ summaryText: "R" });
		const { agent } = harness({
			runner,
			resolveContextDiff: okDiff("some diff"),
			replay: { entries: [], onRecord: (e) => recorded.push(e) },
		});
		await agent("review the unit", { contextDiff: true });
		expect(recorded[0]?.key).toBe(a);
	});

	test("contextDiff falsy → no diff part, resolveContextDiff never consulted", async () => {
		let consulted = false;
		const runner = new FakeRunner({ summaryText: "R" });
		const { agent } = harness({
			runner,
			resolveContextDiff: async () => {
				consulted = true;
				return { text: "d", isEmpty: false, available: true };
			},
		});
		await agent("plain call");
		expect(consulted).toBe(false);
		expect(runner.launches[0]?.contextParts).toBeUndefined();
	});

	test("resolveContextDiff absent (standalone lib) → contextDiff:true behaves as today, no diff part", async () => {
		const runner = new FakeRunner({ summaryText: "R" });
		const { agent } = harness({ runner });
		expect(await agent("review", { contextDiff: true })).toBe("R");
		expect(runner.launches[0]?.contextParts).toBeUndefined();
	});

	test("a rejecting resolveContextDiff is fenced → launches with NO diff part, never throws", async () => {
		const runner = new FakeRunner({ summaryText: "R" });
		const { agent } = harness({
			runner,
			resolveContextDiff: async () => {
				throw new Error("git blew up");
			},
		});
		expect(await agent("review", { contextDiff: true })).toBe("R");
		expect(runner.launches[0]?.contextParts).toBeUndefined();
	});
});

describe("createAgentPrimitive — empty-diff refusal (Task 4.1.3)", () => {
	test("contextDiff:true + available + empty diff → refuses (null, diagnostic, no launch)", async () => {
		const runner = new FakeRunner({ summaryText: "SHOULD NOT RUN" });
		const { agent, events, diags } = harness({
			runner,
			resolveContextDiff: async () => ({
				text: "",
				isEmpty: true,
				available: true,
			}),
		});
		expect(await agent("review the unit", { contextDiff: true })).toBeNull();
		// Did NOT launch.
		expect(runner.launches.length).toBe(0);
		// Emitted the degrade lifecycle: warn + start + end(error, note~='empty diff').
		expect(events.some((e) => e.type === "warn")).toBe(true);
		expect(events.some((e) => e.type === "agent:start")).toBe(true);
		const end = events.find((e) => e.type === "agent:end") as Extract<
			ProgressEvent,
			{ type: "agent:end" }
		>;
		expect(end.status).toBe("error");
		expect(end.note).toContain("empty diff");
		// Fired the typed diagnostic.
		expect(diags.some((d) => d.reason === "empty_diff")).toBe(true);
	});

	test("contextDiff:true + non-empty diff → launches normally (no refusal)", async () => {
		const runner = new FakeRunner({ summaryText: "REVIEWED" });
		const { agent, diags } = harness({
			runner,
			resolveContextDiff: async () => ({
				text: "real diff",
				isEmpty: false,
				available: true,
			}),
		});
		expect(await agent("review", { contextDiff: true })).toBe("REVIEWED");
		expect(runner.launches.length).toBe(1);
		expect(diags.some((d) => d.reason === "empty_diff")).toBe(false);
	});

	test("contextDiff:true + available:false (no shell / non-git) → launches normally, does NOT refuse", async () => {
		const runner = new FakeRunner({ summaryText: "REVIEWED" });
		const { agent, diags } = harness({
			runner,
			resolveContextDiff: async () => ({
				text: "",
				isEmpty: true,
				available: false,
			}),
		});
		// Emptiness is UNPROVABLE without git → run the review, inject NO diff part.
		expect(await agent("review", { contextDiff: true })).toBe("REVIEWED");
		expect(runner.launches.length).toBe(1);
		expect(runner.launches[0]?.contextParts).toBeUndefined();
		expect(diags.some((d) => d.reason === "empty_diff")).toBe(false);
	});

	test("a refused review does not hold a gate slot (a sibling still completes)", async () => {
		// A limit-1 gate: if the refusal leaked a held slot, the second call would hang.
		const gate = new ConcurrencyManager({ defaultConcurrency: 1 });
		const runner = new FakeRunner({ summaryText: "OK" });
		const { agent } = harness({
			runner,
			gate,
			resolveContextDiff: async () => ({
				text: "",
				isEmpty: true,
				available: true,
			}),
		});
		expect(await agent("refused", { contextDiff: true })).toBeNull();
		// The slot is free → a normal call (no contextDiff) launches and completes.
		expect(await agent("sibling")).toBe("OK");
		expect(gate.runningCount("run-1")).toBe(0);
	});
});

// ---- Epic 4.2: verifyDiff post-condition downgrade ------------------------

describe("createAgentPrimitive — verifyDiff downgrade (Task 4.2.2)", () => {
	test("verifyDiff:true that settles non-null but FAILS verify → downgrades to null, not journaled", async () => {
		const recorded: JournalEntry[] = [];
		const runner = new FakeRunner({ status: "completed", summaryText: "DONE" });
		const { agent, events, diags } = harness({
			runner,
			replay: { entries: [], onRecord: (e) => recorded.push(e) },
			verifyResult: async () => ({
				passed: false,
				available: true,
				reason: "empty git diff",
			}),
		});
		expect(await agent("fix the bug", { verifyDiff: true })).toBeNull();
		// The agent DID launch and settle (verify is post-settle).
		expect(runner.launches.length).toBe(1);
		// Downgraded result is NOT journaled (re-runs on resume).
		expect(recorded).toEqual([]);
		// agent:end carries a verify note + a typed diagnostic fires.
		const end = events.find((e) => e.type === "agent:end") as Extract<
			ProgressEvent,
			{ type: "agent:end" }
		>;
		expect(end.note).toContain("verify_failed");
		expect(diags.some((d) => d.reason === "verify_failed")).toBe(true);
	});

	test("verifyDiff:{check:'false'} (exit != 0) → same downgrade", async () => {
		const recorded: JournalEntry[] = [];
		const runner = new FakeRunner({ status: "completed", summaryText: "DONE" });
		const { agent, diags } = harness({
			runner,
			replay: { entries: [], onRecord: (e) => recorded.push(e) },
			verifyResult: async (o) => ({
				passed:
					typeof o.verifyDiff === "object" && o.verifyDiff.check === "true",
				available: true,
			}),
		});
		expect(
			await agent("fix it", { verifyDiff: { check: "false" } }),
		).toBeNull();
		expect(recorded).toEqual([]);
		expect(diags.some((d) => d.reason === "verify_failed")).toBe(true);
	});

	test("verifyDiff:{check:'true'} (exit 0) → result preserved + journaled", async () => {
		const recorded: JournalEntry[] = [];
		const runner = new FakeRunner({ status: "completed", summaryText: "DONE" });
		const { agent, diags } = harness({
			runner,
			replay: { entries: [], onRecord: (e) => recorded.push(e) },
			verifyResult: async (o) => ({
				passed:
					typeof o.verifyDiff === "object" && o.verifyDiff.check === "true",
				available: true,
			}),
		});
		expect(await agent("fix it", { verifyDiff: { check: "true" } })).toBe(
			"DONE",
		);
		expect(recorded.length).toBe(1);
		expect(diags.some((d) => d.reason === "verify_failed")).toBe(false);
	});

	test("available:false (no shell / non-git) → result passes through unchanged, no fabricated failure", async () => {
		const recorded: JournalEntry[] = [];
		const runner = new FakeRunner({ status: "completed", summaryText: "DONE" });
		const { agent, diags } = harness({
			runner,
			replay: { entries: [], onRecord: (e) => recorded.push(e) },
			verifyResult: async () => ({ passed: false, available: false }),
		});
		// available:false → the check is inert; the result survives even though passed
		// is false (we cannot PROVE a failure without git).
		expect(await agent("fix it", { verifyDiff: true })).toBe("DONE");
		expect(recorded.length).toBe(1);
		expect(diags.some((d) => d.reason === "verify_failed")).toBe(false);
	});

	test("verifyResult absent → verifyDiff:true behaves as today (no downgrade)", async () => {
		const runner = new FakeRunner({ status: "completed", summaryText: "DONE" });
		const { agent } = harness({ runner });
		expect(await agent("fix it", { verifyDiff: true })).toBe("DONE");
	});

	test("verifyDiff unset → verifyResult never consulted", async () => {
		let consulted = false;
		const runner = new FakeRunner({ status: "completed", summaryText: "DONE" });
		const { agent } = harness({
			runner,
			verifyResult: async () => {
				consulted = true;
				return { passed: true, available: true };
			},
		});
		expect(await agent("fix it")).toBe("DONE");
		expect(consulted).toBe(false);
	});

	test("a thrown verify check is fenced → result passes through (no thrown agent())", async () => {
		const recorded: JournalEntry[] = [];
		const runner = new FakeRunner({ status: "completed", summaryText: "DONE" });
		const { agent, diags } = harness({
			runner,
			replay: { entries: [], onRecord: (e) => recorded.push(e) },
			verifyResult: async () => {
				throw new Error("shell exploded");
			},
		});
		// A thrown verify degrades to available:false pass-through, never a thrown agent.
		expect(await agent("fix it", { verifyDiff: true })).toBe("DONE");
		expect(recorded.length).toBe(1);
		expect(diags.some((d) => d.reason === "verify_failed")).toBe(false);
	});

	test("a null-settling agent (failed) is not re-verified (verify only runs on non-null)", async () => {
		let consulted = false;
		const runner = new FakeRunner({ status: "error" });
		const { agent } = harness({
			runner,
			verifyResult: async () => {
				consulted = true;
				return { passed: true, available: true };
			},
		});
		expect(await agent("fix it", { verifyDiff: true })).toBeNull();
		// Nothing on disk to verify when the agent itself degraded to null.
		expect(consulted).toBe(false);
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
		const settled = recorded[0];
		expect(settled?.status === "ok" && settled.result).toEqual({ n: 5 });
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

describe("createAgentPrimitive — cached replay path (key + occurrence, Task 7.3.1)", () => {
	// Task 7.3.1 / field finding R4: replay matches per-key occurrence queues, not a
	// positional `prefixIntact` latch. A key mismatch at one call no longer voids
	// later unchanged items — each call independently shifts ITS key's queue.
	test("every matching key replays cached with ZERO launches and status cached", async () => {
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

	test("R4: editing item 0's key runs item 0 LIVE while item 1 still replays cached", async () => {
		// THE field finding (report §4.3): editing parallel() item 0's prompt must
		// not re-execute an unchanged, expensive item 1. Under the old prefix latch,
		// item 0's mismatch flipped `prefixIntact=false` forever → item 1 re-ran
		// (identical key, 4m17s, different answer). Per-key matching keeps item 1 cached.
		const runner = new FakeRunner({ status: "completed", summaryText: "LIVE" });
		const entries: JournalEntry[] = [
			{
				index: 0,
				key: computeCallKey({ prompt: "item0-OLD" }),
				status: "ok",
				result: "cached-0",
			},
			{
				index: 1,
				key: computeCallKey({ prompt: "item1" }),
				status: "ok",
				result: "cached-1-expensive",
			},
		];
		const { agent, events } = harness({
			runner,
			replay: { entries, onRecord: () => {} },
		});
		// Item 0's prompt was edited → no journaled key matches → runs LIVE.
		expect(await agent("item0-EDITED")).toBe("LIVE");
		// Item 1 is UNCHANGED → its key still has a queued entry → replays cached,
		// even though an earlier call diverged. This is the whole point of 7.3.1.
		expect(await agent("item1")).toBe("cached-1-expensive");
		expect((runner as FakeRunner).launches.length).toBe(1);
		const ends = events.filter((e) => e.type === "agent:end");
		expect(ends.map((e) => (e.type === "agent:end" ? e.status : ""))).toEqual([
			"completed", // item 0 ran live
			"cached", // item 1 replayed
		]);
	});

	test("position independence: reordered identical-key calls still replay", async () => {
		// The journal recorded keys in one order; the resumed script issues them in a
		// DIFFERENT order. Per-key queues match on key identity, not call index, so
		// each call still finds its cached result.
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
			replay: { entries, onRecord: () => {} },
		});
		// Issue them in REVERSE order vs the journal — both still replay.
		expect(await agent("b")).toBe("cached-b");
		expect(await agent("a")).toBe("cached-a");
		expect((r as FakeRunner).launches.length).toBe(0);
	});

	test("N byte-identical journaled calls → N replays, the N+1th runs live (occurrence)", async () => {
		// CC's adversarial-verify spawns N byte-identical refuters. Key-only matching
		// would wrongly dedupe them to one; occurrence queues replay each of the N
		// recorded results exactly once, then the N+1th (no queue left) runs live.
		const runner = new FakeRunner({ status: "completed", summaryText: "LIVE" });
		const key = computeCallKey({ prompt: "dup" });
		const entries: JournalEntry[] = [
			{ index: 0, key, status: "ok", result: "dup-0" },
			{ index: 1, key, status: "ok", result: "dup-1" },
			{ index: 2, key, status: "ok", result: "dup-2" },
		];
		const { agent, runner: r } = harness({
			runner,
			replay: { entries, onRecord: () => {} },
		});
		// Three identical calls drain the queue in recorded order.
		expect(await agent("dup")).toBe("dup-0");
		expect(await agent("dup")).toBe("dup-1");
		expect(await agent("dup")).toBe("dup-2");
		// The 4th identical call has an empty queue → runs LIVE.
		expect(await agent("dup")).toBe("LIVE");
		expect((r as FakeRunner).launches.length).toBe(1);
	});

	test("a cached hit re-records under the CURRENT call index (journals stay self-contained)", async () => {
		// The new journal records each replay with the CURRENT callIndex ordinal, not
		// the prior journal's index — so a resumed run's journal indexes are dense and
		// match this run's call order. Here calls run in reverse, so index 0 carries
		// the entry the prior journal stored at index 1.
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
		expect(await agent("b")).toBe("cached-b");
		expect(await agent("a")).toBe("cached-a");
		expect((r as FakeRunner).launches.length).toBe(0);
		expect(recorded).toEqual([
			{
				index: 0,
				key: computeCallKey({ prompt: "b" }),
				status: "ok",
				result: "cached-b",
			},
			{
				index: 1,
				key: computeCallKey({ prompt: "a" }),
				status: "ok",
				result: "cached-a",
			},
		]);
	});

	test("cached calls still advance counters.agents and hit the 1000 cap", async () => {
		const runner = new FakeRunner({ status: "completed" });
		const entries: JournalEntry[] = [
			{
				index: 0,
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

	test("an absent (previously-null) key runs live — failure-targeted retry", async () => {
		// Previously-null items were never journaled, so their key is absent from the
		// queue map → they run live on resume. Failure-targeted retry, by construction.
		const runner = new FakeRunner({ status: "completed", summaryText: "LIVE" });
		const entries: JournalEntry[] = [
			{
				index: 0,
				key: computeCallKey({ prompt: "a" }),
				status: "ok",
				result: "cached-a",
			},
		];
		const { agent } = harness({
			runner,
			replay: { entries, onRecord: () => {} },
		});
		expect(await agent("a")).toBe("cached-a"); // key present → cached
		expect(await agent("never-journaled")).toBe("LIVE"); // absent key → live
		expect((runner as FakeRunner).launches.length).toBe(1);
	});
});

// ---- Phase 3.1.2: write-ahead intent + replay-cache poison guard ----------

describe("createAgentPrimitive — write-ahead intent (Phase 3)", () => {
	test("a live call AWAITS the intent write BEFORE launch (durability)", async () => {
		// onIntent resolves only after we release it; launch must not have happened
		// while the intent is still pending — proving the await sits before dispatch.
		let releaseIntent: (() => void) | undefined;
		const intentGate = new Promise<void>((res) => {
			releaseIntent = res;
		});
		const intents: IntentJournalEntry[] = [];
		const runner = new FakeRunner({ status: "completed", summaryText: "LIVE" });
		const { agent } = harness({
			runner,
			replay: {
				entries: [],
				onRecord: () => {},
				onIntent: async (e) => {
					intents.push(e);
					await intentGate;
				},
			},
		});
		const pending = agent("do work", { label: "L" });
		await flush();
		// Intent was emitted, but launch is still blocked behind the intent await.
		expect(intents).toHaveLength(1);
		expect(intents[0]).toEqual({
			index: 0,
			key: computeCallKey({ prompt: "do work" }),
			status: "intent",
			label: "L",
		});
		expect((runner as FakeRunner).launches.length).toBe(0);
		// Release the intent → the launch proceeds and the call settles.
		releaseIntent?.();
		expect(await pending).toBe("LIVE");
		expect((runner as FakeRunner).launches.length).toBe(1);
	});

	test("a cached replay writes NO intent (it never launches)", async () => {
		const intents: IntentJournalEntry[] = [];
		const runner = new FakeRunner({ status: "completed", summaryText: "LIVE" });
		const { agent } = harness({
			runner,
			replay: {
				entries: [
					{
						index: 0,
						key: computeCallKey({ prompt: "a" }),
						status: "ok",
						result: "cached-a",
					},
				],
				onRecord: () => {},
				onIntent: (e) => {
					intents.push(e);
				},
			},
		});
		expect(await agent("a")).toBe("cached-a");
		expect(intents).toHaveLength(0);
		expect((runner as FakeRunner).launches.length).toBe(0);
	});

	test("a throwing onIntent degrades to launch-anyway (fenced, never detonates)", async () => {
		const runner = new FakeRunner({ status: "completed", summaryText: "LIVE" });
		const { agent } = harness({
			runner,
			replay: {
				entries: [],
				onRecord: () => {},
				onIntent: () => {
					throw new Error("journal append failed");
				},
			},
		});
		// The intent append blew up; the call must still launch and resolve.
		expect(await agent("do work")).toBe("LIVE");
		expect((runner as FakeRunner).launches.length).toBe(1);
	});

	test("an intent in replay.entries is excluded from byKey — a resumed call runs LIVE", async () => {
		// HIGH-BLAST guard (3.1.2): a crashed prior run's intent line carries no
		// result. If it entered the key's replay queue, a resumed call would shift it
		// and replay garbage. The filter keeps it out → the call runs live.
		const runner = new FakeRunner({ status: "completed", summaryText: "LIVE" });
		const key = computeCallKey({ prompt: "K" });
		const entries: JournalEntry[] = [
			{ index: 0, key, status: "intent", label: "K" },
		];
		const { agent } = harness({
			runner,
			replay: { entries, onRecord: () => {}, onIntent: () => {} },
		});
		expect(await agent("K")).toBe("LIVE");
		expect((runner as FakeRunner).launches.length).toBe(1);
	});

	test("an intent before its settled completion does NOT consume the settled queue slot", async () => {
		// A resumed run's OWN journal interleaves intent + ok for the same key. The
		// settled `ok` must still replay; the intent must not occupy the occurrence
		// slot (else the call would run live and re-do settled work).
		const runner = new FakeRunner({ status: "completed", summaryText: "LIVE" });
		const key = computeCallKey({ prompt: "K" });
		const entries: JournalEntry[] = [
			{ index: 0, key, status: "intent", label: "K" },
			{ index: 0, key, status: "ok", result: "settled-K" },
		];
		const { agent } = harness({
			runner,
			replay: { entries, onRecord: () => {}, onIntent: () => {} },
		});
		expect(await agent("K")).toBe("settled-K");
		expect((runner as FakeRunner).launches.length).toBe(0);
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
