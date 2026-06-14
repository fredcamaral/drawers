/**
 * The workflow runtime phase's internal contract module (spec §3.3).
 *
 * These are the globals a workflow script body programs against once the harness
 * has bound them, plus the supporting view/event/error types the runtime layer
 * shares. The composition primitives (`pipeline`, `parallel`) are typed here with
 * permissive signatures — Task 3.2.2 implements them; this module only fixes the
 * shape the script sees.
 */

/** A single `agent()` call's options (spec §3.3 "agent() options"). */
export interface AgentOpts {
	/** Display label for the progress tree; defaults to the prompt prefix. */
	label?: string;
	/** Progress group; preferred over the global `phase()` state when set. */
	phase?: string;
	/** JSON Schema for structured output (lands in Task 3.3.2). */
	schema?: object;
	/** Model override; default is to inherit the session model. */
	model?: string;
	/** Fresh git worktree — expensive, only for parallel file mutation. */
	isolation?: "worktree";
	/** Custom subagent type from the same registry as the `Agent` tool. */
	agentType?: string;
	/**
	 * Tool names to ENABLE for this spawned agent (Epic 2.1) — e.g. web
	 * search/fetch for a research agent. Each name is forwarded as a
	 * `toolsOverride` flag onto the launch and composes with the structured-
	 * output override when a `schema` is also set. Names are ENVIRONMENT-
	 * DEPENDENT (the platform/MCP servers decide them; this package defines
	 * none); an unknown name is a no-op at the platform layer. Empty or absent →
	 * the agent inherits the session's tools, fully inert.
	 */
	tools?: string[];
	/**
	 * Canonical skill names (e.g. `ring:writing-trds`) to bind into this spawned
	 * step (Epic 2.2), discoverable via the `workflow_skills` tool — use EXACT
	 * names. Each name resolves through the plugin-side `resolveSkills` seam to a
	 * synthetic contextPart carrying the framed `SKILL.md` body, injected onto the
	 * child launch exactly like {@link AgentOpts.contextDiff}. An UNKNOWN name FAILS
	 * the launch LOUDLY (it throws past the degrade-to-null fence) — the deliberate
	 * contrast with `tools`/`agentType`, which silently no-op on an unknown value.
	 * Like `contextDiff`, the part rides synthetically and is deliberately ABSENT
	 * from {@link computeCallKey} (a resumed run replays its journaled result rather
	 * than re-binding). Absent/empty → inert (today's launch). A skill-bound step
	 * needs file-read tools (`Read`/`Bash`) enabled if the skill references bundled
	 * `shared-patterns` resources.
	 */
	skills?: string[];
	/**
	 * Inject the engine-computed REAL git diff (since run start) as model-only
	 * context, and refuse the review when that diff is genuinely empty (Epic 4.1).
	 * Opt-in; absent → today's behavior. For REVIEW agents: a reviewer of narrative-
	 * only claims (a phantom review of work that was never written to disk) is the
	 * #7 catastrophe this prevents. The diff rides {@link AgentOpts} INTENTIONALLY
	 * as a flag, NOT the prompt — the engine injects it as a synthetic contextPart
	 * so it never perturbs the replay {@link computeCallKey} (a contextDiff reviewer
	 * still replays its journaled verdict on resume instead of re-diffing a now-
	 * different tree). The refusal is GATED on the diff being PROVABLY empty (a live
	 * git work tree); on a no-shell / non-git checkout the review runs normally with
	 * no diff part, since emptiness cannot be proven.
	 */
	contextDiff?: boolean;
	/**
	 * Post-condition the engine checks AFTER the agent settles (Epic 4.2). When set
	 * and the check FAILS, the settled result is downgraded to `null` (so it re-runs
	 * on resume rather than journaling a hollow success). Opt-in; absent → no
	 * verification.
	 *   - `true` (or `{}`): the engine asserts the unit's GIT diff (the engine's own
	 *     working-tree delta vs the run-start baseline) is NON-EMPTY — i.e. the agent
	 *     actually wrote something to disk. `verifyDiff:{}` is IDENTICAL to `true`
	 *     (the optional `check` simply being absent), NOT a no-op.
	 *   - `{check:'<cmd>'}`: run `<cmd>` via the engine's repo-bound shell and assert
	 *     exit 0.
	 * Verifies GIT/DISK TRUTH, NOT the agent's self-report and NOT the opencode
	 * session diff (which is a point-in-time SNAPSHOT that survives an out-of-band
	 * git restore — a phantom pass). BEST-EFFORT: it proves "something is on disk vs
	 * HEAD" (or a command exits 0), NOT that the agent's claim is correct. INERT on a
	 * no-shell / non-git checkout (the result passes through unchanged — never a
	 * fabricated failure). `verifyDiff: false` is identical to ABSENT (no isolation
	 * implied, no check run) — a computed flag may legitimately pass `false`. Like
	 * {@link AgentOpts.contextDiff}, a post-condition is NOT part of
	 * {@link computeCallKey} — it must not void the resume cache.
	 *
	 * For an ISOLATED agent (explicit `isolation:'worktree'`, or the worktree this
	 * option itself implies on a git-backed engine), verify GATES the merge-back: a
	 * failed post-condition means the worktree is NOT merged to the main branch — the
	 * work is preserved on the scratch branch (recoverable, named in the warn/note)
	 * and the agent degrades to null so a resume re-runs it cleanly, never on top of
	 * its own failed-but-landed edits.
	 */
	verifyDiff?: boolean | { check?: string };
}

/** Spawn a subagent; resolves to its final text, a validated object, or `null`. */
export type AgentFn = (prompt: string, opts?: AgentOpts) => Promise<unknown>;

/**
 * Run another workflow inline as a sub-step (spec §8). `nameOrRef` is a saved-name
 * string or a `{ scriptPath }` ref; `args` is the child's verbatim `args`. Resolves
 * to the child's `return` value on completion, THROWS on child error (catchable,
 * unlike `agent()`'s null), and is unavailable (throws {@link NestingError}) inside
 * a child — nesting is one level deep.
 */
export type WorkflowFn = (
	nameOrRef: string | { scriptPath: string },
	args?: unknown,
) => Promise<unknown>;

/** A single `shell()` call's options — the cheap deterministic-command primitive. */
export interface ShellOpts {
	/** Display label for the progress feed; defaults to the command string. */
	label?: string;
	/**
	 * Working directory, RELATIVE to the run's project root (or absolute). Absent →
	 * the project root. PART of the replay key: the same command in a different cwd
	 * is a different call (a `make test` in two packages must not share a result).
	 */
	cwd?: string;
	/**
	 * The exit code that counts as `passed`. Default 0. PART of the replay key —
	 * changing it changes the pass/fail verdict the journaled result carries, so a
	 * resume must re-derive it rather than replay a stale verdict.
	 */
	expectExitCode?: number;
}

/**
 * The settled result of a `shell()` call (spec §3.3, the deterministic-command
 * primitive). NEVER thrown: a non-zero exit is a `passed:false` VALUE the script
 * branches on, not an error — mirroring `agent()`'s degrade-don't-detonate.
 */
export interface ShellResult {
	/** The command that ran, verbatim. */
	command: string;
	/** `exitCode === (opts.expectExitCode ?? 0)` — the branch the script reads. */
	passed: boolean;
	/** The process exit code; `-1` when the command could not run (`available:false`). */
	exitCode: number;
	/** Captured stdout, capped to bound the journal; `""` on an unavailable shell. */
	stdout: string;
	/** Captured stderr, capped to bound the journal; `""` on an unavailable shell. */
	stderr: string;
	/**
	 * `false` on a no-shell engine / the standalone library (no shell capability is
	 * threaded). An unavailable result is NEVER journaled — a resume in a
	 * shell-capable engine RE-RUNS it rather than replaying a hollow "unavailable"
	 * (mirrors the agent contract: failures are never cached). On an available shell
	 * this is always `true`, even for a non-zero exit (the command genuinely ran).
	 */
	available: boolean;
}

/**
 * Run a deterministic shell command from a workflow script — the CHEAP counterpart
 * to spending an `agent()` just to discover a command's exit code (spec §3.3). The
 * OS decides facts (`make test` passed?), the agent decides judgment (why did it
 * fail?). Resolves to a {@link ShellResult}; NEVER throws on a non-zero exit. Runs
 * via an engine-supplied seam over the repo-bound host shell; INERT (`available:
 * false`) when no shell capability is threaded — it returns an honest unavailable
 * result, never a fabricated pass (the anti-`dryRun` contract).
 */
export type ShellFn = (
	command: string,
	opts?: ShellOpts,
) => Promise<ShellResult>;

/** The token budget as the script sees it (spec §6). */
export interface BudgetView {
	/** The hard ceiling for the turn, or `null` if none was set. */
	total: number | null;
	/** Output tokens spent this turn across the shared pool. */
	spent(): number;
	/** `max(0, total − spent())`, or `Infinity` with no target. */
	remaining(): number;
}

/** A progress signal emitted as the runtime drives `agent()` calls. */
export type ProgressEvent =
	| {
			type: "agent:start";
			label: string;
			phase?: string;
			/**
			 * A truncated preview of the USER prompt for this call (Task 8.3.x), shown
			 * in the TUI viewer's Detail pane. The original `agent()` argument — NOT the
			 * schema-suffixed launch prompt — capped to keep feed lines bounded. Present
			 * on every path (cached included); the runtime stays clock-free.
			 */
			promptPreview?: string;
	  }
	| {
			/**
			 * A child session was launched (Task 8.1.1), emitted between `agent:start`
			 * and `agent:end` the instant `runner.launch` returns a sessionID. Carries
			 * the session↔label binding downstream consumers (engine choke,
			 * `workflow_status`, feed) need to attach per-agent stats and compute
			 * durations. The cached and pre-launch-throw paths never emit it (no
			 * session). The runtime stays clock-free — durations are an engine-side
			 * derivation, never carried here.
			 */
			type: "agent:launched";
			label: string;
			phase?: string;
			sessionID: string;
			/** Resolved model (`task.model ?? opts.model`), when one is known. */
			model?: string;
			/** Resolved subagent type (`opts.agentType ?? defaults.agent`). */
			agentType?: string;
	  }
	| {
			type: "agent:end";
			label: string;
			status: string;
			/**
			 * The child's sessionID (Task 8.1.1), present only when a session was
			 * launched. Absent on the cached and pre-launch-throw paths, which
			 * legitimately have no session to bind. Lets the engine pair this end with
			 * its `agent:launched` to finalize per-agent stats and duration.
			 */
			sessionID?: string;
			/**
			 * Optional short human diagnostic line (Task 7.2.1), present only when the
			 * call degraded to `null`/`""`. `workflow_status` renders it after the
			 * duration line — e.g. `null — schema_invalid: missing 'verdict'; raw 6.3k
			 * chars preserved`, or the empty-output warning.
			 */
			note?: string;
			/**
			 * A truncated preview of the RESULT the agent passed forward — its
			 * structured-output object (rendered as compact JSON) or its final text.
			 * Present only when the call SETTLED non-null (a degrade carries `note`
			 * instead); the viewer's Detail pane surfaces it as the step's "conclusion"
			 * once the agent settles, so a glance reads what the agent handed downstream
			 * rather than only its tool ring. Capped like {@link promptPreview} to keep
			 * feed lines bounded; the runtime stays clock-free.
			 */
			result?: string;
	  }
	| { type: "log"; message: string }
	| { type: "warn"; message: string };

/** Sink for {@link ProgressEvent}s; renders to `/workflows` and narrator lines. */
export type ProgressEmitter = (e: ProgressEvent) => void;

/**
 * The typed reason an `agent()` call degraded to `null`/`""` (Task 7.2.1). One
 * vocabulary, used in both the progress note and the persisted run record:
 * - `schema_no_call`: structured call completed but `structured_output` was never
 *   called (nothing stored, no validation failure recorded).
 * - `schema_invalid`: `structured_output` WAS called but every call was rejected
 *   (parse or schema validation), so nothing was stored.
 * - `status_error` / `status_cancelled`: the child reached a non-completed terminal
 *   status.
 * - `await_failed`: `launch()`/`awaitCompletion()` threw (degraded, not detonated).
 * - `empty_output`: the child completed and produced an empty (`""`) final text.
 * - `isolation_unsupported`: `isolation:'worktree'` was requested but NO worktree
 *   manager is threaded (the standalone library / no-shell engine has no worktree
 *   primitive), so the call degraded to `null` BEFORE launch rather than running
 *   unisolated (Epic 0.4) — no child session, no `agent:launched`.
 * - `worktree_mint_failed`: `isolation:'worktree'` was requested and a manager IS
 *   present, but `create()` returned `null` for a real reason (a non-repo checkout,
 *   a transient `git worktree add` failure, an index-lock loss, disk-full). Isolation
 *   IS supported here — the MINT failed — so this is reported distinctly from
 *   `isolation_unsupported` (which would falsely tell an operator the feature does not
 *   work). Same pre-launch degrade-to-null: no child session, no `agent:launched`.
 * - `empty_diff`: `contextDiff:true` was set but the engine-computed git diff for
 *   the unit under review was PROVABLY empty (a live work tree), so the review was
 *   refused BEFORE launch rather than reviewing narrative-only claims (Epic 4.1) —
 *   no child session, no `agent:launched`.
 * - `verify_failed`: `verifyDiff` was set and the engine's POST-settle git/command
 *   check FAILED (an empty git diff, or a non-zero check exit), so the settled
 *   result was downgraded to `null` (Epic 4.2). Unlike `empty_diff`, the agent DID
 *   launch and settle (it carries a childSessionID) — the downgrade nulls the RESULT
 *   so it re-runs on resume, but does NOT un-commit (P2 recovery still holds for
 *   bytes already on disk).
 * - `merge_conflict`: an `isolation:'worktree'` agent settled with real work, but the
 *   serialized merge-back of its scratch branch into the main tree CONFLICTED (Epic
 *   H.1.3, locked design decision #2). A conflict means two agents got overlapping
 *   scope — a decomposition error, surfaced LOUD and first-class rather than silently
 *   auto-resolved. The conflicted worktree+branch are PRESERVED (not cleaned) so a Tier
 *   2 resolver script can act on them; the batch is NOT detonated (degrade-don't-
 *   detonate). The agent launched and settled (it carries a childSessionID).
 * - `merge_failed`: an `isolation:'worktree'` agent settled with real work, but the
 *   serialized merge-back FAILED WITHOUT a conflict (git exited non-zero with zero
 *   unmerged files — e.g. the operator dirtied the main tree mid-run, or a transient
 *   failure). Unlike a clean merge, the work did NOT reach the main tree; unlike a
 *   conflict, there is nothing to 3-way resolve. The worktree+branch are PRESERVED (the
 *   edits live committed on the scratch branch, recoverable) and the agent degrades to
 *   `null` so a resumed run re-attempts rather than replaying a false `ok`. NEVER a
 *   silent cleanup — that would re-introduce the #5 lost-work catastrophe through the
 *   isolation path. The batch is NOT detonated.
 * - `skill_not_found`: `skills` named a skill the resolver does not know. The call
 *   THROWS a SkillNotFoundError to the script (fail-loud authoring contract — the
 *   one deliberate exception to degrade-don't-detonate), but the diagnostic is still
 *   emitted so the feed's ✗ carries a reason instead of an unexplained error end.
 *   Skills resolve BEFORE the worktree mint, so a typo never burns a mint.
 */
export type DiagnosticReason =
	| "schema_no_call"
	| "schema_invalid"
	| "status_error"
	| "status_cancelled"
	| "await_failed"
	| "empty_output"
	| "isolation_unsupported"
	| "worktree_mint_failed"
	| "empty_diff"
	| "verify_failed"
	| "merge_conflict"
	| "merge_failed"
	| "skill_not_found";

/**
 * A post-mortem diagnostic for a single failed/empty `agent()` call (Task 7.2.1).
 * Collected by the engine via the {@link DiagnosticEmitter} hook and persisted on
 * the run record so a finished run is debuggable WITHOUT SQLite — answering "why
 * was this null?" from the record alone. `agent()` itself still returns bare
 * `null`/`""` to the script: this is observational, never load-bearing.
 */
export interface AgentDiagnostic {
	/** Display label of the call (same as the progress label). */
	label: string;
	/** The deterministic call ordinal (matches the journal `index`). */
	index: number;
	reason: DiagnosticReason;
	/**
	 * The child's raw final text, captured for the schema reasons so a validation
	 * failure is inspectable. Capped at 20_000 chars with a `…[capped]` marker;
	 * absent when no capture applies or the capture itself failed (fenced).
	 */
	rawText?: string;
	/** The child's sessionID, when one was assigned (absent on a pre-launch throw). */
	childSessionID?: string;
}

/** Sink for {@link AgentDiagnostic}s; the engine collects them onto the run handle. */
export type DiagnosticEmitter = (d: AgentDiagnostic) => void;

/**
 * A {@link ProgressEvent} stamped with the wall-clock time it was observed (Task
 * 6.2.1). The runtime stays deliberately clock-free — it emits bare
 * {@link ProgressEvent}s — and the ENGINE stamps `at = clock.now()` at its
 * `onProgress` boundary before pushing onto the handle. This keeps fake clocks
 * authoritative in tests and confines the only timestamp source to the one layer
 * that already owns an injected {@link Clock}.
 */
export type StampedProgressEvent = ProgressEvent & { at: number };

/**
 * A SETTLED `agent()`/`workflow()` call (spec §7). Only SETTLED, NON-null results
 * are journaled: a failed/null agent must re-run on resume, never replay its
 * failure. `key` is the {@link computeCallKey} hash of `(prompt, opts)`; `index`
 * is the deterministic call ordinal (every invocation, cached or live).
 */
export interface SettledJournalEntry {
	index: number;
	key: string;
	status: "ok";
	result: unknown;
}

/**
 * A WRITE-AHEAD intent record (Phase 3): one line appended BEFORE a live launch
 * so a crash in the launch window leaves a durable "dispatched-but-not-settled"
 * marker. It shares `index` + `key` with its eventual {@link SettledJournalEntry}
 * completion (the same call ordinal) — that pairing is how a reconciler matches
 * them; there is deliberately no separate id. An intent carries NO `result` (it
 * has none by definition); `label` is optional forensic readability. There is no
 * `pending`/`running` status beyond `intent`: a settled call has its `ok` line,
 * an interrupted call has only its `intent` line — that is enough to detect it.
 */
export interface IntentJournalEntry {
	index: number;
	key: string;
	status: "intent";
	label?: string;
}

/**
 * One line in the run journal (spec §7), discriminated on `status`: a settled
 * {@link SettledJournalEntry} (`ok`, replayed on resume) or a write-ahead
 * {@link IntentJournalEntry} (`intent`, never replayed — filtered before the
 * replay cache is built). The journal serializes/deserializes whole objects, so
 * both members ride the same `record()`/`load()` path unchanged.
 *
 * Lives here (not in `../plugin/journal`) so the runtime layer stays free of any
 * plugin import — journal.ts imports this type from the runtime instead.
 */
export type JournalEntry = SettledJournalEntry | IntentJournalEntry;

/**
 * The OPAQUE per-agent worktree-manager seam (Epic H.1.6). The engine constructs the
 * concrete `createWorktreeManager({ shell, directory, logger })` (in the plugin layer)
 * ONCE and threads THIS structural surface down through {@link WorkflowRunDeps} →
 * `AgentPrimitiveDeps` so the future isolation mint-point (Epic H.1.2) can reach it.
 *
 * It is defined STRUCTURALLY here — NOT imported from the plugin — so the runtime stays
 * plugin-agnostic, exactly like the `resolveContextDiff`/`verifyResult` seams: the
 * runtime never learns what a worktree IS, it only forwards the handle. The engine's
 * concrete `WorktreeManager` satisfies this shape by structural typing.
 *
 * ABSENT (the standalone library, child runs, and a no-shell engine — the manager is a
 * documented no-op when `$` is absent) → isolation requests degrade-to-null as today
 * (Epic 0.4). UNUSED until Epic H.1.2 mints a per-agent worktree at the
 * `isolation:'worktree'` seam; this task threads the handle only (no behavior change).
 */
export interface WorktreeManagerSeam {
	create(key: { runId: string; label: string }): Promise<{
		dir: string;
		branch: string;
	} | null>;
	mergeBack(
		dir: string,
		branch: string,
	): Promise<
		| { merged: true; sha?: string; paths?: string[] }
		| {
				conflict: true;
				branch: string;
				files: string[];
				baseRef: string | undefined;
		  }
		| { failed: true }
	>;
	isUnchanged(dir: string): Promise<boolean>;
	cleanup(dir: string, branch: string): Promise<void>;
	sweep(): Promise<void>;
}

/**
 * The complete set of globals available to a workflow script body (spec §3.3).
 * `pipeline`/`parallel` keep permissive signatures here — their concrete typing
 * arrives with their implementation (Task 3.2.2).
 */
export interface RuntimeApi {
	agent: AgentFn;
	pipeline: (...args: unknown[]) => Promise<unknown[]>;
	parallel: (...args: unknown[]) => Promise<unknown[]>;
	phase: (title: string) => void;
	log: (message: string) => void;
	args: unknown;
	budget: BudgetView;
	/** Run another workflow inline as a sub-step (spec §8); see {@link WorkflowFn}. */
	workflow: WorkflowFn;
	/** Run a deterministic shell command (spec §3.3); see {@link ShellFn}. */
	shell: ShellFn;
}

/** The lifetime agent-count cap (1,000) was hit — a runaway-loop backstop (§5). */
export class AgentCapError extends Error {
	constructor(message = "workflow exceeded the 1000-agent lifetime cap") {
		super(message);
		this.name = "AgentCapError";
	}
}

/**
 * `isolation:'worktree'` was requested but there is no OpenCode worktree-session
 * primitive (Epic 0.4). The old behavior silently ran the agent UNISOLATED, giving
 * false safety; the new behavior fails the requesting agent loudly. The agent-call
 * primitive DEGRADES the call to `null` carrying this message (it does NOT throw —
 * a throw before `gate.acquire` would detonate the whole `parallel()` batch,
 * breaking the degrade-don't-detonate contract). The class exists so the message is
 * one canonical string and a caller that wants a hard stop can throw it instead.
 */
export class IsolationUnsupportedError extends Error {
	constructor(
		message = "isolation:'worktree' is not supported (no worktree session primitive); the agent fails rather than running unisolated",
	) {
		super(message);
		this.name = "IsolationUnsupportedError";
	}
}

/** The token budget is exhausted; further `agent()` calls are refused (§6). */
export class BudgetExhaustedError extends Error {
	constructor(message = "workflow token budget exhausted") {
		super(message);
		this.name = "BudgetExhaustedError";
	}
}

// ItemCapError's canonical home is compose.ts (it carries count/cap fields the
// composition functions populate); re-exported here so the error-class family
// stays importable from one module.
export { ItemCapError } from "./compose";

/** A primitive/option that is recognized but not yet implemented in this phase. */
export class NotYetSupportedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NotYetSupportedError";
	}
}

/**
 * `workflow()` was called inside a child workflow (spec §8: nesting is one level
 * deep). Thrown structurally — a child run is built with no `resolveSubWorkflow`,
 * so its `workflow()` global detonates rather than nesting a second level.
 */
export class NestingError extends Error {
	constructor(
		message = "sub-workflows are limited to one level — workflow() is unavailable inside a child workflow",
	) {
		super(message);
		this.name = "NestingError";
	}
}
