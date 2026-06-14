/**
 * Shared test doubles for the workflows runner-coupled layer.
 *
 * The seam tests fake is the pi-core {@link SessionRunner}: a hand-scripted runner
 * that lets a test drive `agent()` (over a real {@link createWorkflowRun}) through
 * launch → awaitCompletion → readOutput → resume WITHOUT a real `pi --mode rpc`
 * child. It records every launch so a test can assert the LaunchRequest shape (the
 * HIGH fix: `tools` carrying `structured_output`), and resolves completion/output
 * from a per-task script keyed by launch order.
 *
 * NOT a `.test.ts` file: it is a helper imported BY tests, so the default `bun test`
 * glob never collects it as a suite and it carries no top-level side effects.
 *
 * Node-safe: no Bun.* APIs.
 */

import type {
	BgTask,
	LaunchRequest,
	ReadOpts,
	SessionRunner,
	TaskOutput,
} from "@drawers/pi-core";
import type { WorktreeManagerSeam } from "./types";

/** The terminal a fake launch settles on, plus the text/structured echo it yields. */
export interface FakeAgentScript {
	/** Terminal status `awaitCompletion` resolves the task to. Default "completed". */
	status?: BgTask["status"];
	/** The last-assistant text `readOutput().summaryText` returns. Default "ok". */
	summaryText?: string;
	/**
	 * The raw JSON string the child "echoed" via structured_output, returned by the
	 * engine `readStructured` seam (which the test wires to {@link readStructuredFor}).
	 * `undefined` → the child never called the tool (schema_no_call). A FUNCTION lets a
	 * test return different values per attempt (first read vs nudge re-read).
	 */
	structured?: string | undefined | (() => string | undefined);
}

/** A scripted SessionRunner that records launches and settles tasks deterministically. */
export interface ScriptedWorkflowRunner extends SessionRunner {
	/** Every LaunchRequest in launch order — the assertion surface for tool gating. */
	launches: LaunchRequest[];
	/** Every resume `(taskId, prompt)` in order — the structured nudge surface. */
	resumes: Array<{ taskId: string; prompt: string }>;
	/** The engine-side `readStructured(taskId, sessionId)` seam over the scripts. */
	readStructuredFor(
		taskId: string,
		sessionId: string,
	): Promise<string | undefined>;
}

/**
 * Build a scripted runner. `scripts` is consumed in launch order: launch N settles
 * per `scripts[N]`. A launch past the script list settles "completed" with text "ok".
 * Structured re-reads (after a nudge resume) advance the structured fn each call.
 */
export function makeScriptedRunner(
	scripts: FakeAgentScript[] = [],
): ScriptedWorkflowRunner {
	const launches: LaunchRequest[] = [];
	const resumes: Array<{ taskId: string; prompt: string }> = [];
	// taskId → its resolved script + a mutable copy of the structured echo source.
	const byTask = new Map<
		string,
		{ script: FakeAgentScript; sessionID: string }
	>();
	let n = 0;

	const taskFrom = (
		req: LaunchRequest,
		id: string,
		sessionID: string,
	): BgTask => ({
		id,
		sessionID,
		parentSessionID: req.parentSessionID,
		description: req.description,
		agent: req.agent,
		status: "running",
		createdAt: 0,
		depth: req.depth,
		concurrencyKey: "k",
		...(req.model !== undefined ? { model: req.model } : {}),
		sessionFile: `/sessions/${id}.jsonl`,
	});

	const runner: ScriptedWorkflowRunner = {
		launches,
		resumes,
		launch: async (req) => {
			launches.push(req);
			const index = n;
			n += 1;
			const id = `wf_task_${index}`;
			const sessionID = `sess_${index}`;
			const script = scripts[index] ?? {};
			byTask.set(id, { script, sessionID });
			// onSessionCreated fires SYNCHRONOUSLY at launch (the registry-register hook).
			req.onSessionCreated?.(sessionID);
			return taskFrom(req, id, sessionID);
		},
		awaitCompletion: async (taskId) => {
			const entry = byTask.get(taskId);
			const status = entry?.script.status ?? "completed";
			return {
				id: taskId,
				sessionID: entry?.sessionID,
				parentSessionID: "parent_1",
				description: "scripted",
				agent: "build",
				status,
				createdAt: 0,
				depth: 0,
				concurrencyKey: "k",
			};
		},
		readOutput: async (taskId, _opts?: ReadOpts): Promise<TaskOutput> => {
			const entry = byTask.get(taskId);
			const status = entry?.script.status ?? "completed";
			return { status, summaryText: entry?.script.summaryText ?? "ok" };
		},
		resume: async (taskId, prompt) => {
			resumes.push({ taskId, prompt });
			const entry = byTask.get(taskId);
			return {
				id: taskId,
				sessionID: entry?.sessionID,
				parentSessionID: "parent_1",
				description: "resumed",
				agent: "build",
				status: "running",
				createdAt: 0,
				depth: 0,
				concurrencyKey: "k",
			};
		},
		cancel: async (taskId) => ({
			id: taskId,
			parentSessionID: "parent_1",
			description: "cancelled",
			agent: "build",
			status: "cancelled",
			createdAt: 0,
			depth: 0,
			concurrencyKey: "k",
		}),
		list: () => [],
		dispose: async () => {},
		readStructuredFor: async (taskId) => {
			const entry = byTask.get(taskId);
			const s = entry?.script.structured;
			return typeof s === "function" ? s() : s;
		},
	};
	return runner;
}

/**
 * A fake {@link WorktreeManagerSeam} the isolation tests drive. Records create/merge/
 * cleanup calls; `mergeOutcome` decides what mergeBack returns. `createReturns:null`
 * forces a mint miss. Defaults: a clean merge, never unchanged.
 */
export interface FakeWorktreeManager extends WorktreeManagerSeam {
	creates: Array<{ runId: string; label: string }>;
	merges: Array<{ dir: string; branch: string }>;
	cleanups: Array<{ dir: string; branch: string }>;
}

export function makeFakeWorktreeManager(
	opts: {
		createReturns?: { dir: string; branch: string } | null;
		mergeOutcome?: Awaited<ReturnType<WorktreeManagerSeam["mergeBack"]>>;
		unchanged?: boolean;
	} = {},
): FakeWorktreeManager {
	const creates: Array<{ runId: string; label: string }> = [];
	const merges: Array<{ dir: string; branch: string }> = [];
	const cleanups: Array<{ dir: string; branch: string }> = [];
	let serial = 0;
	return {
		creates,
		merges,
		cleanups,
		create: async (key) => {
			creates.push(key);
			if (opts.createReturns === null) {
				return null;
			}
			serial += 1;
			return (
				opts.createReturns ?? {
					dir: `/wt/${key.label}-${serial}`,
					branch: `wf/${key.runId}/${key.label}-${serial}`,
				}
			);
		},
		mergeBack: async (dir, branch) => {
			merges.push({ dir, branch });
			return (
				opts.mergeOutcome ?? {
					merged: true,
					sha: "abc1234",
					paths: ["src/x.ts"],
				}
			);
		},
		isUnchanged: async () => opts.unchanged ?? false,
		cleanup: async (dir, branch) => {
			cleanups.push({ dir, branch });
		},
		sweep: async () => {},
	};
}

/** Build a minimal valid workflow script: `meta` header + a body. */
export function scriptOf(body: string, name = "test-wf"): string {
	return `export const meta = { name: ${JSON.stringify(name)}, description: "t" };\n${body}`;
}

/** Flush the microtask queue a few turns so detached settles land. */
export async function flush(): Promise<void> {
	for (let i = 0; i < 12; i += 1) await Promise.resolve();
}
