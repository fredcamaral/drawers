/**
 * Cadence plugin entry.
 *
 * opencode's plugin loader calls EVERY export of this module as a function, so the
 * entry exposes exactly ONE export — the async {@link Plugin} factory. Testable
 * pieces (`createCadenceEngine`, `createCadenceStore`, the tools) live in their
 * own modules and are imported, never re-exported.
 *
 * The factory builds the JSON store under `<dataDir>/cadence`, constructs the one
 * shared engine, recovers any persisted directives (re-arming active loop timers),
 * and returns the hooks:
 *   - `event`  → `engine.handleEvent` so the IDLE-driven `goal` mechanism sees the
 *     live session.idle stream;
 *   - `tool`   — `loop` / `goal` / `cadence_stop` / `cadence_list`;
 *   - `dispose`→ clears every armed timer.
 *
 * All logging routes through `client.app.log` (structured JSON) — never `console`.
 */

import { adaptSdkClient } from "@drawers/core";
import type { Plugin } from "@opencode-ai/plugin";
import { type CadenceEngineLogger, createCadenceEngine } from "./engine";
import { createCadenceStore } from "./store";
import { createGoalTool } from "./tools/goal";
import { createListTool } from "./tools/list";
import { createLoopTool } from "./tools/loop";
import { createStopTool } from "./tools/stop";

const SERVICE = "opencode-drawer-cadence";

export const CadencePlugin: Plugin = async ({ client }) => {
	const logger: CadenceEngineLogger = {
		debug: (message, extra) => {
			void client.app.log({
				body: { service: SERVICE, level: "debug", message, extra },
			});
		},
		info: (message, extra) => {
			void client.app.log({
				body: { service: SERVICE, level: "info", message, extra },
			});
		},
		warn: (message, extra) => {
			void client.app.log({
				body: { service: SERVICE, level: "warn", message, extra },
			});
		},
		error: (message, extra) => {
			void client.app.log({
				body: { service: SERVICE, level: "error", message, extra },
			});
		},
	};

	const store = createCadenceStore({ logger });
	const engine = createCadenceEngine({
		// Narrow the live SDK client through core's single drift-detection adapter
		// (the same one background-agents/workflows use). adaptSdkClient returns an
		// EngineClient — a structural superset of the engine's CadenceClient surface
		// (session.promptAsync + session.messages) — so the compiler validates the IO
		// boundary instead of an `as unknown as` double-cast erasing it.
		client: adaptSdkClient(client),
		store,
		logger,
	});

	await engine.recover();
	logger.info?.("cadence plugin wired");

	return {
		event: async ({ event }) => {
			await engine.handleEvent(event);
		},
		tool: {
			loop: createLoopTool(engine),
			goal: createGoalTool(engine),
			cadence_stop: createStopTool(engine),
			cadence_list: createListTool(engine),
		},
		dispose: async () => {
			engine.dispose();
		},
	};
};
