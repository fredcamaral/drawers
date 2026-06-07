#!/usr/bin/env bun
/**
 * Headless end-to-end smoke harness for the `opencode-drawer-workflows` plugin.
 *
 * Drives a REAL opencode (`$OPENCODE_BIN run ...`) loading the ACTUAL plugin entry
 * (packages/workflows/src/plugin/index.ts, registered by absolute file:// path in
 * test-harness/opencode.json) and proves the workflow tool family end-to-end.
 *
 * Three scenarios:
 *
 *   A. canonical review workflow — the model calls `workflow` with an inline script
 *      that exercises phase()/pipeline()/parallel() AND a saved sub-workflow
 *      (`await workflow('helper', { x: 1 })`, resolved from
 *      .opencode/workflows/helper.js), then calls `workflow_status` with
 *      `wait_ms=90000` to BLOCK until the run settles (the honest single-turn
 *      affordance — `opencode run` has no completion notification to re-invoke the
 *      model, unlike CC's task-notifications). The harness asserts the run record
 *      on disk is `completed`, the result carries `reviewed fs.ts` / `reviewed
 *      net.ts` (pipeline + parallel over the two items), and `helper-marker` (the
 *      sub-workflow's agent output) — one scenario covering pipeline, parallel,
 *      phase, sub-workflow, saved-name resolution, and the wait_ms block.
 *
 *   B. stop — the model launches a workflow whose script runs one agent, then calls
 *      `workflow_stop` in the SAME turn right after launch. The harness asserts the
 *      run record settles `cancelled`.
 *
 *   C. resume — a SECOND opencode process re-runs scenario A's persisted runId via
 *      `resume_from_run_id`. The harness asserts the resumed run is `completed`,
 *      `workflow_status` reports all-cached (`0 live agent calls`), AND the plugin's
 *      own child-task store gained NO new task files for the resumed run — the
 *      authoritative cross-process "nothing relaunched" signal (see the note in the
 *      README on why this, not opencode's global session DB, is the honest probe).
 *
 * Cross-process observation: the harness reads the persisted run-record + task JSON
 * files under $OPENCODE_DRAWERS_DATA_DIR directly (the authoritative signal), in
 * addition to the model echoing tool output to stdout.
 *
 * Exit 0 + PASS summary on success; nonzero + diagnostics on failure.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface RunRecord {
	id: string;
	status: string;
	returnValue?: unknown;
	error?: string;
	parentSessionID: string;
}

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));

// The resolved opencode binary — NOT the `opencode`/`ai-opencode` zsh functions,
// which are interactive-shell wrappers that fail in scripts.
const OPENCODE_BIN =
	process.env.OPENCODE_BIN ?? "/Users/fredamaral/.opencode/bin/opencode";

// Force the model on `run` explicitly. A global agent config can silently override
// the config-level model; `--model` on `run` overrides everything, so the harness
// is deterministic regardless of the host's global config. claude-haiku-4-5 is
// cheap and reliable at tool-calling.
const OPENCODE_MODEL = process.env.SMOKE_MODEL ?? "opencode/claude-haiku-4-5";

const RUN_SPAWN_TIMEOUT_MS = 300_000;
const SETTLE_POLL_INTERVAL_MS = 1_500;
const SETTLE_TIMEOUT_MS = 120_000;

function log(msg: string): void {
	process.stdout.write(`[smoke:workflows] ${msg}\n`);
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
					// PWD env var, NOT from the spawn cwd. Pin PWD to the harness dir so
					// config discovery finds this opencode.json and registers the plugin
					// (and so saved-workflow resolution roots at the harness dir).
					PWD: HARNESS_DIR,
					// The engine reads this for its run/task store base dir (engine.ts).
					OPENCODE_DRAWERS_DATA_DIR: dataDir,
					// Do NOT set OPENCODE_PURE=1 — it skips ALL external plugins.
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

/** Read all persisted run-record JSON files from the workflow-runs store dir. */
async function readRuns(dataDir: string): Promise<RunRecord[]> {
	const dir = join(dataDir, "workflow-runs");
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const records: RunRecord[] = [];
	for (const name of names) {
		if (!name.endsWith(".json") || name.endsWith(".json.tmp")) {
			continue;
		}
		try {
			const raw = await readFile(join(dir, name), "utf-8");
			records.push(JSON.parse(raw) as RunRecord);
		} catch {
			// torn/partial file mid-write — ignore, will retry next poll.
		}
	}
	return records;
}

/** Count the plugin's persisted child-task files (one per launched child agent). */
async function countTaskFiles(dataDir: string): Promise<number> {
	const dir = join(dataDir, "workflow-tasks");
	try {
		const names = await readdir(dir);
		return names.filter((n) => n.endsWith(".json") && !n.endsWith(".json.tmp"))
			.length;
	} catch {
		return 0;
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function trim(s: string, max = 2000): string {
	const t = s.trim();
	return t.length > max
		? `${t.slice(0, max)}\n…[truncated ${t.length - max} chars]`
		: t;
}

/**
 * Run a prompt, retrying on model refusal (a generation artifact). The authoritative
 * signal is a NEW run record appearing in the store, so retry until the run count
 * grows beyond `beforeCount`.
 */
async function runUntilRunAppears(
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
			log(`  stdout (trimmed):\n${trim(run.stdout, 900)}`);
		}
		if (run.code !== 0) {
			throw new Error(
				`run nonzero exit (${run.code})\nstderr:\n${trim(run.stderr)}`,
			);
		}
		if ((await readRuns(dataDir)).length > beforeCount) {
			return run;
		}
		log("  no new run record appeared — model likely refused; retrying …");
	}
	throw new Error(
		`model never called workflow across ${maxAttempts} attempts (no new run ` +
			`record persisted). Model-behavior issue, not a plugin fault. Last stdout:\n${trim(
				lastRun?.stdout ?? "",
				900,
			)}`,
	);
}

/** Poll the run store until a record matching predicate is terminal. */
async function waitForTerminal(
	dataDir: string,
	predicate: (r: RunRecord) => boolean,
	timeoutMs = SETTLE_TIMEOUT_MS,
): Promise<RunRecord> {
	const deadline = Date.now() + timeoutMs;
	let lastSnapshot = "";
	while (Date.now() < deadline) {
		const runs = await readRuns(dataDir);
		const snapshot = runs
			.map((r) => `${r.id}:${r.status}`)
			.sort()
			.join(",");
		if (snapshot !== lastSnapshot) {
			log(`  runs: [${snapshot || "(none yet)"}]`);
			lastSnapshot = snapshot;
		}
		const match = runs.find((r) => r.status !== "running" && predicate(r));
		if (match) {
			return match;
		}
		await sleep(SETTLE_POLL_INTERVAL_MS);
	}
	throw new Error(
		`no matching run reached a terminal status within ${timeoutMs}ms. last: [${lastSnapshot}]`,
	);
}

/** The canonical review workflow inline script (Scenario A). */
const REVIEW_SCRIPT = [
	"export const meta = { name: 'review', description: 'canonical review workflow', phases: [{ title: 'Review' }, { title: 'Verify' }] };",
	// pipeline over two items, each spawning a review agent under the Review phase.
	"const reviewed = await pipeline(['fs.ts', 'net.ts'], (item) =>",
	"  agent('Reply with exactly: reviewed ' + item, { label: 'review:' + item, phase: 'Review' }));",
	// parallel verify stage over the results (barrier), under the Verify phase.
	"const verified = await parallel(reviewed.map((r) => () =>",
	"  agent('Reply with exactly: verified ' + r, { label: 'verify', phase: 'Verify' })));",
	// a saved sub-workflow call — saved-name resolution + the sub-workflow boundary.
	"const helper = await workflow('helper', { x: 1 });",
	"return { reviewed, verified, helper };",
]
	.join("\n")
	.replace(/'/g, "\\'");

async function scenarioA(dataDir: string): Promise<RunRecord> {
	log("");
	log(
		"=== Scenario A: review workflow (pipeline + parallel + phase + sub-workflow) ===",
	);
	const prompt =
		"You have tools named workflow and workflow_status. They ARE available. " +
		"This is an explicit multi-agent orchestration request (opt-in satisfied). " +
		"In this single turn, do EXACTLY this and nothing else: " +
		`(1) call workflow with { "script": "${REVIEW_SCRIPT}" }. ` +
		"(2) Take the run_id it returns and immediately call workflow_status with " +
		'that run_id and { "wait_ms": 90000 } so you BLOCK until the workflow settles. ' +
		"(3) Then reply with only the result text workflow_status returned. " +
		"Do not refuse, do not poll in a loop — workflow_status(wait_ms) already waits.";
	const run = await runUntilRunAppears(prompt, dataDir, 0);
	const record = await waitForTerminal(
		dataDir,
		(r) => r.status === "completed",
	);
	log(`run ${record.id} completed`);

	const result = JSON.stringify(record.returnValue ?? null);
	const combined = `${run.stdout}\n${result}`.toLowerCase();
	for (const needle of ["reviewed fs.ts", "reviewed net.ts", "helper-marker"]) {
		if (!combined.includes(needle)) {
			throw new Error(
				`Scenario A: expected the result to contain '${needle}'. ` +
					`returnValue=${result}\nstdout:\n${trim(run.stdout, 1200)}`,
			);
		}
	}
	log(
		"Scenario A PASS: pipeline+parallel+phase+sub-workflow completed; result carried " +
			"'reviewed fs.ts' / 'reviewed net.ts' / 'helper-marker'",
	);
	return record;
}

async function scenarioB(dataDir: string, beforeCount: number): Promise<void> {
	log("");
	log("=== Scenario B: stop a live workflow ===");
	const stopScript = [
		"export const meta = { name: 'longrun', description: 'one long agent' };",
		"const r = await agent('Count slowly from 1 to 50, one number per line.', { label: 'long' });",
		"return r;",
	]
		.join("\n")
		.replace(/'/g, "\\'");
	const prompt =
		"You have tools named workflow and workflow_stop. They ARE available. " +
		"This is an explicit multi-agent orchestration request (opt-in satisfied). " +
		"In this single turn, do EXACTLY this: " +
		`(1) call workflow with { "script": "${stopScript}" }. ` +
		"(2) Take the run_id it returns and immediately call workflow_stop with that " +
		"run_id to cancel it. (3) Reply with only what workflow_stop returned. Do not refuse.";
	await runUntilRunAppears(prompt, dataDir, beforeCount);
	const record = await waitForTerminal(
		dataDir,
		(r) => r.status === "cancelled",
		30_000,
	);
	log(`Scenario B PASS: run ${record.id} settled 'cancelled'`);
}

async function scenarioC(dataDir: string, resumeId: string): Promise<void> {
	log("");
	log("=== Scenario C: resume (second process, all-cached, no relaunch) ===");
	const tasksBefore = await countTaskFiles(dataDir);
	const runsBefore = (await readRuns(dataDir)).length;
	log(`  child-task files before resume: ${tasksBefore}`);

	const prompt =
		"You have tools named workflow and workflow_status. They ARE available. " +
		"This is an explicit multi-agent orchestration request (opt-in satisfied). " +
		"In this single turn, do EXACTLY this: " +
		`(1) call workflow with { "resume_from_run_id": "${resumeId}" } to resume the ` +
		"prior run. (2) Take the NEW run_id it returns and immediately call " +
		'workflow_status with that run_id and { "wait_ms": 90000 } to block until it ' +
		"settles. (3) Reply with only what workflow_status returned. Do not refuse.";
	const run = await runUntilRunAppears(prompt, dataDir, runsBefore);

	// The resumed run is a NEW record (its own runId) resumed from the prior one.
	const record = await waitForTerminal(
		dataDir,
		(r) => r.status === "completed" && r.id !== resumeId,
	);
	log(`  resumed run ${record.id} completed (resumed from ${resumeId})`);

	// All-cached assertion: workflow_status reports "0 live agent calls" for a fully
	// cached resume. The model echoes that line; assert on the run stdout.
	if (!/0 live agent calls/.test(run.stdout)) {
		throw new Error(
			`Scenario C: expected workflow_status to report '0 live agent calls' on a ` +
				`fully-cached resume. stdout:\n${trim(run.stdout, 1200)}`,
		);
	}

	// Authoritative cross-process probe: a fully-cached resume relaunches NO child
	// agents, so the plugin's child-task store must not have grown.
	const tasksAfter = await countTaskFiles(dataDir);
	log(`  child-task files after resume: ${tasksAfter}`);
	if (tasksAfter !== tasksBefore) {
		throw new Error(
			`Scenario C: resume relaunched children — child-task files grew from ` +
				`${tasksBefore} to ${tasksAfter} (a cached resume must launch zero).`,
		);
	}
	log(
		`Scenario C PASS: resumed run completed all-cached; child-task store unchanged ` +
			`(${tasksBefore} → ${tasksAfter})`,
	);
}

async function main(): Promise<void> {
	log(`opencode binary: ${OPENCODE_BIN}`);
	log(`model (forced via --model): ${OPENCODE_MODEL}`);
	const dataDir = await mkdtemp(join(tmpdir(), "smoke-workflows-"));
	log(`OPENCODE_DRAWERS_DATA_DIR: ${dataDir}`);

	let exitCode = 0;
	try {
		const a = await scenarioA(dataDir);
		const afterA = (await readRuns(dataDir)).length;
		await scenarioB(dataDir, afterA);
		await scenarioC(dataDir, a.id);

		log("");
		log("================ PASS ================");
		log("A: review workflow (pipeline+parallel+phase+sub-workflow) ✓");
		log("B: workflow_stop → cancelled                              ✓");
		log("C: resume all-cached, no child relaunch (new process)     ✓");
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
