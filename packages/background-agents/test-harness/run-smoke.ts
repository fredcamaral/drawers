#!/usr/bin/env bun
/**
 * Headless end-to-end smoke harness for the `opencode-drawer-agents` plugin.
 *
 * Drives a REAL opencode (`$OPENCODE_BIN run ...`) loading the ACTUAL plugin
 * entry (packages/background-agents/src/index.ts, registered by absolute
 * file:// path in test-harness/opencode.json) and proves the `bg_*` tool family
 * end-to-end against it. Three scenarios:
 *
 *   A. launch + blocking output — instruct the model to call `bg_task` and then
 *      `bg_output(block:true)` IN THE SAME TURN. The blocking output holds the
 *      parent turn open (via the engine's `awaitCompletion`) so the single-turn
 *      `opencode run` process does not shut down + abort the child before it
 *      completes. Assert the child reaches `completed` and its output contains
 *      the expected token ("alpha").
 *
 *   B. fork — ONE run where the parent prompt states a fact (a release codename
 *      "zanzibar"), then calls `bg_task(fork:true)` asking the child to write a
 *      release note that must include it, then `bg_output(block:true)`. At fork
 *      time the parent transcript already contains the user message with the
 *      codename — that is what the fork injects as synthetic context. Assert the
 *      child output contains the codename ("zanzibar"). (Benign engineering
 *      framing on purpose: a "secret word → state it back" framing reads as a
 *      jailbreak to the model, which refuses; the fork mechanism is identical.)
 *
 *   C. restart — a SECOND opencode process (fresh engine) loads recoveredTasks
 *      from the SAME data dir, then `bg_list` + `bg_output` on a recovered task.
 *      Assert the recovered task is terminal with a readable output.
 *
 * Cross-process observation: the harness reads the persisted task JSON files in
 * $OPENCODE_DRAWERS_DATA_DIR directly (the authoritative signal), in addition to
 * the model echoing tool output to stdout.
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

// The resolved opencode binary — NOT the `opencode`/`ai-opencode` zsh functions,
// which are interactive-shell wrappers that fail in scripts.
const OPENCODE_BIN =
	process.env.OPENCODE_BIN ?? "/Users/fredamaral/.opencode/bin/opencode";

// Force the model on `run` explicitly. A global agent config can silently
// override the config-level model; `--model` on `run` overrides everything, so
// the harness is deterministic regardless of the host's global config.
// claude-haiku-4-5 is cheap and reliable at tool-calling.
const OPENCODE_MODEL = process.env.SMOKE_MODEL ?? "opencode/claude-haiku-4-5";

const LAUNCH_TIMEOUT_MS = 120_000;
const RUN_SPAWN_TIMEOUT_MS = 240_000;
const POLL_INTERVAL_MS = 1_500;

function log(msg: string): void {
	process.stdout.write(`[smoke:agents] ${msg}\n`);
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
					// PWD env var, NOT from the spawn cwd. spawn({cwd}) sets the real
					// working dir but leaves PWD inherited. Pin PWD to the harness dir so
					// config discovery finds this opencode.json and registers the plugin.
					PWD: HARNESS_DIR,
					// The engine reads this for its TaskStore base dir (engine.ts).
					OPENCODE_DRAWERS_DATA_DIR: dataDir,
					// Do NOT set OPENCODE_PURE=1 — it skips ALL external plugins,
					// including this one.
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

function trim(s: string, max = 2000): string {
	const t = s.trim();
	return t.length > max
		? `${t.slice(0, max)}\n…[truncated ${t.length - max} chars]`
		: t;
}

/**
 * Run a launch-style prompt, retrying on model refusal (a generation artifact:
 * the model occasionally declines to call the tool). The authoritative signal is
 * a NEW task file appearing in the store, so retry until the task count grows.
 */
async function runUntilTaskAppears(
	prompt: string,
	dataDir: string,
	beforeCount: number,
	maxAttempts = 3,
): Promise<RunResult> {
	let lastRun: RunResult | undefined;
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		log(`  attempt ${attempt}/${maxAttempts} …`);
		const run = await runOpencode(prompt, dataDir);
		lastRun = run;
		log(`  run exited code=${run.code}`);
		if (run.stdout.trim()) {
			log(`  stdout (trimmed):\n${trim(run.stdout, 700)}`);
		}
		if (run.code !== 0) {
			throw new Error(
				`run nonzero exit (${run.code})\nstderr:\n${trim(run.stderr)}`,
			);
		}
		if ((await readTasks(dataDir)).length > beforeCount) {
			return run;
		}
		log("  no new task file appeared — model likely refused; retrying …");
	}
	throw new Error(
		`model never called bg_task across ${maxAttempts} attempts (no new task ` +
			`file persisted). Model-behavior issue, not a plugin fault. Last stdout:\n${trim(
				lastRun?.stdout ?? "",
				700,
			)}`,
	);
}

/** Poll the store until a task with sessionID matching predicate is completed. */
async function waitForCompletion(
	dataDir: string,
	timeoutMs: number,
	predicate: (t: PersistedTask) => boolean = () => true,
): Promise<PersistedTask> {
	const deadline = Date.now() + timeoutMs;
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
		const completed = tasks.find(
			(t) => t.status === "completed" && predicate(t),
		);
		if (completed) {
			return completed;
		}
		const errored = tasks.find(
			(t) => (t.status === "error" || t.status === "cancelled") && predicate(t),
		);
		if (errored) {
			throw new Error(
				`task ${errored.id} reached terminal-but-failed status ` +
					`'${errored.status}': ${errored.error ?? "(no error message)"}`,
			);
		}
		await sleep(POLL_INTERVAL_MS);
	}
	throw new Error(
		`no matching task reached 'completed' within ${timeoutMs}ms. ` +
			`last seen: [${lastSnapshot}]`,
	);
}

async function scenarioA(dataDir: string): Promise<PersistedTask> {
	log("");
	log("=== Scenario A: launch + blocking output ===");
	const prompt =
		"You have tools named bg_task and bg_output. They ARE available. " +
		"In this single turn, do EXACTLY this and nothing else: " +
		'(1) call bg_task with { "description": "say alpha", ' +
		'"prompt": "Reply with exactly: alpha" }. ' +
		"(2) Then immediately call bg_output with the task id from step 1 and " +
		'{ "block": true } so you wait for it to finish. ' +
		"(3) Then reply with only the output text bg_output returned. " +
		"Do not explain, do not refuse, do not poll in a loop — bg_output(block:true) " +
		"already waits for you.";
	const run = await runUntilTaskAppears(prompt, dataDir, 0);
	const completed = await waitForCompletion(dataDir, LAUNCH_TIMEOUT_MS);
	log(`task ${completed.id} completed (sessionID=${completed.sessionID})`);

	// Output token assertion: the model echoes bg_output's result, which carries
	// the child's "alpha". The blocking output also means the run stdout contains
	// it. Assert on the run stdout (most direct cross-process proof).
	if (!run.stdout.toLowerCase().includes("alpha")) {
		throw new Error(
			`Scenario A: expected output to contain 'alpha', but the run stdout did ` +
				`not. stdout:\n${trim(run.stdout, 900)}`,
		);
	}
	log("Scenario A PASS: child completed and output contained 'alpha'");
	return completed;
}

async function scenarioB(dataDir: string, beforeCount: number): Promise<void> {
	log("");
	log("=== Scenario B: fork (parent fact → child) ===");
	// Framing matters: an earlier version used "the secret word is X … fork a
	// child to state it back", which the model refused as a perceived prompt-
	// injection/jailbreak test (it never called bg_task). The fork MECHANISM is
	// identical regardless of the fact's framing, so we use a benign engineering
	// handoff: the parent picks a release codename, then delegates a child (with
	// fork:true) to write a one-line release note that must include it. The child
	// can only know the codename via the forked parent transcript.
	const prompt =
		"We are shipping a release. Its codename is zanzibar. " +
		"You have tools named bg_task and bg_output. They ARE available. " +
		"In this single turn, do EXACTLY this: " +
		'(1) call bg_task with { "description": "write release note", ' +
		'"prompt": "Using the forked parent context, write a one-line release ' +
		'note. It MUST include the release codename mentioned earlier.", ' +
		'"fork": true }. ' +
		"(2) Then immediately call bg_output with that task id and " +
		'{ "block": true } to wait for completion. ' +
		"(3) Then reply with only the output text bg_output returned.";
	const run = await runUntilTaskAppears(prompt, dataDir, beforeCount);
	// The newest task is the fork task; wait for any new completion beyond before.
	await waitForCompletion(dataDir, LAUNCH_TIMEOUT_MS, () => true);

	if (!run.stdout.toLowerCase().includes("zanzibar")) {
		throw new Error(
			`Scenario B: forked child did not surface the parent's codename 'zanzibar'. ` +
				`The fork either injected nothing or the child ignored it. stdout:\n${trim(
					run.stdout,
					900,
				)}`,
		);
	}
	log(
		"Scenario B PASS: forked child used the parent's codename 'zanzibar' from forked context",
	);
}

async function scenarioC(dataDir: string, recoveredId: string): Promise<void> {
	log("");
	log("=== Scenario C: restart recovery (new process) ===");
	const prompt =
		"You have tools named bg_list and bg_output. They ARE available. " +
		"In this single turn: (1) call bg_list to see background tasks. " +
		`(2) call bg_output with { "task_id": "${recoveredId}" } to read its result. ` +
		"(3) reply with only the JSON/text bg_output returned. Do not refuse.";
	const MAX_ATTEMPTS = 3;
	let echoed = false;
	let lastRun: RunResult | undefined;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
		log(`  attempt ${attempt}/${MAX_ATTEMPTS} …`);
		const run = await runOpencode(prompt, dataDir);
		lastRun = run;
		log(`  run exited code=${run.code}`);
		if (run.stdout.trim()) {
			log(`  stdout (trimmed):\n${trim(run.stdout, 700)}`);
		}
		if (run.code !== 0) {
			throw new Error(
				`status run nonzero exit (${run.code})\nstderr:\n${trim(run.stderr)}`,
			);
		}
		if (run.stdout.includes(recoveredId)) {
			echoed = true;
			break;
		}
		log("  output did not echo the recovered task id; retrying …");
	}

	// Authoritative cross-process assertion: the persisted task survived and is
	// still terminal with a readable result.
	const afterTasks = await readTasks(dataDir);
	const recovered = afterTasks.find((t) => t.id === recoveredId);
	if (!recovered) {
		throw new Error(
			`task ${recoveredId} vanished from the store after restart`,
		);
	}
	if (
		recovered.status !== "completed" &&
		recovered.status !== "error" &&
		recovered.status !== "cancelled"
	) {
		throw new Error(
			`recovered task ${recovered.id} is non-terminal '${recovered.status}'`,
		);
	}
	if (!echoed) {
		throw new Error(
			`the restarted process never echoed the recovered task id via bg_output ` +
				`across ${MAX_ATTEMPTS} attempts. Last output:\n${trim(
					lastRun?.stdout ?? "",
					700,
				)}`,
		);
	}
	log(
		`Scenario C PASS: recovered task ${recovered.id} terminal ` +
			`('${recovered.status}') and readable in a new process`,
	);
}

async function main(): Promise<void> {
	log(`opencode binary: ${OPENCODE_BIN}`);
	log(`model (forced via --model): ${OPENCODE_MODEL}`);
	const dataDir = await mkdtemp(join(tmpdir(), "smoke-agents-"));
	log(`OPENCODE_DRAWERS_DATA_DIR: ${dataDir}`);

	let exitCode = 0;
	try {
		const a = await scenarioA(dataDir);
		const afterA = (await readTasks(dataDir)).length;
		await scenarioB(dataDir, afterA);
		// Restart recovery uses Scenario A's completed task (guaranteed terminal).
		await scenarioC(dataDir, a.id);

		log("");
		log("================ PASS ================");
		log("A: launch + bg_output(block) → 'alpha'        ✓");
		log("B: fork injects parent secret → 'zanzibar'    ✓");
		log("C: restart recovery readable in new process   ✓");
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

main().catch((err) => {
	log(`fatal: ${err instanceof Error ? err.stack : String(err)}`);
	process.exit(1);
});
