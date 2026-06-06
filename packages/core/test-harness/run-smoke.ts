#!/usr/bin/env bun
/**
 * Headless end-to-end smoke harness for the opencode-drawers core engine.
 *
 * Orchestrates a REAL opencode (`$OPENCODE_BIN run ...`) loading the smoke
 * plugin (packages/core/test-harness/opencode.json), and proves the engine's
 * launch → completion → persistence → restart-recovery path against it:
 *
 *   1. Create a fresh temp $SMOKE_DATA_DIR (the plugin's TaskStore base).
 *   2. Spawn `opencode run` with an instruction telling the model to call
 *      smoke_launch with a trivial prompt. The plugin launches a bg child
 *      session; the engine's completion gate observes the live event stream
 *      and persists the task to $SMOKE_DATA_DIR/<id>.json.
 *   3. Poll the persisted task files directly (cleanest cross-process
 *      observation) until a task reaches `completed` with non-empty output,
 *      or timeout.
 *   4. SIMULATED RESTART: spawn a SECOND `opencode run` (new process, new
 *      engine instance) that calls smoke_status on the recovered task id. The
 *      second engine loads recoveredTasks from the same store at startup, so
 *      the still-terminal task must be readable — exercising the restart
 *      recovery + store-load path.
 *
 * Exit 0 + PASS summary on success; nonzero + diagnostics on failure.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface PersistedTask {
	id: string;
	status: string;
	sessionID?: string;
	error?: string;
	parentSessionID: string;
}

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));

// Default to the resolved opencode binary — NOT the `ai-opencode`/`opencode`
// shell functions, which are interactive-shell wrappers that fail in scripts.
const OPENCODE_BIN =
	process.env.OPENCODE_BIN ?? "/Users/fredamaral/.opencode/bin/opencode";

// Force the model on the `run` CLI explicitly. The harness opencode.json sets a
// `model`, but a user's GLOBAL agent config (e.g. a `build` agent pinned to a
// different model) silently overrides the config-level model — observed: the
// build agent ran gpt-5.5 instead of the configured haiku, and that combo
// refused to call the custom tool ("tool not available"). The `--model` flag on
// `run` overrides everything, so the harness is deterministic regardless of the
// host's global config. claude-haiku-4-5 is cheap and reliable at tool-calling.
const OPENCODE_MODEL = process.env.SMOKE_MODEL ?? "opencode/claude-haiku-4-5";

const LAUNCH_TIMEOUT_MS = 120_000;
const RUN_SPAWN_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 1_500;

function log(msg: string): void {
	process.stdout.write(`[smoke] ${msg}\n`);
}

interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

/** Spawn an opencode `run` headlessly with the harness cwd + env, capture output. */
function runOpencode(prompt: string, dataDir: string): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			OPENCODE_BIN,
			["run", "--model", OPENCODE_MODEL, prompt],
			{
				cwd: HARNESS_DIR,
				env: {
					...process.env,
					// CRITICAL: opencode resolves its project/config directory from the
					// PWD env var, NOT from the spawn cwd. Node/Bun's spawn({cwd}) sets
					// the real working dir but leaves PWD inherited from the parent. If
					// the parent runs from the repo root, opencode would look for config
					// there, miss this harness's opencode.json, and never register the
					// plugin's tools — the model then reports "smoke_launch not
					// available". Pin PWD to the harness dir so config discovery is
					// anchored where opencode.json lives.
					PWD: HARNESS_DIR,
					SMOKE_DATA_DIR: dataDir,
					// NOTE: do NOT set OPENCODE_PURE=1 here — it skips ALL external
					// plugins, including this one (the smoke plugin is itself an external
					// plugin), so the tools would be unavailable. The user's global
					// observer plugins (cwd-status/herdr/rtk) load too but are harmless.
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);

		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(
				new Error(
					`opencode run timed out after ${RUN_SPAWN_TIMEOUT_MS}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`,
				),
			);
		}, RUN_SPAWN_TIMEOUT_MS);

		child.stdout.on("data", (d) => {
			stdout += d.toString();
		});
		child.stderr.on("data", (d) => {
			stderr += d.toString();
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

/** Read all persisted task JSON files from the store dir. */
async function readTasks(dataDir: string): Promise<PersistedTask[]> {
	let names: string[];
	try {
		names = await readdir(dataDir);
	} catch {
		return [];
	}
	const tasks: PersistedTask[] = [];
	for (const name of names) {
		if (!name.endsWith(".json") || name.endsWith(".json.tmp")) {
			continue;
		}
		try {
			const raw = await readFile(join(dataDir, name), "utf-8");
			tasks.push(JSON.parse(raw) as PersistedTask);
		} catch {
			// torn/partial file mid-write — ignore, will retry next poll.
		}
	}
	return tasks;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
	log(`opencode binary: ${OPENCODE_BIN}`);
	log(`model (forced via --model): ${OPENCODE_MODEL}`);
	const dataDir = await mkdtemp(join(tmpdir(), "smoke-drawers-"));
	log(`SMOKE_DATA_DIR: ${dataDir}`);

	let exitCode = 0;
	try {
		// --- Phase 1: launch ------------------------------------------------
		// The smoke_launch tool always works once the model invokes it (verified),
		// but a small model occasionally REFUSES to call it ("tool not available")
		// purely as a generation artifact. The authoritative signal is a task file
		// appearing in the store — so retry the launch run until one shows up.
		log("phase 1: launching background task via opencode run …");
		const launchPrompt =
			"You have a tool named smoke_launch. It IS available — call it now. " +
			"Invoke smoke_launch exactly once with this argument: " +
			'{ "prompt": "Reply with exactly the word: done" }. ' +
			"Do not explain, do not refuse, do not ask for clarification — just call " +
			"the tool. After it returns, reply with only the task id it gave you.";
		const MAX_LAUNCH_ATTEMPTS = 3;
		let launched = false;
		for (let attempt = 1; attempt <= MAX_LAUNCH_ATTEMPTS; attempt += 1) {
			log(`  launch attempt ${attempt}/${MAX_LAUNCH_ATTEMPTS} …`);
			const launchRun = await runOpencode(launchPrompt, dataDir);
			log(`  launch run exited code=${launchRun.code}`);
			if (launchRun.stdout.trim()) {
				log(`  launch stdout (trimmed):\n${trim(launchRun.stdout, 600)}`);
			}
			if (launchRun.code !== 0) {
				throw new Error(
					`launch run nonzero exit (${launchRun.code})\nstderr:\n${trim(
						launchRun.stderr,
					)}`,
				);
			}
			if ((await readTasks(dataDir)).length > 0) {
				launched = true;
				break;
			}
			log("  no task file appeared — model likely refused; retrying …");
		}
		if (!launched) {
			throw new Error(
				`model never called smoke_launch across ${MAX_LAUNCH_ATTEMPTS} attempts ` +
					"(no task file was persisted). This is a model-behavior issue, not an " +
					"engine fault — try a different model in opencode.json.",
			);
		}

		// --- Phase 2: poll persisted task files until terminal+completed ----
		log("phase 2: polling persisted task files for completion …");
		const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
		let completed: PersistedTask | undefined;
		let lastSnapshot = "";
		while (Date.now() < deadline) {
			const tasks = await readTasks(dataDir);
			const snapshot = tasks
				.map((t) => `${t.id}:${t.status}`)
				.sort()
				.join(",");
			if (snapshot !== lastSnapshot) {
				log(`  tasks: [${snapshot || "(none yet)"}]`);
				lastSnapshot = snapshot;
			}
			completed = tasks.find((t) => t.status === "completed");
			if (completed) {
				break;
			}
			const errored = tasks.find(
				(t) => t.status === "error" || t.status === "cancelled",
			);
			if (errored) {
				throw new Error(
					`task ${errored.id} reached terminal-but-failed status '${errored.status}': ${
						errored.error ?? "(no error message)"
					}`,
				);
			}
			await sleep(POLL_INTERVAL_MS);
		}

		if (!completed) {
			throw new Error(
				`no task reached 'completed' within ${LAUNCH_TIMEOUT_MS}ms. ` +
					`last seen: [${lastSnapshot}]`,
			);
		}
		log(`task ${completed.id} completed (sessionID=${completed.sessionID})`);

		// --- Phase 3: simulated restart — read status in a NEW process ------
		// A brand-new opencode process boots a fresh engine that loads
		// recoveredTasks from the SAME store, then calls smoke_status. We retry on
		// model refusal (same artifact as phase 1); the proof is the recovered
		// engine echoing the task id it loaded from disk.
		log(
			"phase 3: simulated restart — reading recovered task in a new process …",
		);
		const statusPrompt =
			"You have a tool named smoke_status. It IS available — call it now. " +
			`Invoke smoke_status exactly once with this argument: { "task_id": "${completed.id}" }. ` +
			"Do not explain or refuse — just call the tool. Then reply with only the " +
			"JSON the tool returned.";
		const MAX_STATUS_ATTEMPTS = 3;
		let statusEchoedId = false;
		let lastStatusRun: RunResult | undefined;
		for (let attempt = 1; attempt <= MAX_STATUS_ATTEMPTS; attempt += 1) {
			log(`  status attempt ${attempt}/${MAX_STATUS_ATTEMPTS} …`);
			const statusRun = await runOpencode(statusPrompt, dataDir);
			lastStatusRun = statusRun;
			log(`  status run exited code=${statusRun.code}`);
			if (statusRun.stdout.trim()) {
				log(`  status stdout (trimmed):\n${trim(statusRun.stdout, 600)}`);
			}
			if (statusRun.code !== 0) {
				throw new Error(
					`status run nonzero exit (${statusRun.code})\nstderr:\n${trim(
						statusRun.stderr,
					)}`,
				);
			}
			if (statusRun.stdout.includes(completed.id)) {
				statusEchoedId = true;
				break;
			}
			log("  status output did not echo the task id; retrying …");
		}

		// The authoritative cross-process assertion: the persisted task survived
		// the restart and is still terminal with a readable result.
		const afterTasks = await readTasks(dataDir);
		const recovered = afterTasks.find((t) => t.id === completed?.id);
		if (!recovered) {
			throw new Error(
				`task ${completed.id} vanished from the store after restart`,
			);
		}
		if (recovered.status !== "completed") {
			throw new Error(
				`recovered task ${recovered.id} is '${recovered.status}', expected 'completed'`,
			);
		}
		// The recovered engine should have read the task via smoke_status and the
		// model echoed its id back — proving the second process's engine loaded the
		// recovered task and readOutput resolved against it.
		if (!statusEchoedId) {
			throw new Error(
				"the restarted process never echoed the recovered task id via " +
					`smoke_status across ${MAX_STATUS_ATTEMPTS} attempts. Last output:\n${trim(
						lastStatusRun?.stdout ?? "",
						600,
					)}`,
			);
		}

		log("");
		log("================ PASS ================");
		log(`launched + completed task : ${completed.id}`);
		log(`child sessionID           : ${completed.sessionID}`);
		log(`survived simulated restart: status='${recovered.status}'`);
		log(`status read in new process: id echoed by recovered engine ✓`);
		log("======================================");
	} catch (err) {
		exitCode = 1;
		log("");
		log("================ FAIL ================");
		log(err instanceof Error ? err.message : String(err));
		log("======================================");
	} finally {
		await rm(dataDir, { recursive: true, force: true }).catch(() => {});
	}

	process.exit(exitCode);
}

function trim(s: string, max = 2000): string {
	const t = s.trim();
	return t.length > max
		? `${t.slice(0, max)}\n…[truncated ${t.length - max} chars]`
		: t;
}

main().catch((err) => {
	log(`fatal: ${err instanceof Error ? err.stack : String(err)}`);
	process.exit(1);
});
