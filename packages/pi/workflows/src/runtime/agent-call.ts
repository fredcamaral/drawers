import type { ConcurrencyManager, SessionRunner } from "@drawers/pi-core";
import { computeCallKey } from "./keys";
import type { SchemaRegistry } from "./structured/registry";
import { type CompiledSchema, compileSchema } from "./structured/validate";
import {
	AgentCapError,
	type AgentDiagnostic,
	type AgentFn,
	type AgentOpts,
	BudgetExhaustedError,
	type BudgetView,
	type DiagnosticEmitter,
	type DiagnosticReason,
	type IntentJournalEntry,
	IsolationUnsupportedError,
	type JournalEntry,
	type ProgressEmitter,
	type SettledJournalEntry,
	type WorktreeManagerSeam,
} from "./types";

/**
 * The structural seam the runtime uses to charge a settled child against the
 * budget WITHOUT importing the plugin's TokenBudget. The runtime keeps zero
 * plugin knowledge: it runtime-checks `typeof budget.recordTask === "function"`
 * and, when present with a sessionID, awaits it at settle. A plain
 * {@link BudgetView} (no recordTask) is left untouched.
 *
 * Sequential accuracy: because `recordTask` is awaited BEFORE this call resolves,
 * the NEXT sequential `agent()` call's budget pre-check (§6) sees this call's
 * spend. Concurrent calls are best-effort by nature — overlapping settles both
 * record, but a pre-check between them may not yet have seen the other.
 */
interface RecordableBudget {
	recordTask(sessionID: string): Promise<void>;
}

/** Runtime-check whether a budget structurally exposes `recordTask`. */
function isRecordable(budget: unknown): budget is RecordableBudget {
	return typeof (budget as { recordTask?: unknown }).recordTask === "function";
}

/** Lifetime agent-count backstop per workflow (spec §5). */
const AGENT_LIFETIME_CAP = 1_000;
/** Label fallback length when no `opts.label` is given. */
const LABEL_PREFIX_LEN = 60;

/** Max chars of the user prompt carried into `agent:start` for the viewer's Detail. */
const PROMPT_PREVIEW_MAX = 2000;

/** A truncated, ellipsis-marked preview of the user prompt for `agent:start`. */
function promptPreviewOf(prompt: string): string {
	return prompt.length > PROMPT_PREVIEW_MAX
		? `${prompt.slice(0, PROMPT_PREVIEW_MAX)}…`
		: prompt;
}
/** Max chars of the agent's result carried into `agent:end` for the viewer's Detail. */
const RESULT_PREVIEW_MAX = 2000;

/**
 * A truncated, ellipsis-marked preview of the RESULT an agent passed forward — the
 * "conclusion" the viewer's Detail pane surfaces once the agent settles. A string
 * result passes through; a structured (object) result is rendered as compact JSON so
 * a glance reads the shape it returned. `null`/`undefined`/`""` yield `undefined` (a
 * degrade carries a `note`, not a conclusion), as does a non-serializable value.
 * Capped like {@link promptPreviewOf} to keep feed lines bounded.
 */
function resultPreviewOf(result: unknown): string | undefined {
	if (result === null || result === undefined) {
		return undefined;
	}
	let text: string;
	if (typeof result === "string") {
		text = result;
	} else {
		try {
			text = JSON.stringify(result);
		} catch {
			return undefined;
		}
	}
	if (text.length === 0) {
		return undefined;
	}
	return text.length > RESULT_PREVIEW_MAX
		? `${text.slice(0, RESULT_PREVIEW_MAX)}…`
		: text;
}

/** Cap on captured raw final text in a diagnostic (Task 7.2.1). */
const RAW_TEXT_CAP = 20_000;
/** Marker appended when raw-text capture is truncated. */
const RAW_TEXT_CAP_MARKER = "…[capped]";

/**
 * pi-native agent resolution (the `agent()` → {@link LaunchRequest} seam). pi has
 * NO `--agent` flag: an agent NAME is resolved by the CALLER to pi-native child
 * knobs (an appended system prompt, a tool allow-list, and a model). The engine
 * supplies this closure (it knows the worktree cwd and pi's agent locations); the
 * runtime stays plugin/pi-agnostic and just spreads the result onto the launch,
 * symmetric with `resolveSkills`/`verifyResult`. ABSENT (the standalone library /
 * in-memory tests) → the child runs pi's DEFAULT coding assistant (no append, no
 * tools), and the `agent` field is the bare display label.
 */
export type ResolveAgentKnobs = (agentType: string) =>
	| {
			appendSystemPrompt?: string;
			tools?: string[];
			model?: string;
	  }
	| undefined;

/**
 * Read a child's structured result back off its transcript (the pi read-back seam,
 * §3.3 row 1). In opencode the child's `structured_output` tool wrote the validated
 * value into a shared in-process registry the parent read directly; in pi the child
 * is a SUBPROCESS, so it echoes the raw JSON value as its LAST `structured_output`
 * tool-result content and the engine wires THIS closure to extract that text from
 * the child's persisted transcript. The parent then parses + validates it against
 * the schema it holds (registry.lookup) — moving all validation parent-side. Returns
 * the raw JSON string the child echoed, or `undefined` when the child never called
 * the tool (→ schema_no_call). FENCED engine-side — a read failure resolves
 * `undefined`, never throws. ABSENT (standalone library / tests that pre-populate
 * the registry) → the parent falls back to the registry's stored value (the old
 * in-process path), so this seam is purely additive.
 */
export type ReadStructured = (
	taskId: string,
	sessionId: string,
) => Promise<string | undefined>;

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
	/**
	 * Post-mortem diagnostic sink (Task 7.2.1). Invoked when a call degrades to
	 * `null`/`""` with a typed reason (and, for schema reasons, the captured raw
	 * final text). Optional and observational — `agent()` still returns bare
	 * null/"" to the script regardless. The engine collects these onto the run
	 * handle and persists them on the run record.
	 */
	onDiagnostic?: DiagnosticEmitter;
	/** The active progress phase, when no per-call `opts.phase` is given. */
	currentPhase: () => string | undefined;
	/** Live task ids, so abort() (Task 3.2.3) can cancel in-flight work. */
	liveTasks?: Set<string>;
	defaults: { agent: string };
	/**
	 * Per-run schema/result registry for `agent({ schema })` structured output
	 * (Task 3.3.2). In pi the registry holds the COMPILED schema (registered at
	 * `onSessionCreated`) plus the result/failure the PARENT computes on read-back —
	 * the child subprocess cannot write into it. `agent-call`'s `resolveStructured`
	 * populates it post-completion via {@link ReadStructured}.
	 */
	registry: SchemaRegistry;
	/**
	 * Resolve a pi agent NAME → pi-native child knobs (system prompt / tools /
	 * model). Engine-supplied; ABSENT → the child runs pi's default assistant. See
	 * {@link ResolveAgentKnobs}.
	 */
	resolveAgentKnobs?: ResolveAgentKnobs;
	/**
	 * Read a completed structured child's echoed result off its transcript. ABSENT →
	 * the parent reads the registry's stored value (the in-process fallback). See
	 * {@link ReadStructured}.
	 */
	readStructured?: ReadStructured;
	/**
	 * Deterministic-resume seam (spec §7, Task 7.3.1). When present, each call
	 * replays from `entries` by KEY + OCCURRENCE: every `agent()` (and the
	 * `workflow()` boundary) shifts a per-key queue built from the prior journal —
	 * a hit replays the frozen result, a miss/empty queue runs live. Matching is
	 * position-independent: editing one item no longer voids later unchanged items
	 * (field finding R4). Every settled non-null live result is reported via
	 * `onRecord` for the new journal.
	 *
	 * `onIntent` (Phase 3) is the write-ahead seam: a LIVE call reports its intent
	 * BEFORE dispatch and AWAITS it, so a crash in the launch window leaves a durable
	 * "dispatched-but-not-settled" marker. The engine wires it to a journal append
	 * that is also awaited; absent (the standalone library / child runs) → no
	 * write-ahead. Intent entries in `entries` are NEVER replayed — they are filtered
	 * out of the per-key cache below.
	 */
	replay?: {
		entries: JournalEntry[];
		onRecord: (e: SettledJournalEntry) => void;
		onIntent?: (e: IntentJournalEntry) => Promise<void> | void;
	};
	/**
	 * Run-level deterministic call ordinal. Counts EVERY `agent()` invocation in
	 * order — cached or live — so the new journal's `index` field and the progress
	 * ordering anchor stay dense and in call order. Advances in lockstep with
	 * `counters.agents`. NOTE (Task 7.3.1): the index is no longer a replay MATCH
	 * key — matching is by key+occurrence — it is purely the ordering anchor.
	 */
	callIndex: { value: number };
	/**
	 * Pre-launch checkpoint barrier (Task 2.1.5). Awaited AFTER `gate.acquire` and
	 * BEFORE `runner.launch`, so the NEXT agent's launch blocks until the PRIOR
	 * agent's per-unit commit has drained — making "commit-before-next-unit" a real
	 * guarantee, not just commit ORDERING (the gate slot is freed in the prior
	 * agent's `finally` BEFORE its `agent:end`-driven commit even starts, so without
	 * this barrier the next acquire could win the race). OPAQUE to the runtime: it
	 * never learns what a checkpoint is, it just awaits the thunk. ABSENT (the
	 * default, and always so in the standalone library) → no blocking.
	 */
	awaitCheckpointClear?: () => Promise<void>;
	/**
	 * Resolve the engine-computed real git diff (since run start) for an
	 * `agent({ contextDiff:true })` review (Epic 4.1). The engine wires it to its
	 * per-run checkpointer's `diff()`; ABSENT (the standalone library, in-memory
	 * tests) → no diff is injected and no review is ever refused (behaves exactly as
	 * today). The diff is injected as a SYNTHETIC contextPart (NOT the prompt) so it
	 * never perturbs {@link computeCallKey} — a reviewer replays its journaled verdict
	 * on resume rather than re-diffing a now-different tree. `available:false`
	 * (no-shell / non-git) means emptiness is UNPROVABLE: the review runs with no diff
	 * part and is never refused.
	 */
	resolveContextDiff?: () => Promise<{
		text: string;
		isEmpty: boolean;
		available: boolean;
	}>;
	/**
	 * Resolve canonical skill names (Epic 2.2) to synthetic text contextParts — one
	 * per skill — to inject onto the child launch, mirroring `resolveContextDiff`.
	 * Plugin-backed and OPAQUE to the runtime: it never learns what a skill is, it
	 * just merges the returned parts. UNLIKE `resolveContextDiff`, a rejection is NOT
	 * fenced — an unknown skill name (a `SkillNotFoundError`) must propagate past the
	 * degrade-to-null catch and reach the script as a real error (fail-loud is the
	 * contract). ABSENT (standalone library / no-engine) → `skills` is inert (no
	 * parts, no throw).
	 */
	resolveSkills?: (
		names: string[],
	) => Promise<Array<{ type: "text"; text: string; synthetic: true }>>;
	/**
	 * Verify an agent's git/command post-condition AFTER it settles non-null (Epic
	 * 4.2). The engine wires it to the per-run checkpointer: `verifyDiff:true` asserts
	 * the working-tree diff vs baseline is non-empty (valid PRE-commit, so no commit-
	 * ordering dance); `{check}` runs the command via the repo-bound shell and asserts
	 * exit 0. Returns `{passed, available, reason?}`: on `available && !passed` the
	 * settled result is downgraded to `null` (re-runs on resume, NOT journaled).
	 * `available:false` (no-shell / non-git) → the check is INERT, the result passes
	 * through unchanged — NEVER a fabricated failure. ABSENT → no verification. Note:
	 * a downgrade nulls the RESULT only; it does NOT un-commit (the bytes are on disk,
	 * P2 commit-for-recovery still applies — the engine still checkpoints this agent).
	 */
	verifyResult?: (opts: {
		verifyDiff: boolean | { check?: string };
		sessionId?: string;
		/**
		 * Epic H.1.3: the worktree dir to re-root the verify shell to. For an
		 * `isolation:'worktree'` agent the `{check}` command must run in the WORKTREE
		 * checkout (where the agent's edits live), not the main tree. ABSENT → the
		 * engine-wide directory applies.
		 */
		directory?: string;
	}) => Promise<{ passed: boolean; available: boolean; reason?: string }>;
	/**
	 * Serialize a task onto the engine's per-run checkpoint chain (Epic H.1.3). The
	 * engine appends `task` onto the SAME `checkpointTail` that orders per-unit commits
	 * and resolves with its result once the tail drains — so an isolated agent's
	 * merge-back never interleaves with a sibling's commit. OPAQUE: the runtime never
	 * learns what a checkpoint is. ABSENT (standalone library, no-shell engine) → the
	 * runtime runs the task INLINE (no shared git tree to serialize against).
	 */
	serializeOnCheckpoint?: <T>(task: () => Promise<T>) => Promise<T>;
	/**
	 * Per-agent project/worktree directory (Epic H.1), forwarded
	 * straight to `runner.launch` → the child cwd, which re-roots the worker's
	 * Bash/tool cwd. This is an ENGINE-OWNED dep, NOT an `AgentOpts` field — no
	 * script can request it and it is deliberately ABSENT from
	 * {@link computeCallKey}/`CallKeyInput` (a worktree path would re-key every cached
	 * agent on resume and re-run settled work), exactly like the
	 * `contextDiff`/`verifyDiff` exclusion. The mint-point (Epic H.1.2) sets it: an
	 * `isolation:'worktree'` agent launches in its minted worktree dir; ABSENT or
	 * non-isolated → the engine-wide directory applies.
	 */
	directory?: string;
	/**
	 * The OPAQUE per-agent worktree manager (Epic H.1.6), constructed once by the
	 * engine from the host `$` and threaded straight to this primitive. The
	 * isolation mint-point (Epic H.1.2) calls `worktreeManager.create(key)` at the
	 * `isolation:'worktree'` seam and feeds the
	 * minted dir into the {@link AgentPrimitiveDeps.directory} launch injection. OPAQUE
	 * to the runtime — see {@link WorktreeManagerSeam}. ABSENT (no-shell engine,
	 * standalone library, child runs) or a null `create` →
	 * isolation requests degrade-to-null with a loud diagnostic.
	 */
	worktreeManager?: WorktreeManagerSeam;
}

/**
 * The single nudge sent when a child completes without a VALID structured result.
 * pi-native: validation is parent-side, so the nudge carries the validation errors
 * the parent computed (when any) so the model fixes the actual problem, not a blind
 * "you forgot to call the tool".
 */
const STRUCTURED_NUDGE_BASE =
	"You have not returned a valid structured result. Call the structured_output " +
	"tool now with a JSON value conforming to the required schema.";

/** Build the nudge, appending the parent-computed validation errors when present. */
function structuredNudge(errors: string | undefined): string {
	if (errors === undefined || errors.length === 0) {
		return STRUCTURED_NUDGE_BASE;
	}
	return `${STRUCTURED_NUDGE_BASE}\nValidation errors from your last attempt: ${errors}`;
}

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
 * Builds the `agent()` primitive over the pi-core session runner (spec §3.3 row 1).
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
		onDiagnostic,
		currentPhase,
		liveTasks,
		defaults,
		registry,
		resolveAgentKnobs,
		readStructured,
		replay,
		callIndex,
		awaitCheckpointClear,
		resolveContextDiff,
		resolveSkills,
		verifyResult,
		directory,
		// Epic H.1.3: serialize an isolated agent's merge-back onto the engine's
		// per-run checkpoint tail (so merges never interleave with commits). Absent →
		// the merge runs inline (no shared git tree to order against).
		serializeOnCheckpoint,
		// Epic H.1.2: the worktree manager is the per-agent isolation mint-point. When
		// an `isolation:'worktree'` call holds a gate slot, the manager mints a worktree
		// whose dir re-roots the launch; absent (or a null create) → degrade-to-null.
		worktreeManager,
	} = deps;

	/**
	 * Capture a child's raw final text for a diagnostic (Task 7.2.1), capped at
	 * {@link RAW_TEXT_CAP} with a marker. FENCED: a readOutput throw must never mask
	 * the original null flow — it resolves to `undefined` (no rawText) instead.
	 */
	async function captureRawText(taskId: string): Promise<string | undefined> {
		try {
			const { summaryText } = await runner.readOutput(taskId);
			if (summaryText.length <= RAW_TEXT_CAP) {
				return summaryText;
			}
			return summaryText.slice(0, RAW_TEXT_CAP) + RAW_TEXT_CAP_MARKER;
		} catch {
			// Capture is best-effort observability; never propagate its failure.
			return undefined;
		}
	}

	/** Build the short human note rendered on the `agent:end` progress event. */
	function diagnosticNote(reason: DiagnosticReason, rawLen?: number): string {
		if (reason === "empty_output") {
			return "empty output";
		}
		if (reason === "empty_diff") {
			return "review refused — empty diff for the unit under review";
		}
		if (reason === "verify_failed") {
			return "null — verify_failed (git/command post-condition failed)";
		}
		if (reason === "worktree_mint_failed") {
			return "null — worktree_mint_failed (isolation supported; git worktree mint failed)";
		}
		if (reason === "merge_conflict") {
			return "merge_conflict — worktree merge-back conflicted; worktree preserved for Tier 2 resolution";
		}
		if (reason === "skill_not_found") {
			return "skill_not_found — unknown skill name; the step aborted before launch (fail-loud authoring contract)";
		}
		const raw =
			rawLen !== undefined ? `; raw ${humanizeChars(rawLen)} preserved` : "";
		return `null — ${reason}${raw}`;
	}

	/**
	 * Classify a settled call into a typed degrade reason (Task 7.2.1), or
	 * `undefined` when the call succeeded (non-empty result). Reads the registry's
	 * recorded validation failure to split `schema_no_call` from `schema_invalid` —
	 * the PARENT validates on read-back BEFORE storing, so an unstored completed
	 * structured turn is either "never called" (no failure recorded) or "called and
	 * rejected" (failure recorded). Runs in the try body, BEFORE the finally clears
	 * the registry, so the failure record is still readable.
	 */
	function classifyDegrade(
		structured: boolean,
		status: string,
		result: unknown,
		sessionId: string | undefined,
	): DiagnosticReason | undefined {
		// A non-completed terminal status degrades regardless of structured-ness.
		if (status !== "completed") {
			return status === "cancelled" ? "status_cancelled" : "status_error";
		}
		if (structured) {
			// Completed structured turn with a stored value → success.
			if (result !== null && result !== undefined) {
				return undefined;
			}
			const recorded =
				sessionId !== undefined ? registry.lastFailure(sessionId) : undefined;
			return recorded !== undefined ? "schema_invalid" : "schema_no_call";
		}
		// Plain completed turn: empty final text is the only degrade.
		return result === "" ? "empty_output" : undefined;
	}

	// Task 7.3.1 / field finding R4: replay matches by KEY + OCCURRENCE, not by
	// position. Build a per-key FIFO queue from the prior journal; each call shifts
	// its key's queue (hit → replay, miss/empty → live). This makes replay
	// position-independent — editing parallel() item 0's prompt no longer flips a
	// run-level latch that re-executed an unchanged item 1 (report §4.3: identical
	// key 1d2e8321…, 4m17s re-run, materially different answer).
	//
	// Entries are queued in journal-FILE order, which is COMPLETION order under
	// concurrency. That is fine: occurrence order only needs to be deterministic
	// per key, and N byte-identical calls have interchangeable cached results by
	// definition — so the order within a key's queue cannot change an answer. The
	// `workflow()` boundary's `workflow:`-prefixed keys land in this same map, no
	// special-casing. N identical keys → N replays; the N+1th finds an empty queue
	// and runs live (preserves CC's adversarial-verify N-byte-identical refuters).
	//
	// Phase 3 HIGH-BLAST FILTER: skip any non-settled (intent) entry. An intent has
	// no result, so if it entered a key's queue a resumed call would shift it and
	// replay garbage — or consume the occurrence slot the genuine `ok` belongs to.
	// Filtering here keeps only settled results in the queue (the resolveResume
	// load-filter is the primary guard; this is the in-runtime backstop).
	const byKey = new Map<string, SettledJournalEntry[]>();
	if (replay !== undefined) {
		for (const entry of replay.entries) {
			if (entry.status !== "ok") {
				continue;
			}
			const queue = byKey.get(entry.key);
			if (queue === undefined) {
				byKey.set(entry.key, [entry]);
			} else {
				queue.push(entry);
			}
		}
	}

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
			schema: opts.schema,
			model: opts.model,
			agentType: opts.agentType,
		});

		// 0b. Replay (spec §7, Task 7.3.1): shift this call's key queue. A hit returns
		// the frozen journaled result WITHOUT launching — independent of position, so
		// an earlier edited item never voids this one (field finding R4). A miss/empty
		// queue falls through to the live path. The cap STILL applies (a replay must
		// hit it where the original did), so check and increment counters exactly as
		// the live path does — before resolving.
		const cached = byKey.get(key)?.shift();
		if (cached !== undefined) {
			if (counters.agents >= AGENT_LIFETIME_CAP) {
				throw new AgentCapError();
			}
			counters.agents += 1;
			emit({
				type: "agent:start",
				label,
				phase,
				promptPreview: promptPreviewOf(prompt),
			});
			// A cached hit still carries its frozen conclusion forward — surface it so a
			// replayed agent's Detail reads the same result a live one would, not blank.
			const cachedResult = resultPreviewOf(cached.result);
			emit({
				type: "agent:end",
				label,
				status: "cached",
				...(cachedResult !== undefined ? { result: cachedResult } : {}),
			});
			// Re-record the cached hit into the NEW journal under the CURRENT call
			// index so a resumed run's journal is fully self-contained and densely
			// ordered — no engine-layer bookkeeping.
			replay?.onRecord({ index, key, status: "ok", result: cached.result });
			return cached.result;
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

		// With a schema, the child returns its result by calling structured_output;
		// it must be told so (suffix) and granted the tool (override).
		const launchPrompt =
			compiled === undefined
				? prompt
				: prompt + structuredPromptSuffix(opts.schema as object);

		// 4s. pi agent resolution (the agent() → LaunchRequest seam): resolve the
		// requested agentType to pi-native child knobs (system prompt / tools / model)
		// BEFORE acquiring a slot, so it is cheap and pure. ABSENT seam → the child
		// runs pi's default assistant. The `agent` LaunchRequest field stays the
		// display LABEL (never a pi flag); the resolved knobs are threaded separately.
		const agentType = opts.agentType ?? defaults.agent;
		const resolvedAgent =
			resolveAgentKnobs !== undefined
				? resolveAgentKnobs(agentType)
				: undefined;

		// 5. Gate the launch on the run's concurrency slots.
		await gate.acquire(runId);

		// 5s. skills (Epic 2.2): resolve canonical skill names to synthetic
		// contextParts BEFORE the worktree mint, so an authoring typo fails before
		// burning a mint (a created worktree is a real resource: a checkout + a
		// scratch branch). Fail-loud contract: an unknown name (SkillNotFoundError)
		// ABORTS the call by THROWING to the script — but it still releases the held
		// slot, emits a visible start/end pair, and fires a typed skill_not_found
		// diagnostic so the feed's ✗ carries a reason. Any OTHER resolveSkills
		// rejection keeps the degrade-to-null discipline (await_failed), matching the
		// pre-launch fencing of the rest of this body. ABSENT seam → inert.
		let skillParts: Array<{ type: "text"; text: string; synthetic: true }> = [];
		if (opts.skills?.length && resolveSkills !== undefined) {
			try {
				skillParts = await resolveSkills(opts.skills);
			} catch (err) {
				gate.release(runId);
				emit({
					type: "agent:start",
					label,
					phase,
					promptPreview: promptPreviewOf(prompt),
				});
				const skillMiss =
					err instanceof Error && err.name === "SkillNotFoundError";
				const reason: DiagnosticReason = skillMiss
					? "skill_not_found"
					: "await_failed";
				emit({
					type: "warn",
					message: `agent '${label}' failed: ${describeError(err)}`,
				});
				onDiagnostic?.({ label, index, reason });
				emit({
					type: "agent:end",
					label,
					status: "error",
					note: diagnosticNote(reason),
				});
				if (skillMiss) {
					throw err;
				}
				return null;
			}
		}

		// 5w. Per-agent worktree isolation (Epic H.1.2). Minted AFTER gate.acquire — a
		// created worktree holds a real resource (a checkout + scratch branch), so we
		// do not mint one the gate would have rejected. On success the worktree's dir
		// OVERRIDES the run-wide `directory` at the launch injection (re-rooting just
		// this agent's worker), and the handle is carried into the finally for teardown.
		// When NO manager is threaded (no-shell engine / standalone library) OR
		// `create` returns null (non-repo / git failure), we KEEP the loud P0.4
		// degrade-to-null: a warn, a typed diagnostic, a visible start/end pair, then
		// `null`. We do NOT throw (a throw would detonate the whole parallel() batch)
		// and we release the held slot before returning (degrade, don't detonate).
		let worktree: { dir: string; branch: string } | undefined;
		let launchDirectory = directory;
		// Phase 3 / Task 3.1.1: `verifyDiff` IMPLIES worktree isolation — an agent
		// with a post-condition must run in its own worktree so the check (a git diff
		// or a real tsc/lint command reading disk) observes only THIS agent's edits,
		// not a sibling's mid-flight mutation of the shared tree. Two booleans split
		// the contracts: an EXPLICIT `isolation:'worktree'` request keeps the loud
		// degrade-to-null on a mint miss (the script demanded a guarantee), while an
		// IMPLIED isolation (verifyDiff-only) falls through to run unisolated on a mint
		// miss — honoring verifyDiff's INERT-on-no-shell contract (types.ts:60-66).
		// Gate on TRUTHINESS, not presence: `verifyDiff: false` (a computed flag) must
		// behave exactly like an absent option — no surprise worktree, no check.
		// `verifySpec` collapses `false` to undefined ONCE so both this gate and the
		// post-settle verify (§ verifyDiff below) read the same narrowed value.
		const explicitIsolation = opts.isolation === "worktree";
		const verifySpec = opts.verifyDiff === false ? undefined : opts.verifyDiff;
		const wantsIsolation = explicitIsolation || verifySpec !== undefined;
		if (wantsIsolation) {
			// Fold the unique per-call `index` into the mint key so the worktree manager
			// (which derives both the branch and the checkout dir from this label and
			// DOES NOT de-dup — git-worktree.ts) can never collide two parallel isolated
			// calls onto one branch+dir. The display `label` stays as-is; only the
			// path/branch IDENTITY is made unique-per-call (`<label>-<index>`).
			// Serialize the `git worktree add` on the SAME checkpoint tail that orders
			// merges + per-unit commits (5a/9), so a create never races a sibling's
			// merge/commit for the `.git` ref locks. An unserialized create CAN lose that
			// race → the merge then exits non-zero with zero unmerged files → a phantom
			// `{failed}` → the agent's work is dropped: the #5 lost-work tail re-entering
			// through a lock race, under exactly the parallel load this epic makes safe.
			// Falls back to a direct create for the standalone library (no shared tree).
			let minted: { dir: string; branch: string } | null = null;
			if (worktreeManager !== undefined) {
				const mgr = worktreeManager;
				const doMint = () => mgr.create({ runId, label: `${label}-${index}` });
				minted =
					serializeOnCheckpoint !== undefined
						? await serializeOnCheckpoint(doMint)
						: await doMint();
			}
			if (minted === null && explicitIsolation) {
				gate.release(runId);
				// Distinguish "no manager threaded" (genuine isolation_unsupported: the
				// feature has no primitive here) from "manager present but create()
				// returned null" (a real mint failure: a non-repo checkout, a transient
				// `git worktree add` failure, an index-lock loss). Emitting
				// isolation_unsupported for the latter would falsely tell an operator the
				// feature does not work; worktree_mint_failed names the true cause.
				const reason: DiagnosticReason =
					worktreeManager === undefined
						? "isolation_unsupported"
						: "worktree_mint_failed";
				const message =
					reason === "isolation_unsupported"
						? new IsolationUnsupportedError().message
						: `isolation:worktree mint failed for '${label}' (runId ${runId}) — degrading this agent to null`;
				emit({ type: "warn", message });
				emit({
					type: "agent:start",
					label,
					phase,
					promptPreview: promptPreviewOf(prompt),
				});
				onDiagnostic?.({ label, index, reason });
				emit({
					type: "agent:end",
					label,
					status: "error",
					note: diagnosticNote(reason),
				});
				return null;
			}
			// IMPLIED isolation (verifyDiff-only) mint miss: do NOT degrade. Leave
			// `worktree` undefined and `launchDirectory` as the run-wide directory, then
			// fall through to a normal unisolated launch. The later verify (it sees
			// `worktree === undefined`) forwards no directory and evaluates against the
			// shared tree / inert-on-no-shell path — identical to pre-fix verifyDiff
			// behavior, no worse than the baseline. A successful mint applies to BOTH
			// explicit and implied isolation.
			if (minted !== null) {
				worktree = minted;
				launchDirectory = minted.dir;
			}
		}

		// 5a. Pre-launch checkpoint barrier (Task 2.1.5): with the slot held, block
		// until the PRIOR agent's per-unit commit has drained. The gate slot was freed
		// in the prior agent's `finally` BEFORE its `agent:end`-driven commit even
		// kicked off, so this barrier — not the gate — is what makes the next launch
		// wait for the commit. Opaque + optional; ABSENT adds ZERO microtask hops (the
		// guard avoids an `await undefined` tick that would shift launch timing). Fenced
		// like the rest of this body — a barrier rejection must never crash the call.
		if (awaitCheckpointClear !== undefined) {
			try {
				await awaitCheckpointClear();
			} catch {
				// The checkpoint chain is fenced engine-side and never rejects; guard
				// defensively so a surprise rejection degrades to "launch anyway", never
				// a thrown agent() (degrade, don't detonate).
			}
		}

		// 5b. Write-ahead the intent (Phase 3): record a durable "dispatched-but-not
		// -settled" marker BEFORE launch, sharing this call's index+key with the
		// eventual completion. AWAITED so the marker hits disk before the launch
		// window opens — a crash there then leaves a visible intent with no `ok`.
		// FENCED like the barrier above: a journal append failure degrades to
		// launch-anyway, never throws (degrade, don't detonate). The cap/budget are
		// already charged; the intent is purely observational write-ahead.
		if (replay?.onIntent !== undefined) {
			try {
				await replay.onIntent({ index, key, status: "intent", label });
			} catch {
				// A failed intent append must not detonate the call — launch anyway.
			}
		}

		let taskId: string | undefined;
		let sessionId: string | undefined;
		let status = "error";
		// Carried into the finally so the single `agent:end` emit can attach the
		// diagnostic note (Task 7.2.1) — set on any null/empty collapse below.
		let endNote: string | undefined;
		// Carried into the finally so the single `agent:end` emit can attach the
		// conclusion preview — set on any SETTLED non-null result below, so the viewer
		// surfaces what the agent passed forward (a degrade leaves it unset, carrying
		// `endNote` instead).
		let endResult: string | undefined;
		// Task H.1.4: the first-class merge-conflict result (locked design decision #2).
		// The merge-back settle runs in the finally (so it also covers teardown on the
		// throw path); when it hits a Tier 1 conflict it sets this, and the finally
		// RETURNS it — overriding the try's resolved value so the agent resolves to a
		// structured `{status:'conflict'}` a Tier 2 script can branch on, NOT the
		// agent's text. Non-throwing (mirrors P0.4): the batch survives.
		let conflictResult:
			| {
					status: "conflict";
					branch: string;
					files: string[];
					baseRef: string | undefined;
			  }
			| undefined;
		// A non-conflict merge-back failure (merge_failed): the worktree is preserved and
		// the agent degrades to null (the finally returns null and journals nothing, so a
		// resumed run re-attempts). Set in the worktree settle; read by the finally.
		let mergeFailed = false;
		// Verify GATES the merge for an isolated agent: a failed post-condition makes
		// the finally's settle SKIP the merge-back and PRESERVE the worktree + scratch
		// branch (recoverable) instead of landing failed work on the main branch. Set
		// in the verify block below; read by settleWorktree in the finally.
		let verifyFailed = false;
		// The catch below RETHROWS a SkillNotFoundError (fail-loud authoring contract).
		// The finally's conflict/merge_failed value-substituting returns are only safe
		// when NO exception is in flight — this flag tells them to stand down so they
		// never swallow the rethrow.
		let rethrowing = false;
		// The try body's settled non-null result, hoisted so the finally can journal it
		// AFTER the worktree merge-back settles (a conflict supersedes it). For a
		// worktree agent the `onRecord` is deferred to the finally; this carries the
		// value across that seam. `undefined` means nothing to journal.
		let settledResult: unknown;
		try {
			// 6. Announce the start once the slot is held.
			emit({
				type: "agent:start",
				label,
				phase,
				promptPreview: promptPreviewOf(prompt),
			});

			// 6a. skills (Epic 2.2): merge the PRE-RESOLVED skill parts FIRST (so they
			// precede any contextDiff part). Resolution itself moved to 5s — BEFORE the
			// worktree mint — so an unknown skill name aborts before a mint is burned;
			// the fail-loud throw and its diagnostics live there.
			const contextParts: { type: "text"; text: string; synthetic: true }[] =
				[];
			contextParts.push(...skillParts);

			// 6b. contextDiff (Epic 4.1): resolve the engine-computed real git diff
			// (since run start) for a review. The diff rides a SYNTHETIC contextPart, not
			// the prompt, so it never perturbs computeCallKey (resume replays the verdict).
			// REFUSAL (#7 fix): when the diff is PROVABLY empty (available — a live work
			// tree), degrade to null BEFORE launch rather than reviewing narrative-only
			// claims. The gate slot is freed by the finally on this return, so a sibling
			// in the same parallel() batch is unaffected (degrade, don't detonate). When
			// `available:false` (no shell / non-git) emptiness is unprovable → run the
			// review with NO diff part; never refuse. A rejecting/absent thunk is fenced
			// to launch-anyway with no diff part.
			if (opts.contextDiff === true && resolveContextDiff !== undefined) {
				let diff:
					| { text: string; isEmpty: boolean; available: boolean }
					| undefined;
				try {
					diff = await resolveContextDiff();
				} catch {
					// A thunk rejection degrades to launch-anyway with no diff part.
					diff = undefined;
				}
				if (diff !== undefined && diff.available) {
					if (diff.isEmpty) {
						emit({
							type: "warn",
							message: `review '${label}' refused: the git diff for the unit under review is empty`,
						});
						endNote = diagnosticNote("empty_diff");
						onDiagnostic?.({ label, index, reason: "empty_diff" });
						status = "error";
						return null;
					}
					// `!isEmpty` no longer implies non-empty TEXT: the emptiness verdict
					// also counts UNTRACKED files (which `git diff` cannot render). An
					// untracked-only delta runs the review but injects no empty diff part.
					if (diff.text.trim().length > 0) {
						contextParts.push({
							type: "text",
							text: diff.text,
							synthetic: true,
						});
					}
				}
			}

			// 7. Launch the subagent. For structured output, register the compiled
			// schema against the child sessionID the instant it exists (synchronous
			// onSessionCreated hook), before the child's first turn can call the tool.
			// The parent reads the child's echoed value back from the transcript and
			// validates it against THIS registered schema (resolveStructured).
			//
			// pi tool-gating (the HIGH fix): pi's `--tools <csv>` (LaunchRequest.tools)
			// is a STRICT allow-list — a child launched with it can call ONLY those
			// tools, so `structured_output` (and any `opts.tools`) MUST land in the SAME
			// `--tools` list, NOT only in the boolean `toolsOverride` map. pi has no
			// per-prompt tool channel (opencode dispatched the map with each prompt; pi
			// fixes the child tool set at spawn via `--tools`), so a child whose resolved
			// agent carries a `tools` frontmatter would get a strict allow-list that
			// EXCLUDES structured_output -> the child cannot call the tool the schema
			// requires and structured output silently breaks. Two cases:
			//   - resolved agent HAS a `tools` frontmatter -> UNION the launch's extra tool
			//     names into it (else the strict allow-list drops them).
			//   - resolved agent has NO `tools` (req.tools undefined = ALL tools enabled,
			//     structured_output included) -> leave it undefined: materializing a list
			//     here would RESTRICT a default agent to only these names. We pass a list
			//     ONLY when the agent already constrains its tools.
			// `toolsOverride` stays the recursion-guard composition seam (it merges over
			// SPAWN_GUARD in the runner and is replayed on resume); `launchTools` is what
			// actually reaches the child's `--tools` filter.
			const extraToolNames: string[] = [];
			if (compiled !== undefined) {
				extraToolNames.push("structured_output");
			}
			for (const name of opts.tools ?? []) {
				const trimmed = name.trim();
				if (trimmed.length > 0) {
					extraToolNames.push(trimmed);
				}
			}
			const toolsOverride: Record<string, boolean> = {};
			for (const name of extraToolNames) {
				toolsOverride[name] = true;
			}
			// The effective `--tools` allow-list, present ONLY when the resolved agent
			// already constrains tools (a non-empty `tools` frontmatter): then the extra
			// tool names are unioned in so the strict allow-list does not exclude the tools
			// the launch needs. A default agent (no frontmatter tools) keeps `undefined` ->
			// pi enables ALL tools, structured_output included.
			const launchTools =
				resolvedAgent?.tools !== undefined && resolvedAgent.tools.length > 0
					? [...new Set([...resolvedAgent.tools, ...extraToolNames])]
					: resolvedAgent?.tools;
			const task = await runner.launch({
				parentSessionID,
				description: label,
				prompt: launchPrompt,
				// The `agent` field is the display LABEL only — pi has no --agent flag.
				agent: agentType,
				// Model precedence: an explicit opts.model wins over the resolved agent
				// definition's frontmatter model.
				model: opts.model ?? resolvedAgent?.model,
				depth: 0,
				// pi-native agent knobs (the agent() → child seam): the resolved system
				// prompt + tool allow-list. ABSENT → pi's default assistant.
				...(resolvedAgent?.appendSystemPrompt !== undefined
					? { appendSystemPrompt: resolvedAgent.appendSystemPrompt }
					: {}),
				// pi `--tools` allow-list: `launchTools` is `resolvedAgent.tools` UNIONED
				// with structured_output + opts.tools when the agent constrains tools, else
				// undefined (no constraint -> all tools). Undefined -> omit the flag entirely.
				...(launchTools !== undefined ? { tools: launchTools } : {}),
				// Epic H.1: forward the per-agent directory so it re-roots the worker
				// cwd. For an isolation:'worktree' agent this is the minted worktree dir
				// (overriding the run-wide `directory`, set at 5w); otherwise it is the
				// engine-owned run-wide directory. Absent → identical launch as today.
				...(launchDirectory !== undefined
					? { directory: launchDirectory }
					: {}),
				...(contextParts.length > 0 ? { contextParts } : {}),
				...(compiled !== undefined
					? {
							onSessionCreated: (sid: string) =>
								registry.register(sid, compiled),
						}
					: {}),
				...(Object.keys(toolsOverride).length > 0 ? { toolsOverride } : {}),
			});
			taskId = task.id;
			sessionId = task.sessionID;
			liveTasks?.add(task.id);

			// Task 8.1.1: announce the launched session the instant it exists, between
			// start and end. This carries the session↔label binding downstream
			// consumers attach stats/durations to; model resolves from the launched
			// task (which mirrors the requested model) falling back to opts.model, and
			// agentType from opts.agentType ?? defaults.agent. Stays clock-free. Guarded
			// on a present sessionID — a runner that returns no session has nothing to
			// bind, so it skips agent:launched just like the cached path.
			if (sessionId !== undefined) {
				const launchedModel = task.model ?? opts.model;
				emit({
					type: "agent:launched",
					label,
					phase,
					sessionID: sessionId,
					...(launchedModel !== undefined ? { model: launchedModel } : {}),
					agentType,
				});
			}

			// 8. Wait for it to reach a terminal status — for as LONG as it takes.
			// Workflows are long-running by nature; there is no per-agent wall-clock
			// timeout (a fired timeout would reject this await and abandon a child that
			// is still working, breaking the run with no way to resume that agent). The
			// completion fuser still resolves this on genuine terminal states: normal
			// idle completion, session-gone (error), or the stale backstop (45min of
			// TOTAL silence — which an actively-working agent never reaches).
			const done = await runner.awaitCompletion(task.id);
			status = done.status;

			// 8b. Budget accounting (§6, Task 4.3.1): once the child has settled on
			// ANY terminal status, charge its token spend against the budget BEFORE
			// resolving — so the next sequential call's pre-check sees it. Fenced
			// inside recordTask itself (degrade, don't detonate). A failed agent
			// still consumed tokens, so it is charged just like a completed one.
			if (sessionId !== undefined && isRecordable(budget)) {
				await budget.recordTask(sessionId);
			}

			// 10. Map terminal status to a result, then journal it if non-null.
			let result: unknown;
			if (compiled !== undefined) {
				result = await resolveStructured(
					task,
					done.status,
					sessionId,
					compiled,
				);
			} else if (done.status === "completed") {
				// Non-structured: completed → final text, else degrade to null.
				result = (await runner.readOutput(task.id)).summaryText;
			} else {
				result = null;
			}

			// Task 7.2.1: classify any null/empty collapse into a typed diagnostic,
			// capture the raw final text for schema reasons, and carry a short note
			// for `agent:end`. Script-visible semantics are untouched — `result` is
			// returned as-is (bare null/"").
			const reason = classifyDegrade(
				compiled !== undefined,
				done.status,
				result,
				sessionId,
			);
			if (reason !== undefined) {
				// Schema reasons capture the child's raw final text (fenced); a
				// non-completed status or empty output has no useful capture target.
				const rawText =
					(reason === "schema_no_call" || reason === "schema_invalid") &&
					taskId !== undefined
						? await captureRawText(taskId)
						: undefined;
				endNote = diagnosticNote(reason, rawText?.length);
				const diagnostic: AgentDiagnostic = {
					label,
					index,
					reason,
					...(rawText !== undefined ? { rawText } : {}),
					...(sessionId !== undefined ? { childSessionID: sessionId } : {}),
				};
				onDiagnostic?.(diagnostic);
			}

			// verifyDiff post-condition (Epic 4.2): for an agent that settled NON-NULL,
			// verify its git/command post-condition AFTER it settles but BEFORE
			// journaling. On a PROVABLE failure (available && !passed), downgrade the
			// result to null so it RE-RUNS on resume (a hollow success is never
			// journaled) — the #7 fix against a settled-but-empty unit. available:false
			// (no-shell / non-git) is INERT: the result survives, never a fabricated
			// failure. For an UNISOLATED agent the downgrade nulls the RESULT only; it
			// does NOT un-commit — the engine still checkpoints it (the bytes are on
			// disk; agent:end still carries the sessionID), so P2 recovery holds. For an
			// ISOLATED agent, verify GATES the merge: `verifyFailed` makes the finally's
			// settle PRESERVE the worktree+scratch branch instead of merging, so failed
			// work never silently lands on the main branch (and a resume never re-runs
			// the agent on top of its own landed edits). Fenced: a thrown verify
			// degrades to pass-through, never a thrown agent() (degrade, don't
			// detonate). Runs only when the agent itself produced a result to verify.
			if (
				verifySpec !== undefined &&
				verifyResult !== undefined &&
				result !== null &&
				result !== undefined
			) {
				let verdict:
					| { passed: boolean; available: boolean; reason?: string }
					| undefined;
				try {
					verdict = await verifyResult({
						verifyDiff: verifySpec,
						...(sessionId !== undefined ? { sessionId } : {}),
						// Epic H.1.3: re-root the verify shell to the WORKTREE checkout for
						// an isolated agent — its edits live there, not in the main tree.
						...(worktree !== undefined ? { directory: worktree.dir } : {}),
					});
				} catch {
					// A thrown verify degrades to pass-through (treated as inert).
					verdict = undefined;
				}
				if (verdict !== undefined && verdict.available && !verdict.passed) {
					verifyFailed = true;
					endNote =
						worktree !== undefined
							? `${diagnosticNote("verify_failed")} — worktree preserved on branch ${worktree.branch} (NOT merged)`
							: diagnosticNote("verify_failed");
					onDiagnostic?.({
						label,
						index,
						reason: "verify_failed",
						...(sessionId !== undefined ? { childSessionID: sessionId } : {}),
					});
					return null;
				}
			}

			// Spec §7: only SETTLED non-null results are journaled — a failed/null
			// agent must re-run on resume, not replay its failure. For a worktree agent
			// the journaled value is decided AFTER the finally's merge-back settle (a
			// conflict replaces the result with the Tier 1 `{status:'conflict'}` value,
			// Task H.1.4); deferring the record there keeps resume replaying the SAME
			// value the script saw, never the now-superseded agent text.
			if (result !== null && result !== undefined) {
				// Capture the conclusion preview for `agent:end` on EVERY settled path
				// (worktree or not) — the finally reads it to surface what was handed
				// forward. A later Tier 1 conflict supersedes the script's value but not
				// this preview: the note then names the conflict, and the preview still
				// shows what the agent itself produced.
				endResult = resultPreviewOf(result);
				if (worktree !== undefined && worktreeManager !== undefined) {
					settledResult = result;
				} else {
					replay?.onRecord({ index, key, status: "ok", result });
				}
			}
			return result;
		} catch (err) {
			// Fail-loud exception (Epic 2.2): an unknown skill name (SkillNotFoundError)
			// is an authoring bug that must reach the script as a real error, NOT degrade
			// to a silent null like a launch/await failure. Skills now resolve at 5s
			// (before the mint and before this try), so this branch is a DEFENSIVE
			// backstop; discriminated structurally by name so the runtime stays
			// plugin-agnostic. `rethrowing` tells the finally's conflict/mergeFailed
			// value-substituting returns to stand down — a `return` in a finally would
			// otherwise SWALLOW this in-flight exception.
			if (err instanceof Error && err.name === "SkillNotFoundError") {
				rethrowing = true;
				throw err;
			}
			// launch()/awaitCompletion() throwing is a degrade, not a detonation.
			status = "error";
			emit({
				type: "warn",
				message: `agent '${label}' failed: ${describeError(err)}`,
			});
			// Task 7.2.1: a throw before/around completion is `await_failed`. No raw
			// capture — the child may not have a usable session/transcript.
			endNote = diagnosticNote("await_failed");
			onDiagnostic?.({
				label,
				index,
				reason: "await_failed",
				...(sessionId !== undefined ? { childSessionID: sessionId } : {}),
			});
			return null;
		} finally {
			// 9. Release the slot and drop the live task on EVERY path.
			if (taskId !== undefined) {
				liveTasks?.delete(taskId);
			}
			gate.release(runId);
			// Epic H.1.3: settle the per-agent worktree minted at 5w with a
			// merge-back-then-conditional-cleanup, SERIALIZED on the engine's checkpoint
			// tail (so a merge never interleaves with a sibling's commit). The whole
			// thing is FENCED + best-effort — a merge/cleanup failure must never crash
			// this agent or detonate its batch (degrade, don't detonate). The work runs
			// BEFORE the `agent:end` emit below, so the merge lands on the tail ahead of
			// this agent's own checkpoint (driven by that event), letting the main
			// checkpointer capture the merged result next.
			if (worktree !== undefined && worktreeManager !== undefined) {
				const mgr = worktreeManager;
				const wt = worktree;
				// The serialized settle: a FAILED VERIFY gates the merge (preserve, never
				// land failed work); unchanged → cleanup (CC auto-cleanup-if-unchanged, no
				// merge commit); else mergeBack from the main tree. A clean merge →
				// cleanup; a real CONFLICT or a non-conflict {failed} → preserve the
				// worktree+branch (SKIP cleanup) for Tier 2 / recovery.
				const settleWorktree = async (): Promise<void> => {
					if (verifyFailed) {
						// Verify GATES the merge (the #2 semantic): the post-condition failed,
						// so the worktree's work must NOT land on the main branch — merging it
						// would silently ship failed work AND make a resume re-run the agent on
						// top of its own landed edits. PRESERVE the worktree + scratch branch
						// exactly like the conflict path (recoverable; the startup sweep
						// reclaims it if abandoned) and name the branch loud.
						emit({
							type: "warn",
							message: `agent '${label}' verify FAILED — its work was NOT merged; worktree preserved on branch ${wt.branch} for inspection/recovery`,
						});
						return;
					}
					if (await mgr.isUnchanged(wt.dir)) {
						await mgr.cleanup(wt.dir, wt.branch);
						return;
					}
					const merge = await mgr.mergeBack(wt.dir, wt.branch);
					if ("conflict" in merge) {
						// Locked design decision #2 (Task H.1.4): a conflict is Tier 1 —
						// loud, first-class, NOT auto-resolved. Preserve the worktree (no
						// cleanup) so a Tier 2 resolver script can act on it, emit a loud
						// warn + a merge_conflict diagnostic, and surface the conflict as a
						// STRUCTURED result the script branches on (set here, RETURNED by the
						// finally — overriding the agent's text). Do NOT throw: the parallel()
						// batch survives (same non-detonating discipline as P0.4).
						endNote = diagnosticNote("merge_conflict");
						emit({
							type: "warn",
							message: `agent '${label}' merge-back CONFLICTED on branch ${merge.branch} (${merge.files.length} file(s): ${merge.files.join(", ")}) — worktree preserved for Tier 2 resolution; the agent resolves to a {status:'conflict'} result`,
						});
						onDiagnostic?.({
							label,
							index,
							reason: "merge_conflict",
							...(sessionId !== undefined ? { childSessionID: sessionId } : {}),
						});
						conflictResult = {
							status: "conflict",
							branch: merge.branch,
							files: merge.files,
							baseRef: merge.baseRef,
						};
						return;
					}
					if ("failed" in merge) {
						// merge_failed: git exited non-zero with ZERO unmerged files (operator
						// dirtied the main tree mid-run, or a transient failure). The agent's
						// edits are committed on the scratch branch but did NOT reach the main
						// tree. PRESERVE the worktree+branch (recoverable) and surface LOUD —
						// NEVER a silent cleanup, which would drop the work (#5 through the
						// isolation path). The agent degrades to null (finally returns null) so a
						// resumed run re-attempts rather than replaying a false `ok`.
						mergeFailed = true;
						endNote = diagnosticNote("merge_failed");
						emit({
							type: "warn",
							message: `agent '${label}' merge-back FAILED without conflict on branch ${wt.branch} — worktree preserved (edits are committed on the scratch branch, NOT in the main tree); this agent degrades to null for re-attempt on resume`,
						});
						onDiagnostic?.({
							label,
							index,
							reason: "merge_failed",
							...(sessionId !== undefined ? { childSessionID: sessionId } : {}),
						});
						return;
					}
					// merged (clean): reclaim the worktree+branch.
					await mgr.cleanup(wt.dir, wt.branch);
				};
				try {
					// Serialize on the engine's checkpoint tail when wired; otherwise run
					// inline (the standalone library has no shared git tree to order against).
					if (serializeOnCheckpoint !== undefined) {
						await serializeOnCheckpoint(settleWorktree);
					} else {
						await settleWorktree();
					}
				} catch {
					// Settling a worktree is best-effort; never propagate its failure into
					// the agent's resolution (degrade, don't detonate).
				}
				// Journal the value the script actually saw (deferred from the try body
				// for worktree agents): the Tier 1 conflict result on a conflict, else the
				// agent's settled result. A conflict is a deterministic structured value, so
				// recording IT (not the superseded agent text) keeps a resumed run replaying
				// the same conflict the script branched on. Spec §7: only non-null records.
				// On merge_failed, journal NOTHING — the work did not land, so a resumed run
				// must re-attempt the agent rather than replay a false `ok`.
				const recordValue = mergeFailed
					? undefined
					: (conflictResult ?? settledResult);
				if (recordValue !== null && recordValue !== undefined) {
					replay?.onRecord({ index, key, status: "ok", result: recordValue });
				}
			}
			// Structured output: drop the schema + any stored result for this child.
			if (sessionId !== undefined) {
				registry.clear(sessionId);
			}
			// 11. Announce the end with the resolved status (and the diagnostic note,
			// when this call degraded — Task 7.2.1). When a session was launched, carry
			// its sessionID (Task 8.1.1) so the engine can pair this end with its
			// agent:launched; the cached and pre-launch-throw paths omit it.
			emit({
				type: "agent:end",
				label,
				status,
				...(sessionId !== undefined ? { sessionID: sessionId } : {}),
				...(endNote !== undefined ? { note: endNote } : {}),
				...(endResult !== undefined ? { result: endResult } : {}),
			});
			// Task H.1.4: a Tier 1 merge conflict supersedes the try's resolved value.
			// A `return` in the finally overrides whatever the try returned (the agent's
			// text), so the script receives the first-class `{status:'conflict'}` result.
			// Only on conflict — a clean settle leaves the try's return intact. THE REAL
			// INVARIANT: the catch above degrades every error to `return null` EXCEPT a
			// SkillNotFoundError, which it RETHROWS with `rethrowing` set. A finally
			// `return` while that exception is in flight would SWALLOW it — so both
			// value-substituting returns are guarded on `!rethrowing` (a deliberate
			// substitution is only safe when nothing is propagating).
			if (conflictResult !== undefined && !rethrowing) {
				// biome-ignore lint/correctness/noUnsafeFinally: deliberate Tier 1 conflict result override; guarded on !rethrowing so an in-flight rethrow is never swallowed (see comment above).
				return conflictResult;
			}
			// merge_failed degrades the agent to null (the work did not reach the main
			// tree; the worktree+branch are preserved for recovery). Same guarded
			// substitution as the conflict path.
			if (mergeFailed && !rethrowing) {
				// biome-ignore lint/correctness/noUnsafeFinally: deliberate merge_failed degrade-to-null; guarded on !rethrowing so an in-flight rethrow is never swallowed (see comment above).
				return null;
			}
		}
	};

	/**
	 * Resolve the structured result for a completed structured agent (pi read-back).
	 *
	 * The child is a SUBPROCESS that echoed its JSON value as the LAST
	 * `structured_output` tool result on its transcript (see structured/tool.ts). The
	 * PARENT extracts that text via the engine-wired {@link ReadStructured} seam,
	 * parses + validates it against the schema it holds, and populates the registry
	 * (`store` on success, `recordFailure` on parse/validation failure — so
	 * `classifyDegrade` can tell schema_invalid from schema_no_call). Non-completed
	 * statuses degrade to `null` with no nudge. A completion with no valid stored
	 * result earns ONE re-prompt carrying the validation errors; if that still yields
	 * nothing, the call resolves `null`. A resume/await/read throw degrades to `null`
	 * with a warn.
	 *
	 * ABSENT {@link ReadStructured} (the standalone library / tests that pre-populate
	 * the registry in-process): fall back to the registry's stored value directly —
	 * the old opencode in-process path — so this seam is purely additive.
	 */
	async function resolveStructured(
		task: { id: string },
		status: string,
		sessionId: string | undefined,
		compiled: CompiledSchema,
	): Promise<unknown> {
		if (status !== "completed" || sessionId === undefined) {
			return null;
		}

		// First read: extract + validate the child's echoed value into the registry.
		await ingestStructured(task.id, sessionId, compiled);
		const first = registry.resultFor(sessionId);
		if (first.present) {
			return first.value;
		}

		// One nudge: re-prompt the child to call the tool (carrying the last
		// validation errors so it fixes the real problem), then await + re-read.
		try {
			const errors = registry.lastFailure(sessionId);
			await runner.resume(task.id, structuredNudge(errors));
			await runner.awaitCompletion(task.id);
		} catch (err) {
			emit({
				type: "warn",
				message: `agent structured-output nudge failed: ${describeError(err)}`,
			});
			return null;
		}
		await ingestStructured(task.id, sessionId, compiled);
		const second = registry.resultFor(sessionId);
		return second.present ? second.value : null;
	}

	/**
	 * Read the child's echoed structured value off its transcript, parse + validate
	 * it against `compiled`, and write the outcome into the registry: `store` on
	 * success, `recordFailure` on a parse/validation failure (the schema_invalid
	 * signal). FENCED — a read failure leaves the registry untouched (→ schema_no_call
	 * unless a prior failure was recorded). When the {@link ReadStructured} seam is
	 * ABSENT this is a no-op: the registry keeps whatever an in-process child wrote
	 * (the standalone-library fallback).
	 */
	async function ingestStructured(
		taskId: string,
		sessionId: string,
		compiled: CompiledSchema,
	): Promise<void> {
		if (readStructured === undefined) {
			// No transcript read-back seam → keep the in-process registry value (tests /
			// standalone library populate it directly).
			return;
		}
		let raw: string | undefined;
		try {
			raw = await readStructured(taskId, sessionId);
		} catch {
			// A read failure is observability-only; leave the registry as-is.
			return;
		}
		if (raw === undefined) {
			// The child never called structured_output → schema_no_call (no failure
			// recorded, nothing stored).
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			registry.recordFailure(sessionId, `JSON parse failed: ${detail}`);
			return;
		}
		const verdict = compiled.validate(parsed);
		if (!verdict.ok) {
			registry.recordFailure(sessionId, verdict.errors);
			return;
		}
		registry.store(sessionId, parsed);
	}
}

/** Compact char-count for a diagnostic note: `6.3k` over 1000, else the integer. */
function humanizeChars(n: number): string {
	if (n >= 1000) {
		return `${(n / 1000).toFixed(1)}k chars`;
	}
	return `${n} chars`;
}

/** Best-effort human-readable detail for a thrown value. */
function describeError(err: unknown): string {
	if (err instanceof Error) {
		return err.message;
	}
	return String(err);
}
