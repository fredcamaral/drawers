/**
 * Workflow runtime assembly (Task 3.2.3, pi port).
 *
 * `createWorkflowRun` binds the parse → evaluate → API-assembly pipeline into a
 * single `run(source)` entry point. It owns the seams the lower modules leave
 * open: the concurrency gate sized from host cores, the lifetime counters, the
 * `currentPhase` box read by `agent()` at CALL time, the progress journal +
 * fenced `onProgress` fan-out, and the abort latch that short-circuits new
 * `agent()` calls and cancels live children.
 *
 * `run()` NEVER rejects: parse/meta/body throws all resolve to a
 * `status: "error"` result. The plugin tool layer decides presentation.
 *
 * pi port: the only coupling to the harness is the `SessionRunner` interface,
 * imported from `@drawers/pi-core` (a verbatim shape match minus `handleEvent` —
 * pi self-reports completion). Two pi-native seams thread straight to the agent
 * primitive: `resolveAgentKnobs` (agent NAME → pi child knobs, since pi has no
 * `--agent` flag) and `readStructured` (parent read-back of a child's echoed
 * structured value off its transcript). Both are engine-supplied and OPAQUE to the
 * runtime, symmetric with `resolveSkills`/`verifyResult`.
 */

import { availableParallelism } from "node:os";
import { ConcurrencyManager, type SessionRunner } from "@drawers/pi-core";
import {
	createAgentPrimitive,
	type ReadStructured,
	type ResolveAgentKnobs,
} from "./agent-call";
import { parallel, pipeline } from "./compose";
import { evaluateScript } from "./evaluate";
import { parseScript, type WorkflowMeta } from "./meta";
import { createShellPrimitive, type RunShell } from "./shell-call";
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
	DiagnosticEmitter,
	IntentJournalEntry,
	JournalEntry,
	ProgressEmitter,
	ProgressEvent,
	RuntimeApi,
	SettledJournalEntry,
	ShellFn,
	WorktreeManagerSeam,
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
	/**
	 * External diagnostic sink (Task 7.2.1): each null/empty `agent()` collapse
	 * reports a typed {@link AgentDiagnostic}. Fenced like `onProgress`. The engine
	 * collects these onto the run handle and persists them on the run record.
	 */
	onDiagnostic?: DiagnosticEmitter;
	defaults?: { agent?: string };
	/**
	 * Deterministic-resume seam (spec §7, Task 7.3.1). Present on a resume:
	 * `entries` is the prior run's journal (replayed per-key + occurrence,
	 * position-independent), `onRecord` captures each settled non-null live result
	 * for the new journal.
	 *
	 * `onIntent` (Phase 3) write-aheads a "dispatched-but-not-settled" marker before
	 * each LIVE agent launch; the engine wires it to a journal append that is awaited
	 * before dispatch. Optional so child runs and the standalone library are
	 * unaffected. Only the agent primitive consumes it — a `workflow()` boundary
	 * writes no intent.
	 */
	replay?: {
		entries: JournalEntry[];
		onRecord: (e: SettledJournalEntry) => void;
		onIntent?: (e: IntentJournalEntry) => Promise<void> | void;
	};
	/**
	 * Structured-output schema/result registry. When provided (the plugin's
	 * single registry shared across concurrent runs since sessionIDs are globally
	 * unique), the run uses THIS instance instead of minting its own — and
	 * `run.registry` returns it. Absent: the run creates its own (standalone behavior).
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
	 * Resolve a pi agent NAME → pi-native child knobs (system prompt / tools /
	 * model), threaded straight to the `agent()` primitive and inherited by child
	 * sub-workflow runs. pi has NO `--agent` flag, so the engine resolves an agent
	 * definition (its markdown body → appended system prompt, frontmatter → tools /
	 * model) and supplies this closure. OPAQUE to the runtime. ABSENT (the standalone
	 * library) → the child runs pi's default coding assistant.
	 */
	resolveAgentKnobs?: ResolveAgentKnobs;
	/**
	 * Read a completed structured child's echoed result off its transcript, threaded
	 * straight to the `agent()` primitive and inherited by child sub-workflow runs.
	 * The engine wires it to the runner's transcript read. OPAQUE to the runtime.
	 * ABSENT (the standalone library / tests that pre-populate the registry) → the
	 * parent reads the registry's stored value directly (the in-process fallback).
	 */
	readStructured?: ReadStructured;
	/**
	 * Pre-built shared boxes inherited from a parent run (spec §8). PRESENT only for
	 * a child sub-workflow run: the child shares the parent's gate, counter,
	 * liveTasks, and abort latch. ABSENT (a top-level run) → the run mints its own.
	 */
	shared?: SharedRunBoxes;
	/**
	 * Pre-launch checkpoint barrier (Task 2.1.5), threaded straight to the `agent()`
	 * primitive. The engine resolves it when the per-run commit chain has drained, so
	 * the next agent's launch blocks behind the prior agent's commit. OPAQUE to the
	 * runtime — it never learns what a checkpoint is, preserving the runtime's
	 * zero-plugin-knowledge layering. ABSENT → no blocking.
	 */
	awaitCheckpointClear?: () => Promise<void>;
	/**
	 * Resolve the engine-computed real git diff (since run start) for an
	 * `agent({ contextDiff:true })` review (Epic 4.1), threaded straight to the
	 * `agent()` primitive. The engine wires it to its per-run checkpointer's
	 * `diff()`; ABSENT (the standalone library, child runs without it) → no diff is
	 * injected and no review is refused. OPAQUE to the runtime — it never learns what
	 * a diff is, preserving the zero-plugin-knowledge layering.
	 */
	resolveContextDiff?: () => Promise<{
		text: string;
		isEmpty: boolean;
		available: boolean;
	}>;
	/**
	 * Resolve canonical skill names to synthetic contextParts for an
	 * `agent({ skills })` step (Epic 2.2), threaded straight to the `agent()`
	 * primitive. The engine wires it to the plugin-side skill resolver (disk reads
	 * under the pi skill root); ABSENT (the standalone library) → `skills` is
	 * inert. OPAQUE to the runtime — it never learns what a skill is. UNLIKE
	 * `resolveContextDiff`, a rejection is NOT fenced: an unknown name fails the
	 * launch loudly.
	 */
	resolveSkills?: (
		names: string[],
	) => Promise<Array<{ type: "text"; text: string; synthetic: true }>>;
	/**
	 * Verify an `agent({ verifyDiff })` post-condition after it settles (Epic 4.2),
	 * threaded straight to the `agent()` primitive. The engine wires it to its per-run
	 * checkpointer + repo-bound shell; ABSENT (the standalone library) → no
	 * verification. OPAQUE to the runtime — it never learns what a git diff or a check
	 * command is.
	 */
	verifyResult?: (opts: {
		verifyDiff: boolean | { check?: string };
		sessionId?: string;
		/**
		 * Epic H.1.3: the worktree dir to re-root the verify shell to. For an
		 * `isolation:'worktree'` agent the engine runs the `{check}` command against
		 * the WORKTREE checkout (where the agent's edits live), not the main tree.
		 * ABSENT → the engine-wide directory applies as today.
		 */
		directory?: string;
	}) => Promise<{ passed: boolean; available: boolean; reason?: string }>;
	/**
	 * Serialize a task onto the engine's per-run checkpoint chain (Epic H.1.3),
	 * threaded straight to the `agent()` primitive. The engine appends the task onto
	 * the SAME `checkpointTail` that orders per-unit commits and resolves with the
	 * task's result once it drains — so an isolated agent's merge-back never interleaves
	 * with a sibling's commit. OPAQUE to the runtime — it never learns what a checkpoint
	 * is. ABSENT (the standalone library, a no-shell engine) → the runtime runs the task
	 * inline (no cross-unit serialization, which is fine without a shared git tree).
	 */
	serializeOnCheckpoint?: <T>(task: () => Promise<T>) => Promise<T>;
	/**
	 * Per-agent project/worktree directory (Epic H.1), threaded straight to the
	 * `agent()` primitive (`AgentPrimitiveDeps.directory`) and inherited by child
	 * sub-workflow runs (a child runs in the same project today). OPAQUE to the
	 * runtime — it never learns what the directory is. It is a DIFFERENT layer from
	 * the engine-wide `directory` (the single project dir used for saved-workflow
	 * lookup): this is the per-agent worktree dir that re-roots one worker's cwd.
	 * ABSENT (the standalone library, non-isolated agents) → the engine-wide
	 * directory applies.
	 */
	directory?: string;
	/**
	 * The OPAQUE per-agent worktree manager (Epic H.1.6), threaded straight to the
	 * `agent()` primitive (`AgentPrimitiveDeps.worktreeManager`) and inherited by child
	 * sub-workflow runs (a child shares the parent's git tree today). The engine
	 * constructs it ONCE from the host `$` and passes it here; the isolation mint-point
	 * (Epic H.1.2) consumes it. OPAQUE to the runtime — see {@link WorktreeManagerSeam}.
	 * ABSENT (the standalone library, a no-shell engine — where the manager is a
	 * documented no-op) → isolation requests degrade-to-null (Epic 0.4).
	 */
	worktreeManager?: WorktreeManagerSeam;
	/**
	 * Run a deterministic shell command for the `shell()` global, threaded straight to
	 * the shell primitive. The engine wires it to the repo-bound host shell; ABSENT
	 * (the standalone library / a no-shell engine) → `shell()` is inert
	 * (`available:false`, never a fabricated pass). OPAQUE to the runtime — it never
	 * learns what a shell is, preserving the zero-plugin-knowledge layering. A child
	 * sub-workflow inherits the parent's shell (same project tree).
	 */
	runShell?: RunShell;
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
	 * `agent({ schema })`. Exposed because the plugin shell registers the global
	 * `structured_output` tool and the agent primitive's read-back populate THIS SAME
	 * instance — the parent's read-back and result read must share state.
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
	// Resume seam (§7, Task 7.3.1): the deterministic call ordinal is run-level,
	// shared by every agent()/workflow() invocation as the journal ordering anchor.
	// Replay matching itself is per-key+occurrence (no run-level latch), so there is
	// no `prefixIntact` to thread. A child run (replay undefined) keeps its own index.
	const callIndex = { value: 0 };

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

	// Task 7.2.1: the diagnostic sink, fenced like `emit`. A throwing listener must
	// not kill the run — diagnostics are observational post-mortem signal.
	const emitDiagnostic: DiagnosticEmitter = (d) => {
		try {
			deps.onDiagnostic?.(d);
		} catch {
			// Swallow listener failures — diagnostics are observational.
		}
	};

	const budget = deps.budget ?? defaultBudget();

	// One schema/result registry, shared by the agent primitive and the global
	// structured_output tool. The plugin injects a plugin-level registry shared across
	// runs; absent, the run owns a standalone one.
	const registry = deps.registry ?? createSchemaRegistry();

	// The real agent primitive over the pi-core runner. Its `runId` is the GATE KEY
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
		onDiagnostic: emitDiagnostic,
		currentPhase: () => currentPhaseBox.value,
		liveTasks,
		defaults: {
			agent: deps.defaults?.agent ?? DEFAULT_AGENT,
		},
		registry,
		// pi-native: resolve agent NAME → child knobs; read a child's structured
		// echo back off its transcript. Both engine-supplied; absent → defaults.
		...(deps.resolveAgentKnobs !== undefined
			? { resolveAgentKnobs: deps.resolveAgentKnobs }
			: {}),
		...(deps.readStructured !== undefined
			? { readStructured: deps.readStructured }
			: {}),
		replay: deps.replay,
		callIndex,
		...(deps.awaitCheckpointClear !== undefined
			? { awaitCheckpointClear: deps.awaitCheckpointClear }
			: {}),
		...(deps.resolveContextDiff !== undefined
			? { resolveContextDiff: deps.resolveContextDiff }
			: {}),
		// Epic 2.2: thread the skill-resolution seam so an `agent({ skills })` step
		// binds the resolved parts; absent → skills is inert.
		...(deps.resolveSkills !== undefined
			? { resolveSkills: deps.resolveSkills }
			: {}),
		...(deps.verifyResult !== undefined
			? { verifyResult: deps.verifyResult }
			: {}),
		// Epic H.1.3: thread the checkpoint-serialization thunk so an isolated agent's
		// merge-back rides the SAME tail as the per-unit commits; absent → inline.
		...(deps.serializeOnCheckpoint !== undefined
			? { serializeOnCheckpoint: deps.serializeOnCheckpoint }
			: {}),
		// Epic 4.2 + H.1: thread the per-agent directory seam straight to the
		// primitive when present; absent → identical primitive as today.
		...(deps.directory !== undefined ? { directory: deps.directory } : {}),
		// Epic H.1.6: thread the opaque worktree manager to the primitive (reachable at
		// the isolation mint-point); absent → identical primitive as today.
		...(deps.worktreeManager !== undefined
			? { worktreeManager: deps.worktreeManager }
			: {}),
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
				// Task 7.2.1: a child's agent diagnostics flow to the SAME engine sink
				// as the parent's, so a sub-workflow's null/empty is post-mortem-visible.
				onDiagnostic: emitDiagnostic,
				// pi-native: a child inherits the parent's agent-resolution + structured
				// read-back seams (same project / runner).
				...(deps.resolveAgentKnobs !== undefined
					? { resolveAgentKnobs: deps.resolveAgentKnobs }
					: {}),
				...(deps.readStructured !== undefined
					? { readStructured: deps.readStructured }
					: {}),
				// Task 2.1.5: a child's agents ride the SAME per-run commit barrier as
				// the parent's (they share the gate/run), so the checkpoint serialization
				// holds across the sub-workflow boundary too.
				...(deps.awaitCheckpointClear !== undefined
					? { awaitCheckpointClear: deps.awaitCheckpointClear }
					: {}),
				// Epic 4.1: a child's contextDiff reviews ride the SAME per-run
				// checkpointer diff as the parent's (they share the run/git tree).
				...(deps.resolveContextDiff !== undefined
					? { resolveContextDiff: deps.resolveContextDiff }
					: {}),
				// Epic 2.2: a child's skills steps ride the SAME skill resolver as the
				// parent's (they share the project's skill roots).
				...(deps.resolveSkills !== undefined
					? { resolveSkills: deps.resolveSkills }
					: {}),
				// Epic 4.2: a child's verifyDiff post-conditions ride the SAME per-run
				// checkpointer + shell as the parent's.
				...(deps.verifyResult !== undefined
					? { verifyResult: deps.verifyResult }
					: {}),
				// Epic H.1.3: a child's isolated merge-backs ride the SAME checkpoint tail
				// as the parent's (they share the run/git tree).
				...(deps.serializeOnCheckpoint !== undefined
					? { serializeOnCheckpoint: deps.serializeOnCheckpoint }
					: {}),
				// Epic H.1: a child sub-workflow inherits the parent's per-agent directory
				// by default — a child runs in the same project today.
				...(deps.directory !== undefined ? { directory: deps.directory } : {}),
				// Epic H.1.6: a child inherits the parent's worktree manager (same git
				// tree / run today), so the isolation mint-point reaches it inside a
				// sub-workflow too.
				...(deps.worktreeManager !== undefined
					? { worktreeManager: deps.worktreeManager }
					: {}),
				// A child sub-workflow inherits the parent's shell seam (same project
				// tree), so a `shell()` inside a sub-workflow runs exactly as it would
				// in the parent.
				...(deps.runShell !== undefined ? { runShell: deps.runShell } : {}),
				// No resolver → child workflow() throws NestingError (depth 1).
				// No replay → the boundary entry in the PARENT journal covers the child.
			});
			const result = await child.run(childSource);
			return result.status === "completed"
				? { status: "completed", returnValue: result.returnValue }
				: { status: "error", error: result.error };
		},
		counters,
		callIndex,
		emit,
		currentPhase: () => currentPhaseBox.value,
		replay: deps.replay,
	});

	// The `shell()` global (spec §3.3): a journaled deterministic-command primitive
	// over the opaque runShell seam. Shares the run's counters + callIndex + replay so
	// a shell call is one journaled unit in the same dense ordinal stream as agents.
	const innerShell = createShellPrimitive({
		...(deps.runShell !== undefined ? { runShell: deps.runShell } : {}),
		counters,
		callIndex,
		emit,
		...(deps.replay !== undefined ? { replay: deps.replay } : {}),
	});
	// After abort(), a NEW shell() resolves an inert result immediately (mirrors the
	// agent wrapper) rather than spawning a fresh command. The latch is the SHARED box,
	// so a parent abort short-circuits a child's shell() too.
	const shell: ShellFn = (command, opts) => {
		if (abortBox.aborted) {
			return Promise.resolve({
				command,
				passed: false,
				exitCode: -1,
				stdout: "",
				stderr: "",
				available: false,
			});
		}
		return innerShell(command, opts);
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
		workflow,
		shell,
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
