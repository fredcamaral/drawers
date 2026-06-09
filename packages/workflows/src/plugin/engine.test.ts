import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FsFacade, IdGenerator } from "@drawers/core";
import type { ToolContext } from "@opencode-ai/plugin";
import { createStructuredOutputTool } from "../runtime/structured/tool";
import { compileSchema } from "../runtime/structured/validate";
import type { JournalEntry } from "../runtime/types";
import { createWorkflowEngine } from "./engine";
import type { FeedEvent } from "./feed";
import { computeCallKey } from "./journal";

/**
 * Engine tests for the workflows plugin (Task 4.1.2). Everything is faked: the
 * SDK surface is an inert {@link makeClient}, persistence runs over an in-memory
 * {@link makeFs}, and the clock is fixed. No real opencode, no real timers.
 *
 * The run store and the workflow-tasks store both live under the SAME in-memory
 * fs but in DIFFERENT subdirectories (`workflow-runs`, `workflow-tasks`,
 * `workflow-scripts`), so a single fs fake exercises the whole layout.
 */

function basename(path: string): string {
	const i = path.lastIndexOf("/");
	return i === -1 ? path : path.slice(i + 1);
}
function dirname(path: string): string {
	const i = path.lastIndexOf("/");
	return i === -1 ? "" : path.slice(0, i);
}

/**
 * In-memory fs. `readdir` returns BASENAMES of files whose PARENT dir matches the
 * requested dir (the store re-joins with baseDir), mirroring node's readdir.
 * `writeFileSync`/`mkdirSync`-equivalents are folded into the async facade since
 * the engine only ever uses the async surface for scripts too.
 */
function makeFs(initial: Record<string, string> = {}) {
	const files = new Map<string, string>(Object.entries(initial));
	const facade: FsFacade = {
		mkdir: async () => undefined,
		readdir: async (dir: string) => {
			const out: string[] = [];
			for (const key of files.keys()) {
				if (dirname(key) === dir) {
					out.push(basename(key));
				}
			}
			return out;
		},
		readFile: async (path: string) => {
			const f = files.get(path);
			if (f === undefined) {
				const err = new Error("ENOENT") as Error & { code: string };
				err.code = "ENOENT";
				throw err;
			}
			return f;
		},
		writeFile: async (path: string, data: string) => {
			files.set(path, data);
		},
		rename: async (from: string, to: string) => {
			const v = files.get(from);
			if (v !== undefined) {
				files.set(to, v);
				files.delete(from);
			}
		},
		rm: async (path: string) => {
			files.delete(path);
		},
	};
	return { facade, files };
}

/**
 * A scripted EngineClient-shaped fake. `idleAfterPrompt` controls whether a
 * launched child ever "completes": when false (the default), the inert client
 * never emits an idle, so an `agent()` call stays in flight — letting us assert
 * `startRun` returns BEFORE the run settles.
 */
function makeClient() {
	return {
		session: {
			create: async () => ({ data: { id: "ses_child" } }),
			promptAsync: async () => undefined,
			abort: async () => undefined,
			messages: async () => ({ data: [] }),
			get: async () => ({ data: { id: "ses_child" } }),
			// Empty status map: absent = idle-equivalent, no liveness veto (Task 7.1.1).
			status: async () => ({ data: {} }),
		},
	};
}

const noopLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

const BASE = "/wf-data";
const NOW = 1_000_000;
const clock = { now: () => NOW };

/** Deterministic wf_ id generator over a fixed list. */
function fixedIds(...ids: string[]): IdGenerator {
	let i = 0;
	return {
		next: () => {
			const id = ids[i] ?? `wf_overflow${i}`;
			i += 1;
			return id;
		},
	};
}

const META = `export const meta = { name: "demo", description: "d" };\n`;

/** A script that hangs forever: launches a child the inert client never idles. */
const HANGING = `${META}await agent("do work");\nreturn "done";\n`;
/** A script that returns immediately with no agent calls. */
const INSTANT = `${META}return args;\n`;
/** A syntactically broken script (TypeScript annotation → acorn parse failure). */
const BROKEN = `${META}const x: number = 1;\nreturn x;\n`;

describe("createWorkflowEngine — startRun returns immediately", () => {
	test("returns runId + scriptPath before the run settles, and persists the script", async () => {
		const { facade, files } = makeFs();
		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock,
			logger: noopLogger,
			ids: fixedIds("wf_aaaa1111"),
		});

		// HANGING never settles against the inert client, so this resolves while the
		// run is still in flight.
		const handle = await engine.startRun({
			source: HANGING,
			parentSessionID: "ses_parent",
		});

		expect(handle.runId).toBe("wf_aaaa1111");
		expect(handle.scriptPath).toBe(`${BASE}/workflow-scripts/wf_aaaa1111.js`);
		expect(handle.name).toBe("demo");

		// Script source persisted to disk before execution.
		expect(files.get(handle.scriptPath)).toBe(HANGING);

		// In-memory handle exists and is still running (never settled).
		const status = engine.statusOf("wf_aaaa1111");
		expect(status?.record.status).toBe("running");

		await engine.dispose();
	});

	test("description falls back to 'workflow' when meta name cannot be extracted", async () => {
		const { facade } = makeFs();
		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock,
			logger: noopLogger,
			ids: fixedIds("wf_bbbb2222"),
		});

		// No meta → name extraction throws internally; description falls back.
		const handle = await engine.startRun({
			source: "return 1;\n",
			parentSessionID: "ses_parent",
		});
		expect(handle.name).toBe("workflow");
		const status = engine.statusOf("wf_bbbb2222");
		expect(status?.record.description).toBe("workflow");

		await engine.dispose();
	});
});

// ---- Epic 2.1: the host BunShell ($) threads into the engine options --------

/**
 * A minimal tagged-template BunShell fake (Epic 2.1). The host `$` is a callable
 * `(strings, ...exprs) => Promise<BunShellOutput>` plus chainable `.cwd()/.nothrow()`.
 * This fake answers every `git` command with a canned success/empty output, and
 * records the reconstructed command strings so a test can assert the git argv shape.
 */
function makeShell(
	reply: (cmd: string) => {
		stdout?: string;
		stderr?: string;
		exitCode?: number;
	},
) {
	const commands: string[] = [];
	const recon = (strings: TemplateStringsArray, exprs: unknown[]): string => {
		let out = strings[0] ?? "";
		for (let i = 0; i < exprs.length; i += 1) {
			out += String(exprs[i]) + (strings[i + 1] ?? "");
		}
		return out.trim();
	};
	const shell = (strings: TemplateStringsArray, ...exprs: unknown[]) => {
		const cmd = recon(strings, exprs);
		commands.push(cmd);
		const r = reply(cmd);
		const text = r.stdout ?? "";
		const p = Promise.resolve({
			stdout: { toString: () => text },
			stderr: { toString: () => r.stderr ?? "" },
			exitCode: r.exitCode ?? 0,
			text: () => text,
		});
		// `.quiet()` lives on the ShellPromise (not the namespace); the engine appends it
		// per-call to suppress the echo to the host TTY. Model it as a chainable no-op.
		Object.assign(p, { quiet: () => p });
		return p;
	};
	const chain = Object.assign(shell, {
		cwd: () => chain,
		nothrow: () => chain,
		env: () => chain,
		braces: (p: string) => [p],
		escape: (s: string) => s,
		throws: () => chain,
	});
	// biome-ignore lint/suspicious/noExplicitAny: structural BunShell fake.
	return { shell: chain as any, commands };
}

/**
 * A stateful git-repo fake (Epic 2.1) over the tagged-template BunShell. It models
 * a single working tree: `dirty` is the set of currently-modified paths,
 * `setDirty()` simulates an agent's edit, and `commits` records every checkpoint the
 * engine makes (sha + the staged paths + the message). `commitGate`, when set, makes
 * each `git commit` await a deferred so a test can prove the pre-launch barrier holds
 * the NEXT agent until the PRIOR commit resolves — slow in MICROTASK terms (an awaited
 * promise), never wall-clock, so the synchronous `flush()` can observe the block.
 */
function makeGitRepo(opts: { isRepo?: boolean } = {}) {
	const isRepo = opts.isRepo ?? true;
	const dirty = new Set<string>();
	const commits: Array<{ sha: string; paths: string[]; message: string }> = [];
	let head = "base0000";
	let seq = 0;
	let staged: string[] = [];
	let commitGate: (() => Promise<void>) | undefined;
	// The text `git diff <base>` (Task 4.1.1) returns; a test sets it to exercise
	// contextDiff injection (non-empty) and verifyDiff/contextDiff refusal (empty).
	let diffText = "";
	// Exit code returned for a verifyDiff `{check}` command (Task 4.2.x) — any non-git
	// command that isn't matched above. Default 0 (pass); a test sets non-zero to fail.
	let checkExit = 0;
	// Epic H.1.3: when set, `git merge --no-ff` exits non-zero and
	// `git diff --diff-filter=U` reports these unmerged files — modeling a REAL conflict.
	let conflictFiles: string[] = [];
	// Epic H.1.3 (high finding): the `git diff` text returned ONLY when the diff is bound
	// to a worktree cwd (not the main tree). Lets a test model an EMPTY main-tree diff
	// with a NON-EMPTY worktree diff — the exact shape that falsely failed a correctly-
	// working isolated agent before verifyResult re-rooted its git-diff branch.
	let worktreeDiffText = "";

	const recon = (strings: TemplateStringsArray, exprs: unknown[]): string => {
		let out = strings[0] ?? "";
		for (let i = 0; i < exprs.length; i += 1) {
			const e = exprs[i];
			// Bun's `${{ raw: cmd }}` escape hatch injects an unescaped command string;
			// mirror it so a verifyDiff `{check}` reconstructs to its real command.
			const piece =
				e !== null && typeof e === "object" && "raw" in e
					? String((e as { raw: unknown }).raw)
					: String(e);
			out += piece + (strings[i + 1] ?? "");
		}
		return out.trim();
	};
	const result = (stdout: string, exitCode = 0) =>
		Promise.resolve({
			stdout: { toString: () => stdout },
			stderr: { toString: () => "" },
			exitCode,
			text: () => stdout,
		});

	const commands: string[] = [];
	const quietedCommands: string[] = [];
	// Epic H.1.3 (medium finding): record the directory each command was BOUND to via
	// `.cwd(dir)` so a test can prove the verify shell re-rooted to the worktree dir and
	// not the main tree. `cwd()` stashes `lastCwd`; the template invocation stamps it.
	const cwdByCommand: Array<{ cmd: string; cwd: string }> = [];
	let lastCwd = "/proj";
	const run = (strings: TemplateStringsArray, ...exprs: unknown[]) => {
		const cmd = recon(strings, exprs);
		commands.push(cmd);
		cwdByCommand.push({ cmd, cwd: lastCwd });
		if (cmd.includes("is-inside-work-tree")) {
			return isRepo ? result("true") : result("", 128);
		}
		if (cmd.includes("status --porcelain")) {
			const lines = [...dirty].map((p) => ` M ${p}`).join("\n");
			return result(lines);
		}
		if (cmd === "git rev-parse HEAD") {
			return result(head);
		}
		// Epic H.1.3: `isUnchanged` counts commits ahead of the worktree base. This
		// fake does not model per-worktree commits, so it reports 0 ahead — leaving
		// the porcelain status (the shared dirty set) as the sole change signal.
		if (cmd.includes("rev-list --count")) {
			return result("0");
		}
		// Epic H.1.3: the unmerged-files probe MUST be matched before the generic
		// `git diff` (both start with "git diff"). It reports the injected conflict set.
		if (cmd.includes("--diff-filter=U")) {
			return result(conflictFiles.join("\n"));
		}
		if (cmd.startsWith("git merge --no-ff")) {
			// A real conflict exits non-zero (the manager then probes diff-filter=U); a
			// clean merge exits 0. `git merge --abort` falls through to the catch-all (0).
			return conflictFiles.length > 0 ? result("", 1) : result("");
		}
		if (cmd.startsWith("git diff")) {
			// A diff bound to a non-main cwd is a WORKTREE diff (Epic H.1.3 re-rooting):
			// report the worktree text so a test can prove an isolated agent's verifyDiff
			// judges its OWN tree, not the (empty) main tree.
			return result(lastCwd !== "/proj" ? worktreeDiffText : diffText);
		}
		if (cmd.startsWith("git add -- ")) {
			staged.push(cmd.slice("git add -- ".length));
			return result("");
		}
		if (cmd.includes("commit --no-verify")) {
			const message = cmd.slice(cmd.indexOf("-m ") + 3);
			const doCommit = () => {
				seq += 1;
				head = `sha_${seq}`;
				commits.push({ sha: head, paths: [...staged], message });
				for (const p of staged) {
					dirty.delete(p);
				}
				staged = [];
				return result("");
			};
			if (commitGate !== undefined) {
				return commitGate().then(doCommit);
			}
			return doCommit();
		}
		// A non-git command is a verifyDiff `{check}`: its exit code is the verdict.
		if (!cmd.startsWith("git ")) {
			return result("", checkExit);
		}
		return result("");
	};
	// `.quiet()` lives on the ShellPromise (not the namespace); the engine appends it
	// per-call to stop the echo to the host TTY. The wrapper records the quieted command
	// so a test can assert the verifyDiff check cannot corrupt the opencode TUI.
	const shell = (strings: TemplateStringsArray, ...exprs: unknown[]) => {
		const cmd = recon(strings, exprs);
		const p = run(strings, ...exprs);
		Object.assign(p, {
			quiet: () => {
				quietedCommands.push(cmd);
				return p;
			},
		});
		return p;
	};
	const chain = Object.assign(shell, {
		cwd: (d: string) => {
			lastCwd = d;
			return chain;
		},
		nothrow: () => chain,
		env: () => chain,
		braces: (p: string) => [p],
		escape: (s: string) => s,
		throws: () => chain,
	});
	return {
		// biome-ignore lint/suspicious/noExplicitAny: structural BunShell fake.
		shell: chain as any,
		commits,
		commands,
		quietedCommands,
		cwdByCommand,
		setDirty: (path: string) => dirty.add(path),
		setClean: (path: string) => dirty.delete(path),
		setCommitGate: (gate: (() => Promise<void>) | undefined) => {
			commitGate = gate;
		},
		setDiff: (text: string) => {
			diffText = text;
		},
		setWorktreeDiff: (text: string) => {
			worktreeDiffText = text;
		},
		setCheckExit: (code: number) => {
			checkExit = code;
		},
		setMergeConflict: (files: string[]) => {
			conflictFiles = files;
		},
	};
}

/**
 * A completing client whose assistant message timestamps track the LIVE clock
 * (Epic 2.1). The default {@link makeCompletingClient} hardcodes `created: NOW`, so
 * a SECOND sequential agent — launched after the clock has been bumped past the idle
 * grace several times — has a turn watermark ABOVE that fixed timestamp and its
 * message is rejected as stale (the turn never completes). Tracking the live clock
 * lets every sequential agent complete on `driveIdle`, which the multi-agent
 * checkpoint tests require.
 */
function makeClockedCompletingClient(now: () => number, reply = "DONE") {
	const sessions: string[] = [];
	let seq = 0;
	return {
		sessions,
		client: {
			session: {
				create: async () => {
					seq += 1;
					const id = `ses_child_${seq}`;
					sessions.push(id);
					return { data: { id } };
				},
				promptAsync: async () => undefined,
				abort: async () => undefined,
				messages: async () => ({
					data: [
						{
							info: {
								role: "assistant" as const,
								time: { created: now(), completed: now() },
							},
							parts: [{ type: "text", text: reply }],
						},
					],
				}),
				get: async () => ({ data: { id: "ses_child" } }),
				status: async () => ({ data: {} }),
			},
		},
	};
}

/**
 * A clocked completing client that ALSO records the `parts` array each
 * `promptAsync` was dispatched with, keyed by sessionID (Epic 4.1). Lets a test
 * assert that a `contextDiff:true` reviewer's launch carried the engine-computed
 * synthetic git-diff contextPart BEFORE the task prompt.
 */
function makeClockedCapturingClient(now: () => number, reply = "DONE") {
	const sessions: string[] = [];
	const promptParts = new Map<string, unknown[]>();
	let seq = 0;
	return {
		sessions,
		promptParts,
		client: {
			session: {
				create: async () => {
					seq += 1;
					const id = `ses_child_${seq}`;
					sessions.push(id);
					return { data: { id } };
				},
				promptAsync: async (opts: {
					path: { id: string };
					body: { parts: unknown[] };
				}) => {
					promptParts.set(opts.path.id, opts.body.parts);
					return undefined;
				},
				abort: async () => undefined,
				messages: async () => ({
					data: [
						{
							info: {
								role: "assistant" as const,
								time: { created: now(), completed: now() },
							},
							parts: [{ type: "text", text: reply }],
						},
					],
				}),
				get: async () => ({ data: { id: "ses_child" } }),
				status: async () => ({ data: {} }),
			},
		},
	};
}

describe("createWorkflowEngine — host shell ($) threading (Epic 2.1)", () => {
	test("constructs WITH a shell handle and still starts a run", async () => {
		const { facade } = makeFs();
		const { shell } = makeShell(() => ({ exitCode: 0, stdout: "true" }));
		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock,
			logger: noopLogger,
			ids: fixedIds("wf_shell001"),
			shell,
		});
		await engine.ready();
		const handle = await engine.startRun({
			source: HANGING,
			parentSessionID: "ses_parent",
		});
		expect(handle.runId).toBe("wf_shell001");
		await engine.dispose();
	});

	test("constructs WITHOUT a shell handle (feature no-ops, no throw)", async () => {
		const { facade } = makeFs();
		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock,
			logger: noopLogger,
			ids: fixedIds("wf_noshell01"),
		});
		await engine.ready();
		const handle = await engine.startRun({
			source: INSTANT,
			args: { ok: true },
			parentSessionID: "ses_parent",
		});
		await engine.statusOf(handle.runId)?.settled;
		expect(engine.statusOf(handle.runId)?.record.status).toBe("completed");
		await engine.dispose();
	});

	test("a shell-bearing engine wires a worktree manager into the run (Epic H.1.6)", async () => {
		// H.1.6: the engine constructs createWorktreeManager once from `$` and threads
		// it through WorkflowRunDeps → AgentPrimitiveDeps so the isolation mint-point
		// (H.1.2) can reach it. This guards the wiring does not throw. The shell reports
		// a NON-repo (`git rev-parse --is-inside-work-tree` ≠ "true"), so the manager's
		// `create` returns null and an isolation:'worktree' agent takes the
		// degrade-to-null FALLBACK rather than minting a worktree — keeping this test
		// focused on wiring, with the mint path covered by agent-call.test.ts.
		const { facade } = makeFs();
		const { shell } = makeShell(() => ({ exitCode: 1, stdout: "" }));
		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock,
			logger: noopLogger,
			ids: fixedIds("wf_wtmgr001"),
			shell,
		});
		await engine.ready();
		const handle = await engine.startRun({
			source: `${META}const r = await agent("isolated", { isolation: "worktree", label: "iso" });\nreturn r;\n`,
			parentSessionID: "ses_parent",
		});
		await engine.statusOf(handle.runId)?.settled;
		const record = engine.statusOf(handle.runId)?.record;
		expect(record?.status).toBe("completed");
		// The isolation request degrades-to-null. A manager IS threaded (shell present)
		// but create() returns null because the checkout is a non-repo → this is a MINT
		// failure (worktree_mint_failed), NOT isolation_unsupported: the feature is wired,
		// the mint failed. isolation_unsupported is reserved for "no manager threaded".
		expect(record?.returnValue).toBeNull();
		expect(
			record?.diagnostics?.some((d) => d.reason === "worktree_mint_failed"),
		).toBe(true);
		expect(
			record?.diagnostics?.some((d) => d.reason === "isolation_unsupported"),
		).toBe(false);
		await engine.dispose();
	});

	test("a git-backed engine threads a FUNCTIONING manager: an isolated agent mints + completes non-null (Epic H.1.2/H.1.6)", async () => {
		// The H.1.6 test above only ever exercises the create→null branch (non-repo). This
		// guards the SUCCESS path end-to-end: with a git-backed shell (is-inside-work-tree
		// 'true' and `git worktree add` exit 0), the engine constructs and threads a
		// FUNCTIONING manager whose create() returns a real handle, so an
		// isolation:'worktree' agent runs isolated and completes with a NON-null result and
		// NO isolation diagnostic — proving the wiring is correct on the mint path, not just
		// the degrade path. (A mis-threaded manager on the success path would only surface
		// at the unit layer otherwise.)
		const { facade } = makeFs();
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeClockedCompletingClient(
			mclock.now,
			"DONE",
		);
		// makeGitRepo: is-inside-work-tree 'true' and any other `git ...` (incl. `worktree
		// add`/`remove`, `branch -D`) returns exit 0 — a successful mint + teardown.
		const repo = makeGitRepo();
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_wtmgr002"),
			shell: repo.shell,
		});
		await engine.ready();
		const handle = await engine.startRun({
			source: `${META}const r = await agent("isolated", { isolation: "worktree", label: "iso" });\nreturn r;\n`,
			parentSessionID: "ses_parent",
		});
		await flush();
		await driveIdle(engine, sessions[0] as string, bump);
		await engine.statusOf(handle.runId)?.settled;

		const record = engine.statusOf(handle.runId)?.record;
		expect(record?.status).toBe("completed");
		// The mint succeeded → the agent ran isolated and returned its real result.
		expect(record?.returnValue).toBe("DONE");
		// No isolation/mint failure diagnostic on the success path (an absent
		// diagnostics array is itself "no such diagnostic").
		expect(
			(record?.diagnostics ?? []).some(
				(d) =>
					d.reason === "isolation_unsupported" ||
					d.reason === "worktree_mint_failed",
			),
		).toBe(false);
		// A worktree WAS minted (the engine threaded a functioning manager).
		expect(repo.commands.some((c) => c.startsWith("git worktree add"))).toBe(
			true,
		);
		await engine.dispose();
	});
});

// ---- Task H.1.3: verifyDiff + merge-back on agent:end (engine wiring) -----

const ISO_VERIFY_CHECK = `${META}const r = await agent("isolated", { isolation: "worktree", label: "iso", verifyDiff: { check: "bun run lint" } });\nreturn r;\n`;
const ISO_AGENT = `${META}const r = await agent("isolated", { isolation: "worktree", label: "iso" });\nreturn r;\n`;
const ISO_VERIFY_DIFF = `${META}const r = await agent("isolated", { isolation: "worktree", label: "iso", verifyDiff: true });\nreturn r;\n`;

describe("createWorkflowEngine — worktree merge-back on settle (Task H.1.3)", () => {
	test("a CHANGED isolated agent merges its branch back into the main tree, then cleans up", async () => {
		const { facade } = makeFs();
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeClockedCompletingClient(
			mclock.now,
			"DONE",
		);
		const repo = makeGitRepo();
		// The worktree carries real work → isUnchanged is false → the engine merges back.
		repo.setDirty("src/A.ts");
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_h13_merge"),
			shell: repo.shell,
		});
		await engine.ready();
		const handle = await engine.startRun({
			source: ISO_AGENT,
			parentSessionID: "ses_parent",
		});
		await flush();
		await driveIdle(engine, sessions[0] as string, bump);
		await engine.statusOf(handle.runId)?.settled;

		const rec = engine.statusOf(handle.runId)?.record;
		expect(rec?.status).toBe("completed");
		expect(rec?.returnValue).toBe("DONE");
		// The scratch branch was merged back into the main tree (--no-ff, an explicit
		// merge unit), and the worktree was then reclaimed.
		expect(repo.commands.some((c) => c.startsWith("git merge --no-ff"))).toBe(
			true,
		);
		expect(
			repo.commands.some((c) => c.startsWith("git worktree remove --force")),
		).toBe(true);
		// No conflict diagnostic on the clean-merge path.
		expect(
			(rec?.diagnostics ?? []).some((d) => d.reason === "merge_conflict"),
		).toBe(false);
		await engine.dispose();
	});

	test("a merge CONFLICT surfaces merge_conflict and PRESERVES the worktree (no remove)", async () => {
		const { facade } = makeFs();
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeClockedCompletingClient(
			mclock.now,
			"DONE",
		);
		const repo = makeGitRepo();
		repo.setDirty("src/A.ts"); // changed → merge is attempted
		repo.setMergeConflict(["src/A.ts"]); // and it conflicts
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_h13_conf"),
			shell: repo.shell,
		});
		await engine.ready();
		const handle = await engine.startRun({
			source: ISO_AGENT,
			parentSessionID: "ses_parent",
		});
		await flush();
		await driveIdle(engine, sessions[0] as string, bump);
		await engine.statusOf(handle.runId)?.settled;

		const rec = engine.statusOf(handle.runId)?.record;
		// The run itself still completes (degrade, don't detonate); the conflict is a
		// first-class diagnostic, NOT a thrown run.
		expect(rec?.status).toBe("completed");
		expect(
			(rec?.diagnostics ?? []).some((d) => d.reason === "merge_conflict"),
		).toBe(true);
		// merge --abort left the main tree clean; the conflicted worktree is PRESERVED
		// (no `worktree remove`) for inspection / a Tier 2 resolver.
		expect(repo.commands.some((c) => c.startsWith("git merge --abort"))).toBe(
			true,
		);
		expect(repo.commands.some((c) => c.startsWith("git worktree remove"))).toBe(
			false,
		);
		await engine.dispose();
	});

	test("verifyDiff:{check} for an isolated agent runs the check IN the worktree dir", async () => {
		const { facade } = makeFs();
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeClockedCompletingClient(
			mclock.now,
			"DONE",
		);
		const repo = makeGitRepo();
		repo.setDirty("src/A.ts");
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_h13_verify"),
			shell: repo.shell,
		});
		await engine.ready();
		const handle = await engine.startRun({
			source: ISO_VERIFY_CHECK,
			parentSessionID: "ses_parent",
		});
		await flush();
		await driveIdle(engine, sessions[0] as string, bump);
		await engine.statusOf(handle.runId)?.settled;

		const rec = engine.statusOf(handle.runId)?.record;
		expect(rec?.status).toBe("completed");
		// The check passed (exit 0) so the result survives, and the command was quieted
		// (TTY safety) — the verify shell re-rooted to the worktree, not the main tree.
		expect(rec?.returnValue).toBe("DONE");
		expect(repo.quietedCommands).toContain("bun run lint");
		// Medium finding: the check must run BOUND to the minted worktree dir, not the
		// main tree. The worktree root is a sibling of the repo (`<repo>/../.wf-worktrees`)
		// and the label is `<label>-<index>` → with directory '/proj' the minted dir is
		// '/.wf-worktrees/<runId>/iso-0'. Assert the recorded cwd so a regression that
		// ignores v.directory (binds to '/proj') is caught — the prior name-only assertion
		// could not distinguish the two.
		const lintBinding = repo.cwdByCommand.find((c) => c.cmd === "bun run lint");
		expect(lintBinding).toBeDefined();
		expect(lintBinding?.cwd).toBe("/.wf-worktrees/wf_h13_verify/iso-0");
		expect(lintBinding?.cwd).not.toBe("/proj");
		await engine.dispose();
	});

	test("verifyDiff:true for an isolated agent judges the WORKTREE diff, not the empty main tree (high finding)", async () => {
		const { facade } = makeFs();
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeClockedCompletingClient(
			mclock.now,
			"DONE",
		);
		const repo = makeGitRepo();
		// The agent's edits live in its WORKTREE: the worktree diff is NON-empty while the
		// main-tree diff is EMPTY. Before the fix, verifyResult's git-diff branch diffed
		// the (empty) MAIN tree → passed:false → the correctly-working agent was downgraded
		// to null with verify_failed. After the fix the diff is re-rooted to the worktree.
		repo.setDiff(""); // main tree: empty
		repo.setWorktreeDiff("diff --git a/src/A.ts b/src/A.ts\n+work"); // worktree: real
		repo.setDirty("src/A.ts"); // so the worktree is changed → merge-back fires
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_h13_vdiff"),
			shell: repo.shell,
		});
		await engine.ready();
		const handle = await engine.startRun({
			source: ISO_VERIFY_DIFF,
			parentSessionID: "ses_parent",
		});
		await flush();
		await driveIdle(engine, sessions[0] as string, bump);
		await engine.statusOf(handle.runId)?.settled;

		const rec = engine.statusOf(handle.runId)?.record;
		expect(rec?.status).toBe("completed");
		// The agent PASSES verify (its worktree diff is non-empty) and is NOT downgraded.
		expect(rec?.returnValue).toBe("DONE");
		expect(
			(rec?.diagnostics ?? []).some((d) => d.reason === "verify_failed"),
		).toBe(false);
		await engine.dispose();
	});
});

describe("createWorkflowEngine — crash-safety sweep on ready (Task H.1.5)", () => {
	test("ready() sweeps orphan wf/* worktrees + branches from a prior crash, quieted", async () => {
		const { facade } = makeFs();
		const repo = makeGitRepo();
		const engine = createWorkflowEngine({
			client: makeCompletingClient().client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: { now: () => NOW },
			logger: noopLogger,
			ids: fixedIds("wf_h15_sweep"),
			shell: repo.shell,
		});
		await engine.ready();
		// The manager's sweep prunes stale worktree admin entries, then enumerates ONLY
		// our wf/* branch namespace (never operator/host branches) for deletion. Both
		// commands MUST have been issued by ready() — a crashed prior run leaves orphans.
		expect(repo.commands).toContain("git worktree prune");
		expect(
			repo.commands.some(
				(c) => c.startsWith("git for-each-ref") && c.includes("refs/heads/wf/"),
			),
		).toBe(true);
		// TTY invariant: every engine-owned git command appends `.quiet()` to the
		// ShellPromise (the host shares fd 1/2 with the opentui renderer).
		expect(repo.quietedCommands).toContain("git worktree prune");
		await engine.dispose();
	});

	test("a non-repo engine's ready() does NOT issue sweep mutations (dead-latch)", async () => {
		const { facade } = makeFs();
		const repo = makeGitRepo({ isRepo: false });
		const engine = createWorkflowEngine({
			client: makeCompletingClient().client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: { now: () => NOW },
			logger: noopLogger,
			ids: fixedIds("wf_h15_norepo"),
			shell: repo.shell,
		});
		await engine.ready();
		// The manager latches dead on the non-repo probe → sweep is a no-op. No prune,
		// no branch enumeration (the for-each-ref over wf/* never runs).
		expect(repo.commands).not.toContain("git worktree prune");
		expect(repo.commands.some((c) => c.startsWith("git for-each-ref"))).toBe(
			false,
		);
		await engine.dispose();
	});
});

const TWO_AGENTS_P2 = `${META}const a = await agent("edit A", { label: "one", phase: "P" });\nconst b = await agent("overwrite A", { label: "two", phase: "P" });\nreturn [a, b];\n`;

describe("createWorkflowEngine — per-agent git checkpoints (Epic 2.1)", () => {
	test("a live completed agent's workflow-touched edit is committed; a later overwrite stays RECOVERABLE", async () => {
		const { facade, files } = makeFs();
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeClockedCompletingClient(
			mclock.now,
			"DONE",
		);
		const repo = makeGitRepo();
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_ckpt001"),
			shell: repo.shell,
		});
		await engine.ready();

		const handle = await engine.startRun({
			source: TWO_AGENTS_P2,
			parentSessionID: "ses_parent",
		});
		await flush();
		// Agent one edits src/A.ts, then idles → its agent:end fires a checkpoint.
		repo.setDirty("src/A.ts");
		await driveIdle(engine, sessions[0] as string, bump);
		await flush();

		// Agent two overwrites src/A.ts, then idles → second checkpoint.
		expect(sessions.length).toBe(2);
		repo.setDirty("src/A.ts");
		await driveIdle(engine, sessions[1] as string, bump);
		await engine.statusOf(handle.runId)?.settled;

		// TWO commits landed, in agent:end order, each holding src/A.ts.
		expect(repo.commits).toHaveLength(2);
		expect(repo.commits[0]?.paths).toEqual(["src/A.ts"]);
		expect(repo.commits[1]?.paths).toEqual(["src/A.ts"]);
		// Agent one's work is recoverable from the FIRST commit's sha even though
		// agent two later overwrote the same path (HEAD advanced; tree never reset).
		expect(repo.commits[0]?.sha).toBe("sha_1");
		expect(repo.commits[1]?.sha).toBe("sha_2");
		// The commit messages are forensically traceable to each agent's session.
		expect(repo.commits[0]?.message).toContain(sessions[0] as string);
		expect(repo.commits[1]?.message).toContain(sessions[1] as string);

		// The feed carries a per-agent checkpoint line per commit, before run:end.
		const feed = readFeed(files, "wf_ckpt001");
		const ckpts = feed.filter((l) => l.type === "agent:checkpoint");
		expect(ckpts).toHaveLength(2);
		const lastCkptIdx = feed.lastIndexOf(
			ckpts[ckpts.length - 1] as Record<string, unknown>,
		);
		const runEndIdx = feed.findIndex((l) => l.type === "run:end");
		expect(runEndIdx).toBeGreaterThan(lastCkptIdx);

		await engine.dispose();
	});

	test("the pre-launch barrier holds agent two's launch until agent one's commit drains", async () => {
		const { facade } = makeFs();
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeClockedCompletingClient(
			mclock.now,
			"DONE",
		);
		const repo = makeGitRepo();
		// Gate agent one's commit on a deferred resolved only by the test.
		let releaseCommit!: () => void;
		const commitDone = new Promise<void>((r) => {
			releaseCommit = r;
		});
		let gated = true;
		repo.setCommitGate(() => (gated ? commitDone : Promise.resolve()));

		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_ckpt002"),
			shell: repo.shell,
		});
		await engine.ready();

		await engine.startRun({
			source: TWO_AGENTS_P2,
			parentSessionID: "ses_parent",
		});
		await flush();
		repo.setDirty("src/A.ts");
		// Drive agent one idle → its commit STARTS but is parked on commitDone.
		await driveIdle(engine, sessions[0] as string, bump);
		await flush();

		// Agent two must NOT have launched: its acquire won a slot, but the pre-launch
		// barrier is blocked behind agent one's still-draining commit.
		expect(sessions.length).toBe(1);

		// Release agent one's commit → the barrier clears → agent two launches.
		gated = false;
		releaseCommit();
		await flush();
		expect(sessions.length).toBe(2);

		await engine.dispose();
	});

	test("an operator-dirty path is NEVER committed end-to-end (refuse-don't-stomp)", async () => {
		const { facade } = makeFs();
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeCompletingClient("DONE");
		const repo = makeGitRepo();
		// The operator already has uncommitted work in operator.ts BEFORE the run.
		repo.setDirty("operator.ts");
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_ckpt003"),
			shell: repo.shell,
		});
		await engine.ready();

		const handle = await engine.startRun({
			source: ONE_AGENT,
			parentSessionID: "ses_parent",
		});
		await flush();
		// The agent ALSO touches operator.ts (a collision) — and nothing else.
		await driveIdle(engine, sessions[0] as string, bump);
		await engine.statusOf(handle.runId)?.settled;

		// operator.ts was dirty at baseline → refused → no commit at all.
		expect(repo.commits).toHaveLength(0);
		// The operator's path is STILL dirty (never swept into an engine commit).
		await engine.dispose();
	});

	test("two concurrent runs keep INDEPENDENT operator baselines — run B's baseline never clobbers run A's refuse-set", async () => {
		// The bug: a SINGLE engine-scoped checkpointer holds ONE `preexistingDirty`
		// baseline. With two live runs, run B's baseline() (taken at B's startRun)
		// overwrites run A's, so run A loses the protection for the operator path it
		// captured at its OWN start — and then commits the operator's uncommitted work
		// under run A's session (the #5 class, by the engine). Fix: each run gets its
		// OWN checkpointer instance, so baselines are run-scoped and never clobber.
		const { facade } = makeFs();
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeClockedCompletingClient(
			mclock.now,
			"DONE",
		);
		const repo = makeGitRepo();
		// The operator has uncommitted work in operatorA.ts BEFORE run A starts. Run A's
		// baseline MUST capture it as off-limits for the whole life of run A.
		repo.setDirty("operatorA.ts");
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_runA", "wf_runB"),
			shell: repo.shell,
		});
		await engine.ready();

		// Run A baselines with operatorA.ts dirty → it is off-limits for run A.
		const a = await engine.startRun({
			source: ONE_AGENT,
			parentSessionID: "ses_parent",
		});
		await flush();

		// The operator's path leaves the dirty set BEFORE run B baselines (e.g. the
		// operator committed it). Run B therefore baselines with a CLEAN tree. A single
		// shared baseline would now hold `{}` — clobbering run A's `{operatorA.ts}`.
		repo.setClean("operatorA.ts");
		await engine.startRun({
			source: ONE_AGENT,
			parentSessionID: "ses_parent",
		});
		await flush();

		// Run A's agent now re-touches operatorA.ts (still the operator's uncommitted
		// work from run A's perspective). With an independent baseline run A REFUSES it;
		// with the shared (clobbered) baseline run A sweeps it into a commit.
		repo.setDirty("operatorA.ts");
		await driveIdle(engine, sessions[0] as string, bump);
		await engine.statusOf(a.runId)?.settled;

		// No commit anywhere contains operatorA.ts — run A's baseline survived run B's.
		expect(repo.commits.some((c) => c.paths.includes("operatorA.ts"))).toBe(
			false,
		);

		await engine.dispose();
	});

	test("a non-repo directory yields zero commits and warns ONCE (no per-agent noise)", async () => {
		const { facade } = makeFs();
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeClockedCompletingClient(
			mclock.now,
			"DONE",
		);
		const repo = makeGitRepo({ isRepo: false });
		const warns: string[] = [];
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: { ...noopLogger, warn: (m: string) => warns.push(m) },
			ids: fixedIds("wf_ckpt004"),
			shell: repo.shell,
		});
		await engine.ready();

		const handle = await engine.startRun({
			source: TWO_AGENTS_P2,
			parentSessionID: "ses_parent",
		});
		await flush();
		repo.setDirty("src/A.ts");
		await driveIdle(engine, sessions[0] as string, bump);
		await flush();
		repo.setDirty("src/A.ts");
		await driveIdle(engine, sessions[1] as string, bump);
		await engine.statusOf(handle.runId)?.settled;

		expect(repo.commits).toHaveLength(0);
		// Exactly one "not a git work tree" warn for the whole run — no per-agent spam.
		const repoWarns = warns.filter((w) =>
			w.includes("git checkpoint disabled"),
		);
		expect(repoWarns).toHaveLength(1);

		await engine.dispose();
	});
});

// ---- Task 4.1.4: engine wires resolveContextDiff from the per-run checkpointer --

const REVIEW_AGENT = `${META}const r = await agent("review the unit", { label: "rev", contextDiff: true });\nreturn r;\n`;

describe("createWorkflowEngine — contextDiff review injection (Task 4.1.4)", () => {
	test("a contextDiff reviewer launches with the engine-computed git diff as a synthetic contextPart", async () => {
		const { facade } = makeFs();
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions, promptParts } = makeClockedCapturingClient(
			mclock.now,
			"REVIEWED",
		);
		const repo = makeGitRepo();
		repo.setDiff("diff --git a/src/A.ts b/src/A.ts\n+real change");
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_ctxdiff01"),
			shell: repo.shell,
		});
		await engine.ready();

		const handle = await engine.startRun({
			source: REVIEW_AGENT,
			parentSessionID: "ses_parent",
		});
		await flush();
		await driveIdle(engine, sessions[0] as string, bump);
		await engine.statusOf(handle.runId)?.settled;

		const parts = promptParts.get(sessions[0] as string) as Array<{
			type: string;
			text: string;
			synthetic?: boolean;
		}>;
		expect(parts).toBeDefined();
		// The synthetic diff part comes FIRST, the task prompt LAST.
		expect(parts[0]).toEqual({
			type: "text",
			text: "diff --git a/src/A.ts b/src/A.ts\n+real change",
			synthetic: true,
		});
		expect(parts.some((p) => p.text === "review the unit")).toBe(true);

		await engine.dispose();
	});

	test("an empty git diff refuses the reviewer (null result + empty_diff diagnostic on the record)", async () => {
		const { facade } = makeFs();
		const { clock: mclock } = bumpClock(NOW);
		const { client, sessions, promptParts } = makeClockedCapturingClient(
			mclock.now,
			"SHOULD NOT RUN",
		);
		const repo = makeGitRepo();
		repo.setDiff(""); // a genuinely empty diff for the unit under review
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_ctxdiff02"),
			shell: repo.shell,
		});
		await engine.ready();

		const handle = await engine.startRun({
			source: REVIEW_AGENT,
			parentSessionID: "ses_parent",
		});
		await engine.statusOf(handle.runId)?.settled;

		// The reviewer never launched (no session created, no prompt dispatched).
		expect(sessions.length).toBe(0);
		expect(promptParts.size).toBe(0);
		// The run completed with a null reviewer result.
		const rec = engine.statusOf(handle.runId)?.record;
		expect(rec?.status).toBe("completed");
		expect(rec?.returnValue).toBeNull();
		// The empty_diff degrade is recorded as a typed diagnostic.
		expect(rec?.diagnostics?.some((d) => d.reason === "empty_diff")).toBe(true);

		await engine.dispose();
	});

	test("the no-shell engine path is unchanged: a contextDiff reviewer runs normally with no diff part", async () => {
		const { facade } = makeFs();
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions, promptParts } = makeClockedCapturingClient(
			mclock.now,
			"REVIEWED",
		);
		// No shell → the checkpointer is a documented no-op (available:false), so the
		// review must run and inject NO diff part (emptiness is unprovable).
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_ctxdiff03"),
		});
		await engine.ready();

		const handle = await engine.startRun({
			source: REVIEW_AGENT,
			parentSessionID: "ses_parent",
		});
		await flush();
		await driveIdle(engine, sessions[0] as string, bump);
		await engine.statusOf(handle.runId)?.settled;

		expect(engine.statusOf(handle.runId)?.record.returnValue).toBe("REVIEWED");
		const parts = promptParts.get(sessions[0] as string) as Array<{
			text: string;
			synthetic?: boolean;
		}>;
		expect(parts.some((p) => p.synthetic === true)).toBe(false);

		await engine.dispose();
	});
});

// ---- Task 4.2.3: engine wires verifyResult from the per-run checkpointer + shell --

const VERIFY_DIFF_AGENT = `${META}const r = await agent("fix the bug", { label: "fix", verifyDiff: true });\nreturn r;\n`;
const VERIFY_CHECK_AGENT = `${META}const r = await agent("fix the bug", { label: "fix", verifyDiff: { check: "bun test x" } });\nreturn r;\n`;

describe("createWorkflowEngine — verifyDiff post-condition (Task 4.2.3)", () => {
	test("verifyDiff:true with an EMPTY git diff downgrades the settled agent to null (verify_failed)", async () => {
		const { facade } = makeFs();
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeClockedCompletingClient(
			mclock.now,
			"DONE",
		);
		const repo = makeGitRepo();
		repo.setDiff(""); // the agent claims a fix but nothing is on disk
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_verify01"),
			shell: repo.shell,
		});
		await engine.ready();

		const handle = await engine.startRun({
			source: VERIFY_DIFF_AGENT,
			parentSessionID: "ses_parent",
		});
		await flush();
		await driveIdle(engine, sessions[0] as string, bump);
		await engine.statusOf(handle.runId)?.settled;

		const rec = engine.statusOf(handle.runId)?.record;
		expect(rec?.status).toBe("completed");
		// The agent settled but its empty-diff post-condition failed → null result.
		expect(rec?.returnValue).toBeNull();
		expect(rec?.diagnostics?.some((d) => d.reason === "verify_failed")).toBe(
			true,
		);

		await engine.dispose();
	});

	test("verifyDiff:true with a NON-EMPTY git diff preserves the result", async () => {
		const { facade } = makeFs();
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeClockedCompletingClient(
			mclock.now,
			"DONE",
		);
		const repo = makeGitRepo();
		repo.setDirty("src/A.ts");
		repo.setDiff("diff --git a/src/A.ts b/src/A.ts\n+real fix");
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_verify02"),
			shell: repo.shell,
		});
		await engine.ready();

		const handle = await engine.startRun({
			source: VERIFY_DIFF_AGENT,
			parentSessionID: "ses_parent",
		});
		await flush();
		await driveIdle(engine, sessions[0] as string, bump);
		await engine.statusOf(handle.runId)?.settled;

		const rec = engine.statusOf(handle.runId)?.record;
		expect(rec?.returnValue).toBe("DONE");
		expect(
			rec?.diagnostics?.some((d) => d.reason === "verify_failed"),
		).toBeFalsy();

		await engine.dispose();
	});

	test("verifyDiff:{check} that exits non-zero downgrades; exit 0 preserves", async () => {
		const { facade } = makeFs();
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeClockedCompletingClient(
			mclock.now,
			"DONE",
		);
		const repo = makeGitRepo();
		repo.setCheckExit(1); // the verification command FAILS
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_verify03"),
			shell: repo.shell,
		});
		await engine.ready();

		const handle = await engine.startRun({
			source: VERIFY_CHECK_AGENT,
			parentSessionID: "ses_parent",
		});
		await flush();
		await driveIdle(engine, sessions[0] as string, bump);
		await engine.statusOf(handle.runId)?.settled;

		const rec = engine.statusOf(handle.runId)?.record;
		expect(rec?.returnValue).toBeNull();
		expect(rec?.diagnostics?.some((d) => d.reason === "verify_failed")).toBe(
			true,
		);
		// TTY safety: the verifyDiff check command runs an arbitrary tool (tsc/eslint)
		// whose stdout/stderr would otherwise echo onto the opencode TUI alt-buffer; it
		// MUST be quieted at the source.
		expect(repo.quietedCommands).toContain("bun test x");

		await engine.dispose();
	});

	test("the no-shell engine path is unchanged: verifyDiff is inert, the result survives", async () => {
		const { facade } = makeFs();
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeClockedCompletingClient(
			mclock.now,
			"DONE",
		);
		// No shell → checkpointer dead → verify available:false → inert pass-through.
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_verify04"),
		});
		await engine.ready();

		const handle = await engine.startRun({
			source: VERIFY_DIFF_AGENT,
			parentSessionID: "ses_parent",
		});
		await flush();
		await driveIdle(engine, sessions[0] as string, bump);
		await engine.statusOf(handle.runId)?.settled;

		const rec = engine.statusOf(handle.runId)?.record;
		expect(rec?.returnValue).toBe("DONE");
		expect(
			rec?.diagnostics?.some((d) => d.reason === "verify_failed"),
		).toBeFalsy();

		await engine.dispose();
	});
});

describe("createWorkflowEngine — settle updates record + queues notice", () => {
	test("an instant run completes: record flips, returnValue captured, notice queued with hint", async () => {
		const { facade } = makeFs();
		const notices: { taskId: string; status: string }[] = [];
		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock,
			logger: noopLogger,
			ids: fixedIds("wf_cccc3333"),
			onNotify: (n) => notices.push({ taskId: n.taskId, status: n.status }),
		});

		const handle = await engine.startRun({
			source: INSTANT,
			args: { hello: "world" },
			parentSessionID: "ses_parent",
		});

		// Await the run's settle sync point (the journal-drain step adds microtask
		// hops, so counting fixed ticks no longer suffices).
		await engine.statusOf(handle.runId)?.settled;

		const status = engine.statusOf(handle.runId);
		expect(status?.record.status).toBe("completed");
		expect(status?.record.returnValue).toEqual({ hello: "world" });
		expect(status?.record.completedAt).toBe(NOW);

		// A terminal notice is queued for the parent, with the workflow_status hint.
		const pending = engine.queue.pending("ses_parent");
		expect(pending).toHaveLength(1);
		expect(pending[0]?.taskId).toBe("wf_cccc3333");
		expect(pending[0]?.status).toBe("completed");
		expect(pending[0]?.hint).toContain("workflow_status");
		expect(pending[0]?.hint).toContain("wf_cccc3333");

		// onNotify fired (the toast path).
		expect(notices).toEqual([{ taskId: "wf_cccc3333", status: "completed" }]);

		await engine.dispose();
	});

	test("a syntactically broken script settles to error: record + notice both error", async () => {
		const { facade } = makeFs();
		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock,
			logger: noopLogger,
			ids: fixedIds("wf_dddd4444"),
		});

		const handle = await engine.startRun({
			source: BROKEN,
			parentSessionID: "ses_parent",
		});
		// Await the run's settle sync point (the journal-drain step adds microtask
		// hops, so counting fixed ticks no longer suffices).
		await engine.statusOf(handle.runId)?.settled;

		const status = engine.statusOf(handle.runId);
		expect(status?.record.status).toBe("error");
		expect(status?.record.error).toBeTruthy();

		const pending = engine.queue.pending("ses_parent");
		expect(pending[0]?.status).toBe("error");

		await engine.dispose();
	});
});

describe("createWorkflowEngine — statusOf progress accumulation", () => {
	test("onProgress events accumulate onto the handle and are visible via statusOf", async () => {
		const { facade } = makeFs();
		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock,
			logger: noopLogger,
			ids: fixedIds("wf_eeee5555"),
		});

		const handle = await engine.startRun({
			source: `${META}log("step one");\nlog("step two");\nreturn null;\n`,
			parentSessionID: "ses_parent",
		});
		await engine.statusOf(handle.runId)?.settled;

		const status = engine.statusOf(handle.runId);
		const logs = (status?.progress ?? []).filter((e) => e.type === "log");
		// Events are engine-stamped at the onProgress boundary (Task 6.2.1): each
		// carries `at = clock.now()` (the fixed NOW here).
		expect(logs).toEqual([
			{ type: "log", message: "step one", at: NOW },
			{ type: "log", message: "step two", at: NOW },
		]);

		await engine.dispose();
	});
});

describe("createWorkflowEngine — sub-workflow resolver wiring (spec §8)", () => {
	test("a top-level run resolves a saved workflow by name and returns its value", async () => {
		// The saved child lives at <dir>/.opencode/workflows/helper.js — the engine's
		// resolver reads it off the SAME in-memory fs. The child returns instantly
		// (no agents), so the parent settles without the inert client ever idling.
		const CHILD = `export const meta = { name: "helper", description: "h" };\nreturn { marker: "HELPER_OK", got: args };\n`;
		const { facade } = makeFs({
			"/proj/.opencode/workflows/helper.js": CHILD,
		});
		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock,
			logger: noopLogger,
			ids: fixedIds("wf_sub00001"),
		});

		const PARENT = `${META}const r = await workflow("helper", { n: 1 });\nreturn r;\n`;
		const handle = await engine.startRun({
			source: PARENT,
			parentSessionID: "ses_parent",
		});
		// Await the run's settle directly (it has no live agents → resolves promptly).
		await engine.statusOf(handle.runId)?.settled;

		const status = engine.statusOf(handle.runId);
		expect(status?.record.status).toBe("completed");
		expect(status?.record.returnValue).toEqual({
			marker: "HELPER_OK",
			got: { n: 1 },
		});

		await engine.dispose();
	});

	test("an unknown sub-workflow name surfaces as a catchable script error", async () => {
		const { facade } = makeFs();
		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock,
			logger: noopLogger,
			ids: fixedIds("wf_sub00002"),
		});
		// The script catches the resolver throw and returns a sentinel — proving the
		// error is catchable (not a detonation).
		const PARENT = `${META}try { await workflow("ghost"); return "NOT_THROWN"; } catch (e) { return "CAUGHT:" + e.message; }\n`;
		const handle = await engine.startRun({
			source: PARENT,
			parentSessionID: "ses_parent",
		});
		await engine.statusOf(handle.runId)?.settled;

		const status = engine.statusOf(handle.runId);
		expect(status?.record.status).toBe("completed");
		expect(String(status?.record.returnValue)).toContain("CAUGHT");
		expect(String(status?.record.returnValue)).toContain("ghost");

		await engine.dispose();
	});
});

describe("createWorkflowEngine — settled promise on the handle (Task 4.3.2)", () => {
	test("an instant run exposes a settled promise that resolves after the record flips", async () => {
		const { facade } = makeFs();
		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock,
			logger: noopLogger,
			ids: fixedIds("wf_settle01"),
		});

		const handle = await engine.startRun({
			source: INSTANT,
			args: { v: 1 },
			parentSessionID: "ses_parent",
		});
		const live = engine.statusOf(handle.runId);
		expect(live?.settled).toBeInstanceOf(Promise);

		await live?.settled;
		// After settle resolves, the record is terminal.
		expect(engine.statusOf(handle.runId)?.record.status).toBe("completed");

		await engine.dispose();
	});
});

describe("createWorkflowEngine — default fs (no injected facade)", () => {
	// Regression for the live-harness Scenario C bug: the production plugin entry
	// builds the engine WITHOUT an fs, and the old engine gated script-persist /
	// journal-write / resume-read on `if (fs)` — so in production scripts were never
	// written and resume could not read the prior script ("no fs configured").
	// The engine must default fs to a real node facade so all three paths work.
	test("with no injected fs, the script is persisted to disk and a resume reads it back", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wf-engine-defaultfs-"));
		try {
			const engine = createWorkflowEngine({
				client: makeClient(),
				directory: "/proj",
				dataDir: dir,
				clock,
				logger: noopLogger,
				ids: fixedIds("wf_real00001", "wf_real00002"),
				// NO fs — exercise the production default.
			});

			const h1 = await engine.startRun({
				source: INSTANT,
				args: { v: 1 },
				parentSessionID: "ses_parent",
			});
			await engine.statusOf(h1.runId)?.settled;

			// The script was actually written to disk (the bug: it never was).
			const persisted = await readFile(h1.scriptPath, "utf-8");
			expect(persisted).toBe(INSTANT);

			// A resume with no explicit source reads that persisted script back — the
			// path that threw "no fs configured" before the fix.
			const h2 = await engine.startRun({
				resumeFromRunId: h1.runId,
				parentSessionID: "ses_parent",
			});
			await engine.statusOf(h2.runId)?.settled;
			const status = engine.statusOf(h2.runId);
			expect(status?.record.status).toBe("completed");
			expect(status?.record.resumedFrom).toBe(h1.runId);

			await engine.dispose();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("createWorkflowEngine — default-install resolution (no dataDir, no env)", () => {
	// Regression: with NO dataDir and NO OPENCODE_DRAWERS_DATA_DIR, the old engine
	// resolved `base` to undefined, so scriptsDir/journalsDir were undefined and
	// script persistence + journal writes silently no-op'd — breaking restart resume
	// for DEFAULT installs. The canonical resolveDataBaseDir always returns a string
	// (XDG-namespaced), so scripts and journals must persist under
	// `$XDG/opencode-drawers/workflow-*`.
	test("with no dataDir and no env var, scripts + journals persist under $XDG/opencode-drawers/workflow-*", async () => {
		const xdg = await mkdtemp(join(tmpdir(), "wf-xdg-"));
		const prevEnv = process.env.OPENCODE_DRAWERS_DATA_DIR;
		const prevXdg = process.env.XDG_DATA_HOME;
		delete process.env.OPENCODE_DRAWERS_DATA_DIR;
		process.env.XDG_DATA_HOME = xdg;
		try {
			const base = join(xdg, "opencode-drawers");
			const { writeFile, mkdir } = await import("node:fs/promises");
			const SCRIPT = `export const meta = { name: "j", description: "d" };\nconst r = await agent("do work", { label: "a" });\nreturn r;\n`;
			const key = computeCallKey({ prompt: "do work" });
			const entry: JournalEntry = {
				index: 0,
				key,
				status: "ok",
				result: "CACHED_RESULT",
			};

			// Seed a terminal prior run (record + script + journal) directly under the
			// XDG-resolved base so a resume replays the cached entry into a NEW journal.
			await mkdir(join(base, "workflow-runs"), { recursive: true });
			await mkdir(join(base, "workflow-scripts"), { recursive: true });
			await mkdir(join(base, "workflow-journals"), { recursive: true });
			await writeFile(
				join(base, "workflow-scripts", "wf_prior0001.js"),
				SCRIPT,
				"utf-8",
			);
			await writeFile(
				join(base, "workflow-journals", "wf_prior0001.jsonl"),
				`${JSON.stringify(entry)}\n`,
				"utf-8",
			);
			await writeFile(
				join(base, "workflow-runs", "wf_prior0001.json"),
				JSON.stringify({
					id: "wf_prior0001",
					parentSessionID: "ses_parent",
					status: "completed",
					description: "j",
					createdAt: NOW - 1000,
					completedAt: NOW - 500,
					scriptPath: join(base, "workflow-scripts", "wf_prior0001.js"),
				}),
				"utf-8",
			);

			// NO dataDir, NO fs — the engine must resolve XDG and use a real node facade.
			const engine = createWorkflowEngine({
				client: makeClient(),
				directory: "/proj",
				clock,
				logger: noopLogger,
				ids: fixedIds("wf_resume0001"),
			});
			await engine.ready();

			const h2 = await engine.startRun({
				resumeFromRunId: "wf_prior0001",
				parentSessionID: "ses_parent",
			});
			await engine.statusOf(h2.runId)?.settled;

			// The new run's script was persisted (resume re-persists the prior script).
			const persistedScript = await readFile(
				join(base, "workflow-scripts", "wf_resume0001.js"),
				"utf-8",
			);
			expect(persistedScript).toBe(SCRIPT);

			// The new run's journal was written under the XDG-resolved journals dir —
			// the path that silently no-op'd for default installs before the fix.
			const newJournal = await readFile(
				join(base, "workflow-journals", "wf_resume0001.jsonl"),
				"utf-8",
			);
			const lines = newJournal
				.split("\n")
				.filter((l) => l.length > 0)
				.map((l) => JSON.parse(l) as JournalEntry);
			expect(lines).toHaveLength(1);
			const settled0 = lines[0];
			expect(settled0?.status === "ok" && settled0.result).toBe(
				"CACHED_RESULT",
			);
			expect(engine.statusOf(h2.runId)?.record.status).toBe("completed");

			await engine.dispose();
		} finally {
			if (prevEnv === undefined) {
				delete process.env.OPENCODE_DRAWERS_DATA_DIR;
			} else {
				process.env.OPENCODE_DRAWERS_DATA_DIR = prevEnv;
			}
			if (prevXdg === undefined) {
				delete process.env.XDG_DATA_HOME;
			} else {
				process.env.XDG_DATA_HOME = prevXdg;
			}
			await rm(xdg, { recursive: true, force: true });
		}
	});
});

describe("createWorkflowEngine — journal is drained before settle (Task 4.3.2)", () => {
	// Regression for the live-harness Scenario C SECOND bug: journal appends were
	// fire-and-forget (`void journal?.record(e)`), so when a single-turn `opencode
	// run` exited the instant the turn ended, the last appends had not flushed — a
	// later resume then replayed NOTHING ("0 cached / N live"). The fix drains all
	// journal writes before `handle.settled` resolves, so wait_ms guarantees a
	// durable journal. Driven deterministically via the replay re-record path: a
	// seeded prior journal replays as cached (no live agent needed against the inert
	// client) and re-records into the NEW journal, which must be on disk after settle.
	test("a resumed run's re-recorded journal is durable on disk by the time settled resolves", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wf-engine-journaldrain-"));
		try {
			const { writeFile, mkdir } = await import("node:fs/promises");
			const SCRIPT = `export const meta = { name: "j", description: "d" };\nconst r = await agent("do work", { label: "a" });\nreturn r;\n`;
			const key = computeCallKey({ prompt: "do work" });
			const entry: JournalEntry = {
				index: 0,
				key,
				status: "ok",
				result: "CACHED_RESULT",
			};

			// Seed a TERMINAL prior run (record + script + journal) directly on disk so
			// startup recovery loads it and the resume guard passes. The journal carries
			// our matching cached entry.
			await mkdir(join(dir, "workflow-runs"), { recursive: true });
			await mkdir(join(dir, "workflow-scripts"), { recursive: true });
			await mkdir(join(dir, "workflow-journals"), { recursive: true });
			await writeFile(
				join(dir, "workflow-scripts", "wf_prior0001.js"),
				SCRIPT,
				"utf-8",
			);
			await writeFile(
				join(dir, "workflow-journals", "wf_prior0001.jsonl"),
				`${JSON.stringify(entry)}\n`,
				"utf-8",
			);
			await writeFile(
				join(dir, "workflow-runs", "wf_prior0001.json"),
				JSON.stringify({
					id: "wf_prior0001",
					parentSessionID: "ses_parent",
					status: "completed",
					description: "j",
					createdAt: NOW - 1000,
					completedAt: NOW - 500,
					scriptPath: join(dir, "workflow-scripts", "wf_prior0001.js"),
				}),
				"utf-8",
			);

			const engine = createWorkflowEngine({
				client: makeClient(),
				directory: "/proj",
				dataDir: dir,
				clock,
				logger: noopLogger,
				ids: fixedIds("wf_resume0001"),
			});
			await engine.ready();

			// Resume: the seeded entry replays as cached; onRecord re-records into the
			// NEW journal. After settled resolves, that file MUST be on disk (drained).
			const h2 = await engine.startRun({
				resumeFromRunId: "wf_prior0001",
				parentSessionID: "ses_parent",
			});
			await engine.statusOf(h2.runId)?.settled;

			const newJournal = await readFile(
				join(dir, "workflow-journals", "wf_resume0001.jsonl"),
				"utf-8",
			);
			const lines = newJournal
				.split("\n")
				.filter((l) => l.length > 0)
				.map((l) => JSON.parse(l) as JournalEntry);
			expect(lines).toHaveLength(1);
			const replayed0 = lines[0];
			expect(replayed0?.key).toBe(key);
			expect(replayed0?.status === "ok" && replayed0.result).toBe(
				"CACHED_RESULT",
			);
			// The resumed run completed with the cached value (fully replayed).
			expect(engine.statusOf(h2.runId)?.record.status).toBe("completed");
			expect(engine.statusOf(h2.runId)?.record.returnValue).toBe(
				"CACHED_RESULT",
			);

			await engine.dispose();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("createWorkflowEngine — startup recovery", () => {
	test("a record left 'running' by a dead process flips to error 'interrupted by restart'", async () => {
		const runsDir = `${BASE}/workflow-runs`;
		const staleRecord = {
			id: "wf_stale001",
			parentSessionID: "ses_parent",
			status: "running",
			description: "interrupted",
			createdAt: NOW - 5000,
			scriptPath: `${BASE}/workflow-scripts/wf_stale001.js`,
		};
		const terminalRecord = {
			id: "wf_done0001",
			parentSessionID: "ses_parent",
			status: "completed",
			description: "finished earlier",
			createdAt: NOW - 9000,
			completedAt: NOW - 8000,
			scriptPath: `${BASE}/workflow-scripts/wf_done0001.js`,
		};
		const { facade } = makeFs({
			[`${runsDir}/wf_stale001.json`]: JSON.stringify(staleRecord),
			[`${runsDir}/wf_done0001.json`]: JSON.stringify(terminalRecord),
		});

		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock,
			logger: noopLogger,
		});
		await engine.ready();

		// Stale running record flipped to error.
		const stale = engine.statusOf("wf_stale001");
		expect(stale?.record.status).toBe("error");
		expect(stale?.record.error).toContain("interrupted by restart");
		expect(stale?.progress).toEqual([]);

		// Epic 1.4: the recovery warning tells the operator the working tree may carry
		// uncommitted agent edits and to inspect `git status` before resuming — and
		// carries NO fabricated agent count (record.agents is empty on a real crash,
		// so any count would be a lie).
		const recoveryError = stale?.record.error ?? "";
		expect(recoveryError).toContain("working tree");
		expect(recoveryError).toContain("git status");
		expect(recoveryError).not.toMatch(/\d+\s*agent/i);

		// Terminal record remains readable, unchanged.
		const done = engine.statusOf("wf_done0001");
		expect(done?.record.status).toBe("completed");

		// Terminal record seeded the notification queue (un-notified); the recovered
		// error from the stale run is also a terminal notice.
		const pendingIds = engine.queue
			.pending("ses_parent")
			.map((n) => n.taskId)
			.sort();
		expect(pendingIds).toContain("wf_done0001");

		await engine.dispose();
	});

	test("recovery rehydrates record.agents + agentCount from the persisted feed (Phase 3.2.2)", async () => {
		const runsDir = `${BASE}/workflow-runs`;
		const staleRecord = {
			id: "wf_rehy0001",
			parentSessionID: "ses_parent",
			status: "running",
			description: "crashed mid-run",
			createdAt: NOW - 5000,
			scriptPath: `${BASE}/workflow-scripts/wf_rehy0001.js`,
		};
		// A feed with one LIVE agent (phase on agent:launched) and one CACHED agent
		// (phase on agent:start). The crash record carries no agents — only the feed
		// holds the real per-agent shape.
		const feedEvents: FeedEvent[] = [
			{ type: "run:start", runId: "wf_rehy0001", parentSessionID: "p", at: 1 },
			{ type: "agent:start", label: "writer", phase: "draft", at: 2 },
			{
				type: "agent:launched",
				label: "writer",
				phase: "draft",
				sessionID: "ses_w",
				model: "claude-x",
				agentType: "build",
				at: 3,
			},
			{
				type: "agent:end",
				label: "writer",
				status: "completed",
				sessionID: "ses_w",
				at: 9,
				durationMs: 6,
				toolCalls: 2,
			} as FeedEvent,
			{ type: "agent:start", label: "verify", phase: "review", at: 10 },
			{ type: "agent:end", label: "verify", status: "cached", at: 11 },
		];
		const { facade } = makeFs({
			[`${runsDir}/wf_rehy0001.json`]: JSON.stringify(staleRecord),
			[FEED("wf_rehy0001")]: `${feedEvents
				.map((e) => JSON.stringify(e))
				.join("\n")}\n`,
		});

		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock,
			logger: noopLogger,
		});
		await engine.ready();

		const handle = engine.statusOf("wf_rehy0001");
		// Recovery invariants preserved.
		expect(handle?.record.status).toBe("error");
		expect(handle?.record.error).toContain("interrupted by restart");
		// The error string carries NO fabricated count (the count lives on the record
		// fields, not the message — the existing :1168 invariant).
		expect(handle?.record.error ?? "").not.toMatch(/\d+\s*agent/i);
		// Rehydrated from the feed.
		expect(handle?.record.agentCount).toBe(2);
		expect(handle?.record.agents).toHaveLength(2);
		expect(handle?.record.agents?.[0]).toMatchObject({
			label: "writer",
			phase: "draft",
			sessionID: "ses_w",
			model: "claude-x",
			agentType: "build",
			status: "completed",
			toolCalls: 2,
		});
		expect(handle?.record.agents?.[1]).toMatchObject({
			label: "verify",
			phase: "review",
			status: "cached",
		});
		// progress stays empty — no fabricated progress events.
		expect(handle?.progress).toEqual([]);

		await engine.dispose();
	});

	test("recovery with a missing feed stays 0/0 and never throws (Phase 3.2.2)", async () => {
		const runsDir = `${BASE}/workflow-runs`;
		const staleRecord = {
			id: "wf_nofeed01",
			parentSessionID: "ses_parent",
			status: "running",
			description: "crashed before any agent",
			createdAt: NOW - 5000,
			scriptPath: `${BASE}/workflow-scripts/wf_nofeed01.js`,
		};
		const { facade } = makeFs({
			[`${runsDir}/wf_nofeed01.json`]: JSON.stringify(staleRecord),
		});
		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock,
			logger: noopLogger,
		});
		await engine.ready();

		const handle = engine.statusOf("wf_nofeed01");
		expect(handle?.record.status).toBe("error");
		expect(handle?.record.error).toContain("interrupted by restart");
		// No feed → no agents rehydrated (honest 0/0).
		expect(handle?.record.agents).toBeUndefined();
		expect(handle?.record.agentCount).toBeUndefined();

		await engine.dispose();
	});
});

describe("createWorkflowEngine — shared registry, no crosstalk", () => {
	test("two sessions route structured results through the engine's one registry independently", async () => {
		const { facade } = makeFs();
		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock,
			logger: noopLogger,
		});

		// The single global structured_output tool over the engine registry — the
		// same instance every run shares.
		const toolDef = createStructuredOutputTool(engine.registry);

		const schemaA = compileSchema({ type: "object", required: ["a"] });
		const schemaB = compileSchema({ type: "object", required: ["b"] });
		engine.registry.register("ses_one", schemaA);
		engine.registry.register("ses_two", schemaB);

		const ctx = (sessionID: string) =>
			({ sessionID }) as unknown as ToolContext;

		// Session one stores its result; session two its own — no crosstalk.
		const r1 = await toolDef.execute(
			{ result: JSON.stringify({ a: 1 }) },
			ctx("ses_one"),
		);
		const r2 = await toolDef.execute(
			{ result: JSON.stringify({ b: 2 }) },
			ctx("ses_two"),
		);
		expect(r1).toBe("accepted");
		expect(r2).toBe("accepted");

		expect(engine.registry.resultFor("ses_one")).toEqual({
			present: true,
			value: { a: 1 },
		});
		expect(engine.registry.resultFor("ses_two")).toEqual({
			present: true,
			value: { b: 2 },
		});

		await engine.dispose();
	});
});

describe("createWorkflowEngine — stopRun", () => {
	test("stopRun aborts a live run, flips the record to cancelled, and queues a notice", async () => {
		const { facade } = makeFs();
		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock,
			logger: noopLogger,
			ids: fixedIds("wf_ffff6666"),
		});

		const handle = await engine.startRun({
			source: HANGING,
			parentSessionID: "ses_parent",
		});
		expect(engine.statusOf(handle.runId)?.record.status).toBe("running");

		engine.stopRun(handle.runId);

		const status = engine.statusOf(handle.runId);
		expect(status?.record.status).toBe("cancelled");

		const pending = engine.queue.pending("ses_parent");
		expect(pending.some((n) => n.taskId === handle.runId)).toBe(true);

		await engine.dispose();
	});
});

// ---- Task 4.2.2: resume wiring -------------------------------------------

/**
 * An auto-completing client: every launched child reaches `completed` the moment
 * a `session.idle` event is driven through `engine.handleEvent`, AND its single
 * assistant message text is `reply`. Combined with a MUTABLE clock bumped past
 * the 5s min-idle grace, completion fires synchronously with no real timers.
 *
 * `session.create` hands out incrementing ids so a multi-agent script gets
 * distinct child sessions (the completion gate + registry track by sessionID).
 */
function makeCompletingClient(reply = "AGENT_RESULT") {
	const sessions: string[] = [];
	let seq = 0;
	return {
		sessions,
		client: {
			session: {
				create: async () => {
					seq += 1;
					const id = `ses_child_${seq}`;
					sessions.push(id);
					return { data: { id } };
				},
				promptAsync: async () => undefined,
				abort: async () => undefined,
				messages: async () => ({
					data: [
						{
							info: {
								role: "assistant" as const,
								time: { created: NOW, completed: NOW },
							},
							parts: [{ type: "text", text: reply }],
						},
					],
				}),
				get: async () => ({ data: { id: "ses_child" } }),
				// Absent status = idle-equivalent; completed message = finished turn.
				status: async () => ({ data: {} }),
			},
		},
	};
}

/**
 * A completing client whose child assistant message carries a completed TOOL part
 * but NO text (Task 7.2.1 test seam). The gate's hasValidOutput accepts the tool
 * part so the turn completes, yet lastAssistantText is "" → the agent primitive
 * resolves "" and reports an `empty_output` diagnostic.
 */
function makeToolOnlyCompletingClient() {
	const sessions: string[] = [];
	let seq = 0;
	return {
		sessions,
		client: {
			session: {
				create: async () => {
					seq += 1;
					const id = `ses_child_${seq}`;
					sessions.push(id);
					return { data: { id } };
				},
				promptAsync: async () => undefined,
				abort: async () => undefined,
				messages: async () => ({
					data: [
						{
							info: {
								role: "assistant" as const,
								time: { created: NOW, completed: NOW },
							},
							parts: [
								{ type: "tool", state: { status: "completed", output: "ran" } },
							],
						},
					],
				}),
				get: async () => ({ data: { id: "ses_child" } }),
				status: async () => ({ data: {} }),
			},
		},
	};
}

/** A clock whose `now` is a mutable box; bump past 5000ms to clear idle grace. */
function bumpClock(start: number) {
	const box = { t: start };
	return {
		clock: { now: () => box.t },
		bump: (ms: number) => {
			box.t += ms;
		},
	};
}

/** Drain the microtask queue: the async parse→eval→acquire→create chain plus
 * the settle continuations take many turns to propagate before asserting. */
async function flush(turns = 60): Promise<void> {
	for (let i = 0; i < turns; i += 1) {
		await Promise.resolve();
	}
}

const JOURNALS = (id: string) => `${BASE}/workflow-journals/${id}.jsonl`;

/** Serialize journal entries to the JSONL file format the journal writes. */
function jsonl(entries: JournalEntry[]): string {
	return `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

/** Read a journal file's entries from the fake fs (missing → []). */
function readJournal(files: Map<string, string>, id: string): JournalEntry[] {
	const raw = files.get(JOURNALS(id));
	if (raw === undefined) {
		return [];
	}
	return raw
		.split("\n")
		.filter((l) => l.length > 0)
		.map((l) => JSON.parse(l) as JournalEntry);
}

const FEED = (id: string) => `${BASE}/workflow-feed/${id}.jsonl`;

/** Read a feed file's parsed lines from the fake fs (missing → []) (Task 8.1.2). */
function readFeed(
	files: Map<string, string>,
	id: string,
): Array<Record<string, unknown>> {
	const raw = files.get(FEED(id));
	if (raw === undefined) {
		return [];
	}
	return raw
		.split("\n")
		.filter((l) => l.length > 0)
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

/**
 * Drive a single-agent child to completion: launch dispatched the prompt async,
 * so bump the clock past the grace and emit the child's idle event. Returns once
 * the run's settle microtasks have drained.
 */
async function driveIdle(
	engine: ReturnType<typeof createWorkflowEngine>,
	sessionID: string,
	bump: (ms: number) => void,
): Promise<void> {
	bump(6000);
	await engine.handleEvent({
		type: "session.idle",
		properties: { sessionID },
		// biome-ignore lint/suspicious/noExplicitAny: the gate reads only type+properties.
	} as any);
	await flush();
}

const ONE_AGENT = `${META}const r = await agent("do work");\nreturn r;\n`;

describe("createWorkflowEngine — fresh run journals to disk", () => {
	test("a fresh run's settled agent result lands in <dataDir>/workflow-journals/<runId>.jsonl", async () => {
		const { facade, files } = makeFs();
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeCompletingClient("HELLO");
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_fresh001"),
		});
		await engine.ready();

		const handle = await engine.startRun({
			source: ONE_AGENT,
			parentSessionID: "ses_parent",
		});
		await flush();
		await driveIdle(engine, sessions[0] as string, bump);

		const status = engine.statusOf(handle.runId);
		expect(status?.record.status).toBe("completed");
		expect(status?.record.returnValue).toBe("HELLO");

		// Phase 3: a live agent write-aheads an intent BEFORE launch, then the settled
		// ok line. Both share index+key; the intent precedes the completion.
		const entries = readJournal(files, "wf_fresh001");
		expect(entries.length).toBe(2);
		expect(entries[0]).toMatchObject({
			index: 0,
			key: computeCallKey({ prompt: "do work" }),
			status: "intent",
		});
		expect(entries[1]).toMatchObject({
			index: 0,
			key: computeCallKey({ prompt: "do work" }),
			status: "ok",
			result: "HELLO",
		});

		await engine.dispose();
	});
});

describe("createWorkflowEngine — agent diagnostics persist on the record (Task 7.2.1)", () => {
	test("an empty-output agent settles with an empty_output diagnostic on the run record", async () => {
		const { facade, files } = makeFs();
		const { clock: mclock, bump } = bumpClock(NOW);
		// A child whose assistant message carries a TOOL part but NO text: the gate's
		// hasValidOutput accepts the tool part (turn completes), yet lastAssistantText
		// is "" — the realistic empty_output path (an empty-text message never
		// completes on idle alone, by Phase 7.1's valid-output requirement).
		const { client, sessions } = makeToolOnlyCompletingClient();
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_diag001"),
		});
		await engine.ready();

		const handle = await engine.startRun({
			source: `${META}const r = await agent("do work", { label: "worker" });\nreturn r;\n`,
			parentSessionID: "ses_parent",
		});
		await flush();
		await driveIdle(engine, sessions[0] as string, bump);

		const record = engine.statusOf(handle.runId)?.record;
		expect(record?.status).toBe("completed");
		// The empty "" result is still returned to the script (byte-identical).
		expect(record?.returnValue).toBe("");
		// And the diagnostic is persisted for post-mortem.
		expect(record?.diagnostics).toBeDefined();
		expect(record?.diagnostics).toHaveLength(1);
		expect(record?.diagnostics?.[0]).toMatchObject({
			label: "worker",
			index: 0,
			reason: "empty_output",
		});

		// It round-trips through the persisted JSON on disk too.
		const persisted = JSON.parse(
			files.get(`${BASE}/workflow-runs/wf_diag001.json`) ?? "{}",
		);
		expect(persisted.diagnostics?.[0]?.reason).toBe("empty_output");

		await engine.dispose();
	});

	test("a clean run persists NO diagnostics field", async () => {
		const { facade } = makeFs();
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeCompletingClient("HELLO");
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_clean001"),
		});
		await engine.ready();

		const handle = await engine.startRun({
			source: ONE_AGENT,
			parentSessionID: "ses_parent",
		});
		await flush();
		await driveIdle(engine, sessions[0] as string, bump);

		const record = engine.statusOf(handle.runId)?.record;
		expect(record?.status).toBe("completed");
		expect(record?.diagnostics).toBeUndefined();

		await engine.dispose();
	});
});

/** Seed a completed prior run: its record + a one-entry journal on disk. */
function seedPrior(
	files: Record<string, string>,
	opts: { id: string; result: unknown; args?: unknown; prompt?: string },
): Record<string, string> {
	const prompt = opts.prompt ?? "do work";
	const record = {
		id: opts.id,
		parentSessionID: "ses_parent",
		status: "completed",
		description: "demo",
		createdAt: NOW - 1000,
		completedAt: NOW - 500,
		scriptPath: `${BASE}/workflow-scripts/${opts.id}.js`,
		args: opts.args,
		returnValue: opts.result,
	};
	const entries: JournalEntry[] = [
		{
			index: 0,
			key: computeCallKey({ prompt }),
			status: "ok",
			result: opts.result,
		},
	];
	return {
		...files,
		[`${BASE}/workflow-runs/${opts.id}.json`]: JSON.stringify(record),
		[`${BASE}/workflow-scripts/${opts.id}.js`]: ONE_AGENT,
		[JOURNALS(opts.id)]: jsonl(entries),
	};
}

describe("createWorkflowEngine — resume (same instance)", () => {
	test("same script + same args resume → ZERO launches, identical returnValue, complete new journal", async () => {
		const seeded = seedPrior({}, { id: "wf_prior001", result: "CACHED" });
		const { facade, files } = makeFs(seeded);
		const { clock: mclock } = bumpClock(NOW);
		let creates = 0;
		const { client } = makeCompletingClient();
		const wrapped = {
			session: {
				...client.session,
				create: async () => {
					creates += 1;
					return { data: { id: "ses_unused" } };
				},
			},
		};
		const engine = createWorkflowEngine({
			client: wrapped,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_new00001"),
		});
		await engine.ready();

		const handle = await engine.startRun({
			resumeFromRunId: "wf_prior001",
			parentSessionID: "ses_parent",
		});
		await flush();

		const status = engine.statusOf(handle.runId);
		expect(status?.record.status).toBe("completed");
		expect(status?.record.returnValue).toBe("CACHED");
		expect(status?.record.resumedFrom).toBe("wf_prior001");
		expect(creates).toBe(0);

		const prior = readJournal(files, "wf_prior001");
		const fresh = readJournal(files, "wf_new00001");
		expect(fresh.length).toBe(prior.length);
		expect(fresh[0]).toMatchObject({
			index: 0,
			key: computeCallKey({ prompt: "do work" }),
			status: "ok",
			result: "CACHED",
		});

		await engine.dispose();
	});

	test("edited script: earlier calls cached, the edited call and ALL subsequent run live", async () => {
		const id = "wf_prior003";
		const entries: JournalEntry[] = [
			{
				index: 0,
				key: computeCallKey({ prompt: "first" }),
				status: "ok",
				result: "c0",
			},
			{
				index: 1,
				key: computeCallKey({ prompt: "second" }),
				status: "ok",
				result: "c1",
			},
		];
		const priorScript = `${META}await agent("first");\nawait agent("second");\nreturn null;\n`;
		const editedScript = `${META}await agent("first");\nawait agent("CHANGED");\nreturn "edited";\n`;
		const seeded: Record<string, string> = {
			[`${BASE}/workflow-runs/${id}.json`]: JSON.stringify({
				id,
				parentSessionID: "ses_parent",
				status: "completed",
				description: "demo",
				createdAt: NOW - 1000,
				completedAt: NOW - 500,
				scriptPath: `${BASE}/workflow-scripts/${id}.js`,
			}),
			[`${BASE}/workflow-scripts/${id}.js`]: priorScript,
			[JOURNALS(id)]: jsonl(entries),
		};
		const { facade } = makeFs(seeded);
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeCompletingClient("LIVE");
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_new00003"),
		});
		await engine.ready();

		const handle = await engine.startRun({
			resumeFromRunId: id,
			source: editedScript,
			parentSessionID: "ses_parent",
		});
		await flush();
		await driveIdle(engine, sessions[0] as string, bump);

		const status = engine.statusOf(handle.runId);
		expect(status?.record.status).toBe("completed");
		expect(status?.record.returnValue).toBe("edited");
		expect(sessions.length).toBe(1);

		await engine.dispose();
	});

	test("R4: editing parallel item 0 reruns ONLY item 0; unchanged item 1 replays cached", async () => {
		// Field finding R4 (report §4.3) end-to-end: a parallel() set where item 0's
		// prompt is edited on resume must replay the UNCHANGED, expensive item 1 from
		// the journal — not re-execute it. The old prefix latch re-ran item 1 (4m17s,
		// different answer); per-key occurrence matching keeps it cached. Asserted via
		// exactly ONE live child session (item 0 only).
		const id = "wf_priorR4";
		const entries: JournalEntry[] = [
			{
				index: 0,
				key: computeCallKey({ prompt: "item0-OLD" }),
				status: "ok",
				result: "stale-0",
			},
			{
				index: 1,
				key: computeCallKey({ prompt: "item1-expensive" }),
				status: "ok",
				result: "CACHED-EXPENSIVE",
			},
		];
		const priorScript = `${META}const r = await parallel([\n() => agent("item0-OLD"),\n() => agent("item1-expensive"),\n]);\nreturn r;\n`;
		const editedScript = `${META}const r = await parallel([\n() => agent("item0-EDITED"),\n() => agent("item1-expensive"),\n]);\nreturn r;\n`;
		const seeded: Record<string, string> = {
			[`${BASE}/workflow-runs/${id}.json`]: JSON.stringify({
				id,
				parentSessionID: "ses_parent",
				status: "completed",
				description: "demo",
				createdAt: NOW - 1000,
				completedAt: NOW - 500,
				scriptPath: `${BASE}/workflow-scripts/${id}.js`,
			}),
			[`${BASE}/workflow-scripts/${id}.js`]: priorScript,
			[JOURNALS(id)]: jsonl(entries),
		};
		const { facade } = makeFs(seeded);
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeCompletingClient("LIVE-0");
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_newR4"),
		});
		await engine.ready();

		const handle = await engine.startRun({
			resumeFromRunId: id,
			source: editedScript,
			parentSessionID: "ses_parent",
		});
		await flush();
		// Only item 0 launches a live child; item 1 replays from the journal.
		await driveIdle(engine, sessions[0] as string, bump);

		const status = engine.statusOf(handle.runId);
		expect(status?.record.status).toBe("completed");
		// Item 0 ran live → "LIVE-0"; item 1 replayed its frozen journaled result.
		expect(status?.record.returnValue).toEqual(["LIVE-0", "CACHED-EXPENSIVE"]);
		// The expensive item was NEVER re-executed: exactly one live session.
		expect(sessions.length).toBe(1);

		await engine.dispose();
	});

	test("resume of a still-running run is refused with a stop hint", async () => {
		const { facade } = makeFs();
		const { clock: mclock } = bumpClock(NOW);
		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_live0001", "wf_resume001"),
		});
		await engine.ready();

		const live = await engine.startRun({
			source: HANGING,
			parentSessionID: "ses_parent",
		});
		expect(engine.statusOf(live.runId)?.record.status).toBe("running");

		await expect(
			engine.startRun({
				resumeFromRunId: live.runId,
				parentSessionID: "ses_parent",
			}),
		).rejects.toThrow(/still running/);

		await engine.dispose();
	});

	test("resume with an unknown id errors, listing known run ids", async () => {
		const seeded = seedPrior({}, { id: "wf_known999", result: "Y" });
		const { facade } = makeFs(seeded);
		const { clock: mclock } = bumpClock(NOW);
		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
		});
		await engine.ready();

		await expect(
			engine.startRun({
				resumeFromRunId: "wf_nope",
				parentSessionID: "ses_parent",
			}),
		).rejects.toThrow(/wf_known999/);

		await engine.dispose();
	});

	test("missing prior journal → run goes live with a warn (resume still works)", async () => {
		const id = "wf_nojour01";
		const seeded: Record<string, string> = {
			[`${BASE}/workflow-runs/${id}.json`]: JSON.stringify({
				id,
				parentSessionID: "ses_parent",
				status: "completed",
				description: "demo",
				createdAt: NOW - 1000,
				completedAt: NOW - 500,
				scriptPath: `${BASE}/workflow-scripts/${id}.js`,
			}),
			[`${BASE}/workflow-scripts/${id}.js`]: ONE_AGENT,
		};
		const { facade } = makeFs(seeded);
		const { clock: mclock, bump } = bumpClock(NOW);
		const warns: string[] = [];
		const logger = { ...noopLogger, warn: (m: string) => warns.push(m) };
		const { client, sessions } = makeCompletingClient("LIVERESULT");
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger,
			ids: fixedIds("wf_new00004"),
		});
		await engine.ready();

		const handle = await engine.startRun({
			resumeFromRunId: id,
			parentSessionID: "ses_parent",
		});
		await flush();
		await driveIdle(engine, sessions[0] as string, bump);

		const status = engine.statusOf(handle.runId);
		expect(status?.record.status).toBe("completed");
		expect(status?.record.returnValue).toBe("LIVERESULT");
		expect(sessions.length).toBe(1);
		expect(warns.some((w) => w.toLowerCase().includes("journal"))).toBe(true);

		await engine.dispose();
	});

	test("explicit args override prior args and break the cache at an args-bearing prompt", async () => {
		const id = "wf_priorarg";
		const oldPrompt = "use old";
		const entries: JournalEntry[] = [
			{
				index: 0,
				key: computeCallKey({ prompt: oldPrompt }),
				status: "ok",
				result: "OLD",
			},
		];
		const script = `${META}const r = await agent("use " + args.x);\nreturn r;\n`;
		const seeded: Record<string, string> = {
			[`${BASE}/workflow-runs/${id}.json`]: JSON.stringify({
				id,
				parentSessionID: "ses_parent",
				status: "completed",
				description: "demo",
				createdAt: NOW - 1000,
				completedAt: NOW - 500,
				scriptPath: `${BASE}/workflow-scripts/${id}.js`,
				args: { x: "old" },
			}),
			[`${BASE}/workflow-scripts/${id}.js`]: script,
			[JOURNALS(id)]: jsonl(entries),
		};
		const { facade } = makeFs(seeded);
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeCompletingClient("NEWRESULT");
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_new00005"),
		});
		await engine.ready();

		const handle = await engine.startRun({
			resumeFromRunId: id,
			args: { x: "new" },
			parentSessionID: "ses_parent",
		});
		await flush();
		await driveIdle(engine, sessions[0] as string, bump);

		const status = engine.statusOf(handle.runId);
		expect(status?.record.status).toBe("completed");
		expect(status?.record.returnValue).toBe("NEWRESULT");
		expect(status?.record.args).toEqual({ x: "new" });
		expect(sessions.length).toBe(1);

		await engine.dispose();
	});
});

// ---- Task 4.3.1: token budget --------------------------------------------

/**
 * A completing client whose assistant messages carry `tokens` metadata, so the
 * budget provider can sum real output+reasoning spend. Each launched child gets
 * a distinct session id; `session.messages` returns one assistant message with
 * the scripted token counts.
 */
function makeBudgetClient(tokens: { output: number; reasoning: number }) {
	const sessions: string[] = [];
	let seq = 0;
	return {
		sessions,
		client: {
			session: {
				create: async () => {
					seq += 1;
					const id = `ses_child_${seq}`;
					sessions.push(id);
					return { data: { id } };
				},
				promptAsync: async () => undefined,
				abort: async () => undefined,
				messages: async () => ({
					data: [
						{
							info: {
								role: "assistant" as const,
								tokens,
								time: { created: NOW, completed: NOW },
							},
							parts: [{ type: "text", text: "REPLY" }],
						},
					],
				}),
				get: async () => ({ data: { id: "ses_child" } }),
				// Absent status = idle-equivalent; completed message = finished turn.
				status: async () => ({ data: {} }),
			},
		},
	};
}

describe("createWorkflowEngine — token budget", () => {
	test("budgetTokens threads a budget; settle fills budgetTotal/budgetSpent", async () => {
		const { facade } = makeFs();
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeBudgetClient({ output: 30, reasoning: 5 });
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_budget01"),
		});
		await engine.ready();

		const handle = await engine.startRun({
			source: ONE_AGENT,
			parentSessionID: "ses_parent",
			budgetTokens: 1000,
		});
		await flush();
		await driveIdle(engine, sessions[0] as string, bump);

		const status = engine.statusOf(handle.runId);
		expect(status?.record.status).toBe("completed");
		// One child spent 30 output + 5 reasoning = 35 against a 1000 ceiling.
		expect(status?.record.budgetTotal).toBe(1000);
		expect(status?.record.budgetSpent).toBe(35);

		await engine.dispose();
	});

	test("a live run exposes the budget view on its handle for live spend reads", async () => {
		const { facade } = makeFs();
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeBudgetClient({ output: 30, reasoning: 5 });
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_budget02"),
		});
		await engine.ready();

		const handle = await engine.startRun({
			source: ONE_AGENT,
			parentSessionID: "ses_parent",
			budgetTokens: 1000,
		});
		await flush();
		await driveIdle(engine, sessions[0] as string, bump);

		// The handle carries a live budget view reading the SAME accumulator.
		const h = engine.statusOf(handle.runId);
		expect(h?.budget?.total).toBe(1000);
		expect(h?.budget?.spent()).toBe(35);
		expect(h?.budget?.remaining()).toBe(965);

		await engine.dispose();
	});

	test("absent budgetTokens → no budget on the handle, no budget fields on the record", async () => {
		const { facade } = makeFs();
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeBudgetClient({ output: 30, reasoning: 5 });
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_budget03"),
		});
		await engine.ready();

		const handle = await engine.startRun({
			source: ONE_AGENT,
			parentSessionID: "ses_parent",
		});
		await flush();
		await driveIdle(engine, sessions[0] as string, bump);

		const status = engine.statusOf(handle.runId);
		expect(status?.record.status).toBe("completed");
		expect(status?.budget).toBeUndefined();
		expect(status?.record.budgetTotal).toBeUndefined();
		expect(status?.record.budgetSpent).toBeUndefined();

		await engine.dispose();
	});
});

describe("createWorkflowEngine — resume across restart", () => {
	test("a second engine instance over the SAME fake-fs resumes to an all-cache replay", async () => {
		const { facade, files } = makeFs();
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeCompletingClient("RESTART");
		const engine1 = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_restart01"),
		});
		await engine1.ready();
		await engine1.startRun({
			source: ONE_AGENT,
			parentSessionID: "ses_parent",
		});
		await flush();
		await driveIdle(engine1, sessions[0] as string, bump);
		expect(engine1.statusOf("wf_restart01")?.record.status).toBe("completed");
		// Phase 3: a live agent journals an intent (pre-launch) AND a settled ok line.
		const restartEntries = readJournal(files, "wf_restart01");
		expect(restartEntries.filter((e) => e.status === "ok").length).toBe(1);
		expect(restartEntries.some((e) => e.status === "intent")).toBe(true);
		await engine1.dispose();

		let creates2 = 0;
		const client2 = {
			session: {
				create: async () => {
					creates2 += 1;
					return { data: { id: "ses_c2" } };
				},
				promptAsync: async () => undefined,
				abort: async () => undefined,
				messages: async () => ({ data: [] }),
				get: async () => ({ data: { id: "ses_c2" } }),
				status: async () => ({ data: {} }),
			},
		};
		const engine2 = createWorkflowEngine({
			client: client2,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: { now: () => NOW },
			logger: noopLogger,
			ids: fixedIds("wf_restart02"),
		});
		await engine2.ready();

		const handle = await engine2.startRun({
			resumeFromRunId: "wf_restart01",
			parentSessionID: "ses_parent",
		});
		await flush();

		const status = engine2.statusOf(handle.runId);
		expect(status?.record.status).toBe("completed");
		expect(status?.record.returnValue).toBe("RESTART");
		expect(status?.record.resumedFrom).toBe("wf_restart01");
		expect(creates2).toBe(0);

		await engine2.dispose();
	});
});

describe("createWorkflowEngine — write-ahead intent journal (Phase 3.1.3)", () => {
	test("a live agent writes a durable intent line BEFORE its settled ok line", async () => {
		const { facade, files } = makeFs();
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeCompletingClient("WROTE");
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_intent001"),
		});
		await engine.ready();
		await engine.startRun({ source: ONE_AGENT, parentSessionID: "ses_parent" });
		await flush();
		await driveIdle(engine, sessions[0] as string, bump);
		await engine.statusOf("wf_intent001")?.settled;
		expect(engine.statusOf("wf_intent001")?.record.status).toBe("completed");

		// The journal carries BOTH the write-ahead intent AND the settled completion,
		// sharing index+key. The intent must precede its ok (written before launch).
		const lines = readJournal(files, "wf_intent001");
		const intent = lines.find((l) => l.status === "intent");
		const settled = lines.find((l) => l.status === "ok");
		expect(intent).toBeDefined();
		expect(settled).toBeDefined();
		expect(intent?.index).toBe(settled?.index as number);
		expect(intent?.key).toBe(settled?.key as string);
		const intentPos = lines.findIndex((l) => l.status === "intent");
		const settledPos = lines.findIndex((l) => l.status === "ok");
		expect(intentPos).toBeLessThan(settledPos);

		await engine.dispose();
	});

	test("resume filters out an intent-only prior journal — the call re-runs LIVE", async () => {
		// An interrupted prior run left ONLY an intent line (crash before settle). On
		// resume the load-filter drops it, so the unsettled call runs live (a real
		// child is created), never replaying a nonexistent result.
		const key = computeCallKey({ prompt: "do work" });
		const priorRecord = {
			id: "wf_crash0001",
			parentSessionID: "ses_parent",
			status: "error",
			description: "crashed",
			createdAt: NOW - 1000,
			completedAt: NOW - 500,
			scriptPath: `${BASE}/workflow-scripts/wf_crash0001.js`,
		};
		const intentOnly: JournalEntry[] = [{ index: 0, key, status: "intent" }];
		const warns: Array<{ msg: string }> = [];
		const captureLogger = {
			debug: () => {},
			info: () => {},
			warn: (msg: string) => warns.push({ msg }),
			error: () => {},
		};
		const { facade } = makeFs({
			[`${BASE}/workflow-scripts/wf_crash0001.js`]: ONE_AGENT,
			[JOURNALS("wf_crash0001")]: jsonl(intentOnly),
			[`${BASE}/workflow-runs/wf_crash0001.json`]: JSON.stringify(priorRecord),
		});
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeCompletingClient("RERUN");
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: captureLogger,
			ids: fixedIds("wf_resume_x1"),
		});
		await engine.ready();

		const handle = await engine.startRun({
			resumeFromRunId: "wf_crash0001",
			parentSessionID: "ses_parent",
		});
		await flush();
		// A live child WAS created — the unsettled call did not replay.
		expect(sessions.length).toBe(1);
		await driveIdle(engine, sessions[0] as string, bump);
		await engine.statusOf(handle.runId)?.settled;
		expect(engine.statusOf(handle.runId)?.record.status).toBe("completed");
		expect(engine.statusOf(handle.runId)?.record.returnValue).toBe("RERUN");

		// Post-filter the prior journal is empty (the lone intent was dropped), so the
		// "running live" warn fires — there are no settled results to replay.
		expect(warns.some((w) => /running live/.test(w.msg))).toBe(true);

		await engine.dispose();
	});
});

describe("createWorkflowEngine — live progress feed (Task 8.1.2)", () => {
	// A completed run must leave a parseable JSONL feed bracketed by run:start /
	// run:end, with every engine-stamped progress event in between mirroring
	// handle.progress (same enriched stream, one source of truth). Driven via the
	// all-cache resume path: a seeded journal replays as cached against the inert
	// client, so the run completes deterministically with agent:start/agent:end
	// progress events and no live child needed.
	test("a completed run leaves run:start … events … run:end matching handle.progress", async () => {
		const SCRIPT = `${META}const r = await agent("do work", { label: "a" });\nreturn r;\n`;
		const key = computeCallKey({ prompt: "do work" });
		const seeded: JournalEntry[] = [
			{ index: 0, key, status: "ok", result: "CACHED" },
		];
		const priorRecord = {
			id: "wf_prior001",
			parentSessionID: "ses_parent",
			status: "completed",
			description: "demo",
			createdAt: NOW - 1000,
			completedAt: NOW - 500,
			scriptPath: `${BASE}/workflow-scripts/wf_prior001.js`,
		};
		const { facade, files } = makeFs({
			[`${BASE}/workflow-scripts/wf_prior001.js`]: SCRIPT,
			[JOURNALS("wf_prior001")]: jsonl(seeded),
			[`${BASE}/workflow-runs/wf_prior001.json`]: JSON.stringify(priorRecord),
		});
		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock,
			logger: noopLogger,
			ids: fixedIds("wf_feed0001"),
		});
		await engine.ready();

		const handle = await engine.startRun({
			resumeFromRunId: "wf_prior001",
			parentSessionID: "ses_parent",
		});
		await engine.statusOf(handle.runId)?.settled;
		expect(engine.statusOf(handle.runId)?.record.status).toBe("completed");

		const lines = readFeed(files, "wf_feed0001");
		// First line frames the run; last line settles it.
		expect(lines[0]?.type).toBe("run:start");
		expect(lines[0]?.runId).toBe("wf_feed0001");
		expect(lines[0]?.parentSessionID).toBe("ses_parent");
		expect(lines[0]?.scriptPath).toBe(handle.scriptPath);
		// The producer seam: the engine stamps `name` from the script META
		// (`name: "demo"`) onto run:start — every TUI header read of the run name
		// depends on this. Without it the viewer silently falls back to the raw runId.
		expect(lines[0]?.name).toBe("demo");
		expect(lines.at(-1)?.type).toBe("run:end");
		expect(lines.at(-1)?.status).toBe("completed");

		// The interior lines are exactly the stamped progress events the handle
		// carries, in order — feed and handle.progress are the same stream.
		const interior = lines.slice(1, -1);
		const progress = engine.statusOf(handle.runId)?.progress ?? [];
		expect(interior).toEqual(progress as unknown as typeof interior);
		// The cached call emitted agent:start + agent:end (no agent:launched).
		expect(interior.some((l) => l.type === "agent:start")).toBe(true);
		expect(interior.some((l) => l.type === "agent:end")).toBe(true);

		await engine.dispose();
	});

	test("a feed-write failure cannot fail the run (fenced): run still completes", async () => {
		// An fs whose writeFile/append synthesis throws for the feed file only would
		// be brittle to target; instead inject a feed fs via a facade whose appendFile
		// path always errors. The simplest deterministic seam: a facade whose
		// readFile/writeFile work for scripts/journals/records but whose feed writes
		// blow up. We model that by making writeFile throw for any feed path.
		const SCRIPT = `${META}const r = await agent("do work", { label: "a" });\nreturn r;\n`;
		const key = computeCallKey({ prompt: "do work" });
		const seeded: JournalEntry[] = [
			{ index: 0, key, status: "ok", result: "CACHED" },
		];
		const priorRecord = {
			id: "wf_prior002",
			parentSessionID: "ses_parent",
			status: "completed",
			description: "demo",
			createdAt: NOW - 1000,
			completedAt: NOW - 500,
			scriptPath: `${BASE}/workflow-scripts/wf_prior002.js`,
		};
		const { facade, files } = makeFs({
			[`${BASE}/workflow-scripts/wf_prior002.js`]: SCRIPT,
			[JOURNALS("wf_prior002")]: jsonl(seeded),
			[`${BASE}/workflow-runs/wf_prior002.json`]: JSON.stringify(priorRecord),
		});
		// Wrap writeFile so any feed-path write throws — the run must survive.
		const baseWrite = facade.writeFile.bind(facade);
		facade.writeFile = async (path: string, data: string, enc: "utf-8") => {
			if (path.includes("/workflow-feed/")) {
				throw new Error("EIO: feed disk on fire");
			}
			return baseWrite(path, data, enc);
		};
		const errors: string[] = [];
		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock,
			logger: { ...noopLogger, error: (msg) => errors.push(msg) },
			ids: fixedIds("wf_feed0002"),
		});
		await engine.ready();

		const handle = await engine.startRun({
			resumeFromRunId: "wf_prior002",
			parentSessionID: "ses_parent",
		});
		await engine.statusOf(handle.runId)?.settled;

		// The run completes despite the feed disk being on fire.
		expect(engine.statusOf(handle.runId)?.record.status).toBe("completed");
		expect(engine.statusOf(handle.runId)?.record.returnValue).toBe("CACHED");
		// Nothing was written; the writer logged its single failure line.
		expect(readFeed(files, "wf_feed0002")).toEqual([]);
		expect(errors.some((e) => e.includes("feed"))).toBe(true);

		await engine.dispose();
	});

	test("a facade with a native appendFile drives feed writes O(1) — no read-modify-write per line", async () => {
		// The production facade (node:fs/promises) exposes a native appendFile. The
		// feed is the high-frequency observability bus, so each line MUST go through
		// that O(1) append — NOT the read-modify-write synthesis (which re-reads the
		// whole growing file per line, O(n²) overall). We assert it by injecting a
		// facade whose appendFile is real but whose readFile would throw if the feed
		// path were ever read back — proving the synthesis path is not taken.
		const SCRIPT = `${META}const r = await agent("do work", { label: "a" });\nreturn r;\n`;
		const key = computeCallKey({ prompt: "do work" });
		const seeded: JournalEntry[] = [
			{ index: 0, key, status: "ok", result: "CACHED" },
		];
		const priorRecord = {
			id: "wf_prior003",
			parentSessionID: "ses_parent",
			status: "completed",
			description: "demo",
			createdAt: NOW - 1000,
			completedAt: NOW - 500,
			scriptPath: `${BASE}/workflow-scripts/wf_prior003.js`,
		};
		const { facade, files } = makeFs({
			[`${BASE}/workflow-scripts/wf_prior003.js`]: SCRIPT,
			[JOURNALS("wf_prior003")]: jsonl(seeded),
			[`${BASE}/workflow-runs/wf_prior003.json`]: JSON.stringify(priorRecord),
		});
		// Native append: concatenate onto the in-memory file, exactly like
		// node:fs/promises.appendFile. Count the calls per feed path.
		const appendCalls = new Map<string, number>();
		facade.appendFile = async (path: string, data: string) => {
			appendCalls.set(path, (appendCalls.get(path) ?? 0) + 1);
			files.set(path, (files.get(path) ?? "") + data);
		};
		// Trap any read-back of the feed file — the O(1) path must never read it.
		const baseRead = facade.readFile.bind(facade);
		const feedReads: string[] = [];
		facade.readFile = async (path: string, enc: "utf-8") => {
			if (path.includes("/workflow-feed/")) {
				feedReads.push(path);
			}
			return baseRead(path, enc);
		};
		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock,
			logger: noopLogger,
			ids: fixedIds("wf_feed0003"),
		});
		await engine.ready();

		const handle = await engine.startRun({
			resumeFromRunId: "wf_prior003",
			parentSessionID: "ses_parent",
		});
		await engine.statusOf(handle.runId)?.settled;
		expect(engine.statusOf(handle.runId)?.record.status).toBe("completed");

		// The feed was written via native appendFile, once per line, and NEVER read
		// back (no read-modify-write).
		expect(appendCalls.get(FEED("wf_feed0003")) ?? 0).toBeGreaterThan(0);
		expect(feedReads).toEqual([]);
		const lines = readFeed(files, "wf_feed0003");
		expect(lines.at(0)?.type).toBe("run:start");
		expect(lines.at(-1)?.type).toBe("run:end");

		await engine.dispose();
	});
});

// ---- Task 8.1.3: session stats collector → throttled agent:stats feed lines ---

/** A synthetic `message.updated` for an assistant message with explicit tokens. */
function msgUpdated(
	sessionID: string,
	messageID: string,
	tokens: {
		input: number;
		output: number;
		reasoning: number;
		cache: { read: number; write: number };
	},
	// biome-ignore lint/suspicious/noExplicitAny: the collector reads a structural slice only.
): any {
	return {
		type: "message.updated",
		properties: {
			info: { id: messageID, sessionID, role: "assistant", tokens },
		},
	};
}

/** A synthetic completed `message.part.updated` tool part. */
function toolPart(
	sessionID: string,
	partID: string,
	tool: string,
	// biome-ignore lint/suspicious/noExplicitAny: structural slice only.
): any {
	return {
		type: "message.part.updated",
		properties: {
			part: {
				id: partID,
				sessionID,
				messageID: "msg_x",
				type: "tool",
				callID: `call_${partID}`,
				tool,
				state: { status: "completed", input: {} },
			},
		},
	};
}

describe("createWorkflowEngine — session stats → agent:stats feed (Task 8.1.3)", () => {
	test("a launched child's token/tool stats emit throttled agent:stats lines, and stop after settle", async () => {
		const { facade, files } = makeFs();
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeCompletingClient("DONE");
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_stats001"),
		});
		await engine.ready();

		const handle = await engine.startRun({
			source: `${META}const r = await agent("do work", { label: "worker" });\nreturn r;\n`,
			parentSessionID: "ses_parent",
		});
		// After flush the agent has launched: agent:launched fired through the choke
		// point, so the child session is REGISTERED with the collector.
		await flush();
		const child = sessions[0] as string;

		// First stats change → emits one agent:stats (no prior emission this window).
		engine.handleEvent(
			msgUpdated(child, "msg_1", {
				input: 100,
				output: 10,
				reasoning: 0,
				cache: { read: 0, write: 0 },
			}),
		);
		// A second change WITHIN the 2000ms window must be throttled (no new line).
		bump(500);
		engine.handleEvent(toolPart(child, "prt_1", "bash"));
		// A third change PAST the window emits again.
		bump(2000);
		engine.handleEvent(toolPart(child, "prt_2", "read"));
		await flush();

		const stats = readFeed(files, "wf_stats001").filter(
			(l) => l.type === "agent:stats",
		);
		// Exactly two emissions: window 1 (the token update) and window 2 (past 2s).
		expect(stats).toHaveLength(2);
		// Each carries the session↔label binding and the rolled-up snapshot.
		expect(stats[0]?.sessionID).toBe(child);
		expect(stats[0]?.label).toBe("worker");
		expect(stats[0]?.tokens).toEqual({
			input: 100,
			output: 10,
			reasoning: 0,
			cacheRead: 0,
			cacheWrite: 0,
		});
		// The second line reflects the accumulated tool calls (the throttled bash +
		// the windowed read both counted in the collector by emit time).
		expect(stats[1]?.toolCalls).toBe(2);
		expect(stats[1]?.lastTools).toEqual(["bash({})", "read({})"]);
		// agent:stats is feed-only — it never lands in handle.progress.
		const progress = engine.statusOf(handle.runId)?.progress ?? [];
		expect(
			progress.some((e) => (e as { type: string }).type === "agent:stats"),
		).toBe(false);

		// Complete the run; the child unregisters at agent:end.
		bump(6000);
		await driveIdle(engine, child, bump);
		expect(engine.statusOf(handle.runId)?.record.status).toBe("completed");

		// A post-settle event for the now-unregistered child emits nothing further.
		const before = readFeed(files, "wf_stats001").filter(
			(l) => l.type === "agent:stats",
		).length;
		engine.handleEvent(toolPart(child, "prt_3", "grep"));
		await flush();
		const after = readFeed(files, "wf_stats001").filter(
			(l) => l.type === "agent:stats",
		).length;
		expect(after).toBe(before);

		await engine.dispose();
	});
});

// ---- Task 8.1.4: enriched agent:end + per-agent rollup on the RunRecord -----

describe("createWorkflowEngine — enriched agent:end + RunRecord.agents (Task 8.1.4)", () => {
	test("a live agent:end is enriched with durationMs/tokens/toolCalls/model/agentType in BOTH the feed and handle.progress, and rolled up onto RunRecord.agents", async () => {
		const { facade, files } = makeFs();
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeCompletingClient("DONE");
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_enr0001"),
		});
		await engine.ready();

		const handle = await engine.startRun({
			source: `${META}const r = await agent("do work", { label: "worker", phase: "Impl", model: "anthropic/claude-opus-4-8", agentType: "reviewer" });\nreturn r;\n`,
			parentSessionID: "ses_parent",
		});
		// agent:launched fires through the choke at this clock instant.
		await flush();
		const child = sessions[0] as string;
		const launchedAt = mclock.now();

		// Feed token + tool stats for the child before it ends, so the collector's
		// final snapshot is non-empty at agent:end time.
		engine.handleEvent(
			msgUpdated(child, "msg_1", {
				input: 200,
				output: 50,
				reasoning: 5,
				cache: { read: 1, write: 2 },
			}),
		);
		engine.handleEvent(toolPart(child, "prt_1", "bash"));
		engine.handleEvent(toolPart(child, "prt_2", "read"));
		await flush();

		// Advance the clock so durationMs = end - launchedAt is a known delta, then
		// drive the child to completion (driveIdle bumps another 6000ms first).
		bump(1234);
		await driveIdle(engine, child, bump);
		const endAt = mclock.now();
		const expectedDuration = endAt - launchedAt;

		expect(engine.statusOf(handle.runId)?.record.status).toBe("completed");

		// (1) The agent:end line in the feed carries the enrichment.
		const feed = readFeed(files, "wf_enr0001");
		const feedEnd = feed.find((l) => l.type === "agent:end");
		expect(feedEnd).toBeDefined();
		expect(feedEnd?.sessionID).toBe(child);
		expect(feedEnd?.durationMs).toBe(expectedDuration);
		expect(feedEnd?.model).toBe("anthropic/claude-opus-4-8");
		expect(feedEnd?.agentType).toBe("reviewer");
		expect(feedEnd?.toolCalls).toBe(2);
		expect(feedEnd?.tokens).toEqual({
			input: 200,
			output: 50,
			reasoning: 5,
			cacheRead: 1,
			cacheWrite: 2,
		});

		// (2) handle.progress carries the SAME enriched values — one source of truth.
		const progress = engine.statusOf(handle.runId)?.progress ?? [];
		const progEnd = progress.find(
			(e) => (e as { type: string }).type === "agent:end",
		) as Record<string, unknown> | undefined;
		expect(progEnd).toBeDefined();
		expect(progEnd?.durationMs).toBe(expectedDuration);
		expect(progEnd?.model).toBe("anthropic/claude-opus-4-8");
		expect(progEnd?.agentType).toBe("reviewer");
		expect(progEnd?.toolCalls).toBe(2);
		expect(progEnd?.tokens).toEqual({
			input: 200,
			output: 50,
			reasoning: 5,
			cacheRead: 1,
			cacheWrite: 2,
		});

		// (3) The settled record's agents array matches the enriched end.
		const agents = engine.statusOf(handle.runId)?.record.agents ?? [];
		expect(agents).toHaveLength(1);
		expect(agents[0]).toMatchObject({
			label: "worker",
			phase: "Impl",
			sessionID: child,
			model: "anthropic/claude-opus-4-8",
			agentType: "reviewer",
			status: "completed",
			toolCalls: 2,
			durationMs: expectedDuration,
		});
		expect(agents[0]?.tokens).toEqual({
			input: 200,
			output: 50,
			reasoning: 5,
			cacheRead: 1,
			cacheWrite: 2,
		});

		await engine.dispose();
	});

	test("a cached agent:end passes through unenriched and rolls up a stats-free cached entry carrying label/phase/status", async () => {
		// Resume with a seeded journal: the call replays as cached → agent:start +
		// agent:end{status:"cached"} with NO sessionID, so the choke leaves it
		// untouched and the summary carries only label/phase/status.
		const SCRIPT = `${META}const r = await agent("do work", { label: "cachee", phase: "Review" });\nreturn r;\n`;
		const key = computeCallKey({
			prompt: "do work",
		});
		const seeded: JournalEntry[] = [
			{ index: 0, key, status: "ok", result: "CACHED" },
		];
		const priorRecord = {
			id: "wf_enrprior",
			parentSessionID: "ses_parent",
			status: "completed",
			description: "demo",
			createdAt: NOW - 1000,
			completedAt: NOW - 500,
			scriptPath: `${BASE}/workflow-scripts/wf_enrprior.js`,
		};
		const { facade, files } = makeFs({
			[`${BASE}/workflow-scripts/wf_enrprior.js`]: SCRIPT,
			[JOURNALS("wf_enrprior")]: jsonl(seeded),
			[`${BASE}/workflow-runs/wf_enrprior.json`]: JSON.stringify(priorRecord),
		});
		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock,
			logger: noopLogger,
			ids: fixedIds("wf_enr0002"),
		});
		await engine.ready();

		const handle = await engine.startRun({
			resumeFromRunId: "wf_enrprior",
			parentSessionID: "ses_parent",
		});
		await engine.statusOf(handle.runId)?.settled;
		expect(engine.statusOf(handle.runId)?.record.status).toBe("completed");

		// The cached agent:end carries no enrichment fields.
		const feed = readFeed(files, "wf_enr0002");
		const feedEnd = feed.find((l) => l.type === "agent:end");
		expect(feedEnd).toBeDefined();
		expect(feedEnd?.status).toBe("cached");
		expect(feedEnd?.sessionID).toBeUndefined();
		expect(feedEnd?.durationMs).toBeUndefined();
		expect(feedEnd?.tokens).toBeUndefined();
		expect(feedEnd?.toolCalls).toBeUndefined();

		// The rolled-up summary carries only label/phase/status (no stats).
		const agents = engine.statusOf(handle.runId)?.record.agents ?? [];
		expect(agents).toHaveLength(1);
		expect(agents[0]).toEqual({
			label: "cachee",
			phase: "Review",
			status: "cached",
		});

		await engine.dispose();
	});

	test("a cancelled run persists the partial agents accumulated through the stop", async () => {
		const { facade } = makeFs();
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeCompletingClient("DONE");
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_enr0003"),
		});
		await engine.ready();

		// Two sequential agents: the first completes (enriched end → accumulated),
		// the second is in flight when the run is stopped. Aborting the run settles
		// the in-flight agent on a non-completed terminal status, so its end fires
		// too — the rollup captures BOTH, proving partial agents survive a cancel.
		const handle = await engine.startRun({
			source: `${META}const a = await agent("first", { label: "one", phase: "P" });\nconst b = await agent("second", { label: "two", phase: "P" });\nreturn [a, b];\n`,
			parentSessionID: "ses_parent",
		});
		await flush();
		const first = sessions[0] as string;
		const launchedAt = mclock.now();
		bump(500);
		await driveIdle(engine, first, bump);
		const firstEndAt = mclock.now();

		// The second agent has launched but never idles; stop it mid-flight.
		await flush();
		expect(sessions.length).toBe(2);
		const second = sessions[1] as string;
		engine.stopRun(handle.runId);
		await flush();

		const status = engine.statusOf(handle.runId);
		expect(status?.record.status).toBe("cancelled");

		const agents = status?.record.agents ?? [];
		expect(agents).toHaveLength(2);
		// The first agent completed cleanly before the stop — full enriched summary.
		expect(agents[0]).toMatchObject({
			label: "one",
			phase: "P",
			sessionID: first,
			status: "completed",
			toolCalls: 0,
			durationMs: firstEndAt - launchedAt,
		});
		// The second agent's end fired on the abort with a non-completed status; it is
		// still rolled up (partial truth), keyed to its own session.
		expect(agents[1]).toMatchObject({
			label: "two",
			phase: "P",
			sessionID: second,
			status: "cancelled",
		});

		await engine.dispose();
	});

	test("a cancel with an in-flight child still leaves run:end as the LAST feed line", async () => {
		const { facade, files } = makeFs();
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeCompletingClient("DONE");
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_cxl0001"),
		});
		await engine.ready();

		// Two sequential agents: the first completes, the second is in flight at stop.
		// Aborting flips the second child terminal, so its `agent:end` flushes through
		// onProgress AFTER stopRun returns — the feed must still close with run:end.
		const handle = await engine.startRun({
			source: `${META}const a = await agent("first", { label: "one", phase: "P" });\nconst b = await agent("second", { label: "two", phase: "P" });\nreturn [a, b];\n`,
			parentSessionID: "ses_parent",
		});
		await flush();
		const first = sessions[0] as string;
		bump(500);
		await driveIdle(engine, first, bump);

		await flush();
		expect(sessions.length).toBe(2);
		engine.stopRun(handle.runId);
		// Let the abort round-trip resolve the in-flight child + drain the settle chain.
		await engine.statusOf(handle.runId)?.settled;
		await flush();

		const status = engine.statusOf(handle.runId);
		expect(status?.record.status).toBe("cancelled");

		const lines = readFeed(files, "wf_cxl0001");
		// The framing invariant: first line run:start, LAST line run:end — even though
		// the in-flight child's agent:end fired after stopRun.
		expect(lines.at(0)?.type).toBe("run:start");
		expect(lines.at(-1)?.type).toBe("run:end");
		expect(lines.at(-1)?.status).toBe("cancelled");
		// The in-flight (second) agent's end is present and lands BEFORE run:end.
		const ends = lines.filter((l) => l.type === "agent:end");
		expect(ends.length).toBe(2);
		const lastEndIdx = lines.map((l) => l.type).lastIndexOf("agent:end");
		const runEndIdx = lines.map((l) => l.type).lastIndexOf("run:end");
		expect(lastEndIdx).toBeLessThan(runEndIdx);

		await engine.dispose();
	});
});

// ---- Task 8.2.2: external control channel (sentinel cancel) ---------------

const CONTROL = `${BASE}/workflow-control`;

/**
 * Capture the control watcher's interval callback through the injected seam so a
 * test can fire a poll deterministically (no real timers). Returns the captured
 * callback box and the inject-able fns the engine wires straight into the watcher.
 */
function captureControlTick() {
	const box: { cb?: () => void } = {};
	return {
		box,
		setIntervalFn: (cb: () => void) => {
			box.cb = cb;
			return 1;
		},
		clearIntervalFn: () => {},
	};
}

describe("createWorkflowEngine — external control channel (Task 8.2.2)", () => {
	test("a `<runId>.cancel` sentinel cancels the live run, brackets the feed with cancel-requested before run:end, and consumes the sentinel", async () => {
		const { facade, files } = makeFs();
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeCompletingClient("DONE");
		const tick = captureControlTick();
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_ctl0001"),
			setIntervalFn: tick.setIntervalFn,
			clearIntervalFn: tick.clearIntervalFn,
		});
		await engine.ready();

		// Two sequential agents: drive the first to completion, then cancel via the
		// sentinel while the second is in flight — mirroring the live-cancel path so
		// the detached settle branch writes the terminal run:end after the aborted
		// child's agent:end drains.
		const handle = await engine.startRun({
			source: `${META}const a = await agent("first", { label: "one", phase: "P" });\nconst b = await agent("second", { label: "two", phase: "P" });\nreturn [a, b];\n`,
			parentSessionID: "ses_parent",
		});
		await flush();
		const first = sessions[0] as string;
		bump(500);
		await driveIdle(engine, first, bump);
		await flush();
		expect(sessions.length).toBe(2);
		expect(engine.statusOf(handle.runId)?.record.status).toBe("running");

		// The external actor drops the sentinel into the control dir, then the
		// engine's poll fires.
		files.set(`${CONTROL}/${handle.runId}.cancel`, "");
		tick.box.cb?.();
		await engine.statusOf(handle.runId)?.settled;
		await flush();

		expect(engine.statusOf(handle.runId)?.record.status).toBe("cancelled");

		// The sentinel was consumed.
		expect(files.has(`${CONTROL}/${handle.runId}.cancel`)).toBe(false);

		// The feed carries run:cancel-requested BEFORE the terminal run:end.
		const lines = readFeed(files, handle.runId);
		const types = lines.map((l) => l.type);
		expect(types).toContain("run:cancel-requested");
		const cancelIdx = types.indexOf("run:cancel-requested");
		const runEndIdx = types.lastIndexOf("run:end");
		expect(cancelIdx).toBeGreaterThanOrEqual(0);
		expect(cancelIdx).toBeLessThan(runEndIdx);
		expect(lines.at(-1)?.type).toBe("run:end");
		expect(lines.at(-1)?.status).toBe("cancelled");

		await engine.dispose();
	});

	test("a sentinel for an unknown runId is consumed with no record change and no feed", async () => {
		const { facade, files } = makeFs();
		const tick = captureControlTick();
		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock,
			logger: noopLogger,
			ids: fixedIds("wf_ctl0002"),
			setIntervalFn: tick.setIntervalFn,
			clearIntervalFn: tick.clearIntervalFn,
		});
		await engine.ready();

		files.set(`${CONTROL}/wf_ghost.cancel`, "");
		tick.box.cb?.();
		await flush();

		// No run exists for the ghost id; nothing settles, but the stale sentinel is
		// consumed so it cannot accumulate or re-fire.
		expect(engine.statusOf("wf_ghost")).toBeUndefined();
		expect(files.has(`${CONTROL}/wf_ghost.cancel`)).toBe(false);
		expect(readFeed(files, "wf_ghost")).toEqual([]);

		await engine.dispose();
	});

	test("dispose() clears the control poll interval (no tick races a disposed engine)", async () => {
		const { facade } = makeFs();
		// Real handle id so clearIntervalFn receives exactly what setIntervalFn returned.
		const armed: number[] = [];
		const cleared: number[] = [];
		let seq = 0;
		const engine = createWorkflowEngine({
			client: makeClient(),
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock,
			logger: noopLogger,
			ids: fixedIds("wf_ctl0003"),
			setIntervalFn: (_cb: () => void) => {
				seq += 1;
				armed.push(seq);
				return seq;
			},
			clearIntervalFn: (handle: unknown) => {
				cleared.push(handle as number);
			},
		});
		await engine.ready();

		// The watcher arms exactly one interval at construction.
		expect(armed).toEqual([1]);
		expect(cleared).toEqual([]);

		await engine.dispose();

		// dispose() must stop the watcher, clearing the same handle setInterval returned.
		expect(cleared).toEqual([1]);
	});
});

// ---- Epic 0.1: live worker-session identity (isWorkerSession) --------------

describe("createWorkflowEngine — isWorkerSession (Epic 0.1)", () => {
	test("true between agent:launched and agent:end, false before/after and for unrelated ids", async () => {
		const { facade } = makeFs();
		const { clock: mclock, bump } = bumpClock(NOW);
		const { client, sessions } = makeCompletingClient("DONE");
		const engine = createWorkflowEngine({
			client,
			directory: "/proj",
			dataDir: BASE,
			fs: facade,
			clock: mclock,
			logger: noopLogger,
			ids: fixedIds("wf_worker01"),
		});
		await engine.ready();

		// Before any launch: the parent and an unrelated id are never workers.
		expect(engine.isWorkerSession("ses_parent")).toBe(false);
		expect(engine.isWorkerSession("ses_unrelated")).toBe(false);

		const handle = await engine.startRun({
			source: `${META}const r = await agent("do work", { label: "worker" });\nreturn r;\n`,
			parentSessionID: "ses_parent",
		});
		// After flush the child has emitted agent:launched through the choke point.
		await flush();
		const child = sessions[0] as string;

		// LIVE window: the worker is a worker; the parent and unrelated ids are not.
		expect(engine.isWorkerSession(child)).toBe(true);
		expect(engine.isWorkerSession("ses_parent")).toBe(false);
		expect(engine.isWorkerSession("ses_unrelated")).toBe(false);

		// Settle the child (agent:end fires through the sessionID-bearing branch).
		await driveIdle(engine, child, bump);
		expect(engine.statusOf(handle.runId)?.record.status).toBe("completed");

		// AFTER settle: the worker window has closed.
		expect(engine.isWorkerSession(child)).toBe(false);

		await engine.dispose();
	});
});
