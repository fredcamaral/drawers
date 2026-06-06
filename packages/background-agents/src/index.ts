/**
 * Background-agents plugin entry.
 *
 * opencode's plugin loader calls EVERY export of this module as a function, so
 * the entry exposes exactly ONE export — the async {@link Plugin} factory. No
 * classes, no value exports, no helpers leak from here: testable pieces
 * (`createEngine`) live in engine.ts and are imported, never re-exported.
 *
 * The factory wraps the real SDK client with core's `adaptSdkClient`, builds the
 * engine (store recovery + notification queue wiring), and returns the hooks:
 *   - `event` → `runner.handleEvent` so the completion gate sees the live
 *     session.idle / session.error stream;
 *   - `chat.message` → drains the per-parent notice queue into the parent's next
 *     message (visible summary + synthetic retrieval hint); fully fenced so a
 *     queue/render failure never kills the prompt;
 *   - `tool` — the `bg_*` family (task/output/cancel/list).
 *
 * Completion toasts ride the engine's `onNotify` seam: a `client.tui.showToast`-
 * backed notifier fires per terminal transition (success/error/info variant).
 *
 * All logging goes through `client.app.log` (structured JSON) — never `console`.
 */

import { adaptSdkClient } from "@drawers/core";
import type { Plugin } from "@opencode-ai/plugin";
import { createEngine, type EngineLogger } from "./engine";
import {
	createChatMessageHook,
	createToastNotifier,
} from "./hooks/notifications";
import { createBgCancelTool } from "./tools/cancel";
import { createBgListTool } from "./tools/list";
import { createBgOutputTool } from "./tools/output";
import { createBgTaskTool } from "./tools/task";

const SERVICE = "opencode-drawer-agents";

export const BackgroundAgentsPlugin: Plugin = async ({ client }) => {
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
	);

	const { runner, queue, fetchSessionMessages } = await createEngine({
		client: adaptSdkClient(client),
		logger,
		onNotify,
	});

	logger.info("background-agents plugin wired");

	return {
		event: async ({ event }) => {
			await runner.handleEvent(event);
		},
		"chat.message": createChatMessageHook(queue, logger),
		tool: {
			bg_task: createBgTaskTool(runner, {
				fetchMessages: fetchSessionMessages,
			}),
			bg_output: createBgOutputTool(runner),
			bg_cancel: createBgCancelTool(runner),
			bg_list: createBgListTool(runner),
		},
	};
};
