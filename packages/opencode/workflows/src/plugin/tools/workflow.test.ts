import { describe, expect, test } from "bun:test";
import type { FsFacade, IdGenerator } from "@drawers/core";
import type { ToolContext } from "@opencode-ai/plugin";
import { createWorkflowEngine, type WorkflowEngine } from "../engine";
import { computeCallKey } from "../journal";
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

describe("createWorkflowTool — description is the authoring contract", () => {
	test("description carries every load-bearing authoring fact", () => {
		const { engine, facade } = makeEngine({});
		const t = createWorkflowTool(engine, { directory: DIRECTORY, fs: facade });
		const d = (t as unknown as { description: string }).description;

		// Opt-in gate and no-poll guidance must survive the expansion.
		expect(d).toContain("ultracode");
		expect(d).toContain("do not poll");
		// Meta block contract.
		expect(d).toContain("export const meta");
		expect(d).toContain("pure literal");
		// The nine globals and their core semantics.
		expect(d).toContain("agent(");
		expect(d).toContain("pipeline(");
		expect(d).toContain("parallel(");
		expect(d).toContain("phase(");
		expect(d).toContain("budget");
		expect(d).toContain("workflow(");
		expect(d).toContain("shell(");
		expect(d).toContain("filter(Boolean)");
		// Determinism bans.
		expect(d).toContain("Math.random()");
		expect(d).toContain("Date.now()");
		// Caps.
		expect(d).toContain("1000");
		expect(d).toContain("4096");
		// Resume + saved workflows (Task 7.3.1: per-item key+occurrence matching,
		// position-independent, with the R5 non-determinism contract line).
		expect(d).toContain("key + occurrence");
		expect(d).toContain("independent of position");
		expect(d).toContain("agents are non-deterministic");
		expect(d).toContain(".opencode/workflows/");
		// Plain JS, not TypeScript.
		expect(d).toContain("not TypeScript");
	});
});

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

describe("createWorkflowTool — architecture echo at submit (Task 6.2.2)", () => {
	const REVIEW = `export const meta = { name: "review-changes", description: "Review changed files", phases: [{ title: "Review" }, { title: "Verify" }] };
const results = await pipeline(
  args.files,
  (f) => agent("Review " + f, { phase: "Review", schema: FINDINGS }),
  (r, f) => r && parallel(r.issues.map((i) => () => agent("Verify " + i, { phase: "Verify" }))),
);
return { verified: results };
`;

	test("echoes meta name + phases alongside the run-id-first line", async () => {
		const { engine, facade } = makeEngine({ ids: fixedIds("wf_arch0001") });
		const t = createWorkflowTool(engine, { directory: DIRECTORY, fs: facade });
		const out = await run(t, { script: REVIEW }, ctx("ses_parent"));

		// Run-id-first line is intact (the model parses it).
		expect(out.startsWith("Launched workflow wf_arch0001")).toBe(true);
		// Architecture echo: meta name + phase titles.
		expect(out).toContain("review-changes");
		expect(out).toContain("Review");
		expect(out).toContain("Verify");
		await engine.dispose();
	});

	test("echoes detected primitive call-site counts, labeled as detected (not a DAG)", async () => {
		const { engine, facade } = makeEngine({ ids: fixedIds("wf_arch0002") });
		const t = createWorkflowTool(engine, { directory: DIRECTORY, fs: facade });
		const out = await run(t, { script: REVIEW }, ctx("ses_parent"));

		// Honest framing: these are DETECTED call-sites, not a proven graph.
		expect(out.toLowerCase()).toContain("detected");
		// REVIEW has 2 agent( call-sites, 1 pipeline(, 1 parallel(, and a schema.
		expect(out).toContain("agent");
		expect(out).toContain("pipeline");
		expect(out).toContain("parallel");
		expect(out).toContain("schema");
		await engine.dispose();
	});

	test("counts agent() call-sites accurately on a multi-agent script", async () => {
		const SCRIPT = `export const meta = { name: "fan", description: "d" };
await agent("one");
await agent("two");
await agent("three");
return 1;
`;
		const { engine, facade } = makeEngine({ ids: fixedIds("wf_arch0003") });
		const t = createWorkflowTool(engine, { directory: DIRECTORY, fs: facade });
		const out = await run(t, { script: SCRIPT }, ctx("ses_parent"));
		// Three agent( call-sites detected.
		expect(out).toMatch(/3.*agent/);
		await engine.dispose();
	});

	test("a resume with no source override omits the architecture block (no source in hand)", async () => {
		// Seed a prior run so the resume path succeeds with no source param.
		const META_LOCAL = `export const meta = { name: "demo", description: "d" };\n`;
		const ONE_AGENT = `${META_LOCAL}const r = await agent("do work");\nreturn r;\n`;
		const record = {
			id: "wf_priorA",
			parentSessionID: "ses_parent",
			status: "completed",
			description: "demo",
			createdAt: NOW - 1000,
			completedAt: NOW - 500,
			scriptPath: `${BASE}/workflow-scripts/wf_priorA.js`,
		};
		const files = {
			[`${BASE}/workflow-runs/wf_priorA.json`]: JSON.stringify(record),
			[`${BASE}/workflow-scripts/wf_priorA.js`]: ONE_AGENT,
		};
		const { engine, facade } = makeEngine({
			files,
			ids: fixedIds("wf_resumeA"),
		});
		await engine.ready();
		const t = createWorkflowTool(engine, { directory: DIRECTORY, fs: facade });
		const out = await run(
			t,
			{ resume_from_run_id: "wf_priorA" },
			ctx("ses_parent"),
		);
		// Run-id-first line still intact; no detected-primitives block.
		expect(out).toContain("wf_resumeA");
		expect(out.toLowerCase()).not.toContain("detected");
		// A resume emits no source-derived nudges either.
		expect(out).not.toContain("consider:");
		await engine.dispose();
	});

	test("schema nudge fires on a gated, schema-less script (Task 2.1.2)", async () => {
		const SCRIPT = `export const meta = { name: "gate-untyped", description: "d" };
const results = await parallel(args.files.map((f) => () => agent("Summarize " + f)));
return { results };
`;
		const { engine, facade } = makeEngine({ ids: fixedIds("wf_arch0004") });
		const t = createWorkflowTool(engine, { directory: DIRECTORY, fs: facade });
		const out = await run(t, { script: SCRIPT }, ctx("ses_parent"));

		expect(out).toContain("no schema detected");
		expect(out.toLowerCase()).toContain("consider");
		// Neutral verb + no disk-truth tokens → disk-truth nudge stays silent.
		expect(out).not.toContain("disk-truth");
		await engine.dispose();
	});

	test("schema nudge silent on a gated script that sets a schema (Task 2.1.2)", async () => {
		const SCRIPT = `export const meta = { name: "gate-with-schema", description: "d" };
const results = await parallel(args.files.map((f) => () => agent("Summarize " + f, { schema: { type: 'object' } })));
return { results };
`;
		const { engine, facade } = makeEngine({ ids: fixedIds("wf_arch0005") });
		const t = createWorkflowTool(engine, { directory: DIRECTORY, fs: facade });
		const out = await run(t, { script: SCRIPT }, ctx("ses_parent"));

		expect(out).not.toContain("no schema detected");
		await engine.dispose();
	});

	test("disk-truth nudge fires on a review-shaped script with no disk-truth token (Task 2.1.2)", async () => {
		const SCRIPT = `export const meta = { name: "review-no-disktruth", description: "d" };
const results = await parallel(args.files.map((f) => () => agent("Review " + f, { schema: { type: 'object' } })));
return { results };
`;
		const { engine, facade } = makeEngine({ ids: fixedIds("wf_arch0006") });
		const t = createWorkflowTool(engine, { directory: DIRECTORY, fs: facade });
		const out = await run(t, { script: SCRIPT }, ctx("ses_parent"));

		expect(out).toContain("disk-truth");
		expect(out).toContain("review-against-disk-truth");
		// Schema present → schema nudge stays silent, isolating the disk-truth assertion.
		expect(out).not.toContain("no schema detected");
		await engine.dispose();
	});

	test("disk-truth nudge silent on a script that uses verifyDiff/contextDiff (Task 2.1.2)", async () => {
		// No bare review/fix/verify word — the only `verify` substring is inside
		// `verifyDiff`, proving `\bverify\b` does not falsely trip the token.
		const SCRIPT = `export const meta = { name: "good-disktruth", description: "d" };
const results = await parallel(args.files.map((f) => () => agent("Inspect " + f, { contextDiff: true, schema: { type: 'object' } })));
const repaired = await agent("Repair the unit", { verifyDiff: { check: 'bun test' }, schema: { type: 'object' } });
return { results, repaired };
`;
		const { engine, facade } = makeEngine({ ids: fixedIds("wf_arch0007") });
		const t = createWorkflowTool(engine, { directory: DIRECTORY, fs: facade });
		const out = await run(t, { script: SCRIPT }, ctx("ses_parent"));

		expect(out).not.toContain("disk-truth");
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

	test("absolute path loads verbatim (not joined under directory)", async () => {
		const absPath = "/abs/elsewhere/flow.js";
		const { engine, facade } = makeEngine({
			files: { [absPath]: HANGING },
			ids: fixedIds("wf_abs00001"),
		});
		const t = createWorkflowTool(engine, { directory: DIRECTORY, fs: facade });
		const out = await run(t, { script_path: absPath }, ctx("ses_parent"));
		expect(out).toContain("wf_abs00001");
		expect(engine.statusOf("wf_abs00001")?.record.status).toBe("running");
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

describe("createWorkflowTool — budget_tokens coercion", () => {
	test("a finite positive number threads budgetTokens to startRun", async () => {
		const calls: { budgetTokens?: number }[] = [];
		const engine = {
			startRun: async (a: { budgetTokens?: number }) => {
				calls.push({ budgetTokens: a.budgetTokens });
				return { runId: "wf_x", scriptPath: "/p", name: "n" };
			},
			statusOf: () => undefined,
			runs: new Map(),
		} as unknown as WorkflowEngine;
		const { facade } = makeFs();
		const t = createWorkflowTool(engine, { directory: DIRECTORY, fs: facade });
		await run(t, { script: HANGING, budget_tokens: 5000 }, ctx("ses_parent"));
		expect(calls[0]?.budgetTokens).toBe(5000);
	});

	test("a numeric string coerces to a number", async () => {
		const calls: { budgetTokens?: number }[] = [];
		const engine = {
			startRun: async (a: { budgetTokens?: number }) => {
				calls.push({ budgetTokens: a.budgetTokens });
				return { runId: "wf_x", scriptPath: "/p", name: "n" };
			},
			statusOf: () => undefined,
			runs: new Map(),
		} as unknown as WorkflowEngine;
		const { facade } = makeFs();
		const t = createWorkflowTool(engine, { directory: DIRECTORY, fs: facade });
		await run(t, { script: HANGING, budget_tokens: "5000" }, ctx("ses_parent"));
		expect(calls[0]?.budgetTokens).toBe(5000);
	});

	test("NaN / non-numeric / zero / negative / absent all coerce to undefined (no budget)", async () => {
		for (const raw of [Number.NaN, "not a number", 0, -100, undefined, ""]) {
			const calls: { budgetTokens?: number }[] = [];
			const engine = {
				startRun: async (a: { budgetTokens?: number }) => {
					calls.push({ budgetTokens: a.budgetTokens });
					return { runId: "wf_x", scriptPath: "/p", name: "n" };
				},
				statusOf: () => undefined,
				runs: new Map(),
			} as unknown as WorkflowEngine;
			const { facade } = makeFs();
			const t = createWorkflowTool(engine, {
				directory: DIRECTORY,
				fs: facade,
			});
			await run(t, { script: HANGING, budget_tokens: raw }, ctx("ses_parent"));
			expect(calls[0]?.budgetTokens).toBeUndefined();
		}
	});
});

describe("createWorkflowTool — spec_path coercion (Issue 6)", () => {
	const stubEngine = (calls: { specPath?: string }[]): WorkflowEngine =>
		({
			startRun: async (a: { specPath?: string }) => {
				calls.push({ specPath: a.specPath });
				return { runId: "wf_x", scriptPath: "/p", name: "n" };
			},
			statusOf: () => undefined,
			runs: new Map(),
		}) as unknown as WorkflowEngine;

	test("a non-empty spec_path threads (trimmed) to startRun as specPath", async () => {
		const calls: { specPath?: string }[] = [];
		const { facade } = makeFs();
		const t = createWorkflowTool(stubEngine(calls), {
			directory: DIRECTORY,
			fs: facade,
		});
		await run(
			t,
			{ script: HANGING, spec_path: "  docs/plans/plan.md  " },
			ctx("ses_parent"),
		);
		expect(calls[0]?.specPath).toBe("docs/plans/plan.md");
	});

	test("an empty / whitespace / absent spec_path coerces to undefined (no key set)", async () => {
		for (const raw of ["", "   ", undefined]) {
			const calls: { specPath?: string }[] = [];
			const { facade } = makeFs();
			const t = createWorkflowTool(stubEngine(calls), {
				directory: DIRECTORY,
				fs: facade,
			});
			await run(t, { script: HANGING, spec_path: raw }, ctx("ses_parent"));
			expect(calls[0]?.specPath).toBeUndefined();
		}
	});

	test("a spec_path escaping the project directory is REJECTED at the tool boundary (#6)", async () => {
		// spec_path is model-supplied: `join(directory, '../../etc/passwd')` used to
		// escape the repo (and the engine would later COPY it into worktrees). The
		// tool must refuse with an honest error and never reach startRun.
		for (const escapee of [
			"../outside.md",
			"../../etc/passwd",
			"docs/../../outside.md",
			"/etc/passwd",
		]) {
			const calls: { specPath?: string }[] = [];
			const { facade } = makeFs();
			const t = createWorkflowTool(stubEngine(calls), {
				directory: DIRECTORY,
				fs: facade,
			});
			const out = await run(
				t,
				{ script: HANGING, spec_path: escapee },
				ctx("ses_parent"),
			);
			expect(out).toContain("spec_path must resolve inside the project");
			expect(calls).toHaveLength(0);
		}
	});

	test("an ABSOLUTE spec_path under the project directory normalizes to repo-relative (#6)", async () => {
		// The documented contract is "repo-relative or absolute" — joinPath used to
		// MANGLE an absolute path by re-rooting it under the project directory.
		const calls: { specPath?: string }[] = [];
		const { facade } = makeFs();
		const t = createWorkflowTool(stubEngine(calls), {
			directory: DIRECTORY,
			fs: facade,
		});
		await run(
			t,
			{ script: HANGING, spec_path: "/proj/docs/plans/plan.md" },
			ctx("ses_parent"),
		);
		expect(calls[0]?.specPath).toBe("docs/plans/plan.md");
	});

	test("a repo-relative spec_path with an INTERNAL ../ that stays inside normalizes cleanly (#6)", async () => {
		const calls: { specPath?: string }[] = [];
		const { facade } = makeFs();
		const t = createWorkflowTool(stubEngine(calls), {
			directory: DIRECTORY,
			fs: facade,
		});
		await run(
			t,
			{ script: HANGING, spec_path: "docs/sub/../plans/plan.md" },
			ctx("ses_parent"),
		);
		expect(calls[0]?.specPath).toBe("docs/plans/plan.md");
	});
});

describe("createWorkflowTool — resume", () => {
	const META_LOCAL = `export const meta = { name: "demo", description: "d" };\n`;
	const ONE_AGENT = `${META_LOCAL}const r = await agent("do work");\nreturn r;\n`;

	/** Seed a completed prior run (record + script + one-entry journal) on disk. */
	function seedPrior(id: string, result: unknown): Record<string, string> {
		const record = {
			id,
			parentSessionID: "ses_parent",
			status: "completed",
			description: "demo",
			createdAt: NOW - 1000,
			completedAt: NOW - 500,
			scriptPath: `${BASE}/workflow-scripts/${id}.js`,
			returnValue: result,
		};
		const entry = {
			index: 0,
			key: computeCallKey({ prompt: "do work" }),
			status: "ok",
			result,
		};
		return {
			[`${BASE}/workflow-runs/${id}.json`]: JSON.stringify(record),
			[`${BASE}/workflow-scripts/${id}.js`]: ONE_AGENT,
			[`${BASE}/workflow-journals/${id}.jsonl`]: `${JSON.stringify(entry)}\n`,
		};
	}

	test("resume without a source uses the prior script and re-persists it under the new runId", async () => {
		const files = seedPrior("wf_prior001", "CACHED");
		const { engine, facade } = makeEngine({
			files,
			ids: fixedIds("wf_resume001"),
		});
		const t = createWorkflowTool(engine, { directory: DIRECTORY, fs: facade });

		// No source params at all — only resume_from_run_id. The xor check must NOT
		// fire when resuming.
		const out = await run(
			t,
			{ resume_from_run_id: "wf_prior001" },
			ctx("ses_parent"),
		);

		expect(out).toContain("wf_resume001");
		expect(out.toLowerCase()).toContain("resumed from");
		expect(out).toContain("wf_prior001");

		await Promise.resolve();
		await Promise.resolve();

		const status = engine.statusOf("wf_resume001");
		expect(status?.record.resumedFrom).toBe("wf_prior001");
		// The prior script was re-persisted verbatim under the NEW runId.
		const priorSrc = `${BASE}/workflow-scripts/wf_prior001.js`;
		const newSrc = `${BASE}/workflow-scripts/wf_resume001.js`;
		expect(engine.statusOf("wf_resume001")?.record.scriptPath).toBe(newSrc);
		// Same script content under both paths (read via the shared fake fs).
		expect(await facade.readFile(newSrc, "utf-8")).toBe(
			await facade.readFile(priorSrc, "utf-8"),
		);

		await engine.dispose();
	});

	/** Seed a completed prior run carrying persisted `args`. */
	function seedPriorWithArgs(
		id: string,
		args: unknown,
	): Record<string, string> {
		const record = {
			id,
			parentSessionID: "ses_parent",
			status: "completed",
			description: "demo",
			createdAt: NOW - 1000,
			completedAt: NOW - 500,
			scriptPath: `${BASE}/workflow-scripts/${id}.js`,
			args,
			returnValue: "X",
		};
		return {
			[`${BASE}/workflow-runs/${id}.json`]: JSON.stringify(record),
			[`${BASE}/workflow-scripts/${id}.js`]: ONE_AGENT,
		};
	}

	test("resume WITHOUT args inherits the prior run's persisted args", async () => {
		const priorArgs = { files: ["a.ts", "b.ts"], n: 3 };
		const files = seedPriorWithArgs("wf_inherit01", priorArgs);
		const { engine, facade } = makeEngine({
			files,
			ids: fixedIds("wf_inheritR1"),
		});
		await engine.ready();
		const t = createWorkflowTool(engine, { directory: DIRECTORY, fs: facade });

		await run(t, { resume_from_run_id: "wf_inherit01" }, ctx("ses_parent"));

		expect(engine.statusOf("wf_inheritR1")?.record.args).toEqual(priorArgs);
		await engine.dispose();
	});

	test("resume WITH explicit args overrides the prior run's args", async () => {
		const files = seedPriorWithArgs("wf_override01", { old: true });
		const { engine, facade } = makeEngine({
			files,
			ids: fixedIds("wf_overrideR1"),
		});
		await engine.ready();
		const t = createWorkflowTool(engine, { directory: DIRECTORY, fs: facade });

		await run(
			t,
			{ resume_from_run_id: "wf_override01", args: { fresh: 1 } },
			ctx("ses_parent"),
		);

		expect(engine.statusOf("wf_overrideR1")?.record.args).toEqual({ fresh: 1 });
		await engine.dispose();
	});

	test("resume of an unknown id surfaces the engine error (known-run listing)", async () => {
		const files = seedPrior("wf_known001", "X");
		const { engine, facade } = makeEngine({ files });
		await engine.ready();
		const t = createWorkflowTool(engine, { directory: DIRECTORY, fs: facade });
		const out = await run(
			t,
			{ resume_from_run_id: "wf_nope" },
			ctx("ses_parent"),
		);
		expect(out.toLowerCase()).toContain("unknown");
		expect(out).toContain("wf_known001");
		await engine.dispose();
	});
});
