/**
 * The `shell(command, opts?)` global — run a deterministic shell command (spec §3.3).
 *
 * This is the CHEAP counterpart to `agent()`: the OS decides facts (did `make test`
 * pass?), so a gate should not cost a subagent's tokens and latency. The script then
 * hands a FAILED result's output to an `agent()` for judgment. The doc's central
 * operational complaint — "an agent should not be paid to discover if `go test`
 * passed" — is exactly what this closes.
 *
 * Layering (identical to `sub-workflow.ts`): this factory owns the journaled-primitive
 * semantics; the runtime cannot run a shell itself (it is plugin-agnostic and `Bun`/
 * `process` are BANNED in its sandbox), so the actual command runs through an OPAQUE
 * {@link RunShell} seam the engine wires to the repo-bound host shell. ABSENT seam
 * (the standalone library / a no-shell engine) → every call is INERT (`available:
 * false`), an honest unavailable result, never a fabricated pass.
 *
 * Resume (spec §7): a `shell()` call claims ONE callIndex slot and journals under a
 * `shell:`-prefixed key, exactly like the `workflow()` boundary. An AVAILABLE result
 * is journaled and replayed on resume (the frozen verdict — a `go test` that passed
 * once replays as passed, never re-runs); an UNAVAILABLE result is NEVER journaled
 * (it re-runs in a shell-capable engine). NEVER throws on a non-zero exit — that is a
 * `passed:false` value (degrade, don't detonate). The shared lifetime cap counts a
 * shell call as one unit (a `while(true) shell(...)` runaway backstop).
 */

import { computeShellKey } from "./keys";
import {
	AgentCapError,
	type JournalEntry,
	type ProgressEmitter,
	type SettledJournalEntry,
	type ShellFn,
	type ShellResult,
} from "./types";

/** Lifetime unit-count backstop per workflow (spec §5); mirrors agent-call.ts. */
const AGENT_LIFETIME_CAP = 1_000;

/**
 * Cap on captured stdout/stderr (each) — bounds the journal, which is replayed into
 * memory on resume. ~25k tokens of output is ample for an agent to investigate a
 * failure; an unbounded `make test` log would bloat every resumed run's working set.
 */
const OUTPUT_CAP = 100_000;
/** Marker appended when an output stream is truncated at {@link OUTPUT_CAP}. */
const OUTPUT_CAP_MARKER = "…[capped]";

/** Truncate a captured stream to {@link OUTPUT_CAP} with a marker. */
function capOutput(s: string): string {
	return s.length > OUTPUT_CAP ? s.slice(0, OUTPUT_CAP) + OUTPUT_CAP_MARKER : s;
}

/** Best-effort human-readable detail for a thrown value (mirrors agent-call.ts). */
function describeError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * The OPAQUE shell seam (mirrors `verifyResult`): the engine runs `command` via the
 * repo-bound host shell (`$.cwd(dir).nothrow()`…`.quiet()`) and returns the raw exit
 * code + captured streams. `cwd` is the script-supplied directory (the engine resolves
 * it against the project root). `available:false` (no shell threaded / a thrown spawn)
 * makes the primitive return an inert result. OPAQUE to the runtime — it never learns
 * what a shell is.
 */
export type RunShell = (
	command: string,
	opts: { cwd?: string },
) => Promise<{
	exitCode: number;
	stdout: string;
	stderr: string;
	available: boolean;
}>;

/** Everything the `shell()` primitive needs from the surrounding runtime. */
export interface ShellPrimitiveDeps {
	/** Run a command via the repo-bound host shell. ABSENT → every call is inert. */
	runShell?: RunShell;
	/** Lifetime unit counter shared with `agent()`/`workflow()` (a shell counts as one). */
	counters: { agents: number };
	/** Run-level deterministic call ordinal (shared — the journal ordering anchor). */
	callIndex: { value: number };
	/** Parent progress sink (already fenced upstream). */
	emit: ProgressEmitter;
	/**
	 * Deterministic-resume seam (spec §7). When present, a matching `shell:` key at
	 * this occurrence replays the journaled result; every AVAILABLE live result is
	 * recorded. Intent entries (Phase 3) are filtered out of the per-key cache — a
	 * shell call writes no intent, but the shared `entries` array can carry a crashed
	 * prior run's agent intents, so the same `status !== "ok"` guard holds here too.
	 */
	replay?: {
		entries: JournalEntry[];
		onRecord: (e: SettledJournalEntry) => void;
	};
}

/** Build an inert (no-shell / spawn-failure) result — honest, never a fake pass. */
function inertResult(command: string): ShellResult {
	return {
		command,
		passed: false,
		exitCode: -1,
		stdout: "",
		stderr: "",
		available: false,
	};
}

export function createShellPrimitive(deps: ShellPrimitiveDeps): ShellFn {
	const { runShell, counters, callIndex, emit, replay } = deps;

	// Per-key occurrence queues, identical to sub-workflow.ts / agent-call.ts. The
	// `shell:`-prefixed keys share the SAME byKey namespace as agent/workflow keys
	// (the prefix keeps them collision-free), so resume replay is uniform and
	// position-independent. Intent entries are filtered (settled-only queue).
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

	return async function shell(command, opts = {}): Promise<ShellResult> {
		// 0. Claim this call's deterministic ordinal — one slot, like agent()/workflow().
		const index = callIndex.value;
		callIndex.value += 1;

		const label = opts.label ?? command;
		const expectExitCode = opts.expectExitCode ?? 0;
		const key = computeShellKey(command, {
			...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
			expectExitCode,
		});

		// 1. Replay (spec §7): shift this call's key queue. A hit replays the frozen
		// result WITHOUT running the command — position-independent. The cap STILL
		// applies where the original hit it.
		const cached = byKey.get(key)?.shift();
		if (cached !== undefined) {
			if (counters.agents >= AGENT_LIFETIME_CAP) {
				throw new AgentCapError();
			}
			counters.agents += 1;
			emit({ type: "log", message: `shell ${label}: cached` });
			// Re-record into the NEW journal under the CURRENT index so a resumed run
			// is self-contained and densely ordered.
			replay?.onRecord({ index, key, status: "ok", result: cached.result });
			return cached.result as ShellResult;
		}

		// 2. Shared lifetime cap — count the call BEFORE running it.
		if (counters.agents >= AGENT_LIFETIME_CAP) {
			throw new AgentCapError();
		}
		counters.agents += 1;

		// 3. No shell capability threaded → inert + honest. NOT journaled, so a resume
		// in a shell-capable engine re-runs it rather than replaying "unavailable".
		if (runShell === undefined) {
			emit({
				type: "warn",
				message: `shell ${label}: no shell capability in this engine — returning available:false`,
			});
			return inertResult(command);
		}

		// 4. Run the command live via the opaque seam (fenced: a thrown seam degrades
		// to an inert result, never a thrown shell() — degrade, don't detonate).
		emit({ type: "log", message: `shell ${label}: running` });
		let raw: Awaited<ReturnType<RunShell>>;
		try {
			raw = await runShell(command, {
				...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
			});
		} catch (err) {
			emit({
				type: "warn",
				message: `shell ${label} failed: ${describeError(err)}`,
			});
			return inertResult(command);
		}

		// 5. An unavailable seam result is inert + un-journaled (re-runs on resume).
		if (!raw.available) {
			return inertResult(command);
		}

		const result: ShellResult = {
			command,
			passed: raw.exitCode === expectExitCode,
			exitCode: raw.exitCode,
			stdout: capOutput(raw.stdout),
			stderr: capOutput(raw.stderr),
			available: true,
		};
		emit({
			type: "log",
			message: `shell ${label}: exit ${result.exitCode} (${result.passed ? "passed" : "failed"})`,
		});
		// Spec §7: an available result is journaled (replayed on resume). The capped
		// streams are exactly what the script saw, so the replay is faithful.
		replay?.onRecord({ index, key, status: "ok", result });
		return result;
	};
}
