/**
 * Engine-owned git checkpointer (Epic 2.1) — the privileged VCS actor.
 *
 * #5's catastrophe was a worker clobbering uncommitted work while chasing a green
 * gate. The deny hook (Epic 0.3) blocks a WORKER's destructive git; this module is
 * the other half — the ENGINE commits a checkpoint after each live agent so a
 * later overwrite is RECOVERABLE from the prior commit. The engine is NOT a worker
 * session, so the deny hook never fires on these commits (the intended asymmetry).
 *
 * Granularity (the epic's redefinition): per-agent-call on ONE shared working tree,
 * commit-and-continue — HEAD advances, the tree is NEVER reset. A later dependent
 * agent therefore sees prior agents' edits because they live committed on the same
 * tree. Under `parallel()` with UNISOLATED agents the attribution is HONESTLY
 * APPROXIMATE: the first-settling agent's checkpoint commits EVERYTHING dirty-and-
 * not-baseline at that moment — including a still-running sibling's half-written
 * files — under the first agent's label (the engine marks such checkpoints
 * `shared`). Per-agent attribution under parallel mutation requires isolation
 * (H.1 worktrees); on the shared tree, P2's contract is recoverability, not
 * attribution. Two agents racing the SAME path is likewise an intra-unit collision
 * commits cannot PREVENT — H.1 owns prevention; P2 makes the loser's overwrite
 * recoverable, which is the honest contract.
 *
 * Operator safety (refuse-don't-stomp): the checkpointer NEVER `git add -A`. At run
 * start it snapshots the paths ALREADY dirty (the operator's in-flight edits) and
 * refuses to commit any of them — committing ONLY explicit pathspecs the workflow
 * touched since the baseline. A collision (an agent edits a path the operator had
 * left dirty) is refused and surfaced, never swept into an engine commit.
 *
 * Fencing: EVERY git invocation runs through `shell.cwd(dir).nothrow()`, appends
 * `.quiet()` to the ShellPromise (the plugin host shares fd 1/2 with the opencode
 * opentui renderer — an un-quieted command's stdout/stderr would punch raw bytes
 * through the TUI alt-buffer and corrupt the screen), and is inspected by
 * `exitCode` — a non-zero git never rejects into the run. A non-repo
 * (bare/detached/zero-commit-safe) is detected ONCE by `ready()`, which latches the
 * checkpointer dead with a single warn; every later call is a silent no-op. When no
 * `shell` is injected the whole subsystem is a documented no-op. This mirrors the
 * feed writer's dead-state latch. The module imports nothing from engine.ts — the
 * dependency is one-way (engine constructs this), matching git-deny.ts precedent.
 *
 * BunShell is a TAGGED-TEMPLATE callable (`$\`git status\``), NOT an argv API:
 * subcommands and pathspecs are string-INTERPOLATED into the template. `git`'s
 * global `-c` options (identity fallback) must precede the subcommand. The resolved
 * `BunShellOutput` carries `.exitCode` and a SYNCHRONOUS `.text()` — this module
 * reads `.text()` synchronously off the awaited output.
 */

import type { PluginInput } from "@opencode-ai/plugin";

/** The host shell primitive — `PluginInput['$']`; NOT a named package export. */
export type BunShell = PluginInput["$"];

/** Structured logger surface — a subset of the engine's {@link EngineLogger}. */
export interface CheckpointLogger {
	debug(msg: string, meta?: Record<string, unknown>): void;
	info(msg: string, meta?: Record<string, unknown>): void;
	warn(msg: string, meta?: Record<string, unknown>): void;
	error(msg: string, meta?: Record<string, unknown>): void;
}

/** Forensic identity of one checkpoint, encoded into its commit message. */
export interface CheckpointMeta {
	/** The top-level runId that owns this checkpoint. */
	runId: string;
	/** The agent's display label. */
	label: string;
	/** The live child sessionID (always present — checkpoints fire on LIVE ends). */
	sessionID: string;
	/** The active progress phase, when one was known. */
	phase?: string;
}

/**
 * The engine-computed working-tree delta since the run-start baseline (Task
 * 4.1.1). `available` is the load-bearing signal a caller (contextDiff review
 * refusal, verifyDiff) gates on: it is `true` ONLY when the checkpointer is alive
 * (a real git work tree). A no-shell or non-git checkout returns
 * `{text:'',isEmpty:true,available:false}` — emptiness cannot be PROVEN without
 * git, so a refusal must never trigger on `available:false`.
 */
export interface DiffResult {
	/** The raw `git diff` text (on-disk delta vs baseline); '' when dead or fenced. */
	text: string;
	/** Trimmed `text` is empty. Always true when `available:false`. */
	isEmpty: boolean;
	/** The checkpointer is alive (a real work tree); false on no-shell / non-git. */
	available: boolean;
}

/** The outcome of one {@link Checkpointer.checkpoint} call. */
export interface CheckpointResult {
	/** Whether a commit was actually created (false on empty-diff or dead latch). */
	committed: boolean;
	/** The new commit sha, when a commit was created. */
	sha?: string;
	/** The pathspecs committed (the workflow-touched set, baseline-excluded). */
	paths?: string[];
	/** Paths refused because they were operator-dirty at baseline (never stomped). */
	refused?: string[];
	/**
	 * Mode-aware change enumeration (Epic 2.3): committed paths whose file mode
	 * changed in this commit between two NON-ZERO modes (a real chmod, e.g. a
	 * `chmod +x` that flips `100644 → 100755`), keyed by path with the transition
	 * string `"<oldmode>→<newmode>"`. Creations (`000000→…`) and deletions
	 * (`…→000000`) are NOT mode flips and are excluded — only an executable-bit /
	 * symlink-style transition between two live modes lands here. Absent when no
	 * committed path changed mode (the common case).
	 */
	modeFlips?: Record<string, string>;
}

export interface Checkpointer {
	/** Probe the work-tree ONCE; false latches the checkpointer dead (one warn). */
	ready(): Promise<boolean>;
	/** Snapshot the operator's pre-existing dirty paths + baseline HEAD. Once, at run start. */
	baseline(): Promise<void>;
	/** Commit only workflow-touched paths; refuse operator-dirty ones. */
	checkpoint(meta: CheckpointMeta): Promise<CheckpointResult>;
	/** The current `git status --porcelain` path set (fenced; [] when dead). */
	dirtyPaths(): Promise<string[]>;
	/**
	 * The RAW on-disk delta since the run-start baseline (Task 4.1.1): `git diff
	 * <baselineRef>` (single ref → baseline-tree vs WORKING tree, so committed
	 * per-unit edits AND uncommitted worktree dirt both surface). Dead/no-shell →
	 * `available:false`; alive → `available:true` with the diff text. See
	 * {@link DiffResult}.
	 */
	diff(): Promise<DiffResult>;
	/** The run-start HEAD captured by {@link Checkpointer.baseline}; null in a zero-commit repo or before baseline. */
	baselineRef(): string | null;
	/**
	 * SUCCESS terminal (Epic 4.1): the run completed, so its checkpoint commits stay
	 * on the working branch. Promotion only removes the now-redundant per-run marker
	 * ref ({@link checkpointRefFor}); it NEVER touches the branch. No-op when the run
	 * committed nothing or the checkpointer is dead. Fenced — never rejects.
	 */
	promote(): Promise<void>;
	/**
	 * FAILURE / ABORT / CANCEL terminal (Epic 4.1): the run did not complete, so its
	 * checkpoint commits must not pollute the working branch's permanent history.
	 * Rewinds the branch pointer to {@link Checkpointer.baselineRef} ONLY when the
	 * branch tip still equals the run's marker tip (nothing was layered on top) and a
	 * baseline exists — a NON-destructive `update-ref` that moves the pointer only,
	 * never the index/working tree (the abandoned edits survive on disk as
	 * uncommitted changes). When the tips diverge (operator/other-run layered work) or
	 * no baseline exists, it SKIPS the rewind and warns with the residue SHAs. Always
	 * deletes the marker afterward. No-op when the run committed nothing or the
	 * checkpointer is dead. Fenced — never rejects.
	 */
	discard(): Promise<void>;
	/**
	 * Startup sweep (mirrors the worktree manager's `sweep()`): delete EVERY stale
	 * `refs/wf-checkpoints/*` marker. A run that crashed between checkpoint and
	 * terminal leaves its marker behind, GC-pinning its checkpoint commits forever —
	 * promote()/discard() never ran. Called once at engine ready, BEFORE any run
	 * starts, so every marker found is by construction stale (same single-engine
	 * assumption the worktree sweep already makes). Fenced — never rejects; no-op on
	 * a dead/no-shell checkpointer.
	 */
	sweepMarkers(): Promise<void>;
}

export interface CreateGitCheckpointerOptions {
	/** The host BunShell; `undefined` makes the whole checkpointer a no-op. */
	shell: BunShell | undefined;
	/** Repo root; bound once via `shell.cwd(directory)`. */
	directory: string;
	logger?: CheckpointLogger;
	/** Injectable clock for the identity fallback's deterministic author; unused otherwise. */
	clock?: { now: () => number };
	/**
	 * The repo's already-probed liveness, when the work-tree was checked ONCE
	 * upstream. A PER-RUN checkpointer (each run owns its baseline) must NOT re-probe
	 * and re-warn — the engine probes once with a shared instance and threads the
	 * verdict here: `true` → presume alive, `ready()` is a no-git no-op returning
	 * true; `false` → latch dead silently (the shared probe already warned).
	 * `undefined` (no shell anyway, or a stand-alone instance) keeps the self-probing
	 * `ready()` behavior. Ignored when no `shell` is injected (already dead).
	 */
	presumedAlive?: boolean;
}

/** Engine identity used when the repo has no configured user (so commits still land). */
const ENGINE_USER_NAME = "opencode-drawers";
const ENGINE_USER_EMAIL = "workflows@opencode-drawers.local";

/**
 * Parse `git status --porcelain` (renames OFF) into a flat list of paths. With
 * `-c diff.renames=false` upstream, every entry is a SINGLE path (a rename is a
 * delete + an add), so there is never an `R old -> new` two-path record to split —
 * which keeps path-string set subtraction and `git add -- <path>` semantics honest.
 * Each porcelain line is `XY <path>`; the leading two status columns + a space are
 * stripped, and a quoted path (spaces/unicode → git wraps in `"..."`) is unquoted.
 */
export function parsePorcelain(stdout: string): string[] {
	const out: string[] = [];
	for (const raw of stdout.split("\n")) {
		// A porcelain line is at least `XY <path>` (3 cols + a space); the status
		// columns are positional, so slice past them rather than trimming first.
		if (raw.length < 4) {
			continue;
		}
		const path = unquotePath(raw.slice(3).trim());
		if (path.length > 0) {
			out.push(path);
		}
	}
	return out;
}

/**
 * Whether a path must be passed to git via `--pathspec-from-file=-` (stdin)
 * instead of argv interpolation. Bun's shell LEXER corrupts non-ASCII template
 * interpolations (observed on Bun 1.3.10: `café.txt` reaches git as
 * `cafcafé.txt`, even through `{raw}`), so a non-ASCII pathspec on argv fails
 * and the path silently vanishes from the checkpoint (#7). stdin bytes are not
 * lexed → exact.
 */
function needsStdinPathspec(path: string): boolean {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: the ASCII range test is the point.
	return /[^\x00-\x7F]/.test(path);
}

/** Strip git's C-style quoting from a porcelain path (only quoted when special). */
function unquotePath(path: string): string {
	if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) {
		return path.slice(1, -1);
	}
	return path;
}

/**
 * Parse `git diff-tree --no-commit-id --no-renames -r <sha>` raw output into a
 * path → `"<oldmode>→<newmode>"` map of MODE FLIPS only (Epic 2.3). Each raw line
 * is `:<oldmode> <newmode> <oldsha> <newsha> <status>\t<path>`: a leading colon,
 * space-separated metadata, a TAB, then the path. An entry is recorded ONLY when
 * the two modes differ AND BOTH are non-zero — a creation (`000000→…`) or a
 * deletion (`…→000000`) is not a chmod and is excluded. A content-only change
 * (equal modes) yields no entry. The blob-sha columns are read past but not used:
 * v1 surfaces the transition string, not the mode-only-vs-mode+content distinction.
 */
export function parseModeFlips(stdout: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const raw of stdout.split("\n")) {
		if (!raw.startsWith(":")) {
			continue;
		}
		const tab = raw.indexOf("\t");
		if (tab === -1) {
			continue;
		}
		// Metadata is the pre-TAB segment, minus the leading colon.
		const meta = raw.slice(1, tab).trim().split(/\s+/);
		const oldmode = meta[0];
		const newmode = meta[1];
		if (oldmode === undefined || newmode === undefined) {
			continue;
		}
		// Only a transition between two LIVE (non-zero) modes is a chmod.
		if (oldmode === newmode || oldmode === "000000" || newmode === "000000") {
			continue;
		}
		const path = unquotePath(raw.slice(tab + 1).trim());
		if (path.length > 0) {
			out[path] = `${oldmode}→${newmode}`;
		}
	}
	return out;
}

/**
 * The ref namespace for per-run checkpoint markers (Epic 4.1). Each run advances
 * `refs/wf-checkpoints/<runId>` to its latest checkpoint commit; on a SUCCESS
 * terminal the marker is deleted (commits stay), on a FAILURE/ABORT/CANCEL terminal
 * the branch is rewound to baseline and the marker deleted (orphaned commits → GC'd).
 */
const WF_CHECKPOINT_REF_PREFIX = "refs/wf-checkpoints/";

/** The per-run checkpoint marker ref for a runId (engine-generated `wf_…`, ref-name-safe). */
export function checkpointRefFor(runId: string): string {
	return `${WF_CHECKPOINT_REF_PREFIX}${runId}`;
}

/** The forensic commit message: traceable to the run/agent that made it. */
export function commitMessageFor(meta: CheckpointMeta): string {
	const phase = meta.phase !== undefined ? ` phase=${meta.phase}` : "";
	return `workflow checkpoint: run=${meta.runId} agent=${meta.label} session=${meta.sessionID}${phase}`;
}

/** The text view of an awaited BunShellOutput's stdout (sync `.text()`). */
function readText(output: { text(): string }): string {
	try {
		return output.text();
	} catch {
		return "";
	}
}

export function createGitCheckpointer(
	opts: CreateGitCheckpointerOptions,
): Checkpointer {
	const { shell, directory, logger, presumedAlive } = opts;

	// Dead latch (mirrors the feed writer): set the instant the subsystem cannot or
	// must not run, after which every method is a silent no-op. No shell at all is
	// the documented no-op; a non-repo flips it dead in ready() with ONE warn.
	//
	// When the caller already probed the work-tree ONCE upstream (a per-run instance,
	// see {@link CreateGitCheckpointerOptions.presumedAlive}), adopt that verdict here
	// so this instance neither re-probes nor re-warns: `false` → latch dead silently;
	// `true` → presume alive and skip the probe. A missing shell is dead regardless.
	let dead = shell === undefined || presumedAlive === false;
	let probed = shell !== undefined && presumedAlive !== undefined;
	let alive = shell !== undefined && presumedAlive === true;

	// Operator-safety baseline (Task 2.1.3): the paths ALREADY dirty before the run,
	// captured read-only (NEVER via `git stash` — stash MUTATES the working tree,
	// resetting tracked files to HEAD and corrupting a concurrent in-flight agent's
	// edits; the worktree-sharing concern is secondary). Each checkpoint excludes
	// these. baselineHead is the run-start HEAD (null in a zero-commit repo),
	// captured for forensic parity and read back by {@link Checkpointer.baselineRef}.
	let preexistingDirty = new Set<string>();
	let baselineHead: string | null = null;

	// The runId of THIS run, captured lazily on the FIRST sha-bearing checkpoint
	// commit (Epic 4.1). `baseline()` takes no meta, so the runId is not known until
	// `checkpoint(meta)` runs; promote()/discard() run only AFTER a terminal, by which
	// point either a checkpoint committed (set) or none did (undefined → no-op).
	let ownRunId: string | undefined;

	/**
	 * The repo-bound, fenced shell. Only reachable when `shell` is defined.
	 *
	 * Returns the configured namespace; EVERY call site appends `.quiet()` to the
	 * resulting ShellPromise — `.quiet()` lives on the promise, NOT the namespace, so it
	 * cannot be baked into this factory. Quieting is load-bearing, not cosmetic: the
	 * plugin host runs in the same OS process as the opencode opentui renderer and shares
	 * fd 1/2. The default BunShell ECHOES each command's stdout/stderr to those
	 * descriptors (only the lazy `ShellPromise.text()` auto-quiets — but this module
	 * awaits first, then reads `.text()` off the resolved buffer, which does NOT). Without
	 * `.quiet()`, git's commit summary ("[branch sha] workflow checkpoint: …") punches raw
	 * bytes through the TUI alt-buffer and corrupts the screen. `.quiet()` still buffers,
	 * so the `.exitCode`/`readText()` reads downstream are unchanged — it only suppresses
	 * the echo. The {@link createGitCheckpointer} output-suppression test guards this.
	 */
	const git = () => (shell as BunShell).cwd(directory).nothrow();

	async function ready(): Promise<boolean> {
		if (shell === undefined) {
			return false;
		}
		if (probed) {
			return alive;
		}
		probed = true;
		const res = await git()`git rev-parse --is-inside-work-tree`.quiet();
		if (res.exitCode !== 0 || readText(res).trim() !== "true") {
			dead = true;
			alive = false;
			logger?.warn(
				"git checkpoint disabled: not a git work tree — workflow runs will " +
					"not be checkpointed (per-agent commit recovery is off for this run)",
				{ directory },
			);
			return false;
		}
		alive = true;
		return true;
	}

	async function dirtyPaths(): Promise<string[]> {
		if (dead) {
			return [];
		}
		// `-c core.quotePath=false`: with quoting ON, git C-quotes a non-ASCII path
		// (`"caf\303\251.txt"`) and the unquoter strips only the wrapping quotes, not
		// the octal escapes — the later `git add -- <mangled>` pathspec then fails and
		// the path is silently dropped from the checkpoint (unrecoverable work).
		const res =
			await git()`git -c core.quotePath=false -c diff.renames=false status --porcelain`.quiet();
		if (res.exitCode !== 0) {
			return [];
		}
		return parsePorcelain(readText(res));
	}

	async function baseline(): Promise<void> {
		if (dead) {
			return;
		}
		// Read-only snapshot of the operator's pre-existing dirty paths.
		preexistingDirty = new Set(await dirtyPaths());
		// Baseline HEAD (forensics). A zero-commit repo has no HEAD → exitCode != 0
		// and we record null without throwing (fenced).
		const head = await git()`git rev-parse HEAD`.quiet();
		baselineHead = head.exitCode === 0 ? readText(head).trim() || null : null;
	}

	async function diff(): Promise<DiffResult> {
		// Dead/no-shell: emptiness is UNPROVABLE without git, so `available:false`
		// (a documented no-op, parity with checkpoint()). A caller's empty-diff
		// refusal MUST gate on `available` so it never fires on a non-git checkout.
		if (dead) {
			return { text: "", isEmpty: true, available: false };
		}
		// Diff against the run-start baseline (the cumulative since-run-start delta a
		// reviewer of "the unit" wants — per-unit commits are descendants of baseline).
		// Single ref → baseline-tree vs the current WORKING tree (NOT `base HEAD`,
		// which would drop the reviewer-relevant uncommitted tail, NOR `--cached`,
		// which would miss worktree-dirty paths). A zero-commit repo (baselineRef null)
		// has no base → `git diff` of the working tree (untracked files omitted by git,
		// documented). Fenced: a non-zero exit → empty text, never a rejection.
		const base = baselineHead;
		const res =
			base !== null
				? await git()`git diff ${base}`.quiet()
				: await git()`git diff`.quiet();
		const text = res.exitCode === 0 ? readText(res) : "";
		// EMPTINESS must not be blind to UNTRACKED files: `git diff` never lists them,
		// so an agent whose only output is a NEW module would read as "empty" and a
		// verifyDiff post-condition would falsely fail it (and an empty-diff review
		// refusal would falsely fire). Probe porcelain alongside the diff and subtract
		// the operator's baseline-dirty set (a pre-existing untracked file is not run
		// work). The TEXT stays the raw `git diff` — contextDiff consumers keep their
		// exact diff; only the emptiness VERDICT widens.
		const newDirty = (await dirtyPaths()).filter(
			(p) => !preexistingDirty.has(p),
		);
		return {
			text,
			isEmpty: text.trim().length === 0 && newDirty.length === 0,
			available: true,
		};
	}

	async function checkpoint(meta: CheckpointMeta): Promise<CheckpointResult> {
		if (dead) {
			return { committed: false };
		}
		// (1) Current dirty set (renames off → single-path entries).
		const currentDirty = await dirtyPaths();

		// (2)+(3) Split the workflow-touched paths from the operator's pre-existing
		// edits. A path dirty at baseline is REFUSED, never committed (refuse-don't-
		// stomp): committing it would sweep the operator's in-flight work into an
		// engine commit (#5's catastrophe, now by the engine itself).
		const toCommit: string[] = [];
		const refused: string[] = [];
		for (const path of currentDirty) {
			if (preexistingDirty.has(path)) {
				refused.push(path);
			} else {
				toCommit.push(path);
			}
		}
		if (refused.length > 0) {
			logger?.warn(
				"git checkpoint refused to commit operator-dirty paths (they were " +
					"already modified before the run started; the engine never stomps " +
					"pre-existing uncommitted work)",
				{ runId: meta.runId, label: meta.label, refused },
			);
		}

		// (4) Nothing the workflow touched (or it reverted its own edits) → no empty
		// commit. Refusals are still reported so the caller can surface the warn.
		if (toCommit.length === 0) {
			return refused.length > 0
				? { committed: false, refused }
				: { committed: false };
		}

		// (5) Stage ONLY explicit pathspecs — NEVER `git add -A`. Each path is its own
		// fenced add so one bad pathspec cannot abort the rest; a failed add drops that
		// path from the commit set rather than throwing. A NON-ASCII path is routed via
		// `--pathspec-from-file=-` on stdin: Bun's shell lexer corrupts non-ASCII argv
		// interpolations (`café.txt` reaches git as `cafcafé.txt`), so the argv add
		// would fail and the path would silently vanish from the checkpoint (#7).
		const staged: string[] = [];
		for (const path of toCommit) {
			const stdinPath = needsStdinPathspec(path);
			const add = stdinPath
				? await git()`git add --pathspec-from-file=- < ${Buffer.from(`${path}\n`, "utf-8")}`.quiet()
				: await git()`git add -- ${path}`.quiet();
			if (add.exitCode === 0) {
				staged.push(path);
				continue;
			}
			// A failed `git add` is NOT proof the path is uncommittable: an
			// ALREADY-STAGED deletion (the file is gone from disk — what `git rm`/`git
			// mv` both produce, porcelain column-1 `D`) makes `git add -- <path>` fail
			// with `fatal: pathspec did not match any files`, yet the deletion is already
			// in the index and the scoped `git commit -- <staged>` commits it. Probe the
			// index before dropping the path: if the cached set lists it, keep it. The
			// non-ASCII probe lists the WHOLE cached set and checks membership in JS
			// (argv-free, lexer-safe); the ASCII probe stays pathspec-scoped.
			const cached = stdinPath
				? await git()`git -c core.quotePath=false diff --cached --name-only`.quiet()
				: await git()`git diff --cached --name-only -- ${path}`.quiet();
			const cachedHit = stdinPath
				? readText(cached)
						.split("\n")
						.some((l) => l.trim() === path)
				: cached.exitCode === 0 && readText(cached).trim().length > 0;
			if (cached.exitCode === 0 && cachedHit) {
				staged.push(path);
			} else {
				logger?.warn("git checkpoint add failed; skipping path", {
					runId: meta.runId,
					path,
					stderr: readText({ text: () => add.stderr.toString() }),
				});
			}
		}
		if (staged.length === 0) {
			return refused.length > 0
				? { committed: false, refused }
				: { committed: false };
		}

		// Commit with --no-verify (skip operator hooks) and an identity fallback via
		// git GLOBAL `-c` options (which MUST precede the subcommand) so a repo with no
		// configured user.name/user.email still commits. The commit is SCOPED to the
		// exact staged pathspecs (`-- <paths>`): git then commits ONLY those paths
		// regardless of what else sits in the index. Without the pathspec the commit is
		// index-wide and would sweep ANY pre-staged operator content (a file the
		// operator `git add`ed before launching) into an engine commit — the
		// refuse-don't-stomp guarantee (header lines 19-23) must hold for staged content
		// too, not just worktree-dirty paths. BunShell escapes the interpolated array
		// element-wise, so each pathspec is a single safely-quoted argument.
		const message = commitMessageFor(meta);
		const commit = staged.some(needsStdinPathspec)
			? await git()`git -c user.name=${ENGINE_USER_NAME} -c user.email=${ENGINE_USER_EMAIL} commit --no-verify -m ${message} --pathspec-from-file=- < ${Buffer.from(`${staged.join("\n")}\n`, "utf-8")}`.quiet()
			: await git()`git -c user.name=${ENGINE_USER_NAME} -c user.email=${ENGINE_USER_EMAIL} commit --no-verify -m ${message} -- ${staged}`.quiet();
		if (commit.exitCode !== 0) {
			logger?.warn("git checkpoint commit failed", {
				runId: meta.runId,
				label: meta.label,
				stderr: readText({ text: () => commit.stderr.toString() }),
			});
			return refused.length > 0
				? { committed: false, refused }
				: { committed: false };
		}

		// (6) Read back the new commit sha.
		const rev = await git()`git rev-parse HEAD`.quiet();
		const sha = rev.exitCode === 0 ? readText(rev).trim() : undefined;

		// (6b) Advance the per-run checkpoint marker to the new HEAD (Epic 4.1). The
		// marker is forensic + the rewind anchor for promote()/discard(); its failure
		// must NOT fail a checkpoint that already committed, so it is fenced and logged
		// at debug. Skipped when the sha read-back failed (no sha to point the ref at).
		if (sha !== undefined) {
			ownRunId = meta.runId;
			const upd =
				await git()`git update-ref ${checkpointRefFor(meta.runId)} ${sha}`.quiet();
			if (upd.exitCode !== 0) {
				logger?.debug("git checkpoint marker update failed", {
					runId: meta.runId,
					sha,
					stderr: readText({ text: () => upd.stderr.toString() }),
				});
			}
		}

		// (7) Mode-aware enumeration (Epic 2.3): read the just-created commit's raw
		// diff against its parent to surface chmod transitions (e.g. `100644→100755`)
		// the bare `M path` porcelain status hides. Fenced + quieted (host-fd safety,
		// header lines 25-34); a non-zero exit → empty stdout → empty map → omitted.
		// Skipped when the sha read-back failed (no commit to inspect).
		let modeFlips: Record<string, string> = {};
		if (sha !== undefined) {
			const dt =
				await git()`git diff-tree --no-commit-id --no-renames -r ${sha}`.quiet();
			if (dt.exitCode === 0) {
				modeFlips = parseModeFlips(readText(dt));
			}
		}

		return {
			committed: true,
			...(sha !== undefined ? { sha } : {}),
			paths: staged,
			...(refused.length > 0 ? { refused } : {}),
			...(Object.keys(modeFlips).length > 0 ? { modeFlips } : {}),
		};
	}

	async function promote(): Promise<void> {
		// Success terminal: commits are already on the branch; only drop the now-
		// redundant marker. No-op on a dead checkpointer or a run with no commits.
		if (dead || ownRunId === undefined) {
			return;
		}
		const del =
			await git()`git update-ref -d ${checkpointRefFor(ownRunId)}`.quiet();
		if (del.exitCode !== 0) {
			logger?.debug("git checkpoint marker delete (promote) failed", {
				runId: ownRunId,
				stderr: readText({ text: () => del.stderr.toString() }),
			});
		}
	}

	async function discard(): Promise<void> {
		// Failure/abort/cancel terminal. No-op on a dead checkpointer or a run with no
		// commits (nothing to rewind, no marker to delete).
		if (dead || ownRunId === undefined) {
			return;
		}
		const ref = checkpointRefFor(ownRunId);
		// (a) Current branch tip and (b) the run's marker tip (forensic warn context).
		const branch = await git()`git rev-parse HEAD`.quiet();
		const branchTip = branch.exitCode === 0 ? readText(branch).trim() : "";
		const marker = await git()`git rev-parse ${ref}`.quiet();
		const markerTip = marker.exitCode === 0 ? readText(marker).trim() : "";
		// (c) FOREIGN-COMMIT GUARD: rewind ONLY when a baseline exists AND every
		// commit in `baseline..HEAD` carries THIS run's forensic `run=<runId>` marker
		// in its subject (checkpoint commits, worktree scratch commits, and merge-back
		// commits all stamp it). A bare tip-equality check is NOT enough: two
		// CONCURRENT runs interleave checkpoint commits on one branch, so run A's
		// rewind-to-baseline would orphan run B's commits even when A's marker happens
		// to sit at the tip. ANY foreign commit in the range (an operator's, a sibling
		// run's) → SKIP the rewind (keep the marker cleanup) and warn. A NON-destructive
		// `update-ref HEAD <baseline>`: it follows the checked-out branch symref and
		// moves ONLY the pointer, never the index/working tree, so the abandoned run's
		// edits survive on disk as uncommitted changes.
		const base = baselineHead;
		let ownsRange = base !== null;
		if (base !== null && ownsRange) {
			const log = await git()`git log --format=%s ${base}..HEAD`.quiet();
			if (log.exitCode !== 0) {
				ownsRange = false;
			} else {
				const runMarker = `run=${ownRunId}`;
				for (const raw of readText(log).split("\n")) {
					const subject = raw.trim();
					if (subject.length > 0 && !subject.includes(runMarker)) {
						ownsRange = false;
						break;
					}
				}
			}
		}
		if (base !== null && ownsRange) {
			const rewind = await git()`git update-ref HEAD ${base}`.quiet();
			if (rewind.exitCode !== 0) {
				logger?.debug("git checkpoint discard rewind failed", {
					runId: ownRunId,
					stderr: readText({ text: () => rewind.stderr.toString() }),
				});
			}
		} else {
			// A foreign commit in the range (operator / concurrent run), an unreadable
			// log, or no baseline: surface the residue SHA(s) the operator can
			// inspect/clean before GC (ISSUES.md Issue 1 fallback).
			logger?.warn(
				"git checkpoint discard skipped the branch rewind: the baseline..tip " +
					"range contains commits that do not belong to this run (an operator's " +
					"or a concurrent run's), or there is no run-start baseline — this " +
					"run's checkpoint commits are left in place; inspect/clean them manually",
				{ runId: ownRunId, markerTip, branchTip, baselineRef: baselineHead },
			);
		}
		// (d) Always delete the marker (the orphaned commits, if rewound, become
		// unreachable → GC'd).
		const del = await git()`git update-ref -d ${ref}`.quiet();
		if (del.exitCode !== 0) {
			logger?.debug("git checkpoint marker delete (discard) failed", {
				runId: ownRunId,
				stderr: readText({ text: () => del.stderr.toString() }),
			});
		}
	}

	async function sweepMarkers(): Promise<void> {
		// Liveness via ready() (idempotent probe; presumedAlive instances adopt the
		// upstream verdict). Dead/no-shell → silent no-op.
		if (!(await ready())) {
			return;
		}
		const refs =
			await git()`git for-each-ref --format=%(refname) ${WF_CHECKPOINT_REF_PREFIX}`.quiet();
		if (refs.exitCode !== 0) {
			return;
		}
		for (const raw of readText(refs).split("\n")) {
			const ref = raw.trim();
			if (ref.length === 0 || !ref.startsWith(WF_CHECKPOINT_REF_PREFIX)) {
				continue;
			}
			const del = await git()`git update-ref -d ${ref}`.quiet();
			if (del.exitCode !== 0) {
				logger?.debug("stale checkpoint marker delete failed", {
					ref,
					stderr: readText({ text: () => del.stderr.toString() }),
				});
			}
		}
	}

	return {
		ready,
		baseline,
		checkpoint,
		dirtyPaths,
		diff,
		baselineRef: () => baselineHead,
		promote,
		discard,
		sweepMarkers,
	};
}
