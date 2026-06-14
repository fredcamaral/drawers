/**
 * Destructive-git matcher (Epic 0.2) — `isDestructiveGit(command): boolean`.
 *
 * Recognizes the five working-tree destruction verbs that #5's forensics named —
 * `restore`, `checkout <pathspec>`, `reset` (any mode), `stash`, `clean` — run by
 * agents chasing a green gate. Used by the `tool.execute.before` deny hook to block
 * a worker session from clobbering the engine's version control.
 *
 * This is a STRING MATCHER, not a shell parser, and therefore one layer of
 * defense-in-depth — a mitigation, NOT a wall. Explicitly OUT OF SCOPE:
 *   - Variable-indirection / aliasing evasion (`g=git; $g restore .`,
 *     `alias x=git; x reset --hard`, `eval`, command substitution). A determined
 *     worker can route around a string match; that is accepted.
 *   - Native `write`/`edit` tool clobbering of files. This matcher only sees Bash
 *     command strings; non-shell file destruction is the engine's problem, not
 *     this layer's.
 * These gaps are why the deny hook is one layer of several, not the whole defense.
 *
 * Matching rules (per segment, after splitting compounds on
 * `&&` / `||` / `;` / `|` / `\n` / `&`):
 *   - EVERY `git` invocation in the segment is inspected (not just the first), so a
 *     benign-first/destructive-second sequence (`git status; git reset --hard`) is
 *     caught. A leading shell grouping char glued to git (`(git`, `{git`) is
 *     normalized off; including `git -C <dir>` (the `-C <dir>` / `-C=<dir>` global
 *     option is skipped to reach the subcommand).
 *   - `restore`, `stash`, `clean`, `reset` (ANY mode: bare, `--hard`, `--mixed`,
 *     `--soft`, `HEAD~`, …) → destructive.
 *   - `checkout` is destructive ONLY with a pathspec (`--`, `.`, or an explicit path
 *     shape: leading `./` / `../` / `/`, or trailing `/`), NOT for a bare branch
 *     switch like `git checkout main` nor a slashed branch/ref like
 *     `git checkout origin/main`.
 */

const DESTRUCTIVE_SUBCOMMANDS = new Set(["restore", "reset", "stash", "clean"]);

/**
 * Whether `command` contains at least one destructive git invocation. Compound
 * commands are split on `&&`, `||`, `;`, `|`, `\n`, and `&`, and EACH segment is
 * tested (and every git invocation within it).
 */
export function isDestructiveGit(command: string): boolean {
	return splitSegments(command).some(isDestructiveSegment);
}

/**
 * Split a compound command into segments on `&&`, `||`, `;`, `|` (single or
 * double), `\n`, and a bare `&`. Each segment is tested independently so
 * `cd ui && git restore .`, `git status && git restore .`, the newline form
 * `git status\ngit reset --hard`, and the backgrounding form
 * `git status & git reset --hard` all surface the destructive half. Without
 * `\n`/`&` a multi-line or backgrounded bash block is one segment, and only the
 * first git invocation in it would be inspected — a benign-first/destructive-second
 * sequence (the default shape an LLM worker emits) would slip the matcher.
 */
function splitSegments(command: string): string[] {
	return command.split(/&&|\|\||;|\||\n|&/);
}

function isDestructiveSegment(segment: string): boolean {
	const tokens = segment.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return false;

	// Inspect EVERY git invocation in the segment, not just the first: a single
	// segment may chain a benign git before a destructive one (e.g.
	// `git status\ngit reset --hard` if newline-splitting were ever bypassed, or a
	// grouping that lands multiple gits in one segment). Stopping at the first git
	// would let the benign-first/destructive-second sequence through.
	for (let g = 0; g < tokens.length; g++) {
		if (!isGitToken(tokens[g] as string)) continue;
		if (isDestructiveGitAt(tokens, g)) return true;
	}
	return false;
}

/**
 * A token that invokes `git`, after stripping a leading shell grouping/substitution
 * punctuation glued to it. A bare subshell or brace group (`(git restore .)`,
 * `{git reset;`) leaves `(git` / `{git` as one token, which an exact `=== "git"`
 * test misses. Command-substitution forms (`$(git …`, `` `git … ``) are out of
 * scope per the header, but normalizing their leading punctuation here is harmless
 * and keeps the check uniform.
 */
function isGitToken(token: string): boolean {
	return token.replace(/^[({]*\$?\(?`?/, "") === "git";
}

/**
 * Whether the git invocation starting at `gitIdx` in `tokens` is destructive.
 */
function isDestructiveGitAt(tokens: string[], gitIdx: number): boolean {
	// Walk past git's global options to the subcommand. We only need to recognize
	// `-C <dir>` / `-C=<dir>` (the pathspec-relevant one); any other global flag
	// (`-c k=v`, `--git-dir=…`) is skipped generically: a leading-dash token is an
	// option, and `-C`/`-c` consume the following token as their value.
	let i = gitIdx + 1;
	while (i < tokens.length) {
		const tok = tokens[i] as string;
		if (!tok.startsWith("-")) break;
		// `-C dir` and `-c k=v` take a separate value token (unless `=`-joined).
		if ((tok === "-C" || tok === "-c") && i + 1 < tokens.length) {
			i += 2;
			continue;
		}
		i += 1;
	}
	if (i >= tokens.length) return false;

	const subcommand = tokens[i] as string;
	if (DESTRUCTIVE_SUBCOMMANDS.has(subcommand)) return true;

	if (subcommand === "checkout") {
		// Destructive only with a pathspec — `--`, `.`, or a relative/explicit path.
		// A bare branch name (`git checkout main`) or a slashed branch/ref name
		// (`feature/foo`, `origin/main`) is a non-destructive branch switch.
		return tokens.slice(i + 1).some(isPathspec);
	}

	return false;
}

/**
 * A checkout argument that targets the working tree rather than a branch.
 *
 * `--` and `.` are unambiguous pathspecs. For a slash-bearing arg we must NOT
 * treat every slash as a path: slashed branch/ref names (`feature/foo`,
 * `release/1.2`, `origin/main`) are the dominant git convention and are branch
 * switches, not pathspecs. We only count it as a path when it carries an explicit
 * path shape — a leading `./`, `../`, or `/`, or a trailing `/` (a directory
 * pathspec like `src/`). The plan's TRUE case `git checkout src/` lands here via
 * the trailing slash; `git checkout origin/main` does not.
 */
function isPathspec(arg: string): boolean {
	if (arg === "--" || arg === ".") return true;
	return (
		arg.startsWith("./") ||
		arg.startsWith("../") ||
		arg.startsWith("/") ||
		arg.endsWith("/")
	);
}
