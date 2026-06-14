import { describe, expect, test } from "bun:test";
import { classifyPath, parseCheckIgnoreRule } from "./classify-path";

/**
 * Tests for the source-path classifier (Epic 2.4). The host `$` (BunShell) is a
 * TAGGED-TEMPLATE callable; the fake reconstructs the command string by zipping
 * the template with its interpolations and answers from the first matching stub.
 * No real git — the module is fenced and pure-by-injection.
 */

interface FakeOutput {
	stdout: string;
	stderr: string;
	exitCode: number;
}
interface Stub {
	match: (cmd: string) => boolean;
	out: FakeOutput;
}

function makeShell(stubs: Stub[] = []) {
	const commands: string[] = [];
	const quietedCommands: string[] = [];
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
	const makeResult = (out: FakeOutput) =>
		Promise.resolve({
			stdout: { toString: () => out.stdout },
			stderr: { toString: () => out.stderr },
			exitCode: out.exitCode,
			text: () => out.stdout,
		});
	const shell = (strings: TemplateStringsArray, ...expressions: unknown[]) => {
		const cmd = reconstruct(strings, expressions);
		commands.push(cmd);
		const stub = stubs.find((s) => s.match(cmd));
		const p = makeResult(stub?.out ?? { stdout: "", stderr: "", exitCode: 0 });
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
		braces: (pp: string) => [pp],
		escape: (s: string) => s,
		throws: () => chain,
	});
	// biome-ignore lint/suspicious/noExplicitAny: structural BunShell fake for tests.
	return { shell: chain as any, commands, quietedCommands };
}

const ok = (stdout = ""): FakeOutput => ({ stdout, stderr: "", exitCode: 0 });
const fail = (exitCode = 1): FakeOutput => ({
	stdout: "",
	stderr: "",
	exitCode,
});
const aliveStub: Stub = {
	match: (c) => c.includes("is-inside-work-tree"),
	out: ok("true"),
};

describe("parseCheckIgnoreRule", () => {
	test("returns the pre-TAB rule of a check-ignore -v line", () => {
		expect(
			parseCheckIgnoreRule(".gitignore:47:docs/plans/\tdocs/plans/x.md"),
		).toBe(".gitignore:47:docs/plans/");
	});
	test("empty string → undefined", () => {
		expect(parseCheckIgnoreRule("")).toBeUndefined();
	});
});

describe("classifyPath", () => {
	test("ls-files exit 0 → tracked (tracked beats ignored)", async () => {
		const { shell } = makeShell([
			aliveStub,
			{ match: (c) => c.includes("ls-files"), out: ok() },
		]);
		expect(await classifyPath(shell, "/proj", "src/a.ts", true)).toEqual({
			path: "src/a.ts",
			classification: "tracked",
		});
	});

	test("not tracked + check-ignore exit 0 → ignored with the rule", async () => {
		const { shell } = makeShell([
			aliveStub,
			{ match: (c) => c.includes("ls-files"), out: fail() },
			{
				match: (c) => c.includes("check-ignore"),
				out: ok(".gitignore:47:docs/plans/\tdocs/plans/x.md"),
			},
		]);
		expect(await classifyPath(shell, "/proj", "docs/plans/x.md", true)).toEqual(
			{
				path: "docs/plans/x.md",
				classification: "ignored",
				rule: ".gitignore:47:docs/plans/",
			},
		);
	});

	test("neither tracked nor ignored + exists → untracked", async () => {
		const { shell } = makeShell([
			aliveStub,
			{ match: (c) => c.includes("ls-files"), out: fail() },
			{ match: (c) => c.includes("check-ignore"), out: fail() },
		]);
		expect(await classifyPath(shell, "/proj", "scratch.md", true)).toEqual({
			path: "scratch.md",
			classification: "untracked",
		});
	});

	test("neither tracked nor ignored + absent → missing", async () => {
		const { shell } = makeShell([
			aliveStub,
			{ match: (c) => c.includes("ls-files"), out: fail() },
			{ match: (c) => c.includes("check-ignore"), out: fail() },
		]);
		expect(await classifyPath(shell, "/proj", "gone.md", false)).toEqual({
			path: "gone.md",
			classification: "missing",
		});
	});

	test("no shell + exists → untracked (never a fabricated git verdict)", async () => {
		expect(await classifyPath(undefined, "/proj", "x.md", true)).toEqual({
			path: "x.md",
			classification: "untracked",
		});
		expect(await classifyPath(undefined, "/proj", "x.md", false)).toEqual({
			path: "x.md",
			classification: "missing",
		});
	});

	test("non-git checkout → never claims ignored/tracked", async () => {
		const { shell } = makeShell([
			{ match: (c) => c.includes("is-inside-work-tree"), out: fail(128) },
		]);
		expect(await classifyPath(shell, "/proj", "x.md", true)).toEqual({
			path: "x.md",
			classification: "untracked",
		});
	});

	test("every git command goes through .quiet()", async () => {
		const { shell, commands, quietedCommands } = makeShell([
			aliveStub,
			{ match: (c) => c.includes("ls-files"), out: fail() },
			{ match: (c) => c.includes("check-ignore"), out: fail() },
		]);
		await classifyPath(shell, "/proj", "x.md", true);
		expect(commands.length).toBeGreaterThan(0);
		expect(quietedCommands).toEqual(commands);
	});
});
