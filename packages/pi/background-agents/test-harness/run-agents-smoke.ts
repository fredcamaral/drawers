/**
 * OPT-IN integration smoke for the pi background-agents extension.
 *
 * This is NOT a unit test. It wires the SAME production seam the extension wires
 * at `session_start` — `resolvePiCliPath()` → `createRpcClientFactory(RpcClient)`
 * → `createSessionTranscriptReader()` → `createEngine()` — then drives a REAL
 * `bg_task` launch through the `bg_task`/`bg_output` tools to a terminal
 * completion against a live `pi --mode rpc` child. It costs a live model call, so
 * it is GATED OUT of the default `bun test`:
 *
 *   - It lives under `test-harness/` with a `.ts` (NOT `.test.ts`) suffix, so the
 *     default `bun test` glob never collects it.
 *   - It additionally refuses to run unless `PI_AGENTS_SMOKE=1` is set, so an
 *     accidental `bun run` is a no-op.
 *
 * Run it explicitly once pi is configured with a real provider + key:
 *
 *   PI_AGENTS_SMOKE=1 \
 *   PI_SMOKE_MODEL=anthropic/claude-haiku-4-5 \
 *   bun run packages/pi/background-agents/test-harness/run-agents-smoke.ts
 *
 * Optional env (mirrors the pi-core runner smoke):
 *   PI_SMOKE_MODEL       provider/model to launch (else pi's configured default).
 *   PI_SMOKE_CWD         worktree/cwd to root the child in (else this repo).
 *   PI_SMOKE_TIMEOUT_MS  overall budget (default 120000).
 *
 * Model resolution mirrors `core/test-harness/run-runner-smoke.ts`: it uses
 * `import.meta.resolve` (NOT createRequire) for the pi-package path, exactly as
 * the extension's `resolvePiCliPath()` primary strategy does.
 *
 * It exits 0 on success, non-zero on any assertion/timeout failure.
 */

import {
	createRpcClientFactory,
	createSessionTranscriptReader,
	type StockRpcClient,
} from "@drawers/pi-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { resolvePiCliPath } from "../src/cli-path";
import { createEngine } from "../src/engine";
import { createBgOutputTool } from "../src/tools/output";
import { createBgTaskTool } from "../src/tools/task";

const GATE = process.env.PI_AGENTS_SMOKE === "1";

function log(msg: string): void {
	process.stderr.write(`[agents-smoke] ${msg}\n`);
}

/** A print-mode-like ExtensionContext: no UI, idle. The tools read only this. */
function smokeContext(): ExtensionContext {
	return {
		hasUI: false,
		isIdle: () => true,
		ui: {
			setStatus: () => {},
			notify: () => {},
		},
		// The smoke never forks, so sessionManager is never touched. Provide a stub
		// for type completeness.
		sessionManager: {
			getBranch: () => [],
		},
	} as unknown as ExtensionContext;
}

/** Flatten a tool result's text content. */
function textOf(res: {
	content: Array<{ type: string; text?: string }>;
}): string {
	return res.content.map((c) => c.text ?? "").join("");
}

async function main(): Promise<void> {
	if (!GATE) {
		log(
			"SKIPPED — set PI_AGENTS_SMOKE=1 to run this live integration smoke " +
				"(it makes a real model call).",
		);
		return;
	}

	const cliPath = resolvePiCliPath();
	const model = process.env.PI_SMOKE_MODEL;
	const cwd = process.env.PI_SMOKE_CWD ?? process.cwd();
	const timeoutMs = Number(process.env.PI_SMOKE_TIMEOUT_MS ?? 120000);

	log(`cliPath=${cliPath}`);
	log(`model=${model ?? "(pi default)"} cwd=${cwd}`);

	// Wire EXACTLY as the extension does at session_start.
	const rpcFactory = createRpcClientFactory({
		cliPath,
		rpcClientCtor: (opts) => new RpcClient(opts) as unknown as StockRpcClient,
		logger: {
			debug: (m) => log(`debug: ${m}`),
			error: (m) => log(`error: ${m}`),
		},
	});
	const transcriptReader = createSessionTranscriptReader();
	const engine = await createEngine({
		rpcFactory,
		transcriptReader,
		// Use pi's default session dir (undefined) so the smoke does not pollute the
		// repo; the data dir is the canonical XDG base.
		onNotify: (n) => log(`notice: ${n.taskId} ${n.status}`),
	});

	const getRunner = () => engine.runner;
	const ctx = smokeContext();

	const taskTool = createBgTaskTool({
		getRunner,
		getParentSessionID: () => "smoke_parent",
		getParentDepth: () => 0,
		readParentEntries: () => [],
	});
	const outputTool = createBgOutputTool(getRunner);

	try {
		// 1. Launch a trivial background task.
		const launchRes = await taskTool.execute(
			"call_launch",
			{
				description: "smoke ping",
				prompt:
					"Reply with exactly the single word: PONG. Do not call any tools.",
				...(model ? { model } : {}),
			} as Parameters<typeof taskTool.execute>[1],
			undefined,
			undefined,
			ctx,
		);
		const launchText = textOf(launchRes);
		log(`launch: ${launchText}`);
		const idMatch = launchText.match(/bg_[a-z0-9]+/i);
		if (!idMatch) {
			throw new Error(
				`could not parse a task id from launch result: ${launchText}`,
			);
		}
		const taskId = idMatch[0];
		log(`taskId=${taskId}`);

		// 2. Block on bg_output until the child reaches a terminal state.
		const outputRes = await outputTool.execute(
			"call_output",
			{
				task_id: taskId,
				block: true,
				full: true,
				timeout_ms: timeoutMs,
			} as Parameters<typeof outputTool.execute>[1],
			undefined,
			undefined,
			ctx,
		);
		const outputText = textOf(outputRes);
		log(`output:\n${outputText}`);

		// 3. Assertions.
		if (outputText.includes("still running")) {
			throw new Error("task did not complete within the smoke timeout");
		}
		if (!outputText.includes("completed")) {
			throw new Error(`task did not reach 'completed': ${outputText}`);
		}

		log(
			"SMOKE PASSED — bg_task launched, ran to completion, bg_output read it.",
		);
	} finally {
		await engine.dispose();
	}
}

main().catch((err: unknown) => {
	log(
		`SMOKE FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
	);
	process.exitCode = 1;
});
