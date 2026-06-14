import { describe, expect, test } from "bun:test";
import { isDestructiveGit } from "./git-deny";

describe("isDestructiveGit (Epic 0.2)", () => {
	const TRUE_CASES: string[] = [
		"git restore foo.txt",
		"git restore .",
		"git checkout -- f",
		"git checkout .",
		"git checkout src/",
		"git reset --hard",
		"git reset",
		"git reset HEAD~",
		"git stash",
		"git clean -fd",
		"cd ui && git restore .",
		"git status && git restore .",
		"git -C ui restore .",
		// Finding 1: newline-separated segments + benign-first/destructive-second.
		"git status\ngit reset --hard",
		"git add -A\ngit restore .",
		"git log\ngit checkout -- .",
		"git add -A\ngit reset --hard HEAD",
		"git status & git reset --hard",
		// Finding 2: leading shell punctuation glued to `git` (bare subshell grouping).
		"(git restore .)",
		"( git reset --hard )",
		"echo start\n(git restore .)",
	];

	const FALSE_CASES: string[] = [
		"git status",
		"git diff",
		"git add -A",
		"git commit",
		"git checkout main",
		"git log",
		"rm -rf",
		// Finding 3: slashed branch/ref names are branch switches, not pathspecs.
		"git checkout feature/foo",
		"git checkout release/1.2",
		"git checkout origin/main",
	];

	test.each(TRUE_CASES)("destructive: %s", (cmd) => {
		expect(isDestructiveGit(cmd)).toBe(true);
	});

	test.each(FALSE_CASES)("not destructive: %s", (cmd) => {
		expect(isDestructiveGit(cmd)).toBe(false);
	});
});
