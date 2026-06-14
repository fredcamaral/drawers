import { afterEach, describe, expect, test } from "bun:test";
import {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { branchFor, createWorktreeManager } from "./git-worktree";

/**
 * Tests for the git-worktree module (Epic H.1.1). Mirrors the git-checkpoint
 * test harness EXACTLY: the host `$` (BunShell) is a TAGGED-TEMPLATE callable —
 * `$\`git worktree add …\`` — so the fake reconstructs the command string by
 * zipping the {@link TemplateStringsArray} with the interpolated expressions,
 * then returns a canned {@link FakeOutput} keyed by a matcher. No real git, no
 * real shell: the module is fenced and pure-by-injection.
 *
 * Beyond the checkpoint harness this models `.quiet()` on the ShellPromise (the
 * TTY-safety contract, T.1) so every git command can be asserted suppressed.
 */

interface FakeOutput {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/** A single canned reply: match the reconstructed command, return an output. */
interface Stub {
	match: (cmd: string) => boolean;
	out: FakeOutput;
}

function makeShell(stubs: Stub[] = []) {
	const commands: string[] = [];
	const reconstruct = (
		strings: TemplateStringsArray,
		expressions: unknown[],
	): string => {
		let out = strings[0] ?? "";
		for (let i = 0; i < expressions.length; i += 1) {
			out += String(expressions[i]) + (strings[i + 1] ?? "");
		}
		return out.trim();
	};
	const makeResult = (out: FakeOutput) => {
		const buf = (s: string) => ({ toString: () => s });
		return Promise.resolve({
			stdout: buf(out.stdout),
			stderr: buf(out.stderr),
			exitCode: out.exitCode,
			text: () => out.stdout,
		});
	};
	const quietedCommands: string[] = [];
	const shell = (strings: TemplateStringsArray, ...expressions: unknown[]) => {
		const cmd = reconstruct(strings, expressions);
		commands.push(cmd);
		const stub = stubs.find((s) => s.match(cmd));
		const p = makeResult(stub?.out ?? { stdout: "", stderr: "", exitCode: 0 });
		// Model `.quiet()` on the returned promise (the namespace does not carry it).
		Object.assign(p, {
			quiet: () => {
				quietedCommands.push(cmd);
				return p;
			},
		});
		return p;
	};
	const chain = Object.assign(shell, {
		cwd: () => chain,
		nothrow: () => chain,
		env: () => chain,
		braces: (path: string) => [path],
		escape: (s: string) => s,
		throws: () => chain,
	});
	// biome-ignore lint/suspicious/noExplicitAny: structural BunShell fake for tests.
	return { shell: chain as any, commands, quietedCommands };
}

const ok = (stdout = ""): FakeOutput => ({ stdout, stderr: "", exitCode: 0 });
const fail = (stderr = "boom"): FakeOutput => ({
	stdout: "",
	stderr,
	exitCode: 128,
});

function captureLogger() {
	const warns: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
	return {
		warns,
		logger: {
			debug: () => {},
			info: () => {},
			warn: (msg: string, meta?: Record<string, unknown>) =>
				warns.push({ msg, meta }),
			error: () => {},
		},
	};
}

describe("branchFor", () => {
	test("encodes runId + label into a wf/<runId>/<label> scratch branch", () => {
		expect(branchFor({ runId: "wf_1", label: "worker" })).toBe(
			"wf/wf_1/worker",
		);
	});

	test("sanitizes label segments that are illegal in a git ref", () => {
		// Spaces, slashes, and other ref-hostile chars collapse to '-' so
		// `git worktree add -b` never fails on the branch name.
		const branch = branchFor({ runId: "wf_1", label: "build the thing!" });
		expect(branch.startsWith("wf/wf_1/")).toBe(true);
		expect(branch).not.toContain(" ");
		expect(branch).not.toContain("!");
		// The runId prefix is preserved verbatim under the wf/ namespace.
		expect(branch).toContain("wf/wf_1/");
	});

	test("a pure-dot label ('.' / '..' / '...') NEVER yields a '.' or '..' segment", () => {
		// A '..' component is forbidden in a git ref (the worktree add would degrade to
		// null) AND traverses out of the managed root in the dir path (re-pointing a
		// `worktree remove --force` at a parent). A pure-dot label carries no identity →
		// it must fall back to 'agent', never survive verbatim.
		for (const label of [".", "..", "..."]) {
			const branch = branchFor({ runId: "wf_1", label });
			const segment = branch.slice("wf/wf_1/".length);
			expect(segment).not.toBe(".");
			expect(segment).not.toBe("..");
			expect(segment).toBe("agent");
		}
	});

	test("the computed dir for a '..' label still resolves UNDER the worktree root (no traversal)", async () => {
		// End-to-end guard: a '..' label must not collapse the run dir away. The minted
		// dir must remain a descendant of <repo>/../.wf-worktrees, not a parent of it.
		const { shell } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{ match: (c) => c.includes("worktree add"), out: ok() },
			{ match: (c) => c.includes("rev-parse HEAD"), out: ok("base000") },
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		const created = (await mgr.create({ runId: "wf_1", label: ".." })) as {
			dir: string;
			branch: string;
		};
		// worktreeRoot = join('/proj','..','.wf-worktrees') = '/.wf-worktrees'.
		expect(created.dir.startsWith("/.wf-worktrees/wf_1/")).toBe(true);
		// The traversal failure would have produced '/.wf-worktrees' (run dir collapsed).
		expect(created.dir).not.toBe("/.wf-worktrees");
		expect(created.dir.endsWith("/agent")).toBe(true);
		expect(created.branch).toBe("wf/wf_1/agent");
	});

	test("an all-hostile label falls back to the 'agent' segment", () => {
		// '///' has no whitelisted chars → empty after sanitize → fallback to 'agent'.
		expect(branchFor({ runId: "wf_1", label: "///" })).toBe("wf/wf_1/agent");
	});

	test("distinct labels that sanitize to the SAME segment collide (de-dup is the caller's job)", () => {
		// 'a b' (space→'-') and 'a-b' both collapse to 'a-b'. Pinning this documents that
		// the module does NOT de-dup: two agents with colliding labels share a branch+dir.
		// If isolation must survive label collisions, the CALLER must disambiguate.
		expect(branchFor({ runId: "wf_1", label: "a b" })).toBe(
			branchFor({ runId: "wf_1", label: "a-b" }),
		);
	});
});

describe("createWorktreeManager — no shell → documented no-op", () => {
	test("undefined shell yields a manager whose create returns null and the rest no-op", async () => {
		const mgr = createWorktreeManager({ shell: undefined, directory: "/proj" });
		expect(await mgr.create({ runId: "wf_1", label: "w" })).toBeNull();
		expect(await mgr.mergeBack("/wt", "wf/wf_1/w")).toEqual({ merged: true });
		expect(await mgr.isUnchanged("/wt")).toBe(true);
		await mgr.cleanup("/wt", "wf/wf_1/w");
		await mgr.sweep();
	});
});

describe("createWorktreeManager — create()", () => {
	test("adds a worktree on a scratch branch ROOTED OUTSIDE the working tree, fenced + quieted", async () => {
		const { shell, commands, quietedCommands } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{ match: (c) => c.includes("worktree add"), out: ok() },
			{ match: (c) => c.includes("rev-parse HEAD"), out: ok("base000") },
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		const res = await mgr.create({ runId: "wf_1", label: "worker" });
		expect(res).not.toBeNull();
		const created = res as { dir: string; branch: string };
		expect(created.branch).toBe("wf/wf_1/worker");

		// The worktree dir is OUTSIDE the working tree (NOT under /proj itself, NOT
		// inside /proj/.git). A sibling-rooted managed dir.
		expect(created.dir.startsWith("/proj/")).toBe(false);
		expect(created.dir.includes("/.git/")).toBe(false);

		const add = commands.find((c) => c.includes("worktree add"));
		expect(add).toBeDefined();
		// `-b <branch> <dir> HEAD` shape per the locked design.
		expect(add).toContain("worktree add -b wf/wf_1/worker");
		expect(add).toContain(created.dir);
		expect(add).toContain("HEAD");

		// Every git command was quieted (TTY safety, T.1).
		for (const c of commands.filter((c) => c.startsWith("git"))) {
			expect(quietedCommands).toContain(c);
		}
	});

	test("a non-repo (probe fails) returns null without throwing — caller degrades", async () => {
		const { shell, commands } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: fail() },
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		await expect(mgr.create({ runId: "wf_1", label: "w" })).resolves.toBeNull();
		// Never attempted the add after the dead probe.
		expect(commands.some((c) => c.includes("worktree add"))).toBe(false);
	});

	test("baseOf exposes the create-time base for a minted dir; undefined for orphans / after cleanup", async () => {
		// The engine's verifyDiff worktree arm reads this to count commits ahead, so
		// agent-COMMITTED work (clean porcelain) still counts as landed.
		const { shell } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{ match: (c) => c.includes("worktree add"), out: ok() },
			{ match: (c) => c.includes("rev-parse HEAD"), out: ok("base000") },
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		const created = (await mgr.create({ runId: "wf_1", label: "w" })) as {
			dir: string;
			branch: string;
		};
		expect(mgr.baseOf(created.dir)).toBe("base000");
		expect(mgr.baseOf("/some/orphan")).toBeUndefined();
		await mgr.cleanup(created.dir, created.branch);
		expect(mgr.baseOf(created.dir)).toBeUndefined();
	});

	test("a failed `worktree add` returns null (fenced, non-throwing)", async () => {
		const { shell } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{ match: (c) => c.includes("worktree add"), out: fail("locked") },
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		await expect(mgr.create({ runId: "wf_1", label: "w" })).resolves.toBeNull();
	});

	test("SERIALIZES concurrent creates through a single promise-chain mutex", async () => {
		// Two adds fired concurrently must not interleave: the second `worktree add`
		// only begins after the first create's whole sequence has run. We assert the
		// command ORDER proves serialization (add1 fully precedes add2).
		let resolveFirstAdd: (() => void) | undefined;
		const gate = new Promise<void>((r) => {
			resolveFirstAdd = r;
		});
		let addCount = 0;
		const order: string[] = [];
		// A bespoke shell that defers the FIRST `worktree add` until we release it.
		const commands: string[] = [];
		const reconstruct = (
			strings: TemplateStringsArray,
			expressions: unknown[],
		): string => {
			let out = strings[0] ?? "";
			for (let i = 0; i < expressions.length; i += 1) {
				out += String(expressions[i]) + (strings[i + 1] ?? "");
			}
			return out.trim();
		};
		const shellFn = (
			strings: TemplateStringsArray,
			...expressions: unknown[]
		) => {
			const cmd = reconstruct(strings, expressions);
			commands.push(cmd);
			const result = (stdout: string) => {
				const p = Promise.resolve({
					stdout: { toString: () => stdout },
					stderr: { toString: () => "" },
					exitCode: 0,
					text: () => stdout,
				});
				Object.assign(p, { quiet: () => p });
				return p;
			};
			if (cmd.includes("is-inside-work-tree")) return result("true");
			if (cmd.includes("rev-parse HEAD")) return result("base000");
			if (cmd.includes("worktree add")) {
				addCount += 1;
				const which = addCount;
				order.push(`add-start-${which}`);
				if (which === 1) {
					const p = gate.then(() => {
						order.push("add-done-1");
						return {
							stdout: { toString: () => "" },
							stderr: { toString: () => "" },
							exitCode: 0,
							text: () => "",
						};
					});
					Object.assign(p, { quiet: () => p });
					return p;
				}
				order.push(`add-done-${which}`);
				return result("");
			}
			return result("");
		};
		const chain = Object.assign(shellFn, {
			cwd: () => chain,
			nothrow: () => chain,
			env: () => chain,
			braces: (p: string) => [p],
			escape: (s: string) => s,
			throws: () => chain,
		});
		const mgr = createWorktreeManager({
			// biome-ignore lint/suspicious/noExplicitAny: structural BunShell fake.
			shell: chain as any,
			directory: "/proj",
		});

		const p1 = mgr.create({ runId: "wf_1", label: "a" });
		const p2 = mgr.create({ runId: "wf_1", label: "b" });
		// Drain microtasks until add-1 is actually IN FLIGHT. create-1 must traverse the
		// mutex link + `await alive()` + `await is-inside-work-tree` before it reaches the
		// gated `worktree add`, which is several microtask hops — a fixed `await
		// Promise.resolve()` count would check BEFORE add-1 even starts, making the
		// "add-2 blocked" assertion vacuous (order would be empty). Spin until add-1
		// starts (bounded) so the invariant is exercised mid-flight.
		for (let i = 0; i < 50 && !order.includes("add-start-1"); i += 1) {
			await Promise.resolve();
		}
		// Guard: only trust the next assertion once add-1 is genuinely in flight.
		expect(order.includes("add-start-1")).toBe(true);
		// add-1 is gated (unresolved) → the mutex must hold add-2 behind it. If creates
		// were unserialized, add-2 would already have started.
		expect(order.includes("add-start-2")).toBe(false);
		// Release the first add; both should now complete in order.
		resolveFirstAdd?.();
		await Promise.all([p1, p2]);
		// add-1's whole turn completed before add-2 began.
		expect(order.indexOf("add-done-1")).toBeLessThan(
			order.indexOf("add-start-2"),
		);
	});
});

describe("createWorktreeManager — mergeBack()", () => {
	test("a clean `merge --no-ff` returns { merged: true }, quieted", async () => {
		const { shell, commands, quietedCommands } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{ match: (c) => c.includes("merge --no-ff"), out: ok() },
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		const res = await mgr.mergeBack("/wt", "wf/wf_1/worker");
		// The merged arm now carries the ledger truth: paths from the post-merge
		// name-only diff (empty here — the fake answers ""), sha omitted (the fake's
		// default rev-parse answer is empty).
		expect(res).toEqual({ merged: true, paths: [] });
		const merge = commands.find((c) => c.includes("merge --no-ff")) as string;
		expect(merge).toContain("wf/wf_1/worker");
		// The merge commit needs an author even in a user-less repo → the identity
		// fallback precedes the subcommand, and the message carries the forensic
		// run marker parsed from the branch (discard()'s range guard contract).
		expect(merge).toContain("user.name=pi-drawers");
		expect(merge).toContain("run=wf_1");
		expect(quietedCommands).toContain(merge);
		// A clean merge never aborts.
		expect(commands.some((c) => c.includes("merge --abort"))).toBe(false);
	});

	test("a conflicting merge captures the unmerged files, aborts, returns Tier 1 conflict", async () => {
		const { shell, commands } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{
				match: (c) => c.includes("merge --no-ff"),
				out: fail("CONFLICT (content): Merge conflict in src/a.ts"),
			},
			{
				match: (c) => c.includes("diff --name-only --diff-filter=U"),
				out: ok("src/a.ts\nsrc/b.ts"),
			},
			{ match: (c) => c.includes("merge --abort"), out: ok() },
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		// No recorded base for "/wt" (mergeBack called directly) → baseRef undefined.
		const res = await mgr.mergeBack("/wt", "wf/wf_1/worker");
		expect(res).toEqual({
			conflict: true,
			branch: "wf/wf_1/worker",
			files: ["src/a.ts", "src/b.ts"],
			baseRef: undefined,
		});
		// It aborted the merge to leave the MAIN tree clean.
		expect(commands.some((c) => c.includes("merge --abort"))).toBe(true);
	});

	test("a real conflict carries the create-time base as baseRef (Tier 2 3-way context)", async () => {
		const { shell } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{ match: (c) => c.includes("worktree add"), out: ok() },
			{ match: (c) => c.includes("rev-parse HEAD"), out: ok("base000") },
			{
				match: (c) => c.includes("merge --no-ff"),
				out: fail("CONFLICT (content): Merge conflict in src/a.ts"),
			},
			{
				match: (c) => c.includes("diff --name-only --diff-filter=U"),
				out: ok("src/a.ts"),
			},
			{ match: (c) => c.includes("merge --abort"), out: ok() },
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		const created = (await mgr.create({ runId: "wf_1", label: "worker" })) as {
			dir: string;
			branch: string;
		};
		const res = await mgr.mergeBack(created.dir, created.branch);
		expect(res).toEqual({
			conflict: true,
			branch: "wf/wf_1/worker",
			files: ["src/a.ts"],
			baseRef: "base000",
		});
	});

	test("a NON-conflict merge failure (zero unmerged files) aborts and returns { failed } — NOT a phantom conflict", async () => {
		// 'local changes would be overwritten by merge' / 'not something we can merge':
		// git exits non-zero but diff --diff-filter=U is empty. Must NOT report conflict.
		const { shell, commands } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{
				match: (c) => c.includes("merge --no-ff"),
				out: fail(
					"error: Your local changes to the following files would be overwritten by merge",
				),
			},
			{
				match: (c) => c.includes("diff --name-only --diff-filter=U"),
				out: ok(""),
			},
			{ match: (c) => c.includes("merge --abort"), out: ok() },
		]);
		const { logger, warns } = captureLogger();
		const mgr = createWorktreeManager({ shell, directory: "/proj", logger });
		const res = await mgr.mergeBack("/wt", "wf/wf_1/worker");
		expect(res).toEqual({ failed: true });
		// It still aborted (harmless no-op) to leave the MAIN tree clean.
		expect(commands.some((c) => c.includes("merge --abort"))).toBe(true);
		// It warned about the degrade rather than raising a Tier 1 conflict.
		expect(warns).toHaveLength(1);
	});

	test("dead latch / no shell → { merged: true } (degrade, no git)", async () => {
		const mgr = createWorktreeManager({ shell: undefined, directory: "/proj" });
		expect(await mgr.mergeBack("/wt", "wf/wf_1/w")).toEqual({ merged: true });
	});

	test("commits the worktree's UNCOMMITTED edits onto the scratch branch BEFORE merging (no silent loss)", async () => {
		// The critical-finding guard: a worker's edits live as UNCOMMITTED changes in the
		// worktree checkout — nothing else commits them. Without a pre-merge commit, the
		// scratch branch sits at base HEAD, the merge is a no-op, and cleanup destroys the
		// work. mergeBack MUST stage the dirty paths (EXPLICIT pathspecs, never `-A`) and
		// commit them onto the branch BEFORE the merge, so the merge actually carries them.
		const { shell, commands, quietedCommands } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			// The worktree has uncommitted edits at merge-back time.
			{
				match: (c) => c.includes("status --porcelain"),
				out: ok(" M src/a.ts\n?? src/b.ts"),
			},
			{ match: (c) => c.includes("git add -- "), out: ok() },
			{ match: (c) => c.includes("commit --no-verify"), out: ok() },
			{ match: (c) => c.includes("merge --no-ff"), out: ok() },
		]);
		const res = await createWorktreeManager({
			shell,
			directory: "/proj",
		}).mergeBack("/wt", "wf/wf_1/worker");
		expect(res).toEqual({ merged: true, paths: [] });

		// It staged BOTH dirty paths as explicit pathspecs (NEVER `git add -A`).
		expect(commands.some((c) => c === "git add -- src/a.ts")).toBe(true);
		expect(commands.some((c) => c === "git add -- src/b.ts")).toBe(true);
		expect(commands.some((c) => c.includes("git add -A"))).toBe(false);

		// It committed onto the scratch branch with --no-verify + the identity fallback,
		// BEFORE the merge (commit index must precede the merge index).
		const commitIdx = commands.findIndex((c) =>
			c.includes("commit --no-verify"),
		);
		const mergeIdx = commands.findIndex((c) => c.includes("merge --no-ff"));
		expect(commitIdx).toBeGreaterThanOrEqual(0);
		expect(mergeIdx).toBeGreaterThan(commitIdx);
		const commit = commands[commitIdx] as string;
		expect(commit).toContain("user.name=pi-drawers");
		expect(commit).toContain("commit --no-verify");
		// The commit is SCOPED to the exact staged pathspecs (`-- <paths>`): real BunShell
		// escapes the interpolated array element-wise into separate args; the fake's
		// reconstruct joins with ',' — either way both staged paths ride the commit.
		expect(commit).toContain("src/a.ts");
		expect(commit).toContain("src/b.ts");
		expect(commit).toContain(" -- ");

		// Every git command quieted (TTY safety, T.1) — including the new add/commit.
		for (const c of commands.filter((c) => c.startsWith("git"))) {
			expect(quietedCommands).toContain(c);
		}
	});

	test("a clean worktree (empty porcelain) makes NO pre-merge commit", async () => {
		// When the worktree has no uncommitted edits there is nothing to commit — the
		// branch already carries whatever it carries. mergeBack must NOT fabricate an
		// empty commit; it goes straight to the merge.
		const { shell, commands } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{ match: (c) => c.includes("status --porcelain"), out: ok("") },
			{ match: (c) => c.includes("merge --no-ff"), out: ok() },
		]);
		const res = await createWorktreeManager({
			shell,
			directory: "/proj",
		}).mergeBack("/wt", "wf/wf_1/worker");
		expect(res).toEqual({ merged: true, paths: [] });
		expect(commands.some((c) => c.includes("git add"))).toBe(false);
		expect(commands.some((c) => c.includes("commit --no-verify"))).toBe(false);
	});
});

describe("createWorktreeManager — isUnchanged()", () => {
	test("clean porcelain AND zero commits ahead → true", async () => {
		const { shell } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{ match: (c) => c.includes("worktree add"), out: ok() },
			{ match: (c) => c.includes("rev-parse HEAD"), out: ok("base000") },
			{ match: (c) => c.includes("status --porcelain"), out: ok("") },
			{ match: (c) => c.includes("rev-list --count"), out: ok("0") },
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		const created = (await mgr.create({ runId: "wf_1", label: "w" })) as {
			dir: string;
			branch: string;
		};
		expect(await mgr.isUnchanged(created.dir)).toBe(true);
	});

	test("dirty porcelain → false (worktree edits not yet committed)", async () => {
		const { shell } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{ match: (c) => c.includes("worktree add"), out: ok() },
			{ match: (c) => c.includes("rev-parse HEAD"), out: ok("base000") },
			{
				match: (c) => c.includes("status --porcelain"),
				out: ok(" M src/a.ts"),
			},
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		const created = (await mgr.create({ runId: "wf_1", label: "w" })) as {
			dir: string;
			branch: string;
		};
		expect(await mgr.isUnchanged(created.dir)).toBe(false);
	});

	test("clean porcelain BUT commits ahead of base → false", async () => {
		const { shell } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{ match: (c) => c.includes("worktree add"), out: ok() },
			{ match: (c) => c.includes("rev-parse HEAD"), out: ok("base000") },
			{ match: (c) => c.includes("status --porcelain"), out: ok("") },
			{ match: (c) => c.includes("rev-list --count"), out: ok("2") },
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		const created = (await mgr.create({ runId: "wf_1", label: "w" })) as {
			dir: string;
			branch: string;
		};
		expect(await mgr.isUnchanged(created.dir)).toBe(false);
	});

	test("an unknown dir (no recorded base) treats commits-ahead as unknown → not unchanged when dirty", async () => {
		// Defensive: isUnchanged on a dir the manager never minted still fences on
		// porcelain. A dirty unknown dir is changed.
		const { shell } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{
				match: (c) => c.includes("status --porcelain"),
				out: ok(" M x.ts"),
			},
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		expect(await mgr.isUnchanged("/some/orphan")).toBe(false);
	});

	test("a CLEAN orphan dir (no recorded base) is NOT provably unchanged → false (never drops work)", async () => {
		// The safe-default: with no recorded base we cannot count commits-ahead, so even a
		// clean porcelain cannot PROVE the worktree is unchanged. Returning true here would
		// route a committed-but-base-lost worktree to cleanup and drop its branch. Must be
		// false so the caller merges instead.
		const { shell, commands } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{ match: (c) => c.includes("status --porcelain"), out: ok("") },
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		expect(await mgr.isUnchanged("/some/orphan")).toBe(false);
		// It never reaches rev-list (no base to diff against).
		expect(commands.some((c) => c.includes("rev-list --count"))).toBe(false);
	});

	test("a non-zero `status --porcelain` is NOT provably unchanged → false (safe default)", async () => {
		const { shell } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{ match: (c) => c.includes("worktree add"), out: ok() },
			{ match: (c) => c.includes("rev-parse HEAD"), out: ok("base000") },
			{ match: (c) => c.includes("status --porcelain"), out: fail() },
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		const created = (await mgr.create({ runId: "wf_1", label: "w" })) as {
			dir: string;
			branch: string;
		};
		expect(await mgr.isUnchanged(created.dir)).toBe(false);
	});

	test("a clean porcelain but failing `rev-list --count` is NOT provably unchanged → false", async () => {
		const { shell } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{ match: (c) => c.includes("worktree add"), out: ok() },
			{ match: (c) => c.includes("rev-parse HEAD"), out: ok("base000") },
			{ match: (c) => c.includes("status --porcelain"), out: ok("") },
			{ match: (c) => c.includes("rev-list --count"), out: fail() },
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		const created = (await mgr.create({ runId: "wf_1", label: "w" })) as {
			dir: string;
			branch: string;
		};
		expect(await mgr.isUnchanged(created.dir)).toBe(false);
	});
});

describe("createWorktreeManager — cleanup()", () => {
	test("removes the worktree --force then deletes the branch, both fenced + quieted", async () => {
		const { shell, commands, quietedCommands } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{ match: (c) => c.includes("worktree remove"), out: ok() },
			{ match: (c) => c.includes("branch -D"), out: ok() },
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		await mgr.cleanup("/wt", "wf/wf_1/worker");
		const remove = commands.find((c) =>
			c.includes("worktree remove"),
		) as string;
		expect(remove).toContain("--force");
		expect(remove).toContain("/wt");
		const del = commands.find((c) => c.includes("branch -D")) as string;
		expect(del).toContain("wf/wf_1/worker");
		expect(quietedCommands).toContain(remove);
		expect(quietedCommands).toContain(del);
	});

	test("a failing remove does NOT prevent the branch delete (best-effort, fenced)", async () => {
		const { shell, commands } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{ match: (c) => c.includes("worktree remove"), out: fail("busy") },
			{ match: (c) => c.includes("branch -D"), out: ok() },
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		await expect(mgr.cleanup("/wt", "wf/wf_1/worker")).resolves.toBeUndefined();
		expect(commands.some((c) => c.includes("branch -D"))).toBe(true);
	});
});

describe("createWorktreeManager — sweep()", () => {
	test("prunes orphan wf/* worktrees AND branches from a crashed prior run", async () => {
		const { shell, commands, quietedCommands } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{ match: (c) => c.includes("worktree prune"), out: ok() },
			{
				match: (c) => c.includes("for-each-ref"),
				out: ok("wf/old_run/a\nwf/old_run/b"),
			},
			{ match: (c) => c.includes("branch -D"), out: ok() },
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		await mgr.sweep();
		// Prunes stale worktree admin entries first.
		expect(commands.some((c) => c.includes("worktree prune"))).toBe(true);
		// Enumerates only wf/* branches, then deletes each.
		const enumCmd = commands.find((c) => c.includes("for-each-ref"));
		expect(enumCmd).toContain("refs/heads/wf/");
		expect(commands.some((c) => c.includes("branch -D wf/old_run/a"))).toBe(
			true,
		);
		expect(commands.some((c) => c.includes("branch -D wf/old_run/b"))).toBe(
			true,
		);
		// Every command quieted.
		for (const c of commands.filter((c) => c.startsWith("git"))) {
			expect(quietedCommands).toContain(c);
		}
	});

	test("no orphan wf/* branches → prune only, no branch deletes", async () => {
		const { shell, commands } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{ match: (c) => c.includes("worktree prune"), out: ok() },
			{ match: (c) => c.includes("for-each-ref"), out: ok("") },
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		await expect(mgr.sweep()).resolves.toBeUndefined();
		expect(commands.some((c) => c.includes("branch -D"))).toBe(false);
	});

	test("sweep is fenced — a failing for-each-ref never throws", async () => {
		const { shell } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: ok("true") },
			{ match: (c) => c.includes("worktree prune"), out: ok() },
			{ match: (c) => c.includes("for-each-ref"), out: fail() },
		]);
		const mgr = createWorktreeManager({ shell, directory: "/proj" });
		await expect(mgr.sweep()).resolves.toBeUndefined();
	});
});

describe("createWorktreeManager — non-repo dead latch shared across the manager", () => {
	test("a non-repo latches dead on first use; mergeBack/cleanup/sweep all no-op", async () => {
		const { shell, commands } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: fail() },
		]);
		const { logger, warns } = captureLogger();
		const mgr = createWorktreeManager({ shell, directory: "/proj", logger });
		expect(await mgr.create({ runId: "wf_1", label: "w" })).toBeNull();
		// Later calls do not re-probe and do not run git mutations.
		expect(await mgr.mergeBack("/wt", "wf/wf_1/w")).toEqual({ merged: true });
		await mgr.cleanup("/wt", "wf/wf_1/w");
		await mgr.sweep();
		expect(await mgr.isUnchanged("/wt")).toBe(true);
		// Exactly one probe, one warn, no mutating git.
		expect(
			commands.filter((c) => c.includes("is-inside-work-tree")),
		).toHaveLength(1);
		expect(warns).toHaveLength(1);
		expect(commands.some((c) => c.includes("worktree add"))).toBe(false);
		expect(commands.some((c) => c.includes("merge"))).toBe(false);
	});
});

/**
 * Issue 6 structural half — real-git temp-repo harness (the spec's required pattern):
 * a registered UNTRACKED spec (covering both ignored and plain-untracked) must be
 * COPIED into a freshly-minted worktree, which — born from `HEAD` — would otherwise
 * lack it. Uses the real `Bun.$` shell + a real on-disk git repo (no fake shell), so
 * the `worktree add … HEAD` + `node:fs` copy round-trip is exercised end-to-end.
 */
describe("createWorktreeManager — registerSpec copies an untracked spec into the worktree (Issue 6)", () => {
	const tmps: string[] = [];

	afterEach(async () => {
		for (const dir of tmps.splice(0)) {
			await rm(dir, { recursive: true, force: true });
		}
	});

	/** Init a real git repo with one tracked commit so `HEAD` exists for `worktree add`. */
	async function makeRepo(): Promise<string> {
		// Nest the repo ONE level under the mkdtemp root: the module's worktree root is
		// a SIBLING of the repo (`<repo>/../.wf-worktrees`), so a repo created directly
		// in mkdtemp(tmpdir()) would resolve its sibling to the machine-global
		// `${tmpdir()}/.wf-worktrees` — shared across concurrent test runs/CI jobs, and
		// rm -rf'd by afterEach (clobbering a parallel job's live worktrees). With the
		// repo at `<tmp>/repo`, the sibling root is `<tmp>/.wf-worktrees`, fully inside
		// the per-test temp dir; ONE tmps entry (the mkdtemp root) cleans everything.
		const root = await mkdtemp(join(tmpdir(), "wf-wt-"));
		tmps.push(root);
		const dir = join(root, "repo");
		await mkdir(dir, { recursive: true });
		const git = $.cwd(dir).nothrow();
		await git`git init -q -b main`.quiet();
		await git`git config user.email t@t.local`.quiet();
		await git`git config user.name tester`.quiet();
		await writeFile(join(dir, "README.md"), "# tracked\n");
		await git`git add README.md`.quiet();
		await git`git commit -q -m init`.quiet();
		return dir;
	}

	test("an IGNORED spec is copied into the new worktree (not in HEAD)", async () => {
		const repo = await makeRepo();
		// A .gitignore'd plan doc: tracked .gitignore, ignored+untracked plan file.
		await writeFile(join(repo, ".gitignore"), "docs/plans/\n");
		await $.cwd(repo).nothrow()`git add .gitignore`.quiet();
		await $.cwd(repo).nothrow()`git commit -q -m ignore`.quiet();
		await $.cwd(repo).nothrow()`mkdir -p docs/plans`.quiet();
		await writeFile(
			join(repo, "docs/plans/plan.md"),
			"# the source of truth\n",
		);

		const mgr = createWorktreeManager({ shell: $, directory: repo });
		mgr.registerSpec("wf_run1", "docs/plans/plan.md");
		const handle = await mgr.create({ runId: "wf_run1", label: "worker" });
		expect(handle).not.toBeNull();
		const dir = (handle as { dir: string }).dir;

		// The ignored plan is PRESENT in the worktree with the main tree's content.
		const copied = await readFile(join(dir, "docs/plans/plan.md"), "utf-8");
		expect(copied).toBe("# the source of truth\n");
		await mgr.cleanup(dir, (handle as { branch: string }).branch);
	});

	test("a PLAIN-UNTRACKED spec is copied into the new worktree", async () => {
		const repo = await makeRepo();
		// Untracked, not ignored — also absent from a HEAD checkout.
		await writeFile(join(repo, "notes.md"), "# untracked notes\n");

		const mgr = createWorktreeManager({ shell: $, directory: repo });
		mgr.registerSpec("wf_run2", "notes.md");
		const handle = await mgr.create({ runId: "wf_run2", label: "worker" });
		const dir = (handle as { dir: string }).dir;

		expect(await readFile(join(dir, "notes.md"), "utf-8")).toBe(
			"# untracked notes\n",
		);
		await mgr.cleanup(dir, (handle as { branch: string }).branch);
	});

	test("NO registered spec → no copy (worktree carries only HEAD)", async () => {
		const repo = await makeRepo();
		await writeFile(join(repo, "notes.md"), "# untracked notes\n");

		const mgr = createWorktreeManager({ shell: $, directory: repo });
		// No registerSpec call.
		const handle = await mgr.create({ runId: "wf_run3", label: "worker" });
		const dir = (handle as { dir: string }).dir;

		// README (tracked) is in HEAD; the untracked notes are NOT copied.
		expect(await readFile(join(dir, "README.md"), "utf-8")).toBe("# tracked\n");
		await expect(stat(join(dir, "notes.md"))).rejects.toThrow();
		await mgr.cleanup(dir, (handle as { branch: string }).branch);
	});

	test("a copy failure (spec vanished) is fenced — the mint still succeeds", async () => {
		const repo = await makeRepo();
		const { logger, warns } = captureLogger();
		const mgr = createWorktreeManager({ shell: $, directory: repo, logger });
		// Register a path that does not exist on disk → copyFile rejects (ENOENT).
		mgr.registerSpec("wf_run4", "ghost.md");
		const handle = await mgr.create({ runId: "wf_run4", label: "worker" });
		// The mint is NOT failed by a copy error.
		expect(handle).not.toBeNull();
		const dir = (handle as { dir: string }).dir;
		await expect(stat(join(dir, "ghost.md"))).rejects.toThrow();
		expect(
			warns.some((w) => w.msg.includes("failed to copy declared spec")),
		).toBe(true);
		await mgr.cleanup(dir, (handle as { branch: string }).branch);
	});

	test("unregisterSpec stops the copy on a later mint", async () => {
		const repo = await makeRepo();
		await writeFile(join(repo, "notes.md"), "# untracked notes\n");
		const mgr = createWorktreeManager({ shell: $, directory: repo });
		mgr.registerSpec("wf_run5", "notes.md");
		mgr.unregisterSpec("wf_run5");
		const handle = await mgr.create({ runId: "wf_run5", label: "worker" });
		const dir = (handle as { dir: string }).dir;
		await expect(stat(join(dir, "notes.md"))).rejects.toThrow();
		await mgr.cleanup(dir, (handle as { branch: string }).branch);
	});

	test("the copied spec is INVISIBLE to the settle path: isUnchanged stays true, nothing merges (#6)", async () => {
		// Before the fix, the copied spec landed as an untracked file in EVERY minted
		// worktree → isUnchanged was always false → commitWorktreeEdits committed and
		// MERGED the operator's never-committed file onto the main branch (bypassing
		// refuse-don't-stomp), or the merge refused on "untracked working tree file
		// would be overwritten" and a SUCCESSFUL agent's real work was dropped.
		const repo = await makeRepo();
		await writeFile(join(repo, "notes.md"), "# the operator's spec\n");
		const mgr = createWorktreeManager({ shell: $, directory: repo });
		mgr.registerSpec("wf_spec_inv", "notes.md");
		const handle = (await mgr.create({
			runId: "wf_spec_inv",
			label: "worker",
		})) as { dir: string; branch: string };
		// The spec IS in the worktree (the agent can read it)…
		expect(await readFile(join(handle.dir, "notes.md"), "utf-8")).toBe(
			"# the operator's spec\n",
		);
		// …but the worktree still reads UNCHANGED (manager-placed ≠ agent work).
		expect(await mgr.isUnchanged(handle.dir)).toBe(true);
		// And a forced merge-back commits NOTHING of it to the main branch: the main
		// tree's notes.md stays the operator's UNTRACKED file, not a committed one.
		await mgr.mergeBack(handle.dir, handle.branch);
		const tracked = await $.cwd(
			repo,
		).nothrow()`git ls-files --error-unmatch -- notes.md`.quiet();
		expect(tracked.exitCode).not.toBe(0);
		await mgr.cleanup(handle.dir, handle.branch);
	});

	test("AGENT work merges back even when a spec rides along; the spec itself never lands (#6)", async () => {
		const repo = await makeRepo();
		await writeFile(join(repo, "notes.md"), "# spec\n");
		const mgr = createWorktreeManager({ shell: $, directory: repo });
		mgr.registerSpec("wf_spec_work", "notes.md");
		const handle = (await mgr.create({
			runId: "wf_spec_work",
			label: "worker",
		})) as { dir: string; branch: string };
		// The agent writes a REAL new module in the worktree.
		await writeFile(join(handle.dir, "feature.ts"), "export const x = 1;\n");
		expect(await mgr.isUnchanged(handle.dir)).toBe(false);
		const res = await mgr.mergeBack(handle.dir, handle.branch);
		expect("merged" in res && res.merged).toBe(true);
		// The agent's file landed in the main tree (committed); the spec did not.
		expect(await readFile(join(repo, "feature.ts"), "utf-8")).toBe(
			"export const x = 1;\n",
		);
		const merged = res as { merged: true; sha?: string; paths?: string[] };
		expect(merged.paths).toEqual(["feature.ts"]);
		expect(typeof merged.sha).toBe("string");
		const specTracked = await $.cwd(
			repo,
		).nothrow()`git ls-files --error-unmatch -- notes.md`.quiet();
		expect(specTracked.exitCode).not.toBe(0);
		await mgr.cleanup(handle.dir, handle.branch);
	});
});

/**
 * Real-git integration tests (#15): the catastrophic flows — merge-back content,
 * conflicts, unicode paths, node_modules linking, forensic markers — exercised
 * against a real on-disk repo, not the fake shell.
 */
describe("createWorktreeManager — real-git integration (#15)", () => {
	const tmps: string[] = [];

	afterEach(async () => {
		for (const dir of tmps.splice(0)) {
			await rm(dir, { recursive: true, force: true });
		}
	});

	async function makeRepo(): Promise<string> {
		// Nested one level under the mkdtemp root — see the harness note above (#0).
		const root = await mkdtemp(join(tmpdir(), "wf-wt-int-"));
		tmps.push(root);
		const dir = join(root, "repo");
		await mkdir(dir, { recursive: true });
		const git = $.cwd(dir).nothrow();
		await git`git init -q -b main`.quiet();
		await git`git config user.email t@t.local`.quiet();
		await git`git config user.name tester`.quiet();
		await writeFile(join(dir, "README.md"), "# tracked\n");
		await git`git add README.md`.quiet();
		await git`git commit -q -m init`.quiet();
		return dir;
	}

	test("a unicode filename round-trips: committed in the worktree, merged to the main tree (#7)", async () => {
		// With core.quotePath ON (git's default), porcelain C-quotes "café.txt" →
		// the parsed pathspec fails `git add` → the path is silently dropped → the
		// later `worktree remove --force` DELETES the file (work loss). quotePath=off
		// on the status invocations keeps the path byte-exact end-to-end.
		const repo = await makeRepo();
		const mgr = createWorktreeManager({ shell: $, directory: repo });
		const handle = (await mgr.create({
			runId: "wf_uni",
			label: "worker",
		})) as { dir: string; branch: string };
		await writeFile(join(handle.dir, "café.txt"), "unicode work\n");
		expect(await mgr.isUnchanged(handle.dir)).toBe(false);
		const res = await mgr.mergeBack(handle.dir, handle.branch);
		expect("merged" in res && res.merged).toBe(true);
		expect(await readFile(join(repo, "café.txt"), "utf-8")).toBe(
			"unicode work\n",
		);
		await mgr.cleanup(handle.dir, handle.branch);
	});

	test("a REAL merge conflict yields the Tier 1 {conflict} result and leaves the main tree clean (#15.3)", async () => {
		const repo = await makeRepo();
		const mgr = createWorktreeManager({ shell: $, directory: repo });
		const handle = (await mgr.create({
			runId: "wf_conf",
			label: "worker",
		})) as { dir: string; branch: string };
		// Diverge: the worktree edits README one way…
		await writeFile(join(handle.dir, "README.md"), "# worktree version\n");
		// …while the MAIN branch commits a competing edit on top of the base.
		await writeFile(join(repo, "README.md"), "# main version\n");
		const git = $.cwd(repo).nothrow();
		await git`git add README.md`.quiet();
		await git`git commit -q -m "main edit"`.quiet();

		const res = await mgr.mergeBack(handle.dir, handle.branch);
		expect("conflict" in res).toBe(true);
		const conflict = res as {
			conflict: true;
			branch: string;
			files: string[];
			baseRef: string | undefined;
		};
		expect(conflict.branch).toBe(handle.branch);
		expect(conflict.files).toEqual(["README.md"]);
		expect(typeof conflict.baseRef).toBe("string");
		// merge --abort left the MAIN tree clean: porcelain empty, content = main's.
		const status = await git`git status --porcelain`.quiet();
		expect(status.text().trim()).toBe("");
		expect(await readFile(join(repo, "README.md"), "utf-8")).toBe(
			"# main version\n",
		);
		// The conflicted worktree+branch are still alive for Tier 2 (cleanup now).
		expect(await readFile(join(handle.dir, "README.md"), "utf-8")).toBe(
			"# worktree version\n",
		);
		await mgr.cleanup(handle.dir, handle.branch);
	});

	test("scratch + merge commits carry the forensic run=<runId> marker (#4)", async () => {
		const repo = await makeRepo();
		const mgr = createWorktreeManager({ shell: $, directory: repo });
		const handle = (await mgr.create({
			runId: "wf_marked",
			label: "worker",
		})) as { dir: string; branch: string };
		await writeFile(join(handle.dir, "work.ts"), "export const w = 1;\n");
		const res = await mgr.mergeBack(handle.dir, handle.branch);
		expect("merged" in res && res.merged).toBe(true);
		// Every commit the settle created (scratch commit + merge commit) must carry
		// `run=wf_marked` so discard()'s range guard recognizes them as the run's own.
		// Walk the whole log and exclude the base commit — `git log -N` is
		// DATE-ordered, and same-second commits make a -2 slice nondeterministic.
		const log = await $.cwd(repo).nothrow()`git log --format=%s`.quiet();
		const subjects = log
			.text()
			.split("\n")
			.filter((s) => s.trim().length > 0 && s.trim() !== "init");
		expect(subjects).toHaveLength(2);
		for (const subject of subjects) {
			expect(subject).toContain("run=wf_marked");
		}
		await mgr.cleanup(handle.dir, handle.branch);
	});

	test("node_modules from the main tree is symlinked into the worktree and stays settle-invisible (#3)", async () => {
		const repo = await makeRepo();
		// A real (untracked, conventionally-ignored-but-here-unignored) node_modules.
		await mkdir(join(repo, "node_modules", "dep"), { recursive: true });
		await writeFile(
			join(repo, "node_modules", "dep", "index.js"),
			"module.exports = 1;\n",
		);
		const mgr = createWorktreeManager({ shell: $, directory: repo });
		const handle = (await mgr.create({
			runId: "wf_mods",
			label: "worker",
		})) as { dir: string; branch: string };
		// The worktree's node_modules is a SYMLINK to the main tree's.
		const link = await lstat(join(handle.dir, "node_modules"));
		expect(link.isSymbolicLink()).toBe(true);
		expect(
			await readFile(
				join(handle.dir, "node_modules", "dep", "index.js"),
				"utf-8",
			),
		).toBe("module.exports = 1;\n");
		// Manager-placed → settle-invisible: the worktree reads UNCHANGED, so the
		// link is never committed/merged (here node_modules is not even gitignored —
		// the exclusion, not .gitignore, is what keeps it out).
		expect(await mgr.isUnchanged(handle.dir)).toBe(true);
		await mgr.cleanup(handle.dir, handle.branch);
	});

	test("checkpoint-style staged DELETION in the worktree merges back (git rm shape)", async () => {
		// #15.2 analogue on the worktree path: a deletion staged via `git rm` (file
		// gone from disk, deletion in the index) must survive commitWorktreeEdits'
		// pathspec staging and land in the main tree as a deletion.
		const repo = await makeRepo();
		const mgr = createWorktreeManager({ shell: $, directory: repo });
		const handle = (await mgr.create({
			runId: "wf_del",
			label: "worker",
		})) as { dir: string; branch: string };
		await $.cwd(handle.dir).nothrow()`git rm -q README.md`.quiet();
		expect(await mgr.isUnchanged(handle.dir)).toBe(false);
		const res = await mgr.mergeBack(handle.dir, handle.branch);
		expect("merged" in res && res.merged).toBe(true);
		// The deletion landed: README.md is gone from the main tree and untracked.
		await expect(stat(join(repo, "README.md"))).rejects.toThrow();
		await mgr.cleanup(handle.dir, handle.branch);
	});

	test("agent-COMMITTED work (clean porcelain) is landed work: isUnchanged false, merge carries it, ledger covers it", async () => {
		// The declared blind spot, closed: an agent that `git commit`s inside its
		// worktree leaves porcelain clean — the settle must still treat it as real
		// work (commits ahead of the mint base), the merge must carry the commits,
		// and the merged paths (HEAD^1..HEAD) must cover files changed ONLY via
		// agent commits.
		const repo = await makeRepo();
		const mgr = createWorktreeManager({ shell: $, directory: repo });
		const handle = (await mgr.create({
			runId: "wf_committed",
			label: "worker",
		})) as { dir: string; branch: string };
		const wt = $.cwd(handle.dir).nothrow();
		await writeFile(join(handle.dir, "feature.ts"), "export const f = 1;\n");
		await wt`git add feature.ts`.quiet();
		await wt`git -c user.name=agent -c user.email=a@a commit -q -m "agent commit run=wf_committed"`.quiet();
		// Porcelain is CLEAN — the work lives in a commit.
		const st = await wt`git status --porcelain`.quiet();
		expect(st.text().trim()).toBe("");
		// baseOf + commits-ahead: the exact probe the engine's verify arm runs.
		const base = mgr.baseOf(handle.dir) as string;
		expect(typeof base).toBe("string");
		const ahead = await wt`git rev-list --count ${base}..HEAD`.quiet();
		expect(Number.parseInt(ahead.text().trim(), 10)).toBeGreaterThan(0);
		// The settle treats it as changed and the merge lands the commit.
		expect(await mgr.isUnchanged(handle.dir)).toBe(false);
		const res = await mgr.mergeBack(handle.dir, handle.branch);
		expect("merged" in res && res.merged).toBe(true);
		const merged = res as { merged: true; sha?: string; paths?: string[] };
		expect(merged.paths).toEqual(["feature.ts"]);
		expect(await readFile(join(repo, "feature.ts"), "utf-8")).toBe(
			"export const f = 1;\n",
		);
		await mgr.cleanup(handle.dir, handle.branch);
	});

	test("MIXED committed + dirty work: both land, the ledger paths cover both", async () => {
		const repo = await makeRepo();
		const mgr = createWorktreeManager({ shell: $, directory: repo });
		const handle = (await mgr.create({
			runId: "wf_mixed",
			label: "worker",
		})) as { dir: string; branch: string };
		const wt = $.cwd(handle.dir).nothrow();
		// One file committed by the agent…
		await writeFile(join(handle.dir, "committed.ts"), "export const c = 1;\n");
		await wt`git add committed.ts`.quiet();
		await wt`git -c user.name=agent -c user.email=a@a commit -q -m "agent commit run=wf_mixed"`.quiet();
		// …one left dirty for the settle to stage.
		await writeFile(join(handle.dir, "dirty.ts"), "export const d = 2;\n");
		expect(await mgr.isUnchanged(handle.dir)).toBe(false);
		const res = await mgr.mergeBack(handle.dir, handle.branch);
		expect("merged" in res && res.merged).toBe(true);
		const merged = res as { merged: true; sha?: string; paths?: string[] };
		expect([...(merged.paths ?? [])].sort()).toEqual([
			"committed.ts",
			"dirty.ts",
		]);
		expect(await readFile(join(repo, "committed.ts"), "utf-8")).toBe(
			"export const c = 1;\n",
		);
		expect(await readFile(join(repo, "dirty.ts"), "utf-8")).toBe(
			"export const d = 2;\n",
		);
		await mgr.cleanup(handle.dir, handle.branch);
	});
});

/**
 * Task 2 — loud-loss for agent edits to the copied spec. The copy is the run's
 * INPUT and stays settle-invisible (merging it would stomp the operator's
 * untracked file); these tests pin that an edit is REPORTED (via the registerSpec
 * onEdit sink) and that the edited bytes are preserved/named per settle path.
 */
describe("createWorktreeManager — spec-edit loud loss (real git)", () => {
	const tmps: string[] = [];

	afterEach(async () => {
		for (const dir of tmps.splice(0)) {
			await rm(dir, { recursive: true, force: true });
		}
	});

	async function makeRepo(): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), "wf-wt-spec-"));
		tmps.push(root);
		const dir = join(root, "repo");
		await mkdir(dir, { recursive: true });
		const git = $.cwd(dir).nothrow();
		await git`git init -q -b main`.quiet();
		await git`git config user.email t@t.local`.quiet();
		await git`git config user.name tester`.quiet();
		await writeFile(join(dir, "README.md"), "# tracked\n");
		await git`git add README.md`.quiet();
		await git`git commit -q -m init`.quiet();
		return dir;
	}

	/** Mint a worktree with a registered untracked spec + a captured onEdit sink. */
	async function mintWithSpec(runId: string) {
		const repo = await makeRepo();
		await writeFile(join(repo, "notes.md"), "# operator spec\n");
		const notes: string[] = [];
		const mgr = createWorktreeManager({ shell: $, directory: repo });
		mgr.registerSpec(runId, "notes.md", (m) => notes.push(m));
		const handle = (await mgr.create({ runId, label: "worker" })) as {
			dir: string;
			branch: string;
		};
		return { repo, mgr, handle, notes };
	}

	test("UNCHANGED spec → no note, no preserved file (clean settle)", async () => {
		const { mgr, handle, notes } = await mintWithSpec("wf_spec_ok");
		await mgr.cleanup(handle.dir, handle.branch);
		expect(notes).toEqual([]);
		await expect(stat(`${handle.dir}.spec-edited`)).rejects.toThrow();
	});

	test("EDITED spec on the clean-settle path → loud note naming the preserved copy; operator file untouched", async () => {
		const { repo, mgr, handle, notes } = await mintWithSpec("wf_spec_edit");
		await writeFile(join(handle.dir, "notes.md"), "# AGENT EDIT\n");
		// Only the (excluded) spec changed → unchanged → the clean-settle path runs
		// cleanup, which is where the bytes would silently die.
		expect(await mgr.isUnchanged(handle.dir)).toBe(true);
		await mgr.cleanup(handle.dir, handle.branch);
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("NEVER merged");
		const aside = `${handle.dir}.spec-edited`;
		expect(notes[0]).toContain(aside);
		// The edited bytes survive aside; the operator's file is untouched.
		expect(await readFile(aside, "utf-8")).toBe("# AGENT EDIT\n");
		expect(await readFile(join(repo, "notes.md"), "utf-8")).toBe(
			"# operator spec\n",
		);
	});

	test("EDITED spec + real agent work → the merge is UNAFFECTED, the spec edit is noted, the spec never lands", async () => {
		const { repo, mgr, handle, notes } = await mintWithSpec("wf_spec_work");
		await writeFile(join(handle.dir, "notes.md"), "# AGENT EDIT\n");
		await writeFile(join(handle.dir, "feature.ts"), "export const x = 1;\n");
		const res = await mgr.mergeBack(handle.dir, handle.branch);
		expect("merged" in res && res.merged).toBe(true);
		// The agent's real work landed; the spec did not (still untracked, operator's
		// content), and the loud note fired at cleanup with the preserved-aside path.
		expect((res as { paths?: string[] }).paths).toEqual(["feature.ts"]);
		await mgr.cleanup(handle.dir, handle.branch);
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain(`${handle.dir}.spec-edited`);
		expect(await readFile(join(repo, "notes.md"), "utf-8")).toBe(
			"# operator spec\n",
		);
		const tracked = await $.cwd(
			repo,
		).nothrow()`git ls-files --error-unmatch -- notes.md`.quiet();
		expect(tracked.exitCode).not.toBe(0);
	});

	test("AGENT-DELETED spec → reported as deleted, nothing preserved, operator file untouched", async () => {
		const { repo, mgr, handle, notes } = await mintWithSpec("wf_spec_del");
		await rm(join(handle.dir, "notes.md"));
		await mgr.cleanup(handle.dir, handle.branch);
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("deleted the copied spec");
		expect(notes[0]).toContain("nothing to preserve");
		expect(await readFile(join(repo, "notes.md"), "utf-8")).toBe(
			"# operator spec\n",
		);
	});

	test("CONFLICT path (worktree preserved) → the note names the spec copy INSIDE the live worktree", async () => {
		const { repo, mgr, handle, notes } = await mintWithSpec("wf_spec_conf");
		await writeFile(join(handle.dir, "notes.md"), "# AGENT EDIT\n");
		// Force a real conflict so the worktree is preserved (no cleanup).
		await writeFile(join(handle.dir, "README.md"), "# worktree version\n");
		await writeFile(join(repo, "README.md"), "# main version\n");
		const git = $.cwd(repo).nothrow();
		await git`git add README.md`.quiet();
		await git`git commit -q -m "main edit"`.quiet();
		const res = await mgr.mergeBack(handle.dir, handle.branch);
		expect("conflict" in res).toBe(true);
		expect(notes).toHaveLength(1);
		// Worktree alive → the bytes survive in place; the note names that location.
		expect(notes[0]).toContain("preserved worktree");
		expect(notes[0]).toContain(join(handle.dir, "notes.md"));
		expect(await readFile(join(handle.dir, "notes.md"), "utf-8")).toBe(
			"# AGENT EDIT\n",
		);
		await mgr.cleanup(handle.dir, handle.branch);
	});
});
