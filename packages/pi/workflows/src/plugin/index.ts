/**
 * Workflows extension entry — the pi default-export factory.
 *
 * Mirrors the proven background-agents lifecycle (gotchas #1/#2):
 *   - factory body: REGISTER ONLY. The six tools register at LOAD and resolve the
 *     engine lazily through a `getEngine()` thunk that throws a clean "no session"
 *     before `session_start`; lifecycle handlers register here too. The
 *     `structured_output` tool registers here as well — it RUNS in the CHILD
 *     subprocess (which loads this same extension); the parent never calls it, so
 *     a parent-side registration is harmless and the child-side one is necessary.
 *   - `session_start`: resolve the spawnable pi cli, build the production RPC
 *     factory + transcript reader, build the engine (run-record recovery +
 *     notification queue + control watcher + the Node-backed host shell +
 *     `resolveAgentKnobs` from the agent resolver), then wire the completion
 *     notifier (toast + idle-wake).
 *   - `before_agent_start`: the passive digest+drain (live-run digest + terminal
 *     notices the parent was too busy to be woken for).
 *   - `tool_call`: the git-deny veto — blocks destructive git inside a worker child
 *     (the §0.3 kill switch; worker-discrimination is `ctx.mode === "rpc"` since pi
 *     gives the hook no sessionID — see git-deny-hook.ts).
 *   - `session_shutdown`: idempotent `engine.dispose()` so the always-on control
 *     watcher interval is cleared and the stores drain (without it the timer leaks
 *     for the process lifetime and a headless `--mode rpc` exit hangs).
 *
 * pi rebinds the extension per session (gotcha #2), so the tools read the engine /
 * directory through getters — the SAME load-time registration stays correct for
 * the whole session as `session_start` fills the values.
 *
 * Node-safe: no Bun.* APIs.
 */

import { join } from "node:path";
import {
	createRpcClientFactory,
	createSessionTranscriptReader,
	resolveDataBaseDir,
	type StockRpcClient,
	type TaskNotice,
} from "@drawers/pi-core";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ResolveAgentKnobs } from "../runtime/agent-call";
import { createStructuredOutputTool } from "../runtime/structured/tool";
import { registerWorkflowsCommand } from "../tui/command";
import { SUBDIR_CONTROL, SUBDIR_FEED } from "../tui/paths";
import { resolveAgent } from "./agent-resolver";
import { resolvePiCliPath } from "./cli-path";
import { createWorkflowBeforeAgentStart } from "./digest-hook";
import {
	createWorkflowEngine,
	type EngineLogger,
	type WorkflowEngine,
} from "./engine";
import { createGitDenyHook } from "./git-deny-hook";
import { createNodeShell } from "./node-shell";
import { createWorkflowTool } from "./tools/workflow";
import { createWorkflowSaveRunTool } from "./tools/workflow-save";
import { createWorkflowSkillsTool } from "./tools/workflow-skills";
import { createWorkflowStatusTool } from "./tools/workflow-status";
import { createWorkflowStopTool } from "./tools/workflow-stop";

export default function (pi: ExtensionAPI) {
	// Built in session_start; the tools resolve it lazily. A tool can only run after
	// session_start, so this thunk never throws in practice.
	let engine: WorkflowEngine | undefined;
	const getEngine = (): WorkflowEngine => {
		if (engine === undefined) {
			throw new Error("pi-drawer-workflows: no active session");
		}
		return engine;
	};

	// The project directory + parent identity for this session. Stamped at
	// session_start; the tools read them through getters so a single load-time
	// registration always sees the current session's values (gotcha #1).
	let directory = "";
	let parentSessionID = "";
	const getDirectory = () => directory;

	// The completion notifier (toast + idle-wake). Built in session_start (it needs
	// the live ctx + queue); the engine's onNotify resolves it lazily through this
	// captured variable — onNotify only fires at runtime on completions, long after
	// wiring, so the notifier is always present by then.
	let notify: ((notice: TaskNotice) => void) | undefined;

	// The git-deny veto is pure (no engine dependency) — it discriminates a worker
	// child by `ctx.mode === "rpc"`, so it is safe to build and register at load.
	const denyGit = createGitDenyHook();

	// Tools register at LOAD (gotcha #1). They read the engine/directory via getters,
	// so the SAME registration is correct for the whole session. structured_output
	// runs in the CHILD subprocess (it loads this extension); registering it here is
	// harmless in the parent and necessary in the child.
	pi.registerTool(createStructuredOutputTool());
	pi.registerTool(createWorkflowTool({ getEngine, directory: getDirectory }));
	pi.registerTool(createWorkflowStatusTool(getEngine));
	pi.registerTool(createWorkflowStopTool(getEngine));
	pi.registerTool(
		createWorkflowSaveRunTool({ getEngine, directory: getDirectory }),
	);
	pi.registerTool(createWorkflowSkillsTool({ directory: getDirectory }));

	// The `/workflows` viewer command (Task 8.3.3 pi port). Register at LOAD (gotcha
	// #1) alongside the tools. The feed/control dirs share the engine's resolution
	// (`resolveDataBaseDir()` with no dataDir — the same default the engine builds with
	// in session_start), so viewer-reads and engine-writes hit the same directory. The
	// resolution is pure/sync, so it is safe to compute here at load.
	const dataBaseDir = resolveDataBaseDir();
	registerWorkflowsCommand(pi, {
		feedDir: join(dataBaseDir, SUBDIR_FEED),
		controlDir: join(dataBaseDir, SUBDIR_CONTROL),
	});

	pi.on("session_start", async (_event, ctx) => {
		const logger = makeLogger(ctx);

		directory = ctx.cwd;
		parentSessionID = ctx.sessionManager.getSessionId();

		// Build the production RPC seam exactly as the proven core smoke + bg-agents
		// do: resolve the spawnable pi cli.js, wrap the stock RpcClient ctor, lazy-
		// import the SDK (it resolves via pi virtual modules at runtime, node_modules
		// for tests).
		const cliPath = resolvePiCliPath();
		const { RpcClient } = (await import("@earendil-works/pi-coding-agent")) as {
			RpcClient: new (opts: {
				cliPath?: string;
				cwd?: string;
				provider?: string;
				model?: string;
				args?: string[];
			}) => StockRpcClient;
		};
		const rpcFactory = createRpcClientFactory({
			cliPath,
			rpcClientCtor: (opts) => new RpcClient(opts),
			logger: {
				debug: (m, meta) => logger.debug(m, meta),
				error: (m, meta) => logger.error(m, meta),
			},
		});
		const transcriptReader = createSessionTranscriptReader();

		// The `agent()` → LaunchRequest seam (pi has no `--agent`): resolve an agent
		// NAME to pi-native child knobs (system prompt / tools / model) against the
		// project + user `.pi/agents` roots. ABSENT/unresolved name → the child runs
		// pi's default coding assistant.
		const resolveAgentKnobs: ResolveAgentKnobs = (agentType) => {
			const resolved = resolveAgent(agentType, directory);
			if (resolved === undefined) {
				return undefined;
			}
			return {
				appendSystemPrompt: resolved.appendSystemPrompt,
				...(resolved.tools !== undefined ? { tools: resolved.tools } : {}),
				...(resolved.model !== undefined ? { model: resolved.model } : {}),
			};
		};

		engine = createWorkflowEngine({
			rpcFactory,
			transcriptReader,
			sessionDir: ctx.sessionManager.getSessionDir(),
			directory,
			// Resolve the notifier lazily — it is built just below, after the queue
			// exists. onNotify only fires on completions, never during this build.
			onNotify: (notice) => notify?.(notice),
			logger,
			resolveAgentKnobs,
			// The Node-`child_process`-backed host shell (Epic 2.1 / §5 seam): pi has no
			// Bun `$`. Rooted at the project dir; the engine rebinds per-worktree via
			// `.cwd(dir)`. The engine owns per-agent git checkpoints/worktrees through it.
			shell: createNodeShell(directory),
		});
		await engine.ready();

		notify = createWorkflowNotifier({
			pi,
			ctx,
			parentSessionID,
			engine,
			logger,
		});

		logger.info("pi-drawer-workflows wired", {
			parentSessionID,
			directory,
			cliPath,
		});
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (engine === undefined) {
			return undefined;
		}
		const drain = createWorkflowBeforeAgentStart({
			engine,
			parentSessionID,
			queue: engine.queue,
			logger: makeLogger(ctx),
		});
		return drain(event, ctx);
	});

	// Deny destructive git inside a worker child (§0.3). The handler is pure — it
	// discriminates the worker via `ctx.mode === "rpc"` and returns `{ block }` to
	// veto; the parent's own git passes untouched.
	pi.on("tool_call", async (event, ctx) => denyGit(event, ctx));

	pi.on("session_shutdown", async () => {
		// Idempotent: dispose stops the control-watcher interval, aborts live
		// children, and drains the stores. Null the engine so a post-shutdown tool
		// call throws clean.
		const e = engine;
		engine = undefined;
		await e?.dispose();
	});
}

/** The demarcated wake text — names the retrieval tool, says it is automated. */
function buildWakeText(notices: readonly TaskNotice[]): string {
	const lines = notices.map((n) => n.hint).join("\n");
	return (
		"[workflow-notification]\n" +
		`${lines}\n` +
		"— automated notice, not the user; inspect the result with workflow_status. " +
		"Do not reply to this notice."
	);
}

/** Terminal status → notify level (pi `ctx.ui.notify` takes info|warning|error). */
function toastLevel(
	status: TaskNotice["status"],
): "info" | "warning" | "error" {
	if (status === "error") {
		return "error";
	}
	if (status === "cancelled") {
		return "warning";
	}
	return "info";
}

interface WorkflowNotifierDeps {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	parentSessionID: string;
	engine: WorkflowEngine;
	logger: EngineLogger;
}

/**
 * Build the engine's `onNotify` sink: a `ctx.ui.notify` toast plus an ACTIVE
 * in-process wake of an IDLE parent (`pi.sendUserMessage(hint, { deliverAs:
 * "followUp" })`). A BUSY parent is left to the passive `before_agent_start` drain
 * — we never wake a busy parent. The completion fired in THIS process for THIS
 * parent's runner, so the notice always targets us; the parent-id guard is
 * belt-and-suspenders. Fully fenced: a throwing notify/wake/drain must NEVER break
 * completion teardown.
 */
function createWorkflowNotifier(
	deps: WorkflowNotifierDeps,
): (notice: TaskNotice) => void {
	const { pi, ctx, parentSessionID, engine, logger } = deps;
	return (notice) => {
		// (1) Visible toast. Fenced — a throwing notify must not break the push path.
		try {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Workflow ${notice.status}: ${notice.description}`,
					toastLevel(notice.status),
				);
			}
		} catch (err) {
			logger.error("ui.notify threw", {
				id: notice.taskId,
				err: err instanceof Error ? err.message : String(err),
			});
		}

		// (2) Active wake — only when the parent is IDLE. A busy parent is left to the
		// passive drain (before_agent_start).
		if (notice.parentSessionID !== parentSessionID) {
			return;
		}
		let idle: boolean;
		try {
			idle = ctx.isIdle();
		} catch {
			idle = false;
		}
		if (!idle) {
			return;
		}

		// Snapshot every pending notice for this parent (coalesce N completions into
		// one wake), deliver them in a single follow-up message, then consume exactly
		// that snapshot. Notices arriving mid-flight stay queued for the passive drain.
		const toSend = engine.queue.pending(parentSessionID);
		if (toSend.length === 0) {
			return;
		}
		try {
			pi.sendUserMessage(buildWakeText(toSend), { deliverAs: "followUp" });
			engine.queue.consume(parentSessionID, toSend);
		} catch (err) {
			// Leave the notices queued for the passive flush — do NOT consume.
			logger.error("wake sendUserMessage threw, leaving notices queued", {
				parent: parentSessionID,
				err: err instanceof Error ? err.message : String(err),
			});
		}
	};
}

/**
 * Structured logger that routes warn/error to `ctx.ui.notify` (when a UI is
 * present) and drops debug/info to keep the TUI quiet (Output discipline). pi
 * extensions have no `client.app.log` equivalent; the injected core logger seam
 * only needs debug/error, so info/warn collapse onto notify.
 */
function makeLogger(ctx: ExtensionContext): EngineLogger {
	const notify = (level: "warning" | "error", message: string): void => {
		try {
			if (ctx.hasUI) {
				ctx.ui.notify(`workflows: ${message}`, level);
			}
		} catch {
			// best-effort — never let logging break the caller.
		}
	};
	return {
		debug: () => {},
		info: () => {},
		warn: (message) => notify("warning", message),
		error: (message) => notify("error", message),
	};
}
