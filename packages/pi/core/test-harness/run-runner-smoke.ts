/**
 * OPT-IN integration smoke for the pi-native RpcClient seam.
 *
 * This is NOT a unit test. It spawns a REAL `pi --mode rpc` child via the REAL
 * `createRpcClientFactory` (wrapping the stock `RpcClient`), sends one trivial
 * prompt, and asserts the run reaches a terminal `agent_end` and that the
 * transcript carries the assistant's reply. It costs a live model call, so it is
 * GATED OUT of the default `bun test`:
 *
 *   - It lives under `test-harness/` with a `.ts` (NOT `.test.ts`) suffix, so the
 *     default `bun test` glob never collects it.
 *   - It additionally refuses to run unless `PI_RUNNER_SMOKE=1` is set, so an
 *     accidental `bun test <thisfile>` or `bun run` is a no-op.
 *
 * Run it explicitly once pi is configured with a real provider + key:
 *
 *   PI_RUNNER_SMOKE=1 \
 *   PI_SMOKE_MODEL=anthropic/claude-haiku-4-5 \
 *   bun run packages/pi/core/test-harness/run-runner-smoke.ts
 *
 * Optional env:
 *   PI_SMOKE_MODEL   provider/model to launch (else pi's configured default).
 *   PI_SMOKE_CWD     worktree/cwd to root the child in (else this repo).
 *   PI_SMOKE_TIMEOUT_MS  overall budget (default 120000).
 *
 * It exits 0 on success, non-zero on any assertion/timeout failure.
 */

import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import {
	createRpcClientFactory,
	createSessionTranscriptReader,
	type RpcAgentEvent,
	type StockRpcClient,
} from "../src/rpc-client";

const GATE = process.env.PI_RUNNER_SMOKE === "1";

function log(msg: string): void {
	process.stderr.write(`[runner-smoke] ${msg}\n`);
}

/** Resolve the installed pi CLI entry (dist/cli.js). */
function resolveCliPath(): string {
	// `createRequire(...).resolve` does not resolve through bun's isolated `.bun`
	// store; `import.meta.resolve` (sync in bun and node) does — it mirrors the
	// runtime dynamic `import()`. The package "main" is dist/index.js; cli.js sits
	// beside it.
	const indexUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
	const indexPath = indexUrl.startsWith("file:")
		? fileURLToPath(indexUrl)
		: indexUrl;
	return indexPath.replace(/index\.js$/, "cli.js");
}

async function main(): Promise<void> {
	if (!GATE) {
		log(
			"SKIPPED — set PI_RUNNER_SMOKE=1 to run this live integration smoke " +
				"(it makes a real model call).",
		);
		// A guarded no-op is success: the default surface must never fail here.
		return;
	}

	const cliPath = resolveCliPath();
	const model = process.env.PI_SMOKE_MODEL;
	const cwd = process.env.PI_SMOKE_CWD ?? process.cwd();
	const timeoutMs = Number(process.env.PI_SMOKE_TIMEOUT_MS ?? 120000);
	const sessionId = `smoke_${Date.now().toString(36)}`;

	log(`cliPath=${cliPath}`);
	log(`model=${model ?? "(pi default)"} cwd=${cwd} sessionId=${sessionId}`);

	const factory = createRpcClientFactory({
		cliPath,
		// The stock RpcClient ctor, narrowed to the seam's structural type.
		rpcClientCtor: (opts) => new RpcClient(opts) as unknown as StockRpcClient,
		logger: {
			debug: (m) => log(`debug: ${m}`),
			error: (m) => log(`error: ${m}`),
		},
	});

	const rpc = factory.create({
		cwd,
		model,
		sessionId,
		sessionDir: undefined,
	});

	let terminalEnd: Extract<RpcAgentEvent, { type: "agent_end" }> | undefined;
	let sawStart = false;
	let exited: { code: number | null; signal: string | null } | undefined;

	const offEvent = rpc.onEvent((e) => {
		if (e.type === "agent_start") {
			sawStart = true;
			log("event: agent_start");
		} else if (e.type === "agent_end") {
			const end = e as Extract<RpcAgentEvent, { type: "agent_end" }>;
			log(`event: agent_end (willRetry=${end.willRetry})`);
			if (!end.willRetry) {
				terminalEnd = end;
			}
		}
	});
	const offExit = rpc.onExit((i) => {
		exited = { code: i.code, signal: i.signal };
		log(`exit: code=${i.code} signal=${i.signal}`);
	});

	const done = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		const tick = setInterval(() => {
			if (terminalEnd) {
				clearTimeout(timer);
				clearInterval(tick);
				resolve();
			} else if (exited) {
				clearTimeout(timer);
				clearInterval(tick);
				reject(
					new Error(
						`child exited before a terminal agent_end: ${JSON.stringify(exited)}`,
					),
				);
			}
		}, 100);
	});

	try {
		log("starting child…");
		await rpc.start();
		log("dispatching prompt…");
		await rpc.prompt(
			"Reply with exactly the single word: PONG. Do not call any tools.",
		);
		await done;

		// --- assertions ---
		if (!sawStart) {
			throw new Error("never observed agent_start");
		}
		if (!terminalEnd) {
			throw new Error("no terminal agent_end captured");
		}

		// Read live messages, then cross-check the disk transcript reader.
		const liveMessages = await rpc.getMessages();
		const lastAssistant = [...liveMessages]
			.reverse()
			.find((m) => (m as { role?: string }).role === "assistant");
		if (!lastAssistant) {
			throw new Error("no assistant message in the live transcript");
		}
		log(`live transcript: ${liveMessages.length} messages`);

		const state = await rpc.getState();
		log(`sessionFile=${state.sessionFile ?? "(none)"}`);

		const reader = createSessionTranscriptReader();
		const diskMessages = await reader({
			sessionId,
			sessionFile: state.sessionFile,
		});
		log(`disk transcript: ${diskMessages.length} messages`);
		if (state.sessionFile && diskMessages.length === 0) {
			throw new Error(
				"disk transcript reader returned empty for a real session file",
			);
		}

		log("SMOKE PASSED — reached agent_end and read a non-empty transcript.");
	} finally {
		offEvent();
		offExit();
		await rpc.stop();
	}
}

main().catch((err: unknown) => {
	log(
		`SMOKE FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
	);
	process.exitCode = 1;
});
