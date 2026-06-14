import { describe, expect, test } from "bun:test";
import type { FsFacade } from "@drawers/core";
import type { ToolContext } from "@opencode-ai/plugin";
import { createWorkflowSkillsTool } from "./workflow-skills";

/**
 * An in-memory {@link FsFacade} over a flat `path -> content` map (the same shape
 * `skill-catalog.test.ts` uses): directories are implicit and `readdir` throws on
 * a file path or unknown path, which is how `loadSkillCatalog` tells dirs from
 * files. These tests drive the tool's `execute` through a seeded catalog and
 * assert on the rendered text — the disk-scan correctness is the catalog's own
 * test; here the contract under test is the rendering, filtering, and the honest
 * empty/no-match messages.
 */
function memFs(files: Record<string, string>): FsFacade {
	const has = (p: string) => Object.hasOwn(files, p);
	const norm = (p: string) => (p.endsWith("/") ? p.slice(0, -1) : p);
	return {
		mkdir: async () => undefined,
		writeFile: async (path, data) => {
			files[path] = data;
		},
		rename: async () => undefined,
		rm: async () => undefined,
		readFile: async (path) => {
			const content = files[path];
			if (content === undefined) {
				throw new Error(`ENOENT: ${path}`);
			}
			return content;
		},
		readdir: async (path) => {
			const dir = norm(path);
			if (has(dir)) {
				throw new Error(`ENOTDIR: ${dir}`);
			}
			const prefix = `${dir}/`;
			const children = new Set<string>();
			for (const full of Object.keys(files)) {
				if (full.startsWith(prefix)) {
					const name = full.slice(prefix.length).split("/")[0];
					if (name) {
						children.add(name);
					}
				}
			}
			if (children.size === 0) {
				throw new Error(`ENOENT: ${dir}`);
			}
			return [...children];
		},
	};
}

const PROJECT = "/proj/.opencode/skill";

/** A SKILL.md frontmatter block for the given name/description. */
function skillFile(name: string, description: string): string {
	return [
		"---",
		`name: ${name}`,
		`description: ${description}`,
		"---",
		"body",
	].join("\n");
}

const ctx = () => ({ sessionID: "ses_parent" }) as unknown as ToolContext;

/** Resolve a ToolResult (string | { output }) to its output text. */
function outputText(result: string | { output: string }): string {
	return typeof result === "string" ? result : result.output;
}

function makeTool(files: Record<string, string>) {
	return createWorkflowSkillsTool({ directory: "/proj", fs: memFs(files) });
}

/** Invoke the tool's execute and coerce the result to its output string. */
async function run(
	files: Record<string, string>,
	args: Record<string, unknown>,
): Promise<string> {
	const tool = makeTool(files);
	const result = (await tool.execute(args, ctx())) as
		| string
		| { output: string };
	return outputText(result);
}

const TWO_SKILLS: Record<string, string> = {
	[`${PROJECT}/writing-trds/SKILL.md`]: skillFile(
		"ring:writing-trds",
		"Write technical requirement docs",
	),
	[`${PROJECT}/reviewing-code/SKILL.md`]: skillFile(
		"ring:reviewing-code",
		"Review a diff for correctness bugs",
	),
};

describe("createWorkflowSkillsTool", () => {
	test("lists seeded skills with name and description", async () => {
		const out = await run(TWO_SKILLS, {});
		expect(out).toContain(
			"ring:writing-trds — Write technical requirement docs",
		);
		expect(out).toContain(
			"ring:reviewing-code — Review a diff for correctness bugs",
		);
		// A header naming the count leads the output.
		expect(out).toContain("2");
	});

	test("filter narrows by name", async () => {
		const out = await run(TWO_SKILLS, { filter: "writing" });
		expect(out).toContain("ring:writing-trds");
		expect(out).not.toContain("ring:reviewing-code");
	});

	test("filter narrows by description (case-insensitive)", async () => {
		const out = await run(TWO_SKILLS, { filter: "DIFF" });
		expect(out).toContain("ring:reviewing-code");
		expect(out).not.toContain("ring:writing-trds");
	});

	test("empty catalog returns the honest empty message", async () => {
		const out = await run({}, {});
		expect(out).toBe(
			"No skills are installed (looked under the user and project .opencode/skill roots).",
		);
	});

	test("filter with no match names the filter back", async () => {
		const out = await run(TWO_SKILLS, { filter: "nonsense-xyz" });
		expect(out).toBe('No skills match the filter "nonsense-xyz".');
	});

	test("description is truncated to a single bounded line with an ellipsis", async () => {
		const long = "x".repeat(500);
		const out = await run(
			{
				[`${PROJECT}/big/SKILL.md`]: skillFile("ring:big", long),
			},
			{},
		);
		expect(out).toContain("…");
		expect(out).not.toContain(long);
		// No inner newline inside the rendered skill line.
		const line = out.split("\n").find((l) => l.startsWith("ring:big"));
		expect(line).toBeDefined();
		expect((line as string).length).toBeLessThan(260);
	});
});
