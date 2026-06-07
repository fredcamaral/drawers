#!/usr/bin/env bun
/**
 * Headless end-to-end smoke harness for the `opencode-drawer-workflows` plugin.
 *
 * Drives a REAL opencode (`$OPENCODE_BIN run ...`) loading the ACTUAL plugin entry
 * (packages/workflows/src/plugin/index.ts, registered by absolute file:// path in
 * test-harness/opencode.json) and proves the workflow tool family end-to-end.
 *
 * Scenarios:
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
 *      `resume_from_run_id`. The harness asserts on authoritative persisted state
 *      ONLY (not model stdout, which paraphrases tool output nondeterministically):
 *      the resumed run record is `completed`, its `returnValue` deep-equals the
 *      original run's (a fully-cached replay reproduces the same result), AND the
 *      plugin's own child-task store gained NO new task files for the resumed run —
 *      the authoritative cross-process "nothing relaunched" signal (see the note in
 *      the README on why this, not opencode's global session DB, is the honest probe).
 *
 *   E. liveness-veto over-block guard — one agent whose child runs a single bash
 *      command that sleeps 15s (past the completion gate's ~10s poll+grace) BEFORE
 *      echoing a distinctive final marker. The harness asserts the persisted
 *      returnValue (the child's final text) is a non-empty string carrying that
 *      marker — proving Task 7.1.1's turn-liveness veto does NOT hang a legitimate
 *      long-running turn: it releases once the turn truly finishes. This scenario
 *      deliberately does NOT detect the mid-turn early-completion bug 7.1.1 fixes
 *      (a blocking in-session tool starves both turn events and the gate's own SDK
 *      reads, so the gate is incidentally protected even without the veto; the
 *      production window is server-responsive-but-eventless — first-token latency /
 *      API retry backoff — which a tool cannot emulate). That bug class is owned by
 *      the six deterministic unit tests in packages/core/src/completion.test.ts.
 *
 *   F. external control channel — the model launches `longrun` AND blocks the turn
 *      on workflow_status(wait_ms) (Scenario E's keep-alive), so the in-process
 *      server — and the engine's control poll loop — stays ALIVE. While the turn is
 *      blocked, THIS HARNESS (a process other than the server) touches the sentinel
 *      <dataDir>/workflow-control/<runId>.cancel. PASS iff the engine's poll loop
 *      observes it inside the live server, settles the run `cancelled`, and consumes
 *      the sentinel — the only honest end-to-end proof of Epic 8.2 against a real
 *      opencode. See the scenarioF header for the load-bearing `opencode run`
 *      lifecycle invariant (process exits at top-level idle, not on child drain).
 *
 * Cross-process observation: the harness reads the persisted run-record + task JSON
 * files under $OPENCODE_DRAWERS_DATA_DIR directly (the authoritative signal), in
 * addition to the model echoing tool output to stdout.
 *
 * Exit 0 + PASS summary on success; nonzero + diagnostics on failure.
 */

import { spawn } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
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

async function scenarioC(dataDir: string, original: RunRecord): Promise<void> {
	log("");
	log("=== Scenario C: resume (second process, all-cached, no relaunch) ===");
	const resumeId = original.id;
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
	await runUntilRunAppears(prompt, dataDir, runsBefore);

	// The resumed run is a NEW record (its own runId) resumed from the prior one.
	const record = await waitForTerminal(
		dataDir,
		(r) => r.status === "completed" && r.id !== resumeId,
	);
	log(`  resumed run ${record.id} completed (resumed from ${resumeId})`);

	// NOTE: we do NOT assert on the model's stdout. workflow_status's "0 live agent
	// calls" line is model-paraphrased — haiku reformats the tool output into its own
	// JSON ("live_calls": 0), so a verbatim regex over stdout is nondeterministic and
	// not an assertion surface. We anchor entirely on authoritative persisted state.

	// Authoritative probe 1 (cross-process): a fully-cached resume relaunches NO child
	// agents, so the plugin's child-task store must not have grown.
	const tasksAfter = await countTaskFiles(dataDir);
	log(`  child-task files after resume: ${tasksAfter}`);
	if (tasksAfter !== tasksBefore) {
		throw new Error(
			`Scenario C: resume relaunched children — child-task files grew from ` +
				`${tasksBefore} to ${tasksAfter} (a cached resume must launch zero).`,
		);
	}

	// Authoritative probe 2 (persisted truth): a fully-cached replay must reproduce the
	// SAME result as the original run. Deep-equal the persisted returnValues.
	const originalRet = JSON.stringify(original.returnValue ?? null);
	const resumedRet = JSON.stringify(record.returnValue ?? null);
	if (resumedRet !== originalRet) {
		throw new Error(
			`Scenario C: resumed returnValue does not match the original run's. ` +
				`original=${originalRet}\nresumed=${resumedRet}`,
		);
	}
	log(
		`Scenario C PASS: resumed run completed; child-task store unchanged ` +
			`(${tasksBefore} → ${tasksAfter}); returnValue reproduced from cache`,
	);
}

async function scenarioD(dataDir: string, beforeCount: number): Promise<void> {
	log("");
	log("=== Scenario D: structured output (agent({ schema })) e2e ===");
	// The ONLY scenario that exercises `agent({ schema })` — the registry/gate path
	// whose regression (returnValue null) shipped to production (plan §6.1, the
	// 2026-06-07 repro). This scenario locks the happy path: a schema-conformant
	// verdict must resolve as the validated OBJECT. The mid-turn early-completion
	// class (a silent window crossing the idle-poll grace) is NOT deterministically
	// live-testable — see Scenario E's comment for why a blocking tool can't emulate
	// it — and is covered by the unit tests in packages/core/src/completion.test.ts.
	const schemaScript = [
		"export const meta = { name: 'verdict', description: 'one structured-output agent' };",
		"const r = await agent('State your verdict on the number 42 being even.', {",
		"  label: 'verdict',",
		"  schema: { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] },",
		"});",
		"return { r };",
	]
		.join("\n")
		.replace(/'/g, "\\'");
	const prompt =
		"You have tools named workflow and workflow_status. They ARE available. " +
		"This is an explicit multi-agent orchestration request (opt-in satisfied). " +
		"In this single turn, do EXACTLY this and nothing else: " +
		`(1) call workflow with { "script": "${schemaScript}" }. ` +
		"(2) Take the run_id it returns and immediately call workflow_status with " +
		'that run_id and { "wait_ms": 90000 } so you BLOCK until the workflow settles. ' +
		"(3) Then reply with only the result text workflow_status returned. " +
		"Do not refuse, do not poll in a loop — workflow_status(wait_ms) already waits.";
	// Snapshot the ids already on disk (A's + C's completed runs) so we match only
	// D's new run, not a prior completed one.
	const priorIds = new Set((await readRuns(dataDir)).map((r) => r.id));
	await runUntilRunAppears(prompt, dataDir, beforeCount);
	const record = await waitForTerminal(
		dataDir,
		(r) => r.status === "completed" && !priorIds.has(r.id),
		SETTLE_TIMEOUT_MS,
	);
	log(`  run ${record.id} completed`);

	// The heart of the scenario: the persisted returnValue must carry the VALIDATED
	// OBJECT, not the production-regression shapes. record.returnValue is { r: <result> }.
	const ret = record.returnValue;
	const nested =
		ret && typeof ret === "object" && !Array.isArray(ret)
			? (ret as Record<string, unknown>).r
			: undefined;
	const shape = JSON.stringify(record.returnValue ?? null);
	if (nested === null) {
		throw new Error(
			`Scenario D: structured output regressed to null (the production bug shape). ` +
				`returnValue=${shape}`,
		);
	}
	if (typeof nested === "string") {
		throw new Error(
			`Scenario D: structured output resolved as a plain string — schema was bypassed. ` +
				`returnValue=${shape}`,
		);
	}
	if (typeof nested !== "object" || Array.isArray(nested)) {
		throw new Error(
			`Scenario D: expected the agent result to be a non-null object. returnValue=${shape}`,
		);
	}
	const verdict = (nested as Record<string, unknown>).verdict;
	if (typeof verdict !== "string") {
		throw new Error(
			`Scenario D: validated object missing a string 'verdict' property. ` +
				`returnValue=${shape}`,
		);
	}
	log(
		`Scenario D PASS: structured output resolved as a validated object with a ` +
			`string verdict (returnValue=${shape})`,
	);
}

/**
 * The literal marker the child must echo as its FINAL assistant text, AFTER a
 * long-blocking in-session tool returns. The script returns that text directly,
 * so the persisted returnValue IS the child's final reply — the assertion target.
 */
const LIVENESS_MARKER = "LIVENESS_FINAL_E2E_77";

async function scenarioE(dataDir: string, beforeCount: number): Promise<void> {
	log("");
	log(
		"=== Scenario E: liveness veto over-block guard (long tool turn completes whole) ===",
	);
	// WHAT THIS GUARDS — the OVER-BLOCK risk of Task 7.1.1, not the bug it fixed.
	// The turn-liveness veto must never HANG legitimate long-running work: a real
	// turn that goes quiet for a while (a slow in-session tool) must still complete,
	// with its FULL final text captured. One agent, no schema, runs a single bash
	// command `sleep 15 && echo <marker>` (~15s, past the gate's ~10s poll+grace
	// window), then echoes the marker as its final text. PASS iff the persisted
	// returnValue is that complete final reply — proving the veto released once the
	// turn truly finished rather than deadlocking it.
	//
	// WHAT THIS DOES NOT DO — and why. This scenario does NOT detect the mid-turn
	// early-completion class (the bug 7.1.1 fixes). A blocking IN-SESSION tool
	// starves BOTH the turn's SDK events AND the gate's own SDK reads
	// (session.status / session.messages / session.get) — they are the same
	// event-loop phenomenon — so the gate is INCIDENTALLY protected from completing
	// mid-tool even with the veto removed (verified empirically: with the veto
	// reverted, the safety poll ticks during the sleep but its reads serialize
	// behind the busy session and never complete the task). The production window
	// 7.1.1 targets is different: the opencode server is RESPONSIVE to status/message
	// reads but no new turn events flow — first-token latency on large prompts, or
	// API ECONNRESET retry backoff between turns — which a sleeping tool cannot
	// emulate. That bug class is owned by the six deterministic unit tests in
	// packages/core/src/completion.test.ts ("turn liveness — …", Task 7.1.1), which
	// pin every veto branch (busy / retry / status-throw / missing time.completed /
	// absent-status+completed / stale-force-cancel) with manual clocks and fakes.
	const livenessScript = [
		"export const meta = { name: 'liveness', description: 'one agent with a long-blocking tool' };",
		"const r = await agent(",
		"  'Run exactly one bash command: sleep 15 && echo " +
			LIVENESS_MARKER +
			". " +
			"After the command returns, reply with exactly this text and nothing else: " +
			LIVENESS_MARKER +
			"', { label: 'liveness' });",
		"return r;",
	]
		.join("\n")
		.replace(/'/g, "\\'");
	const prompt =
		"You have tools named workflow and workflow_status. They ARE available. " +
		"This is an explicit multi-agent orchestration request (opt-in satisfied). " +
		"In this single turn, do EXACTLY this and nothing else: " +
		`(1) call workflow with { "script": "${livenessScript}" }. ` +
		"(2) Take the run_id it returns and immediately call workflow_status with " +
		'that run_id and { "wait_ms": 90000 } so you BLOCK until the workflow settles. ' +
		"(3) Then reply with only the result text workflow_status returned. " +
		"Do not refuse, do not poll in a loop — workflow_status(wait_ms) already waits.";
	// Snapshot the ids already on disk so we match only E's new run.
	const priorIds = new Set((await readRuns(dataDir)).map((r) => r.id));
	await runUntilRunAppears(prompt, dataDir, beforeCount);
	const record = await waitForTerminal(
		dataDir,
		(r) => r.status === "completed" && !priorIds.has(r.id),
		SETTLE_TIMEOUT_MS,
	);
	log(`  run ${record.id} completed`);

	// The heart of the scenario: the persisted returnValue is the child's FINAL
	// text. It must be a non-empty string carrying the marker. Distinguish the three
	// failure shapes so an over-block regression points straight at its cause.
	const ret = record.returnValue;
	const shape = JSON.stringify(ret ?? null);
	if (typeof ret !== "string") {
		throw new Error(
			`Scenario E: expected a string returnValue (the child's final text), got ` +
				`${shape}. A null/object here means the long-tool turn degraded instead of ` +
				`completing normally.`,
		);
	}
	if (ret.trim() === "") {
		throw new Error(
			`Scenario E: returnValue is an EMPTY string — the long-tool turn settled with ` +
				`no captured text. Either the veto released too early (before the final reply) ` +
				`or the turn degraded; the legitimate long turn did not complete whole.`,
		);
	}
	if (!ret.includes(LIVENESS_MARKER)) {
		throw new Error(
			`Scenario E: returnValue is non-empty but MISSING the marker '${LIVENESS_MARKER}' ` +
				`— the long-tool turn's FINAL text was not captured in full (a partial/pre-tool ` +
				`snapshot). returnValue=${shape}`,
		);
	}
	log(
		`Scenario E PASS: a legitimate long in-session tool turn (~15s quiet) completed ` +
			`whole — the liveness veto did not hang it; persisted returnValue carries ` +
			`'${LIVENESS_MARKER}'`,
	);
}

async function scenarioF(dataDir: string): Promise<void> {
	log("");
	log(
		"=== Scenario F: external touch cancels a live run (filesystem sentinel) ===",
	);
	// The ONLY scenario that proves the EXTERNAL control channel (Epic 8.2) end-to-end
	// against a real headless opencode. Scenario B proves the IN-SESSION cancel path
	// (workflow_stop tool → stopRun in the same turn). Here a process OTHER than the
	// opencode server — this harness — cancels a live run by touching a filesystem
	// sentinel under <dataDir>/workflow-control/. PASS iff the engine's poll loop
	// (≤1s cadence) observes the sentinel inside the live server, cancels the run, and
	// consumes (unlinks) the sentinel. This is the honest proof that 8.2.2's watcher
	// fires in a real server, not just in unit tests.
	//
	// LOAD-BEARING LIFECYCLE INVARIANT (the reason this scenario is shaped the way it
	// is). `opencode run` is the NON-INTERACTIVE in-process server: it "exits when the
	// session goes idle" — its event loop breaks the moment the TOP-LEVEL session goes
	// idle and does NOT wait for detached child sessions to drain
	// (.references/opencode/packages/opencode/src/cli/cmd/run.ts: the run loop breaks
	// on `session.status … idle` for `sessionID`, then `await session.prompt(...)`
	// returns and the process tears down — verified against opencode 1.16.2, the
	// vendored ground-truth source under .references/opencode). The engine — and its
	// control poll loop — lives
	// INSIDE that ephemeral process. A `workflow` call returns the run_id immediately
	// and detaches the run, so if the model called `workflow` ALONE and replied, the
	// top-level turn would go idle at once, the process would exit, and the poll loop
	// would be gone BEFORE this harness could touch the sentinel — a guaranteed 30s
	// timeout, not a real assertion. So Scenario F keeps the turn (hence the process,
	// hence the poll loop) ALIVE across the cancel window the SAME way Scenario E does:
	// the model calls `workflow` THEN `workflow_status(wait_ms)`, which BLOCKS the
	// top-level turn until the run settles. While the parent blocks, this harness
	// captures the live runId and touches the sentinel; the live watcher cancels the
	// run; `workflow_status` unblocks (the run is now `cancelled`); the turn ends and
	// the process exits cleanly. The capture+touch therefore CANNOT await process
	// close — we spawn without blocking and race the touch against the still-open turn.
	//
	// Reuse Scenario B's `longrun` script — one slow agent.
	const longrunScript = [
		"export const meta = { name: 'longrun', description: 'one long agent' };",
		"const r = await agent('Count slowly from 1 to 50, one number per line.', { label: 'long' });",
		"return r;",
	]
		.join("\n")
		.replace(/'/g, "\\'");
	const prompt =
		"You have tools named workflow and workflow_status. They ARE available. " +
		"This is an explicit multi-agent orchestration request (opt-in satisfied). " +
		"In this single turn, do EXACTLY this and nothing else: " +
		`(1) call workflow with { "script": "${longrunScript}" }. ` +
		"(2) Take the run_id it returns and immediately call workflow_status with " +
		'that run_id and { "wait_ms": 90000 } so you BLOCK until the workflow settles. ' +
		"(3) Then reply with only the result text workflow_status returned. " +
		"Do NOT call workflow_stop. Do not refuse, do not poll in a loop — " +
		"workflow_status(wait_ms) already waits.";

	const controlDir = join(dataDir, "workflow-control");

	// One attempt: spawn the run WITHOUT awaiting process close (the turn must stay
	// open while we touch), capture the new `running` runId, touch its sentinel, then
	// await close. Returns the captured runId on success, or undefined if the model
	// refused (no new run appeared) so the caller can retry — mirroring
	// runUntilRunAppears' refusal resilience.
	async function attempt(): Promise<string | undefined> {
		const priorIds = new Set((await readRuns(dataDir)).map((r) => r.id));
		// Spawn but DO NOT await: the top-level turn is blocked in workflow_status,
		// keeping the engine (and its poll loop) alive while we capture + touch.
		const runPromise = runOpencode(prompt, dataDir);
		// Ensure a rejected spawn (timeout/spawn error) never becomes an unhandled
		// rejection while we race the capture below; the awaited `runPromise` at the
		// end still surfaces a real failure.
		runPromise.catch(() => {});

		// Capture the NEW run while it is still live: poll the store (bounded ~30s,
		// generous for first-token latency on a cold model) for a `running` record
		// whose id is not in the prior set. Capturing it `running` is what makes this
		// a LIVE-run cancel.
		const captured = await (async () => {
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				const fresh = (await readRuns(dataDir)).find(
					(r) => r.status === "running" && !priorIds.has(r.id),
				);
				if (fresh) {
					return fresh.id;
				}
				await sleep(500);
			}
			return undefined;
		})();

		if (captured === undefined) {
			// The turn may have finished without ever reaching `running` (model refusal,
			// or it cancelled itself). Settle the spawn and report no-capture so the
			// caller can retry on refusal.
			const run = await runPromise;
			if (run.code !== 0) {
				throw new Error(
					`Scenario F: run nonzero exit (${run.code})\nstderr:\n${trim(run.stderr)}`,
				);
			}
			log(
				"  no NEW run reached status 'running' — model likely refused; retrying …",
			);
			return undefined;
		}

		log(`  captured live run ${captured} (status running)`);

		// The literal external `touch`: this harness process — NOT the opencode server —
		// writes the sentinel into the control dir using node:fs/promises. mkdir is
		// recursive because the control dir is not created until something touches it.
		const sentinelName = `${captured}.cancel`;
		await mkdir(controlDir, { recursive: true });
		await writeFile(join(controlDir, sentinelName), "");
		log(`  external touch: ${join(controlDir, sentinelName)}`);

		// Now the turn can end: workflow_status unblocks once the watcher cancels the
		// run. Await the process close so the run is fully settled on disk before we
		// assert (and so a real spawn failure surfaces).
		const run = await runPromise;
		if (run.code !== 0) {
			throw new Error(
				`Scenario F: run nonzero exit (${run.code})\nstderr:\n${trim(run.stderr)}`,
			);
		}
		return captured;
	}

	let runId: string | undefined;
	for (let i = 1; i <= 3 && runId === undefined; i += 1) {
		log(`  attempt ${i}/3 …`);
		runId = await attempt();
	}
	if (runId === undefined) {
		throw new Error(
			"Scenario F: the model never launched a live workflow across 3 attempts " +
				"(no NEW run reached 'running'). Model-behavior issue, not a plugin fault.",
		);
	}
	const sentinelName = `${runId}.cancel`;

	// The engine's poll loop must have observed the sentinel and cancelled the live
	// run. By here the process has exited, so the record is already terminal on disk;
	// a generous deadline still covers the settle. Distinguish the two failure modes
	// so a future opencode `run` lifecycle change yields an ACTIONABLE message rather
	// than a bare timeout: a still-`running` (orphaned) record means the poll loop
	// never fired — the process exited before the touch landed (the lifecycle
	// invariant above broke); any other terminal status means the cancel path itself
	// misbehaved.
	let record: RunRecord;
	try {
		record = await waitForTerminal(
			dataDir,
			(r) => r.id === runId && r.status === "cancelled",
			30_000,
		);
	} catch (err) {
		const final = (await readRuns(dataDir)).find((r) => r.id === runId);
		const status = final?.status ?? "(record vanished)";
		if (status === "running") {
			throw new Error(
				`Scenario F: run ${runId} is still 'running' (orphaned) — the engine's ` +
					`poll loop never fired. The opencode 'run' process most likely exited ` +
					`before the external touch landed (the in-process server tore down at ` +
					`top-level idle). Verify the workflow_status(wait_ms) keep-alive held the ` +
					`turn open, and re-check the run.ts lifecycle invariant for the pinned ` +
					`opencode version. Underlying: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		throw new Error(
			`Scenario F: run ${runId} settled '${status}', not 'cancelled' — the external ` +
				`sentinel was seen but the cancel path produced the wrong terminal state. ` +
				`Underlying: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	log(`  run ${record.id} settled 'cancelled' via external sentinel`);

	// The sentinel must be CONSUMED (unlinked) by the watcher. The unlink happens in
	// the same tick as the cancel, but the file probe may race the record settle, so
	// poll briefly (~5s).
	const consumed = await (async () => {
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			let names: string[];
			try {
				names = await readdir(controlDir);
			} catch {
				// The control dir vanished entirely — sentinel is gone.
				return true;
			}
			if (!names.includes(sentinelName)) {
				return true;
			}
			await sleep(250);
		}
		return false;
	})();
	if (!consumed) {
		throw new Error(
			`Scenario F: the engine cancelled the run but did NOT consume the sentinel ` +
				`'${sentinelName}' within 5s — a stale sentinel would re-fire on the next poll.`,
		);
	}
	log(
		`Scenario F PASS: external touch of ${sentinelName} cancelled live run ${runId} ` +
			`end-to-end and the watcher consumed the sentinel`,
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
		await scenarioC(dataDir, a);
		const afterC = (await readRuns(dataDir)).length;
		await scenarioD(dataDir, afterC);
		const afterD = (await readRuns(dataDir)).length;
		await scenarioE(dataDir, afterD);
		// Scenario F captures its NEW run by `running` status against a per-attempt id
		// snapshot (not a count threshold), so it needs no beforeCount plumbing.
		await scenarioF(dataDir);

		log("");
		log("================ PASS ================");
		log("A: review workflow (pipeline+parallel+phase+sub-workflow) ✓");
		log("B: workflow_stop → cancelled                              ✓");
		log("C: resume all-cached, no child relaunch (new process)     ✓");
		log("D: structured output → validated object returnValue       ✓");
		log("E: liveness veto over-block guard (long tool turn whole)  ✓");
		log("F: external touch → live run cancelled, sentinel consumed ✓");
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
