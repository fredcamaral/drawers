/**
 * pi-drawer-cadence — session-level orchestration for pi.
 *
 * The pi-native port of opencode-drawer-cadence: re-prompts the CURRENT session via
 * two mechanisms sharing one engine — `loop` (interval-driven) and `goal` (idle-
 * driven, stops on a GOAL_COMPLETE sentinel). It does NOT spawn child sessions.
 *
 * pi loads this module's default export once and calls it with the `ExtensionAPI`.
 * The factory only REGISTERS (tools + lifecycle handlers) — action methods throw at
 * load, so the engine is built (and `recover()` runs) in `session_start`, not here.
 * The tools resolve the engine lazily through a thunk, so a tool can only run after
 * `session_start` has built it.
 *
 * Wiring:
 *   - tools register at load: `loop` / `goal` / `cadence_stop` / `cadence_list`;
 *   - `session_start` → build the store + host + engine, then `recover()` re-arms
 *     persisted active loop timers;
 *   - `agent_end` → `engine.handleEvent()` drives the IDLE-driven goals (the per-
 *     prompt boundary replaces opencode's `session.idle`);
 *   - `session_shutdown` → `engine.dispose()` clears every armed timer (idempotent),
 *     then nulls the engine; pi rebinds a fresh instance on the next session.
 *
 * Per-session simplification: pi rebinds the extension per session, so the engine's
 * in-memory state is naturally per-session — no cross-session multiplexing.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	type CadenceEngine,
	type CadenceEngineLogger,
	type CadenceHost,
	createCadenceEngine,
} from "./engine";
import { createCadenceStore } from "./store";
import { createGoalTool } from "./tools/goal";
import { createListTool } from "./tools/list";
import { createLoopTool } from "./tools/loop";
import { createStopTool } from "./tools/stop";

export default function (pi: ExtensionAPI) {
	let engine: CadenceEngine | undefined;

	// The engine is built in session_start (it needs the live ctx + does fs IO in
	// recover()), but tools register at LOAD. They resolve the engine lazily — a tool
	// can only run after session_start, so this thunk never throws in practice.
	const requireEngine = (): CadenceEngine => {
		if (engine === undefined) {
			throw new Error("cadence engine not initialized");
		}
		return engine;
	};

	pi.registerTool(createLoopTool(requireEngine));
	pi.registerTool(createGoalTool(requireEngine));
	pi.registerTool(createStopTool(requireEngine));
	pi.registerTool(createListTool(requireEngine));

	// Cadence runs in the background; only warn/error and the two terminal goal
	// outcomes ("satisfied"/"gave up at max iterations") are worth surfacing. Route
	// those through ctx.ui.notify when a UI is present; drop debug. UI methods are
	// no-ops outside tui/rpc, but the hasUI guard keeps print/json fully silent.
	function makeLogger(ctx: ExtensionContext): CadenceEngineLogger {
		const notify = (
			level: "info" | "warning" | "error",
			message: string,
		): void => {
			if (ctx.hasUI) {
				ctx.ui.notify(`cadence: ${message}`, level);
			}
		};
		return {
			info: (message) => notify("info", message),
			warn: (message) => notify("warning", message),
			error: (message) => notify("error", message),
		};
	}

	pi.on("session_start", async (_event, ctx) => {
		const logger = makeLogger(ctx);
		const store = createCadenceStore({ logger });
		const host: CadenceHost = {
			// sendUserMessage returns void and cannot report failure; wrap it so a throw
			// is swallowed → false, preserving the engine's count-on-delivery contract.
			reprompt: (text) => {
				try {
					pi.sendUserMessage(text, { deliverAs: "followUp" });
					return true;
				} catch (err) {
					logger.error?.(err instanceof Error ? err.message : String(err));
					return false;
				}
			},
			getBranchEntries: () => ctx.sessionManager.getBranch(),
		};
		engine = createCadenceEngine({ host, store, logger });
		await engine.recover();
	});

	pi.on("agent_end", async () => {
		await engine?.handleEvent();
	});

	pi.on("session_shutdown", async () => {
		// Idempotent: dispose() clears a map + sets a flag, safe on any shutdown reason.
		engine?.dispose();
		engine = undefined;
	});
}
