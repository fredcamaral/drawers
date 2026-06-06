/**
 * Workflows plugin entry.
 *
 * opencode's plugin loader calls EVERY export of this module as a function, so
 * the entry exposes exactly ONE export — the async {@link Plugin} factory. No
 * value exports, no helpers leak from here: testable pieces (`createWorkflowEngine`)
 * live in engine.ts and are imported, never re-exported. The library surface
 * (`../index.ts`) is reachable as the package's `./lib` export, never through this
 * entry.
 *
 * The factory wraps the real SDK client with core's `adaptSdkClient`, builds the
 * engine (run-record recovery + notification queue wiring + the one shared schema
 * registry), and returns the hooks:
 *   - `event` → `engine.handleEvent` so the runner's completion gate sees the
 *     live session.idle / session.error stream the workflow children ride on;
 *   - `chat.message` → drains the per-parent notice queue into the parent's next
 *     message (core's `createChatMessageHook`); fully fenced so a queue/render
 *     failure never kills the prompt;
 *   - `tool` — the single global `structured_output` tool over the engine's shared
 *     registry, so any workflow child can return a schema-conforming result. The
 *     `workflow` / `workflow_status` / `workflow_stop` tools arrive in Task 4.1.3.
 *
 * Completion toasts ride the engine's `onNotify` seam: a `client.tui.showToast`-
 * backed notifier fires per terminal transition. All logging goes through
 * `client.app.log` (structured JSON) — never `console`.
 */

import {
	adaptSdkClient,
	createChatMessageHook,
	createToastNotifier,
} from "@drawers/core";
import type { Plugin } from "@opencode-ai/plugin";
import { createStructuredOutputTool } from "../runtime/structured/tool";
import { createWorkflowEngine, type EngineLogger } from "./engine";

const SERVICE = "opencode-drawer-workflows";

export const WorkflowsPlugin: Plugin = async ({ client, directory }) => {
	const logger: EngineLogger = {
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

	const onNotify = createToastNotifier(
		(data) => client.tui.showToast(data),
		logger,
		{ toastTitle: (notice) => `Workflow ${notice.status}` },
	);

	const engine = createWorkflowEngine({
		client: adaptSdkClient(client),
		directory,
		onNotify,
		logger,
	});
	await engine.ready();

	logger.info("workflows plugin wired");

	return {
		event: async ({ event }) => {
			await engine.handleEvent(event);
		},
		"chat.message": createChatMessageHook(engine.queue, logger),
		tool: {
			structured_output: createStructuredOutputTool(engine.registry),
		},
	};
};
