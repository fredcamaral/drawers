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
	type AgentFn,
	type AgentOpts,
	type BudgetView,
	NotYetSupportedError,
	type ProgressEmitter,
	type ProgressEvent,
	type RuntimeApi,
} from "./types";

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
	const gate = new ConcurrencyManager({ defaultConcurrency: gateLimit(cores) });

	const counters = { agents: 0 };
	const liveTasks = new Set<string>();
	const currentPhaseBox: { value?: string } = {};
	const progress: ProgressEvent[] = [];

	let aborted = false;

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

	// One schema/result registry per run, shared by the agent primitive and (in
	// Phase 4) the global structured_output tool.
	const registry = createSchemaRegistry();

	// The real agent primitive over the core runner.
	const innerAgent = createAgentPrimitive({
		runner: deps.runner,
		parentSessionID: deps.parentSessionID,
		runId: deps.runId,
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
	});

	// Wrap the primitive so that after abort(), NEW calls resolve null immediately
	// rather than launching fresh children.
	const agent: AgentFn = (prompt: string, opts?: AgentOpts) => {
		if (aborted) {
			return Promise.resolve(null);
		}
		return innerAgent(prompt, opts);
	};

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
		workflow: (() => {
			throw new NotYetSupportedError(
				"sub-workflows arrive with the workflows plugin (Phase 4)",
			);
		}) as RuntimeApi["workflow"],
	};

	function abort(): void {
		aborted = true;
		// Reject any agent acquire still queued behind the gate for this run.
		gate.cancelWaiters(deps.runId);
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
