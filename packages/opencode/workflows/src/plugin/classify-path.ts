/**
 * Source-path classifier (Epic 2.4) — the engine's "is this a real artifact?"
 * probe.
 *
 * Issue 6: a plan written to `docs/plans/…md` was `.gitignore`d, so it was a local
 * ghost — `git status` never showed it, subagents in fresh checkouts could not see
 * it, yet the workflow treated it as the source of truth. This module classifies a
 * referenced path as tracked / untracked / ignored / missing so the engine can
 * surface the ghost as a {@link SourceDiagnostic} rather than silently trust it.
 *
 * Fencing: like {@link createGitCheckpointer}, EVERY git invocation runs through
 * `shell.cwd(dir).nothrow()` + `.quiet()` (the host shares fd 1/2 with the opencode
 * opentui renderer — an un-quieted command corrupts the TUI; the reason is
 * documented at `git-checkpoint.ts:215-228`) and is inspected by `.exitCode`. A
 * non-zero git never rejects into the run. With NO shell (or a non-git checkout)
 * the classifier never fabricates a git verdict: it returns `untracked`/`missing`
 * from the injected `exists` flag alone — emptiness/ignored-ness is UNPROVABLE
 * without git, parity with the checkpointer's `available:false` honesty.
 */

import type { BunShell } from "./git-checkpoint";

/**
 * The engine's verdict on one source/spec path the run references (Epic 2.4).
 * `rule` is the matching `.gitignore` line (`<file>:<line>:<pattern>`) when the
 * path is `ignored`; absent otherwise. Defined HERE as the single home for the
 * type — `engine.ts` imports it for {@link RunRecord.sourceDiagnostics}.
 * `directory` is an ENGINE-side verdict (the fs probe found a directory, not a
 * file — a spec must be a file); {@link classifyPath} itself never emits it.
 */
export interface SourceDiagnostic {
	path: string;
	classification: "tracked" | "untracked" | "ignored" | "missing" | "directory";
	rule?: string;
}

/** The text view of an awaited BunShellOutput's stdout (sync `.text()`). */
function readText(output: { text(): string }): string {
	try {
		return output.text();
	} catch {
		return "";
	}
}

/**
 * Parse the rule from `git check-ignore -v` output: `<file>:<line>:<pattern>\t<path>`.
 * Returns the pre-TAB metadata of the first non-empty line, or undefined. The path
 * after the TAB is not needed — the caller already knows it.
 */
export function parseCheckIgnoreRule(stdout: string): string | undefined {
	for (const raw of stdout.split("\n")) {
		if (raw.length === 0) {
			continue;
		}
		const tab = raw.indexOf("\t");
		const rule = (tab === -1 ? raw : raw.slice(0, tab)).trim();
		if (rule.length > 0) {
			return rule;
		}
	}
	return undefined;
}

/**
 * Classify a path as tracked / untracked / ignored / missing (Epic 2.4). `exists`
 * is the engine's on-disk verdict (an fs concern, injected so this stays git-only
 * and unit-testable with the same fake-shell harness as the checkpointer).
 *
 * Precedence: a TRACKED path wins (it is never "ignored" even if a pattern would
 * match — force-added). Else an IGNORED path (with its rule). Else the `exists`
 * flag decides untracked-vs-missing. With no shell / non-git checkout, only the
 * `exists` flag is consulted — never a fabricated `ignored`/`tracked`.
 */
export async function classifyPath(
	shell: BunShell | undefined,
	directory: string,
	path: string,
	exists: boolean,
): Promise<SourceDiagnostic> {
	if (shell === undefined) {
		return { path, classification: exists ? "untracked" : "missing" };
	}
	const git = () => shell.cwd(directory).nothrow();

	// Cannot consult git in a non-work-tree — do not claim ignored/tracked.
	const probe = await git()`git rev-parse --is-inside-work-tree`.quiet();
	if (probe.exitCode !== 0 || readText(probe).trim() !== "true") {
		return { path, classification: exists ? "untracked" : "missing" };
	}

	// Tracked wins (force-added files are tracked even if a pattern matches).
	const tracked = await git()`git ls-files --error-unmatch -- ${path}`.quiet();
	if (tracked.exitCode === 0) {
		return { path, classification: "tracked" };
	}

	// Not tracked: is it ignored? check-ignore exits 0 (+output) when ignored.
	const ignored = await git()`git check-ignore -v -- ${path}`.quiet();
	if (ignored.exitCode === 0) {
		const rule = parseCheckIgnoreRule(readText(ignored));
		return {
			path,
			classification: "ignored",
			...(rule !== undefined ? { rule } : {}),
		};
	}

	// Neither tracked nor ignored: the disk verdict decides.
	return { path, classification: exists ? "untracked" : "missing" };
}
