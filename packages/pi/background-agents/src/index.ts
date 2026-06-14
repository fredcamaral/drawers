/**
 * pi-drawer-agents — fire-and-forget background agents for pi.
 *
 * Launches a task in a child `pi --mode rpc` session and lets the parent pull its
 * output later, without blocking the main loop. The hard part — spawning the
 * child, fusing agent_end+process-exit into an exactly-once terminal, and the
 * launch/await/resume/read/cancel/list lifecycle — is owned by `@drawers/pi-core`'s
 * {@link SessionRunner}. This extension CONSUMES that runner: it resolves the
 * spawnable pi CLI, wires the production RPC factory + transcript reader at
 * session_start, registers the four `bg_*` tools, and bridges completion to the
 * parent via an in-process notifier.
 *
 * Lifecycle (pi rebinds the extension per session — gotcha #2):
 *   - factory body: REGISTER ONLY (gotcha #1). The four tools register at load;
 *     they resolve the engine lazily through a `getRunner()` thunk that throws a
 *     clean "no session" before session_start. Lifecycle handlers register here.
 *   - session_start: resolve cliPath, build the RPC factory + transcript reader,
 *     build the engine (store recovery + queue), and wire the completion notifier.
 *   - before_agent_start: passive drain — inject any queued completion notices the
 *     parent was too busy to be woken for.
 *   - session_shutdown: idempotent dispose (stop children, drain store).
 *
 * Depth: a child launched by `bg_task` is one level below this parent session's
 * bg-depth, read from `$PI_BG_DEPTH` (default 0). core's `maxDepth` guard rejects
 * over-deep launches; the runner's SPAWN_GUARD additionally disables `bg_*` in
 * every child, so deep recursion is structurally impossible by default. The env
 * read is the forward-compatible seam for the day the runner forwards env to
 * children — today a child cannot launch a grandchild regardless.
 *
 * Node-safe: no Bun.* APIs. pi resolves at runtime via virtual modules; tests
 * resolve it via node_modules.
 */

import {
	createRpcClientFactory,
	createSessionTranscriptReader,
	type SessionRunner,
	type StockRpcClient,
	type TaskNotice,
} from "@drawers/pi-core";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { resolvePiCliPath } from "./cli-path";
import { createEngine, type Engine, type EngineLogger } from "./engine";
import {
	createBeforeAgentStartDrain,
	createCompletionNotifier,
} from "./notifier";
import { createBgCancelTool } from "./tools/cancel";
import { createBgListTool } from "./tools/list";
import { createBgOutputTool } from "./tools/output";
import { createBgTaskTool } from "./tools/task";

/** Env var carrying THIS session's bg-depth (child = parent + 1). */
const DEPTH_ENV = "PI_BG_DEPTH";

function parseDepth(): number {
	const raw = process.env[DEPTH_ENV];
	if (!raw) {
		return 0;
	}
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export default function (pi: ExtensionAPI) {
	// Built in session_start; tools resolve it lazily. A tool can only run after
	// session_start, so these thunks never throw in practice.
	let engine: Engine | undefined;
	const getRunner = (): SessionRunner => {
		if (engine === undefined) {
			throw new Error("pi-drawer-agents: no active session");
		}
		return engine.runner;
	};

	// The parent identity + depth for every launch from this session. Stamped at
	// session_start; the tools and notifier read them through getters so a single
	// load-time registration always sees the current session's values (gotcha #1:
	// register once at load; the values fill in at session_start).
	let parentSessionID = "";
	let parentDepth = 0;
	const getParentSessionID = () => parentSessionID;

	// The completion notifier (toast + idle-wake). Built in session_start (it needs
	// the live ctx + queue); the engine's onNotify resolves it lazily through this
	// captured variable — onNotify only fires at runtime on completions, long after
	// wiring, so the notifier is always present by then. Mirrors opencode's
	// createWakeOnNotify construction-order cycle.
	let notify: ((notice: TaskNotice) => void) | undefined;

	// Tools register at LOAD (gotcha #1). They read parentSessionID/parentDepth via
	// getters, so the SAME registration is correct for the whole session — no
	// re-registration needed when session_start fills the values.
	pi.registerTool(
		createBgTaskTool({
			getRunner,
			getParentSessionID,
			getParentDepth: () => parentDepth,
			readParentEntries: (ctx) => ctx.sessionManager.getBranch(),
		}),
	);
	pi.registerTool(createBgOutputTool(getRunner));
	pi.registerTool(createBgCancelTool(getRunner, getParentSessionID));
	pi.registerTool(createBgListTool(getRunner, getParentSessionID));

	pi.on("session_start", async (_event, ctx) => {
		const logger = makeLogger(ctx);

		parentSessionID = ctx.sessionManager.getSessionId();
		parentDepth = parseDepth();

		// Build the production RPC seam exactly as the proven core smoke does: resolve
		// the spawnable pi cli.js, wrap the stock RpcClient ctor, lazy-import the SDK
		// (it resolves via pi virtual modules at runtime, node_modules for tests).
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

		engine = await createEngine({
			rpcFactory,
			transcriptReader,
			sessionDir: ctx.sessionManager.getSessionDir(),
			// Resolve the notifier lazily — it is built just below, after the queue
			// exists. onNotify only fires on completions, never during this build.
			onNotify: (notice) => notify?.(notice),
			logger,
		});

		notify = createCompletionNotifier({
			pi,
			ctx,
			parentSessionID,
			queue: engine.queue,
			logger,
		});

		logger.info("pi-drawer-agents wired", {
			parentSessionID,
			depth: parentDepth,
			cliPath,
		});
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (engine === undefined) {
			return undefined;
		}
		const drain = createBeforeAgentStartDrain({
			parentSessionID,
			queue: engine.queue,
			logger: makeLogger(ctx),
		});
		return drain(event, ctx);
	});

	pi.on("session_shutdown", async () => {
		// Idempotent: dispose stops live children + drains the store, safe on any
		// shutdown reason. Null the engine so a post-shutdown tool call throws clean.
		const e = engine;
		engine = undefined;
		await e?.dispose();
	});
}

/**
 * Structured logger that routes to `ctx.ui.notify` for warn/error (when a UI is
 * present) and drops debug/info to keep the TUI quiet (Output discipline). pi
 * extensions have no `client.app.log` equivalent; the injected core logger seam
 * only needs debug/error, so info/warn collapse onto notify.
 */
function makeLogger(ctx: ExtensionContext): EngineLogger {
	const notify = (
		level: "info" | "warning" | "error",
		message: string,
	): void => {
		try {
			if (ctx.hasUI) {
				ctx.ui.notify(`bg-agents: ${message}`, level);
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
