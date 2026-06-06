/**
 * Smoke-test plugin for the opencode-drawers core engine (Task 1.5.1).
 *
 * Proves the core SessionRunner against a REAL opencode process end-to-end:
 *  - instantiates the engine with REAL collaborators (ConcurrencyManager,
 *    createIdGenerator, Date-backed clock, createTaskStore persisting to
 *    $SMOKE_DATA_DIR), and recoveredTasks loaded from the store at startup;
 *  - wires the `event` hook → runner.handleEvent so the completion gate sees
 *    the live session.idle / session.error stream;
 *  - exposes two custom tools the headless model can call:
 *      smoke_launch({ prompt })   → launches a bg task, returns its id
 *      smoke_status({ task_id })  → returns the task JSON (status + summary)
 *
 * The engine's `client` dependency is the structural subset {@link EngineClient}.
 * The real opencode SDK client (ReturnType<createOpencodeClient>) carries more
 * than EngineClient needs, but its generic, Options-shaped method signatures are
 * NOT directly assignable to EngineClient's concrete ones — so we wrap it in a
 * thin adapter that calls each method with the exact `{ path, body }` shape the
 * engine uses and narrows the `{ data }` result. If the live SDK ever returns a
 * different shape than the audit (docs/sdk-surface-audit.md) recorded, the
 * adapter is the one place that breaks loudly.
 */

import { type Plugin, tool } from "@opencode-ai/plugin";
// Relative import into the core source: the plugin is loaded inside opencode's
// own Bun from the test-harness cwd, where the `@drawers/core` workspace alias
// is not guaranteed to resolve. The relative path always resolves.
import {
	adaptSdkClient,
	type BgTask,
	type Clock,
	ConcurrencyManager,
	createIdGenerator,
	createSessionRunner,
	createTaskStore,
} from "../../src/index.ts";

const SERVICE = "smoke-plugin";

// The default agent the local install ships ("build" is opencode's primary
// agent and exists in every install). Override via $SMOKE_AGENT if needed.
const DEFAULT_AGENT = process.env.SMOKE_AGENT ?? "build";

export const SmokePlugin: Plugin = async ({ client }) => {
	const log = (
		level: "debug" | "info" | "warn" | "error",
		message: string,
		extra?: Record<string, unknown>,
	) =>
		client.app.log({
			body: { service: SERVICE, level, message, extra },
		});

	const baseDir = process.env.SMOKE_DATA_DIR;
	if (!baseDir) {
		await log("error", "SMOKE_DATA_DIR not set — plugin disabled");
		return {};
	}

	// Adapter: the real SDK client → the engine's structural EngineClient. Lives
	// in core (`adaptSdkClient`) and is re-verified live by this smoke run.
	const engineClient = adaptSdkClient(client);

	const store = createTaskStore({ baseDir });
	const recoveredTasks = await store.load();
	await log("info", "store loaded", {
		baseDir,
		recoveredCount: recoveredTasks.length,
	});

	const clock: Clock = { now: () => Date.now() };

	// Short min-idle so the gate completes the child quickly once it goes idle
	// (default is 5s). The harness keeps the parent turn alive via awaitCompletion
	// in smoke_launch, but a tight grace keeps the e2e fast.
	const minIdleMs = Number(process.env.SMOKE_MIN_IDLE_MS ?? "1500");

	const runner = createSessionRunner({
		client: engineClient,
		concurrency: new ConcurrencyManager(),
		ids: createIdGenerator(),
		clock,
		config: { minIdleMs },
		persist: (task) => store.save(task),
		recoveredTasks,
		logger: {
			debug: (msg, meta) => {
				void log("debug", msg, meta);
			},
			error: (msg, meta) => {
				void log("error", msg, meta);
			},
		},
	});

	await log("info", "engine wired", { agent: DEFAULT_AGENT });

	return {
		event: async ({ event }) => {
			await runner.handleEvent(event);
		},

		tool: {
			smoke_launch: tool({
				description:
					"Launch a background opencode task that runs the given prompt in a child session. Returns the background task id.",
				args: {
					prompt: tool.schema
						.string()
						.describe("the prompt to run in the background task"),
				},
				async execute(args, context) {
					const task = await runner.launch({
						parentSessionID: context.sessionID,
						description: "smoke background task",
						prompt: args.prompt,
						agent: DEFAULT_AGENT,
						depth: 0,
					});
					await log("info", "smoke_launch:launched", {
						taskId: task.id,
						parentSessionID: context.sessionID,
						status: task.status,
					});
					// CRITICAL for `opencode run`: it is a single-turn headless process.
					// The moment this tool returns and the parent turn ends, opencode
					// shuts the server down and ABORTS the still-running child session
					// (observed: task → error "Aborted"). So we hold the parent turn
					// open by awaiting completion here. This still exercises the full
					// launch → live session.idle event → completion gate → persist path
					// in-process; the second `opencode run` (phase 3) then proves the
					// restart-recovery path against the persisted file.
					const settled = await runner.awaitCompletion(task.id, 90_000);
					await log("info", "smoke_launch:settled", {
						taskId: settled.id,
						status: settled.status,
						error: settled.error,
					});
					return `task ${settled.id} settled with status: ${settled.status}`;
				},
			}),

			smoke_status: tool({
				description:
					"Return the JSON status of a background task (status, summary) given its task id.",
				args: {
					task_id: tool.schema
						.string()
						.describe("the background task id returned by smoke_launch"),
				},
				async execute(args) {
					const out = await runner.readOutput(args.task_id);
					const list = runner.list();
					const task: BgTask | undefined = list.find(
						(t) => t.id === args.task_id,
					);
					const payload = {
						task_id: args.task_id,
						status: out.status,
						summary: out.summaryText,
						error: task?.error,
					};
					await log("info", "smoke_status", payload);
					return JSON.stringify(payload);
				},
			}),
		},
	};
};
