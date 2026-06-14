/**
 * Node `child_process`-backed {@link BunShell} adapter (the §5 shell seam).
 *
 * The ported git subsystem (git-checkpoint / git-worktree / classify-path) and the
 * runtime's `shell()` / verify `{check}` paths all program against a Bun-`$`-shaped
 * tagged-template callable: `shell.cwd(dir).nothrow()` yields a namespace, each
 * `${expr}` interpolation is escaped as ONE argv token (arrays expand to many),
 * `< ${Buffer}` feeds stdin, and `${{ raw }}` injects raw shell text. pi has no
 * host `$`, so this adapter reproduces that contract over `node:child_process`.
 *
 * Two execution modes, chosen per invocation:
 *   - ARGV mode (the git modules): the template's literal chunks are split on
 *     whitespace into argv tokens, and each interpolation is appended as its own
 *     token(s) WITHOUT shell parsing — so a path with spaces/quotes is one safe
 *     argv element, never re-split or glob-expanded. The first token is the program
 *     (`git`), the rest its args; spawned directly with `shell: false`. A `<`
 *     literal token immediately followed by an interpolation marks that
 *     interpolation as the child's STDIN (a Buffer/string), and neither the `<` nor
 *     the operand becomes an argv token — matching Bun's `< ${buf}` redirect.
 *   - RAW mode: when ANY interpolation is `{ raw: <string> }` (the runtime's
 *     `shell(command)` and verify `{check}` commands, which are arbitrary shell),
 *     the whole template is reassembled into one string (raw interpolations
 *     verbatim, others single-quote-escaped) and run via `sh -c` so pipes/globs/
 *     redirects in the user command work.
 *
 * `.nothrow()` is implicit — a non-zero exit NEVER rejects (the consumers read
 * `.exitCode`); a genuine spawn failure (ENOENT) resolves `exitCode: 1` with the
 * error on stderr rather than rejecting, so a fenced caller treats it as a failed
 * command, not an exception. `.quiet()` is a no-op here: `spawn` does not inherit
 * the parent's fd 1/2 (we capture stdout/stderr into buffers), so nothing leaks to
 * the TUI regardless — the method exists only to satisfy the `ShellPromise` shape.
 *
 * Node-safe: no Bun.* APIs.
 */

import { spawn } from "node:child_process";
import type { BunShell, ShellOutput, ShellPromise } from "./git-checkpoint";

/** A `{ raw }` interpolation — verbatim shell text, not an argv token. */
function isRaw(value: unknown): value is { raw: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"raw" in value &&
		typeof (value as { raw: unknown }).raw === "string"
	);
}

/** Single-quote-escape a token for safe inclusion in an `sh -c` string. */
function shQuote(token: string): string {
	return `'${token.replace(/'/g, "'\\''")}'`;
}

/** Coerce one interpolation value to its argv token(s). Arrays expand in order. */
function toTokens(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.map((v) => String(v));
	}
	return [String(value)];
}

interface ParsedArgv {
	argv: string[];
	stdin?: Buffer;
}

/**
 * Parse a template + interpolations into an argv token stream in ARGV mode,
 * honoring Bun-`$` WORD GLUING: an interpolation with no surrounding whitespace
 * concatenates onto the adjacent token rather than splitting (so
 * `-c user.name=${X}` yields `["-c", "user.name=X"]`, not a stray `user.name=`).
 *
 * A token accumulator `current` is built across literal chunks and scalar
 * interpolations; whitespace in a literal flushes it. An ARRAY interpolation
 * flushes `current`, then pushes each element as its OWN token (Bun expands an
 * array to separate words) — a glued array is the rare pathspec-list case where
 * each element must be a distinct argv element regardless.
 *
 * A bare `<` operator token (whitespace-delimited) marks the NEXT interpolation as
 * the child's stdin (a Buffer/string); the `<` is consumed and never an argv token.
 */
function parseArgv(
	strings: TemplateStringsArray,
	expressions: unknown[],
): ParsedArgv {
	const argv: string[] = [];
	let stdin: Buffer | undefined;
	let current = "";
	let hasCurrent = false;
	// Set when the last flushed token was a bare `<` redirect operator, so the next
	// interpolation is stdin rather than an argv token.
	let pendingStdin = false;

	const flush = (): void => {
		if (!hasCurrent) {
			return;
		}
		if (current === "<") {
			// The redirect operator itself is never an argv token; arm stdin capture.
			pendingStdin = true;
		} else {
			argv.push(current);
		}
		current = "";
		hasCurrent = false;
	};
	const append = (text: string): void => {
		current += text;
		hasCurrent = true;
	};

	for (let i = 0; i < strings.length; i++) {
		const literal = strings[i] ?? "";
		// Walk the literal char-class-wise: a run of non-whitespace glues onto the
		// current token; each whitespace run flushes it. This preserves gluing at
		// both the chunk's start (glue onto the prior interpolation) and end (leave
		// `current` open for the next interpolation).
		const segments = literal.split(/(\s+)/);
		for (const seg of segments) {
			if (seg.length === 0) {
				continue;
			}
			if (/^\s+$/.test(seg)) {
				flush();
			} else {
				append(seg);
			}
		}

		if (i < expressions.length) {
			const value = expressions[i];
			if (pendingStdin) {
				stdin = Buffer.isBuffer(value)
					? value
					: Buffer.from(String(value), "utf-8");
				pendingStdin = false;
			} else if (Array.isArray(value)) {
				// An array expands to separate words: flush any glued prefix, then push
				// each element as its own token.
				flush();
				for (const tok of toTokens(value)) {
					argv.push(tok);
				}
			} else {
				// A scalar glues onto the current token (forming one argv element).
				append(String(value));
			}
		}
	}
	flush();
	return stdin !== undefined ? { argv, stdin } : { argv };
}

/** Reassemble a template into one `sh -c` string (RAW mode). */
function parseRaw(
	strings: TemplateStringsArray,
	expressions: unknown[],
): string {
	let out = "";
	for (let i = 0; i < strings.length; i++) {
		out += strings[i] ?? "";
		if (i < expressions.length) {
			const value = expressions[i];
			if (isRaw(value)) {
				out += value.raw;
			} else if (Array.isArray(value)) {
				out += value.map((v) => shQuote(String(v))).join(" ");
			} else {
				out += shQuote(String(value));
			}
		}
	}
	return out;
}

/** Spawn (argv or `sh -c`) and resolve a {@link ShellOutput}; never rejects. */
function run(
	argv: string[],
	stdin: Buffer | undefined,
	cwd: string,
	raw: string | undefined,
): Promise<ShellOutput> {
	return new Promise<ShellOutput>((resolve) => {
		const [program, args] =
			raw !== undefined
				? (["sh", ["-c", raw]] as const)
				: ([argv[0] ?? "", argv.slice(1)] as const);

		if (program.length === 0) {
			resolve(makeOutput(1, "", "empty command"));
			return;
		}

		let stdout = "";
		let stderr = "";
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(program, args, { cwd, shell: false });
		} catch (err) {
			resolve(
				makeOutput(1, "", err instanceof Error ? err.message : String(err)),
			);
			return;
		}

		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", (err) => {
			// ENOENT / spawn failure: resolve as a failed command (nothrow contract).
			resolve(makeOutput(1, stdout, stderr + (err.message ?? String(err))));
		});
		child.on("close", (code) => {
			resolve(makeOutput(code ?? 0, stdout, stderr));
		});

		if (stdin !== undefined && child.stdin) {
			child.stdin.end(stdin);
		} else {
			child.stdin?.end();
		}
	});
}

/** Build the {@link ShellOutput} the consumers read (`.exitCode`/`.text()`/`.stdout`). */
function makeOutput(
	exitCode: number,
	stdout: string,
	stderr: string,
): ShellOutput {
	return {
		exitCode,
		stdout: { toString: () => stdout },
		stderr: { toString: () => stderr },
		text: () => stdout,
	};
}

/** Wrap a settle promise as a {@link ShellPromise} (adds the no-op `.quiet()`). */
function asShellPromise(p: Promise<ShellOutput>): ShellPromise {
	const sp = p as ShellPromise;
	sp.quiet = () => sp;
	return sp;
}

/**
 * Build a Node-backed {@link BunShell} bound to `cwd`. `.cwd(dir)` rebinds; both
 * `.cwd` and `.nothrow` return a fresh callable so the consumer chains exactly as
 * with Bun's `$`. The callable runs in ARGV mode unless an interpolation is
 * `{ raw }`, in which case it runs the whole template via `sh -c`.
 */
function makeShell(cwd: string): BunShell {
	const namespace = (
		strings: TemplateStringsArray,
		...expressions: unknown[]
	): ShellPromise => {
		const hasRaw = expressions.some(isRaw);
		if (hasRaw) {
			const raw = parseRaw(strings, expressions);
			return asShellPromise(run([], undefined, cwd, raw));
		}
		const { argv, stdin } = parseArgv(strings, expressions);
		return asShellPromise(run(argv, stdin, cwd, undefined));
	};
	const shell = namespace as BunShell;
	shell.cwd = (directory: string) => makeShell(directory);
	// `.nothrow()` is the default behavior here (a non-zero exit never rejects), so
	// it simply returns the same bound shell.
	shell.nothrow = () => shell;
	return shell;
}

/**
 * The host shell adapter for the workflows engine: a Node `child_process`-backed
 * {@link BunShell} rooted at `directory`. Threaded into `createWorkflowEngine`'s
 * `shell` option; the engine rebinds per-worktree via `.cwd(dir)`.
 */
export function createNodeShell(directory: string): BunShell {
	return makeShell(directory);
}
