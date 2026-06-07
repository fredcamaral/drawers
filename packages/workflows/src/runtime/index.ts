/**
 * Workflow runtime assembly (Task 3.2.3).
 *
 * `createWorkflowRun` binds the parse → evaluate → API-assembly pipeline into a
 * single `run(source)` entry point. It owns the seams the lower modules leave
 * open: the concurrency gate sized from host cores, the lifetime counters, the
 * `currentPhase` box read by `agent()` at CALL time, the progress journal +
 * fenced `onProgress` fan-out, and the abort latch that short-circuits new
 * `agent()` calls and cancels live children.
 *
 * `run()` NEVER rejects: parse/meta/body throws all resolve to a
 * `status: "error"` result. The Phase 4 tool layer decides presentation.
 */

import { availableParallelism } from "node:os";
import { ConcurrencyManager, type SessionRunner } from "@drawers/core";
import { createAgentPrimitive } from "./agent-call";
import { parallel, pipeline } from "./compose";
import { evaluateScript } from "./evaluate";
import { parseScript, type WorkflowMeta } from "./meta";
import {
	createSchemaRegistry,
	type SchemaRegistry,
} from "./structured/registry";
import {
	type ChildRunResult,
	createSubWorkflowPrimitive,
} from "./sub-workflow";
import type {
	AgentFn,
	AgentOpts,
	BudgetView,
	JournalEntry,
	ProgressEmitter,
	ProgressEvent,
	RuntimeApi,
} from "./types";

/**
 * The shared, mutable boxes a child sub-workflow run (spec §8) inherits from its
 * parent so that the child's agents count against the parent's caps, hold the same
 * concurrency slots, charge the same budget, and abort together. `createWorkflowRun`
 * mints these when absent (a fresh top-level run) and the sub-workflow `runChild`
 * closure threads the parent's set into the child.
 */
export interface SharedRunBoxes {
	/** The per-workflow concurrency gate, keyed by the TOP-LEVEL runId. */
	gate: ConcurrencyManager;
	/** The lifetime agent counter (boundary + every child agent count here). */
	counters: { agents: number };
	/** Live child task ids, so a parent abort() cancels in-flight child agents. */
	liveTasks: Set<string>;
	/** The shared abort latch: parent abort() flips it; child agent() reads it. */
	abortBox: { aborted: boolean };
	/** The gate key used for acquire/release/cancel (the top-level runId). */
	gateKey: string;
}

/** Upper bound on the per-workflow concurrency gate (spec §5). */
const MAX_CONCURRENCY = 16;
/** Cores reserved for the host (main loop + headroom) — spec §5 `cores − 2`. */
const RESERVED_CORES = 2;
/** Default subagent type when the caller pins none. */
const DEFAULT_AGENT = "build";

/** Collaborators `createWorkflowRun` needs to drive a single workflow run. */
export interface WorkflowRunDeps {
	runner: SessionRunner;
	parentSessionID: string;
	/** Concurrency-gate key, journal scope, and abort scope for this run. */
	runId: string;
	/** The invocation's `args`, exposed verbatim to the script. */
	args?: unknown;
	/** Host core count; defaults to `availableParallelism()`. */
	cores?: number;
	/** Shared token budget (spec §6); a permissive default is used when absent. */
	budget?: BudgetView;
	/** External progress sink; fenced so a throw cannot kill the run. */
	onProgress?: ProgressEmitter;
	defaults?: { agent?: string; awaitTimeoutMs?: number };
	/**
	 * Deterministic-resume seam (spec §7). Present on a resume: `entries` is the
	 * prior run's journal (replayed for the longest unchanged prefix), `onRecord`
	 * captures each settled non-null live result for the new journal.
	 */
	replay?: { entries: JournalEntry[]; onRecord: (e: JournalEntry) => void };
	/**
	 * Structured-output schema/result registry. When provided (Phase 4: a single
	 * plugin-level registry behind the global `structured_output` tool, shared
	 * across concurrent runs since sessionIDs are globally unique), the run uses
	 * THIS instance instead of minting its own — and `run.registry` returns it.
	 * Absent: the run creates its own (the standalone Phase 3 behavior).
	 */
	registry?: SchemaRegistry;
	/**
	 * Resolve a sub-workflow name/ref to its script SOURCE (spec §8). The plugin
	 * supplies fs + saved-name resolution; the library stays fs-free. PRESENT marks
	 * a top-level run whose `workflow()` global can nest one level; ABSENT (the
	 * default, and ALWAYS the case for a child) makes `workflow()` throw
	 * {@link NestingError} — depth 1 is enforced structurally.
	 */
	resolveSubWorkflow?: (
		nameOrRef: string | { scriptPath: string },
	) => Promise<string>;
	/**
	 * Pre-built shared boxes inherited from a parent run (spec §8). PRESENT only for
	 * a child sub-workflow run: the child shares the parent's gate, counter,
	 * liveTasks, and abort latch. ABSENT (a top-level run) → the run mints its own.
	 */
	shared?: SharedRunBoxes;
}

/** The terminal outcome of a workflow run (spec §2.3, §3.3). */
export interface WorkflowResult {
	/** The validated `meta` header; `undefined` only when parsing failed first. */
	meta: WorkflowMeta | undefined;
	/** The script's `return` value (`undefined` on any error). */
	returnValue: unknown;
	/** Every {@link ProgressEvent} emitted during the run, in order. */
	progress: ProgressEvent[];
	/** Lifetime `agent()` count for the run. */
	agentCount: number;
	status: "completed" | "error";
	/** Failure message when `status === "error"`. */
	error?: string;
}

/** A live workflow run: a single `run(source)` plus an `abort()` latch. */
export interface WorkflowRun {
	run(source: string): Promise<WorkflowResult>;
	abort(): void;
	/**
	 * The per-run structured-output schema/result registry backing
	 * `agent({ schema })`. Exposed because Phase 4's plugin shell registers the
	 * global `structured_output` tool against THIS SAME instance — the child's
	 * tool call and the agent primitive's result read must share state.
	 */
	registry: SchemaRegistry;
}

/** Cheap child meta-name for the child's DISPLAY runId; falls back to "child". */
function extractChildName(source: string): string {
	try {
		return parseScript(source).meta.name;
	} catch {
		return "child";
	}
}

/** Permissive default budget (spec §6): no target → remaining is Infinity. */
function defaultBudget(): BudgetView {
	return {
		total: null,
		spent: () => 0,
		remaining: () => Number.POSITIVE_INFINITY,
	};
}

/**
 * The per-workflow concurrency limit (spec §5): `min(16, cores − 2)`, floored at
 * 1. The floor matters because ConcurrencyManager treats a limit of 0 as
 * UNLIMITED — a 2-core host would otherwise get an uncapped gate.
 */
function gateLimit(cores: number): number {
	return Math.max(1, Math.min(MAX_CONCURRENCY, cores - RESERVED_CORES));
}

export function createWorkflowRun(deps: WorkflowRunDeps): WorkflowRun {
	const cores = deps.cores ?? availableParallelism();
	// A child run (spec §8) inherits the parent's gate / counter / liveTasks /
	// abort latch via `shared`; a top-level run mints fresh ones. The gate key is
	// the TOP-LEVEL runId so a child's acquires queue behind the same slots.
	const gate =
		deps.shared?.gate ??
		new ConcurrencyManager({ defaultConcurrency: gateLimit(cores) });
	const gateKey = deps.shared?.gateKey ?? deps.runId;
	const counters = deps.shared?.counters ?? { agents: 0 };
	const liveTasks = deps.shared?.liveTasks ?? new Set<string>();
	const abortBox = deps.shared?.abortBox ?? { aborted: false };

	const currentPhaseBox: { value?: string } = {};
	const progress: ProgressEvent[] = [];
	// Resume seam (§7): the deterministic call ordinal and the "prefix still
	// intact" latch are run-level, shared by every agent() invocation. A child run
	// (replay undefined) never consults them, so it keeps its own.
	const callIndex = { value: 0 };
	const prefixIntact = { value: true };

	// The shared boxes this run exposes to a child it spawns via workflow().
	const sharedBoxes: SharedRunBoxes = {
		gate,
		counters,
		liveTasks,
		abortBox,
		gateKey,
	};

	// Every event is journaled, then forwarded to the external sink. The sink is
	// fenced: a throwing onProgress must not kill the run.
	const emit: ProgressEmitter = (e) => {
		progress.push(e);
		try {
			deps.onProgress?.(e);
		} catch {
			// Swallow listener failures — progress is observational, not load-bearing.
		}
	};

	const budget = deps.budget ?? defaultBudget();

	// One schema/result registry, shared by the agent primitive and the global
	// structured_output tool. Phase 4 injects a plugin-level registry shared across
	// runs; absent, the run owns a standalone one (Phase 3 behavior).
	const registry = deps.registry ?? createSchemaRegistry();

	// The real agent primitive over the core runner. Its `runId` is the GATE KEY
	// (the top-level runId for a child) so a child's acquires share the parent's
	// slots and a parent abort's cancelWaiters(gateKey) reaches them.
	const innerAgent = createAgentPrimitive({
		runner: deps.runner,
		parentSessionID: deps.parentSessionID,
		runId: gateKey,
		gate,
		counters,
		budget,
		emit,
		currentPhase: () => currentPhaseBox.value,
		liveTasks,
		defaults: {
			agent: deps.defaults?.agent ?? DEFAULT_AGENT,
			awaitTimeoutMs: deps.defaults?.awaitTimeoutMs,
		},
		registry,
		replay: deps.replay,
		prefixIntact,
		callIndex,
	});

	// Wrap the primitive so that after abort(), NEW calls resolve null immediately
	// rather than launching fresh children. The abort latch is the SHARED box, so a
	// parent abort short-circuits a child's agent() too.
	const agent: AgentFn = (prompt: string, opts?: AgentOpts) => {
		if (abortBox.aborted) {
			return Promise.resolve(null);
		}
		return innerAgent(prompt, opts);
	};

	// The `workflow()` global (spec §8). The `runChild` closure builds the child run
	// HERE — sharing this run's boxes — so the factory itself stays runner-free and
	// the import stays acyclic. The child is built with resolveSubWorkflow undefined
	// (depth-1 structural guard) and replay undefined (the boundary entry covers it).
	const workflow = createSubWorkflowPrimitive({
		resolveSubWorkflow: deps.resolveSubWorkflow,
		runChild: async (
			childSource: string,
			childArgs: unknown,
			onProgress?: ProgressEmitter,
		): Promise<ChildRunResult> => {
			const child = createWorkflowRun({
				runner: deps.runner,
				parentSessionID: deps.parentSessionID,
				// Display-only id; the gate key stays the top-level runId via shared.
				runId: `${deps.runId}/${extractChildName(childSource)}`,
				args: childArgs,
				budget,
				registry,
				shared: sharedBoxes,
				...(onProgress !== undefined ? { onProgress } : {}),
				// No resolver → child workflow() throws NestingError (depth 1).
				// No replay → the boundary entry in the PARENT journal covers the child.
			});
			const result = await child.run(childSource);
			return result.status === "completed"
				? { status: "completed", returnValue: result.returnValue }
				: { status: "error", error: result.error };
		},
		counters,
		prefixIntact,
		callIndex,
		emit,
		currentPhase: () => currentPhaseBox.value,
		replay: deps.replay,
	});

	const api: RuntimeApi = {
		agent,
		pipeline: pipeline as RuntimeApi["pipeline"],
		parallel: parallel as RuntimeApi["parallel"],
		phase: (title: string) => {
			currentPhaseBox.value = title;
		},
		log: (message: string) => {
			emit({ type: "log", message });
		},
		args: deps.args,
		budget,
		workflow,
	};

	function abort(): void {
		abortBox.aborted = true;
		// Reject any agent acquire still queued behind the gate for this run.
		gate.cancelWaiters(gateKey);
		// Cancel every in-flight child (fire-and-forget, fenced).
		for (const id of [...liveTasks]) {
			void Promise.resolve()
				.then(() => deps.runner.cancel(id))
				.catch(() => {
					// Best-effort: a child already torn down is fine.
				});
		}
	}

	async function run(source: string): Promise<WorkflowResult> {
		let meta: WorkflowMeta | undefined;
		try {
			const parsed = parseScript(source);
			meta = parsed.meta;
			const returnValue = await evaluateScript(parsed.bodySource, api);
			return {
				meta,
				returnValue,
				progress,
				agentCount: counters.agents,
				status: "completed",
			};
		} catch (err) {
			return {
				meta,
				returnValue: undefined,
				progress,
				agentCount: counters.agents,
				status: "error",
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	return { run, abort, registry };
}
