import type { ConcurrencyManager, SessionRunner } from "@drawers/core";
import { computeCallKey } from "./keys";
import type { SchemaRegistry } from "./structured/registry";
import { compileSchema } from "./structured/validate";
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
/** Cap on captured raw final text in a diagnostic (Task 7.2.1). */
const RAW_TEXT_CAP = 20_000;
/** Marker appended when raw-text capture is truncated. */
const RAW_TEXT_CAP_MARKER = "…[capped]";

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
	 * (Task 3.3.2). The same instance backs the `structured_output` tool, so a
	 * child's tool call and this primitive's `resultFor` read share state.
	 */
	registry: SchemaRegistry;
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
	 * straight to `runner.launch` → `session.create`'s `query.directory`, which
	 * re-roots the worker's Bash/tool cwd (host-probed green 2026-06-08). This is
	 * an ENGINE-OWNED dep, NOT an `AgentOpts` field — no script can request it and
	 * it is deliberately ABSENT from {@link computeCallKey}/`CallKeyInput` (a
	 * worktree path would re-key every cached agent on resume and re-run settled
	 * work), exactly like the `contextDiff`/`verifyDiff` exclusion. The mint-point (Epic H.1.2) sets it: an
	 * `isolation:'worktree'` agent launches in its minted worktree dir; ABSENT or non-isolated → the
	 * engine-wide directory applies.
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
		onDiagnostic,
		currentPhase,
		liveTasks,
		defaults,
		registry,
		replay,
		callIndex,
		awaitCheckpointClear,
		resolveContextDiff,
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
		const raw =
			rawLen !== undefined ? `; raw ${humanizeChars(rawLen)} preserved` : "";
		return `null — ${reason}${raw}`;
	}

	/**
	 * Classify a settled call into a typed degrade reason (Task 7.2.1), or
	 * `undefined` when the call succeeded (non-empty result). Reads the registry's
	 * recorded validation failure to split `schema_no_call` from `schema_invalid` —
	 * the registry validates BEFORE storing, so an unstored completed structured
	 * turn is either "never called" (no failure recorded) or "called and rejected"
	 * (failure recorded). Runs in the try body, BEFORE the finally clears the
	 * registry, so the failure record is still readable.
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
			emit({ type: "agent:end", label, status: "cached" });
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

		// 5. Gate the launch on the run's concurrency slots.
		await gate.acquire(runId);

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
		if (opts.isolation === "worktree") {
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
			if (minted === null) {
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
			worktree = minted;
			launchDirectory = minted.dir;
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
		// Task H.1.4: the first-class merge-conflict result (locked design decision #2).
		// The merge-back settle runs in the finally (so it also covers teardown on the
		// throw path); when it hits a Tier 1 conflict it sets this, and the finally
		// RETURNS it — overriding the try's resolved value so the agent resolves to a
		// structured `{status:'conflict', …}` a Tier 2 script can branch on, NOT the
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
			let contextParts: { type: "text"; text: string; synthetic: true }[] = [];
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
					contextParts = [{ type: "text", text: diff.text, synthetic: true }];
				}
			}

			// 7. Launch the subagent. For structured output, register the compiled
			// schema against the child sessionID the instant it exists (synchronous
			// onSessionCreated hook), before the child's first turn can call the tool.
			// toolsOverride is assembled from two independent sources that compose:
			// the structured-output tool (when a schema is compiled) and any explicit
			// opts.tools (Epic 2.1). Empty → omitted, so the no-schema/no-tools launch
			// is byte-identical to before.
			const toolsOverride: Record<string, boolean> = {};
			if (compiled !== undefined) {
				toolsOverride.structured_output = true;
			}
			for (const name of opts.tools ?? []) {
				const trimmed = name.trim();
				if (trimmed.length > 0) {
					toolsOverride[trimmed] = true;
				}
			}
			const task = await runner.launch({
				parentSessionID,
				description: label,
				prompt: launchPrompt,
				agent: opts.agentType ?? defaults.agent,
				model: opts.model,
				depth: 0,
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
					agentType: opts.agentType ?? defaults.agent,
				});
			}

			// 8. Wait for it to reach a terminal status — for as LONG as it takes.
			// Workflows are long-running by nature; there is no per-agent wall-clock
			// timeout (a fired timeout would reject this await and abandon a child that
			// is still working, breaking the run with no way to resume that agent). The
			// completion gate still resolves this on genuine terminal states: normal
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
				result = await resolveStructured(task, done.status, sessionId);
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
			// failure. The downgrade nulls the RESULT only; it does NOT un-commit — the
			// engine still checkpoints this agent (the bytes are on disk; agent:end still
			// carries the sessionID), so P2 recovery holds. Fenced: a thrown verify
			// degrades to pass-through, never a thrown agent() (degrade, don't detonate).
			// Runs only when the agent itself produced a result to verify.
			if (
				opts.verifyDiff !== undefined &&
				verifyResult !== undefined &&
				result !== null &&
				result !== undefined
			) {
				let verdict:
					| { passed: boolean; available: boolean; reason?: string }
					| undefined;
				try {
					verdict = await verifyResult({
						verifyDiff: opts.verifyDiff,
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
					endNote = diagnosticNote("verify_failed");
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
				if (worktree !== undefined && worktreeManager !== undefined) {
					settledResult = result;
				} else {
					replay?.onRecord({ index, key, status: "ok", result });
				}
			}
			return result;
		} catch (err) {
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
				// The serialized settle: unchanged → cleanup (CC auto-cleanup-if-
				// unchanged, no merge commit); else mergeBack from the main tree. A clean
				// merge (or a non-conflict {failed}) → cleanup; a real CONFLICT → preserve
				// the worktree+branch (SKIP cleanup) for Tier 2 and surface merge_conflict.
				const settleWorktree = async (): Promise<void> => {
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
			});
			// Task H.1.4: a Tier 1 merge conflict supersedes the try's resolved value.
			// A `return` in the finally overrides whatever the try returned (the agent's
			// text), so the script receives the first-class `{status:'conflict', …}`
			// result. Only on conflict — a clean settle leaves the try's return intact.
			// The override is SAFE here: the catch above always resolves to `return null`
			// and never rethrows, so there is no in-flight exception/return for this to
			// swallow — it is a deliberate value substitution (locked design decision #2).
			if (conflictResult !== undefined) {
				// biome-ignore lint/correctness/noUnsafeFinally: deliberate Tier 1 conflict result override; catch never rethrows (see comment above).
				return conflictResult;
			}
			// merge_failed degrades the agent to null (the work did not reach the main
			// tree; the worktree+branch are preserved for recovery). Same safe override as
			// the conflict path: the catch never rethrows, so substituting the value
			// swallows no in-flight exception.
			if (mergeFailed) {
				// biome-ignore lint/correctness/noUnsafeFinally: deliberate merge_failed degrade-to-null; catch never rethrows (see comment above).
				return null;
			}
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
			await runner.awaitCompletion(task.id);
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
