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
 *   - `dispose` → `engine.dispose()` so the loader's teardown finalizer stops the
 *     engine's always-on control-watcher interval (Task 8.2.2) and drains the
 *     stores — without it the watcher timer leaks for the process lifetime;
 *   - `event` → `engine.handleEvent` so the runner's completion gate sees the
 *     live session.idle / session.error stream the workflow children ride on;
 *   - `chat.message` → prepends a one-line digest per LIVE run owned by the parent
 *     (Task 6.2.4), then drains the per-parent TERMINAL notice queue into the
 *     parent's next message (core's `createChatMessageHook`, wrapped by
 *     `createWorkflowChatMessageHook`); fully fenced so a queue/render failure
 *     never kills the prompt;
 *   - `tool` — the global `structured_output` tool over the engine's shared
 *     registry (so any workflow child can return a schema-conforming result),
 *     plus `workflow` / `workflow_status` / `workflow_stop`: launch a run, inspect
 *     its progress/result, and stop a live run.
 *
 * Completion toasts ride the engine's `onNotify` seam: a `client.tui.showToast`-
 * backed notifier fires per terminal transition. Task 6.3.2 composes the active
 * wake on that same seam: a completing workflow wakes an IDLE parent with a
 * demarcated notice (CC parity); a busy parent falls back to the existing passive
 * flush + digest. The wake text names `workflow_status` because the queue's hint
 * does (the per-plugin tool name flows through `notice.hint`). All logging goes
 * through `client.app.log` (structured JSON) — never `console`.
 */

import {
	adaptSdkClient,
	adaptWakeClient,
	createToastNotifier,
	createWakeNotifier,
	createWakeOnNotify,
	type WakeNotifier,
} from "@drawers/core";
import type { Plugin } from "@opencode-ai/plugin";
import { createStructuredOutputTool } from "../runtime/structured/tool";
import { createWorkflowChatMessageHook } from "./digest-hook";
import { createWorkflowEngine, type EngineLogger } from "./engine";
import { createWorkflowTool } from "./tools/workflow";
import { createWorkflowStatusTool } from "./tools/workflow-status";
import { createWorkflowStopTool } from "./tools/workflow-stop";

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

	// Wake is assigned AFTER the engine exists (it needs the engine's queue), but
	// onNotify is needed AT construction — so the composed onNotify resolves the
	// wake lazily through this captured variable (see createWakeOnNotify).
	let wake: WakeNotifier | undefined;
	const onNotify = createWakeOnNotify(
		createToastNotifier((data) => client.tui.showToast(data), logger, {
			toastTitle: (notice) => `Workflow ${notice.status}`,
		}),
		() => wake,
		logger,
	);

	const engine = createWorkflowEngine({
		client: adaptSdkClient(client),
		directory,
		onNotify,
		logger,
	});
	await engine.ready();

	wake = createWakeNotifier({
		client: adaptWakeClient(client),
		queue: engine.queue,
		clock: { now: () => Date.now() },
		logger,
	});

	logger.info("workflows plugin wired");

	return {
		// The engine arms an always-on control-watcher interval at construction (Task
		// 8.2.2); only engine.dispose() → control.stop() clears it. opencode invokes
		// this hook as a loader finalizer when the plugin scope tears down, so wiring it
		// to engine.dispose() keeps the watcher's timer from leaking for the process
		// lifetime (and lets the at-idle exit `opencode run` depends on proceed).
		dispose: async () => {
			await engine.dispose();
		},
		event: async ({ event }) => {
			await engine.handleEvent(event);
		},
		"chat.message": createWorkflowChatMessageHook(engine, engine.queue, logger),
		tool: {
			structured_output: createStructuredOutputTool(engine.registry),
			workflow: createWorkflowTool(engine, { directory }),
			workflow_status: createWorkflowStatusTool(engine),
			workflow_stop: createWorkflowStopTool(engine),
		},
	};
};
