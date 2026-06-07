import type { ConcurrencyManager, SessionRunner } from "@drawers/core";
import { computeCallKey } from "../plugin/journal";
import type { SchemaRegistry } from "./structured/registry";
import { compileSchema } from "./structured/validate";
import {
	AgentCapError,
	type AgentFn,
	type AgentOpts,
	BudgetExhaustedError,
	type BudgetView,
	type JournalEntry,
	type ProgressEmitter,
} from "./types";

/** Lifetime agent-count backstop per workflow (spec §5). */
const AGENT_LIFETIME_CAP = 1_000;
/** Default per-agent completion timeout: 30 minutes. */
const DEFAULT_AWAIT_TIMEOUT_MS = 1_800_000;
/** Label fallback length when no `opts.label` is given. */
const LABEL_PREFIX_LEN = 60;

/** Everything the `agent()` primitive needs from the surrounding runtime. */
export interface AgentPrimitiveDeps {
	runner: SessionRunner;
	parentSessionID: string;
	/** Concurrency-gate key for this run; also the journal/abort scope. */
	runId: string;
	/** Standalone concurrency gate, keyed by `runId`. */
	gate: ConcurrencyManager;
	/** Lifetime agent counter shared across the run (mutated in place). */
	counters: { agents: number };
	budget: BudgetView;
	emit: ProgressEmitter;
	/** The active progress phase, when no per-call `opts.phase` is given. */
	currentPhase: () => string | undefined;
	/** Live task ids, so abort() (Task 3.2.3) can cancel in-flight work. */
	liveTasks?: Set<string>;
	defaults: { agent: string; awaitTimeoutMs?: number };
	/**
	 * Per-run schema/result registry for `agent({ schema })` structured output
	 * (Task 3.3.2). The same instance backs the `structured_output` tool, so a
	 * child's tool call and this primitive's `resultFor` read share state.
	 */
	registry: SchemaRegistry;
	/**
	 * Deterministic-resume seam (spec §7). When present, the longest unchanged
	 * prefix of `(prompt, opts)` pairs replays from `entries` instead of launching;
	 * every settled non-null live result is reported via `onRecord` for the journal.
	 */
	replay?: { entries: JournalEntry[]; onRecord: (e: JournalEntry) => void };
	/**
	 * Run-level "the replayed prefix is still intact" latch. Starts true; flips
	 * false FOREVER on the first divergence (key mismatch or index past the
	 * journal), so a later coincidentally-matching key still runs live.
	 */
	prefixIntact: { value: boolean };
	/**
	 * Run-level deterministic call ordinal. Counts EVERY `agent()` invocation in
	 * order — cached or live — so a replay indexes the journal at the same points
	 * the original did. Advances in lockstep with `counters.agents`.
	 */
	callIndex: { value: number };
}

/** The single nudge sent when a child completes without a structured result. */
const STRUCTURED_NUDGE =
	"You have not returned a structured result. Call the structured_output " +
	"tool now with a JSON value conforming to the required schema.";

/** Build the schema-instruction suffix appended to a structured agent's prompt. */
function structuredPromptSuffix(schema: object): string {
	return (
		"\n\nYou MUST return your result by calling the structured_output tool " +
		"with a JSON value conforming to this schema:\n" +
		JSON.stringify(schema) +
		"\nYour final text is ignored; only the tool call counts."
	);
}

/**
 * Builds the `agent()` primitive over the core session runner (spec §3.3 row 1).
 *
 * Failure philosophy is "degrade, don't detonate" (§9): an agent that dies on a
 * terminal status, or a runner call that throws, resolves to `null`. The ONLY
 * intentional throws are the lifetime cap, budget exhaustion, and a malformed
 * `schema` (SchemaCompileError, a script bug) — those are meant to stop the run.
 */
export function createAgentPrimitive(deps: AgentPrimitiveDeps): AgentFn {
	const {
		runner,
		parentSessionID,
		runId,
		gate,
		counters,
		budget,
		emit,
		currentPhase,
		liveTasks,
		defaults,
		registry,
		replay,
		prefixIntact,
		callIndex,
	} = deps;
	const awaitTimeoutMs = defaults.awaitTimeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS;

	return async function agent(
		prompt: string,
		opts: AgentOpts = {},
	): Promise<unknown> {
		// 0. Claim this call's deterministic ordinal (every invocation, cached or
		// live, in order — so a replay indexes the journal at the same points).
		const index = callIndex.value;
		callIndex.value += 1;

		const label = opts.label ?? prompt.slice(0, LABEL_PREFIX_LEN);
		const phase = opts.phase ?? currentPhase();

		const key = computeCallKey({
			prompt,
			label: opts.label,
			phase: opts.phase,
			schema: opts.schema,
			model: opts.model,
			agentType: opts.agentType,
		});

		// 0b. Replay (spec §7): while the prefix is intact and this index has a
		// matching journaled key, return the cached result WITHOUT launching. The
		// cap STILL applies (a replay must hit it where the original did), so check
		// and increment counters exactly as the live path does — before resolving.
		if (replay !== undefined && prefixIntact.value) {
			const cached = replay.entries[index];
			if (cached !== undefined && cached.key === key) {
				if (counters.agents >= AGENT_LIFETIME_CAP) {
					throw new AgentCapError();
				}
				counters.agents += 1;
				emit({ type: "agent:start", label, phase });
				emit({ type: "agent:end", label, status: "cached" });
				// Re-record the cached hit into the NEW journal so a resumed run's
				// journal is fully self-contained — no engine-layer bookkeeping.
				replay.onRecord({ index, key, status: "ok", result: cached.result });
				return cached.result;
			}
			// Divergence: this call edited/new (key mismatch or past the journal).
			// The prefix is broken FOREVER — a later coincidental match still runs live.
			prefixIntact.value = false;
		}

		// 1. Lifetime cap — increment BEFORE acquire so queued calls count too.
		if (counters.agents >= AGENT_LIFETIME_CAP) {
			throw new AgentCapError();
		}
		counters.agents += 1;

		// 2. Budget ceiling (§6): a set total with nothing left refuses the call.
		if (budget.total !== null && budget.remaining() <= 0) {
			throw new BudgetExhaustedError();
		}

		// 3. Structured output (§3.3 row 1): compile the schema BEFORE acquiring a
		// gate slot, so a malformed schema (a SCRIPT bug) detonates as
		// SchemaCompileError at call time rather than after a slot is held.
		const compiled =
			opts.schema !== undefined ? compileSchema(opts.schema) : undefined;

		// 4. Worktree isolation has no OpenCode session primitive — honest no-op.
		if (opts.isolation === "worktree") {
			emit({
				type: "warn",
				message:
					"isolation:'worktree' is not supported (no worktree session primitive); running without isolation",
			});
		}

		// With a schema, the child returns its result by calling structured_output;
		// it must be told so (suffix) and granted the tool (override).
		const launchPrompt =
			compiled === undefined
				? prompt
				: prompt + structuredPromptSuffix(opts.schema as object);

		// 5. Gate the launch on the run's concurrency slots.
		await gate.acquire(runId);

		let taskId: string | undefined;
		let sessionId: string | undefined;
		let status = "error";
		try {
			// 6. Announce the start once the slot is held.
			emit({ type: "agent:start", label, phase });

			// 7. Launch the subagent. For structured output, register the compiled
			// schema against the child sessionID the instant it exists (synchronous
			// onSessionCreated hook), before the child's first turn can call the tool.
			const task = await runner.launch({
				parentSessionID,
				description: label,
				prompt: launchPrompt,
				agent: opts.agentType ?? defaults.agent,
				model: opts.model,
				depth: 0,
				...(compiled !== undefined
					? {
							onSessionCreated: (sid: string) =>
								registry.register(sid, compiled),
							toolsOverride: { structured_output: true },
						}
					: {}),
			});
			taskId = task.id;
			sessionId = task.sessionID;
			liveTasks?.add(task.id);

			// 8. Wait for it to reach a terminal status.
			const done = await runner.awaitCompletion(task.id, awaitTimeoutMs);
			status = done.status;

			// 10. Map terminal status to a result, then journal it if non-null.
			let result: unknown;
			if (compiled !== undefined) {
				result = await resolveStructured(task, done.status, sessionId);
			} else if (done.status === "completed") {
				// Non-structured: completed → final text, else degrade to null.
				result = (await runner.readOutput(task.id)).summaryText;
			} else {
				result = null;
			}
			// Spec §7: only SETTLED non-null results are journaled — a failed/null
			// agent must re-run on resume, not replay its failure.
			if (result !== null && result !== undefined) {
				replay?.onRecord({ index, key, status: "ok", result });
			}
			return result;
		} catch (err) {
			// launch()/awaitCompletion() throwing is a degrade, not a detonation.
			status = "error";
			emit({
				type: "warn",
				message: `agent '${label}' failed: ${describeError(err)}`,
			});
			return null;
		} finally {
			// 9. Release the slot and drop the live task on EVERY path.
			if (taskId !== undefined) {
				liveTasks?.delete(taskId);
			}
			gate.release(runId);
			// Structured output: drop the schema + any stored result for this child.
			if (sessionId !== undefined) {
				registry.clear(sessionId);
			}
			// 11. Announce the end with the resolved status.
			emit({ type: "agent:end", label, status });
		}
	};

	/**
	 * Resolve the structured result for a completed structured agent. The child
	 * surfaces its value via the structured_output tool (stored in the registry),
	 * NOT via final text. Non-completed statuses degrade to `null` with no nudge.
	 * A completion with no stored result earns ONE re-prompt; if that still yields
	 * nothing, the call resolves `null`. A resume/await throw (e.g. sessionExpired)
	 * degrades to `null` with a warn.
	 */
	async function resolveStructured(
		task: { id: string },
		status: string,
		sessionId: string | undefined,
	): Promise<unknown> {
		if (status !== "completed" || sessionId === undefined) {
			return null;
		}
		const first = registry.resultFor(sessionId);
		if (first.present) {
			return first.value;
		}
		// One nudge: re-prompt the child to call the tool, then await again.
		try {
			await runner.resume(task.id, STRUCTURED_NUDGE);
			await runner.awaitCompletion(task.id, awaitTimeoutMs);
		} catch (err) {
			emit({
				type: "warn",
				message: `agent structured-output nudge failed: ${describeError(err)}`,
			});
			return null;
		}
		const second = registry.resultFor(sessionId);
		return second.present ? second.value : null;
	}
}

/** Best-effort human-readable detail for a thrown value. */
function describeError(err: unknown): string {
	if (err instanceof Error) {
		return err.message;
	}
	return String(err);
}
