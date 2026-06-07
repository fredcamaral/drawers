import { describe, expect, test } from "bun:test";
import type { FsFacade, IdGenerator } from "@drawers/core";
import type { ToolContext } from "@opencode-ai/plugin";
import { createWorkflowEngine, type WorkflowEngine } from "../engine";
import { createWorkflowTool } from "./workflow";

/**
 * Tests for the `workflow` launch tool (Task 4.1.3). The tool drives the REAL
 * engine over the same in-memory fakes engine.test.ts uses (inlined here — the
 * engine test does not export its helpers).
 */

function basename(path: string): string {
	const i = path.lastIndexOf("/");
	return i === -1 ? path : path.slice(i + 1);
}
function dirname(path: string): string {
	const i = path.lastIndexOf("/");
	return i === -1 ? "" : path.slice(0, i);
}

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

function makeClient() {
	return {
		session: {
			create: async () => ({ data: { id: "ses_child" } }),
			promptAsync: async () => undefined,
			abort: async () => undefined,
			messages: async () => ({ data: [] }),
			get: async () => ({ data: { id: "ses_child" } }),
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
const DIRECTORY = "/proj";

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
const HANGING = `${META}await agent("do work");\nreturn "done";\n`;

function makeEngine(opts: {
	files?: Record<string, string>;
	ids?: IdGenerator;
}): { engine: WorkflowEngine; facade: FsFacade } {
	const { facade } = makeFs(opts.files);
	const engine = createWorkflowEngine({
		client: makeClient(),
		directory: DIRECTORY,
		dataDir: BASE,
		fs: facade,
		clock,
		logger: noopLogger,
		ids: opts.ids,
	});
	return { engine, facade };
}

const ctx = (sessionID: string) => ({ sessionID }) as unknown as ToolContext;

/** Resolve a ToolResult (string | object) to its output text. */
function outputText(result: string | { output: string }): string {
	return typeof result === "string" ? result : result.output;
}

/** Invoke the tool and coerce its result to the output string. */
async function run(
	// biome-ignore lint/suspicious/noExplicitAny: tool() execute is generically typed per its arg schema.
	t: { execute: (...a: any[]) => Promise<unknown> },
	args: Record<string, unknown>,
	c: ToolContext,
): Promise<string> {
	return outputText((await t.execute(args, c)) as string | { output: string });
}

describe("createWorkflowTool — source selection (xor)", () => {
	test("zero sources → error naming the rule", async () => {
		const { engine, facade } = makeEngine({});
		const t = createWorkflowTool(engine, { directory: DIRECTORY, fs: facade });
		const out = await run(t, {}, ctx("ses_parent"));
		expect(out).toContain("exactly one");
		await engine.dispose();
	});

	test("two sources → error naming the rule", async () => {
		const { engine, facade } = makeEngine({});
		const t = createWorkflowTool(engine, { directory: DIRECTORY, fs: facade });
		const out = await run(
			t,
			{ script: HANGING, name: "thing" },
			ctx("ses_parent"),
		);
		expect(out).toContain("exactly one");
		await engine.dispose();
	});

	test("empty strings coerce to absent (empty script + empty name = zero)", async () => {
		const { engine, facade } = makeEngine({});
		const t = createWorkflowTool(engine, { directory: DIRECTORY, fs: facade });
		const out = await run(t, { script: "   ", name: "" }, ctx("ses_parent"));
		expect(out).toContain("exactly one");
		await engine.dispose();
	});
});

describe("createWorkflowTool — inline script happy path", () => {
	test("returns runId + persisted scriptPath + name + no-poll guidance before settle", async () => {
		const { engine, facade } = makeEngine({ ids: fixedIds("wf_aaaa1111") });
		const t = createWorkflowTool(engine, { directory: DIRECTORY, fs: facade });

		const out = await run(t, { script: HANGING }, ctx("ses_parent"));

		expect(out).toContain("wf_aaaa1111");
		expect(out).toContain(`${BASE}/workflow-scripts/wf_aaaa1111.js`);
		expect(out).toContain("demo");
		expect(out).toContain("do not poll");
		expect(out).toContain("workflow_status");

		// run still in flight (HANGING never settles against inert client).
		expect(engine.statusOf("wf_aaaa1111")?.record.status).toBe("running");
		// parentSessionID came from the tool context.
		expect(engine.statusOf("wf_aaaa1111")?.record.parentSessionID).toBe(
			"ses_parent",
		);
		await engine.dispose();
	});
});

describe("createWorkflowTool — saved-name resolution", () => {
	const wfDir = `${DIRECTORY}/.opencode/workflows`;

	test("name resolves <directory>/.opencode/workflows/<name>.js", async () => {
		const { engine, facade } = makeEngine({
			files: {
				[`${wfDir}/review.js`]: HANGING,
				[`${wfDir}/other.js`]: HANGING,
			},
			ids: fixedIds("wf_named001"),
		});
		const t = createWorkflowTool(engine, { directory: DIRECTORY, fs: facade });
		const out = await run(t, { name: "review" }, ctx("ses_parent"));
		expect(out).toContain("wf_named001");
		expect(engine.statusOf("wf_named001")?.record.status).toBe("running");
		await engine.dispose();
	});

	test("missing name lists available files in the dir", async () => {
		const { engine, facade } = makeEngine({
			files: {
				[`${wfDir}/review.js`]: HANGING,
				[`${wfDir}/deploy.js`]: HANGING,
			},
		});
		const t = createWorkflowTool(engine, { directory: DIRECTORY, fs: facade });
		const out = await run(t, { name: "nope" }, ctx("ses_parent"));
		expect(out).toContain("nope");
		expect(out).toContain("review.js");
		expect(out).toContain("deploy.js");
		await engine.dispose();
	});

	test("missing name with empty dir says so", async () => {
		const { engine, facade } = makeEngine({});
		const t = createWorkflowTool(engine, { directory: DIRECTORY, fs: facade });
		const out = await run(t, { name: "nope" }, ctx("ses_parent"));
		expect(out.toLowerCase()).toContain("no");
		await engine.dispose();
	});

	test(".mjs fallback when no .js exists", async () => {
		const { engine, facade } = makeEngine({
			files: { [`${wfDir}/build.mjs`]: HANGING },
			ids: fixedIds("wf_mjs00001"),
		});
		const t = createWorkflowTool(engine, { directory: DIRECTORY, fs: facade });
		const out = await run(t, { name: "build" }, ctx("ses_parent"));
		expect(out).toContain("wf_mjs00001");
		await engine.dispose();
	});
});

describe("createWorkflowTool — script_path", () => {
	test("relative path resolves against directory and reads the file", async () => {
		const { engine, facade } = makeEngine({
			files: { [`${DIRECTORY}/flows/a.js`]: HANGING },
			ids: fixedIds("wf_path0001"),
		});
		const t = createWorkflowTool(engine, { directory: DIRECTORY, fs: facade });
		const out = await run(t, { script_path: "flows/a.js" }, ctx("ses_parent"));
		expect(out).toContain("wf_path0001");
		await engine.dispose();
	});

	test("unreadable script_path → honest error", async () => {
		const { engine, facade } = makeEngine({});
		const t = createWorkflowTool(engine, { directory: DIRECTORY, fs: facade });
		const out = await run(
			t,
			{ script_path: "flows/missing.js" },
			ctx("ses_parent"),
		);
		expect(out.toLowerCase()).toContain("could not read");
		expect(out).toContain("missing.js");
		await engine.dispose();
	});
});

describe("createWorkflowTool — args coercion", () => {
	test("args as object passes through verbatim", async () => {
		const { engine, facade } = makeEngine({ ids: fixedIds("wf_args0001") });
		const t = createWorkflowTool(engine, { directory: DIRECTORY, fs: facade });
		await run(
			t,
			{ script: HANGING, args: { hello: "world" } },
			ctx("ses_parent"),
		);
		expect(engine.statusOf("wf_args0001")?.record.args).toEqual({
			hello: "world",
		});
		await engine.dispose();
	});

	test("args as JSON string parses", async () => {
		const { engine, facade } = makeEngine({ ids: fixedIds("wf_args0002") });
		const t = createWorkflowTool(engine, { directory: DIRECTORY, fs: facade });
		await run(t, { script: HANGING, args: '{"n":42}' }, ctx("ses_parent"));
		expect(engine.statusOf("wf_args0002")?.record.args).toEqual({ n: 42 });
		await engine.dispose();
	});

	test("args as empty string → undefined (not launched-with-garbage)", async () => {
		const { engine, facade } = makeEngine({ ids: fixedIds("wf_args0003") });
		const t = createWorkflowTool(engine, { directory: DIRECTORY, fs: facade });
		await run(t, { script: HANGING, args: "   " }, ctx("ses_parent"));
		expect(engine.statusOf("wf_args0003")?.record.args).toBeUndefined();
		await engine.dispose();
	});

	test("args as garbage string → honest parse error, no launch", async () => {
		const { engine, facade } = makeEngine({ ids: fixedIds("wf_args0004") });
		const t = createWorkflowTool(engine, { directory: DIRECTORY, fs: facade });
		const out = await run(
			t,
			{ script: HANGING, args: "{not json" },
			ctx("ses_parent"),
		);
		expect(out.toLowerCase()).toContain("args");
		expect(out.toLowerCase()).toContain("json");
		expect(engine.statusOf("wf_args0004")).toBeUndefined();
		await engine.dispose();
	});
});

describe("createWorkflowTool — resume placeholder", () => {
	test("resume_from_run_id returns the 4.2.2 placeholder, does not launch", async () => {
		const { engine, facade } = makeEngine({});
		const t = createWorkflowTool(engine, { directory: DIRECTORY, fs: facade });
		const out = await run(
			t,
			{ script: HANGING, resume_from_run_id: "wf_prev0001" },
			ctx("ses_parent"),
		);
		expect(out).toContain("4.2.2");
		expect(engine.runs.size).toBe(0);
		await engine.dispose();
	});
});
