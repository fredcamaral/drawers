/**
 * Unit tests for the pi agent resolver. The fs + dir-resolution seam is injected
 * so the suite is hermetic (no real `~/.pi`, no real cwd walk). We pin:
 *   - a present agent file → system prompt (body) + model/tools (frontmatter);
 *   - tools CSV is split/trimmed; empty/whitespace → undefined;
 *   - project resolution wins over user for the same name;
 *   - user fallback when no project file matches;
 *   - absent file / absent name / empty name → undefined (run pi's default);
 *   - a body-only file (no frontmatter) still yields a usable system prompt.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type AgentResolverDeps, resolveAgent } from "./agent-resolver";

const USER_DIR = "/home/u/.pi/agent/agents";
const CWD = "/repo/pkg";
const PROJECT_DIR = "/repo/.pi/agents"; // nearest ancestor of CWD

/**
 * Build the injected deps from a virtual filesystem: `files` maps absolute paths
 * to contents; `dirs` is the set of existing directories. Reads of an absent path
 * throw (mirrors fs.readFileSync ENOENT).
 */
function deps(
	files: Record<string, string>,
	dirs: string[] = [],
): AgentResolverDeps {
	const dirSet = new Set(dirs);
	return {
		userAgentsDir: USER_DIR,
		readFile: (p) => {
			const content = files[p];
			if (content === undefined) {
				throw new Error(`ENOENT: ${p}`);
			}
			return content;
		},
		existsDir: (p) => dirSet.has(p),
	};
}

const FULL_AGENT = `---
name: reviewer
description: a careful reviewer
model: anthropic/opus
tools: read, grep , bash
---
You are a careful code reviewer. Find bugs first.`;

describe("resolveAgent — resolution", () => {
	test("present user agent → body as system prompt + model + parsed tools", () => {
		const d = deps({ [join(USER_DIR, "reviewer.md")]: FULL_AGENT });
		const r = resolveAgent("reviewer", CWD, d);
		expect(r).toBeDefined();
		expect(r?.source).toBe("user");
		expect(r?.appendSystemPrompt).toBe(
			"You are a careful code reviewer. Find bugs first.",
		);
		expect(r?.model).toBe("anthropic/opus");
		// CSV split + trimmed, empties dropped.
		expect(r?.tools).toEqual(["read", "grep", "bash"]);
		expect(r?.filePath).toBe(join(USER_DIR, "reviewer.md"));
	});

	test("project agent wins over a same-named user agent", () => {
		const d = deps(
			{
				[join(PROJECT_DIR, "reviewer.md")]:
					"---\nmodel: x/proj\n---\nproject body",
				[join(USER_DIR, "reviewer.md")]: FULL_AGENT,
			},
			[PROJECT_DIR],
		);
		const r = resolveAgent("reviewer", CWD, d);
		expect(r?.source).toBe("project");
		expect(r?.appendSystemPrompt).toBe("project body");
		expect(r?.model).toBe("x/proj");
	});

	test("falls back to the user agent when no project file matches", () => {
		// PROJECT_DIR exists but holds a DIFFERENT agent → user file is used.
		const d = deps(
			{
				[join(PROJECT_DIR, "other.md")]: "---\n---\nother",
				[join(USER_DIR, "reviewer.md")]: FULL_AGENT,
			},
			[PROJECT_DIR],
		);
		const r = resolveAgent("reviewer", CWD, d);
		expect(r?.source).toBe("user");
		expect(r?.model).toBe("anthropic/opus");
	});

	test("body-only file (no frontmatter) → system prompt, no model/tools", () => {
		const d = deps({
			[join(USER_DIR, "bare.md")]: "Just be helpful and terse.",
		});
		const r = resolveAgent("bare", CWD, d);
		expect(r?.appendSystemPrompt).toBe("Just be helpful and terse.");
		expect(r?.model).toBeUndefined();
		expect(r?.tools).toBeUndefined();
	});

	test("frontmatter with empty/whitespace tools → tools undefined", () => {
		const d = deps({
			[join(USER_DIR, "notools.md")]: "---\ntools: '   '\n---\nbody",
		});
		const r = resolveAgent("notools", CWD, d);
		expect(r?.tools).toBeUndefined();
	});
});

describe("resolveAgent — default (no resolution)", () => {
	test("absent file → undefined (run pi's default assistant)", () => {
		const d = deps({}); // nothing on disk
		expect(resolveAgent("ghost", CWD, d)).toBeUndefined();
	});

	test("absent name → undefined", () => {
		const d = deps({ [join(USER_DIR, "reviewer.md")]: FULL_AGENT });
		expect(resolveAgent(undefined, CWD, d)).toBeUndefined();
	});

	test("empty name → undefined", () => {
		const d = deps({ [join(USER_DIR, "reviewer.md")]: FULL_AGENT });
		expect(resolveAgent("", CWD, d)).toBeUndefined();
	});

	test("no project dir anywhere up the tree → user lookup only", () => {
		// No dirs registered → findNearestProjectAgentsDir returns null; user hit.
		const d = deps({ [join(USER_DIR, "reviewer.md")]: FULL_AGENT });
		const r = resolveAgent("reviewer", CWD, d);
		expect(r?.source).toBe("user");
	});
});
