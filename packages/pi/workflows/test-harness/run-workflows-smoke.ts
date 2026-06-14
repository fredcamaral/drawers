/**
 * OPT-IN integration smoke for the pi workflows extension.
 *
 * This is NOT a unit test. It wires the SAME production seam the extension wires at
 * `session_start` — `resolvePiCliPath()` → `createRpcClientFactory(RpcClient)` →
 * `createSessionTranscriptReader()` → `createWorkflowEngine()` — then runs a TRIVIAL
 * real workflow (one `agent()` call returning a single word) through the engine to a
 * terminal `completed` record against a live `pi --mode rpc` child. It costs a live
 * model call, so it is GATED OUT of the default `bun test`:
 *
 *   - It lives under `test-harness/` with a `.ts` (NOT `.test.ts`) suffix, so the
 *     default `bun test` glob never collects it.
 *   - It additionally refuses to run unless `PI_WORKFLOWS_SMOKE=1` is set, so an
 *     accidental `bun run` is a no-op.
 *
 * Run it explicitly once pi is configured with a real provider + key:
 *
 *   PI_WORKFLOWS_SMOKE=1 \
 *   PI_SMOKE_MODEL=anthropic/claude-haiku-4-5 \
 *   bun run packages/pi/workflows/test-harness/run-workflows-smoke.ts
 *
 * Optional env (mirrors the pi-core + bg-agents smokes):
 *   PI_SMOKE_MODEL       provider/model to launch (else pi's configured default).
 *   PI_SMOKE_CWD         project dir to root the run in (else this repo).
 *   PI_SMOKE_TIMEOUT_MS  overall budget (default 120000).
 *
 * cliPath/model resolution mirrors the extension's `resolvePiCliPath()` (which uses
 * `import.meta.resolve`, NOT createRequire, as its primary strategy).
 *
 * It exits 0 on success, non-zero on any assertion/timeout failure.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createRpcClientFactory,
	createSessionTranscriptReader,
	type StockRpcClient,
} from "@drawers/pi-core";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { resolvePiCliPath } from "../src/plugin/cli-path";
import { createWorkflowEngine } from "../src/plugin/engine";

const GATE = process.env.PI_WORKFLOWS_SMOKE === "1";

function log(msg: string): void {
	process.stderr.write(`[workflows-smoke] ${msg}\n`);
}

/** Race a promise against a timeout so a stuck run fails the smoke loudly. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return Promise.race([
		p,
		new Promise<never>((_resolve, reject) => {
			const handle = setTimeout(() => {
				reject(new Error(`${label} timed out after ${ms}ms`));
			}, ms);
			// Do not keep the event loop alive solely for the timeout.
			(handle as { unref?: () => void }).unref?.();
		}),
	]);
}

/** The trivial workflow: one agent() call that returns a single word. */
const SMOKE_SOURCE = `export const meta = { name: "smoke-ping", description: "one-agent smoke" };
const word = await agent(
	"Reply with exactly the single word: PONG. Do not call any tools.",
	{ label: "ping" },
);
return word;`;

async function main(): Promise<void> {
	if (!GATE) {
		log(
			"SKIPPED — set PI_WORKFLOWS_SMOKE=1 to run this live integration smoke " +
				"(it makes a real model call).",
		);
		return;
	}

	const cliPath = resolvePiCliPath();
	const model = process.env.PI_SMOKE_MODEL;
	const directory = process.env.PI_SMOKE_CWD ?? process.cwd();
	const timeoutMs = Number(process.env.PI_SMOKE_TIMEOUT_MS ?? 120000);

	log(`cliPath=${cliPath}`);
	log(`model=${model ?? "(pi default)"} directory=${directory}`);

	// Isolate persistence under a tmp data dir so the smoke never pollutes the repo.
	const dataDir = await mkdtemp(join(tmpdir(), "wf-smoke-"));

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
	const engine = createWorkflowEngine({
		rpcFactory,
		transcriptReader,
		directory,
		dataDir,
		// pi's default session dir (undefined) so the smoke does not pollute the repo.
		onNotify: (n) => log(`notice: ${n.taskId} ${n.status}`),
		// No resolveAgentKnobs / shell: the default coding assistant, no git subsystem —
		// the trivial path the orchestrator validates first.
	});
	await engine.ready();

	try {
		// NOTE: a workflow run has no run-level model — the model is per-agent
		// (opts.model / agent frontmatter), else pi's configured default. PI_SMOKE_MODEL
		// is honored by the child via pi's own default when the script pins none; it is
		// logged above for operator context.
		const { runId } = await engine.startRun({
			parentSessionID: "smoke_parent",
			source: SMOKE_SOURCE,
		});
		log(`runId=${runId}`);

		const handle = engine.statusOf(runId);
		if (handle?.settled === undefined) {
			throw new Error("run handle has no settled promise");
		}
		await withTimeout(handle.settled, timeoutMs, "workflow run");

		const record = engine.statusOf(runId)?.record;
		log(
			`status=${record?.status} returnValue=${JSON.stringify(record?.returnValue)}`,
		);
		if (record?.status !== "completed") {
			throw new Error(
				`run did not reach 'completed': status=${record?.status} error=${record?.error}`,
			);
		}
		const value = String(record?.returnValue ?? "");
		if (!value.toUpperCase().includes("PONG")) {
			throw new Error(
				`return value did not contain PONG: ${JSON.stringify(value)}`,
			);
		}
		log(
			"SMOKE PASSED — workflow ran one agent() to completion and returned PONG.",
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
