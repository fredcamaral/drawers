import { describe, expect, test } from "bun:test";
import { computeShellKey } from "./keys";
import { createShellPrimitive, type RunShell } from "./shell-call";
import type {
	JournalEntry,
	ProgressEvent,
	SettledJournalEntry,
	ShellFn,
} from "./types";

/**
 * Unit tests for the `shell()` deterministic-command primitive.
 *
 * The factory is driven directly with a fake {@link RunShell} seam (no real Bun
 * shell), pinning the behaviour the factory owns: pass/fail derivation, the
 * never-throw-on-non-zero contract, the honest inert path (no seam / a thrown seam /
 * an unavailable result), the shared cap, the `shell:` journal boundary (cache hit /
 * key divergence / position independence / record), output capping, and progress.
 */

const AGENT_CAP = 1_000;

interface Boxes {
	counters: { agents: number };
	callIndex: { value: number };
	emitted: ProgressEvent[];
}

function makeBoxes(): Boxes {
	return { counters: { agents: 0 }, callIndex: { value: 0 }, emitted: [] };
}

interface FactoryOpts {
	boxes: Boxes;
	runShell?: RunShell;
	replay?: {
		entries: JournalEntry[];
		onRecord: (e: SettledJournalEntry) => void;
	};
}

function makeShell(opts: FactoryOpts): ShellFn {
	const { boxes } = opts;
	return createShellPrimitive({
		...(opts.runShell !== undefined ? { runShell: opts.runShell } : {}),
		counters: boxes.counters,
		callIndex: boxes.callIndex,
		emit: (e) => boxes.emitted.push(e),
		...(opts.replay !== undefined ? { replay: opts.replay } : {}),
	});
}

/** A seam that always returns the given exit code with fixed streams. */
function fixedSeam(exitCode: number, stdout = "out", stderr = "err"): RunShell {
	return async () => ({ exitCode, stdout, stderr, available: true });
}

describe("shell() — pass/fail derivation", () => {
	test("exit 0 → passed:true, available:true, streams captured", async () => {
		const boxes = makeBoxes();
		const shell = makeShell({ boxes, runShell: fixedSeam(0, "stdout!", "") });
		const r = await shell("make test");
		expect(r).toEqual({
			command: "make test",
			passed: true,
			exitCode: 0,
			stdout: "stdout!",
			stderr: "",
			available: true,
		});
	});

	test("non-zero exit → passed:false but NEVER throws (it is a value)", async () => {
		const boxes = makeBoxes();
		const shell = makeShell({ boxes, runShell: fixedSeam(1, "", "boom") });
		const r = await shell("make test");
		expect(r.passed).toBe(false);
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toBe("boom");
		expect(r.available).toBe(true);
	});

	test("expectExitCode override → a non-zero exit can be passed", async () => {
		const boxes = makeBoxes();
		const shell = makeShell({ boxes, runShell: fixedSeam(3) });
		const r = await shell("grep -q needle file", { expectExitCode: 3 });
		expect(r.passed).toBe(true);
	});
});

describe("shell() — honest inert paths (never a fabricated pass)", () => {
	test("no runShell seam → available:false, passed:false, NOT journaled", async () => {
		const boxes = makeBoxes();
		const recorded: SettledJournalEntry[] = [];
		const shell = makeShell({
			boxes,
			replay: { entries: [], onRecord: (e) => recorded.push(e) },
		});
		const r = await shell("make test");
		expect(r).toEqual({
			command: "make test",
			passed: false,
			exitCode: -1,
			stdout: "",
			stderr: "",
			available: false,
		});
		// Unavailable results are NEVER cached — a resume in a shell-capable engine re-runs.
		expect(recorded).toEqual([]);
		// A warn names the missing capability.
		expect(boxes.emitted.some((e) => e.type === "warn")).toBe(true);
	});

	test("a thrown seam degrades to an inert result (degrade, don't detonate)", async () => {
		const boxes = makeBoxes();
		const recorded: SettledJournalEntry[] = [];
		const shell = makeShell({
			boxes,
			runShell: async () => {
				throw new Error("spawn failed");
			},
			replay: { entries: [], onRecord: (e) => recorded.push(e) },
		});
		const r = await shell("make test");
		expect(r.available).toBe(false);
		expect(r.passed).toBe(false);
		expect(recorded).toEqual([]);
	});

	test("a seam result with available:false is inert and un-journaled", async () => {
		const boxes = makeBoxes();
		const recorded: SettledJournalEntry[] = [];
		const shell = makeShell({
			boxes,
			runShell: async () => ({
				exitCode: -1,
				stdout: "",
				stderr: "",
				available: false,
			}),
			replay: { entries: [], onRecord: (e) => recorded.push(e) },
		});
		const r = await shell("make test");
		expect(r.available).toBe(false);
		expect(recorded).toEqual([]);
	});
});

describe("shell() — shared lifetime cap", () => {
	test("a shell() call increments the shared counter (counts as one unit)", async () => {
		const boxes = makeBoxes();
		const shell = makeShell({ boxes, runShell: fixedSeam(0) });
		await shell("echo hi");
		expect(boxes.counters.agents).toBe(1);
	});

	test("at the cap, shell() throws AgentCapError without running the command", async () => {
		const boxes = makeBoxes();
		boxes.counters.agents = AGENT_CAP;
		let ran = false;
		const shell = makeShell({
			boxes,
			runShell: async () => {
				ran = true;
				return { exitCode: 0, stdout: "", stderr: "", available: true };
			},
		});
		await expect(shell("echo hi")).rejects.toThrow(/cap/i);
		expect(ran).toBe(false);
	});
});

describe("shell() — journal boundary (replay, spec §7)", () => {
	test("matching shell: key → command NEVER runs; cached result + 'cached' log + re-record", async () => {
		const boxes = makeBoxes();
		const key = computeShellKey("make test", { expectExitCode: 0 });
		const cachedResult = {
			command: "make test",
			passed: true,
			exitCode: 0,
			stdout: "cached out",
			stderr: "",
			available: true,
		};
		const recorded: SettledJournalEntry[] = [];
		let ran = false;
		const shell = makeShell({
			boxes,
			runShell: async () => {
				ran = true;
				return { exitCode: 1, stdout: "LIVE", stderr: "", available: true };
			},
			replay: {
				entries: [{ index: 0, key, status: "ok", result: cachedResult }],
				onRecord: (e) => recorded.push(e),
			},
		});
		const r = await shell("make test");
		expect(r).toEqual(cachedResult);
		expect(ran).toBe(false);
		expect(recorded).toEqual([
			{ index: 0, key, status: "ok", result: cachedResult },
		]);
		const logs = boxes.emitted.filter((e) => e.type === "log");
		expect(logs.some((e) => e.type === "log" && /cached/.test(e.message))).toBe(
			true,
		);
	});

	test("cwd is part of the key → same command, different cwd → runs live (no false hit)", async () => {
		const boxes = makeBoxes();
		// Journal carries the key for cwd 'a'; the call asks for cwd 'b' → miss → live.
		const journaledKey = computeShellKey("make test", {
			cwd: "a",
			expectExitCode: 0,
		});
		const recorded: SettledJournalEntry[] = [];
		const shell = makeShell({
			boxes,
			runShell: fixedSeam(0, "fresh"),
			replay: {
				entries: [
					{
						index: 0,
						key: journaledKey,
						status: "ok",
						result: { command: "make test", passed: true },
					},
				],
				onRecord: (e) => recorded.push(e),
			},
		});
		const r = await shell("make test", { cwd: "b" });
		expect(r.stdout).toBe("fresh");
		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.key).toBe(
			computeShellKey("make test", { cwd: "b", expectExitCode: 0 }),
		);
	});

	test("position independence: an unchanged shell still replays after a divergence before it", async () => {
		const boxes = makeBoxes();
		const matchKey = computeShellKey("make sweep", { expectExitCode: 0 });
		let liveRuns = 0;
		const shell = makeShell({
			boxes,
			runShell: async () => {
				liveRuns += 1;
				return { exitCode: 0, stdout: "LIVE", stderr: "", available: true };
			},
			replay: {
				entries: [
					{
						index: 0,
						key: computeShellKey("OLD command", { expectExitCode: 0 }),
						status: "ok",
						result: { stale: true },
					},
					{
						index: 1,
						key: matchKey,
						status: "ok",
						result: {
							command: "make sweep",
							passed: true,
							exitCode: 0,
							stdout: "CACHED",
							stderr: "",
							available: true,
						},
					},
				],
				onRecord: () => {},
			},
		});
		// First call: a new command, no matching key → runs live.
		const first = await shell("make conformance");
		expect(first.stdout).toBe("LIVE");
		// Second call: unchanged → its key still has a queued entry → cached.
		const second = await shell("make sweep");
		expect(second.stdout).toBe("CACHED");
		expect(liveRuns).toBe(1);
	});

	test("intent entries are filtered out of the replay queue (never replayed)", async () => {
		const boxes = makeBoxes();
		const key = computeShellKey("make test", { expectExitCode: 0 });
		const shell = makeShell({
			boxes,
			runShell: fixedSeam(0, "LIVE"),
			replay: {
				// Only an intent line for this key → no settled result → must run live.
				entries: [{ index: 0, key, status: "intent", label: "make test" }],
				onRecord: () => {},
			},
		});
		const r = await shell("make test");
		expect(r.stdout).toBe("LIVE");
	});

	test("live available result is journaled under the shell: key", async () => {
		const boxes = makeBoxes();
		const recorded: SettledJournalEntry[] = [];
		const shell = makeShell({
			boxes,
			runShell: fixedSeam(0, "done"),
			replay: { entries: [], onRecord: (e) => recorded.push(e) },
		});
		await shell("make build");
		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.key).toBe(
			computeShellKey("make build", { expectExitCode: 0 }),
		);
		expect(recorded[0]?.index).toBe(0);
	});
});

describe("shell() — output capping bounds the journal", () => {
	test("stdout/stderr over the cap are truncated with a marker", async () => {
		const boxes = makeBoxes();
		const huge = "x".repeat(150_000);
		const shell = makeShell({ boxes, runShell: fixedSeam(0, huge, huge) });
		const r = await shell("make test");
		expect(r.stdout.length).toBeLessThan(huge.length);
		expect(r.stdout.endsWith("…[capped]")).toBe(true);
		expect(r.stderr.endsWith("…[capped]")).toBe(true);
	});
});

describe("shell() — progress + cwd forwarding", () => {
	test("emits a running log then an exit log naming pass/fail", async () => {
		const boxes = makeBoxes();
		const shell = makeShell({ boxes, runShell: fixedSeam(2) });
		await shell("make test", { label: "the gate" });
		const logs = boxes.emitted
			.filter((e) => e.type === "log")
			.map((e) => (e.type === "log" ? e.message : ""));
		expect(logs.some((m) => /the gate.*running/.test(m))).toBe(true);
		expect(logs.some((m) => /the gate.*exit 2.*failed/.test(m))).toBe(true);
	});

	test("cwd is forwarded to the seam verbatim", async () => {
		const boxes = makeBoxes();
		let seenCwd: string | undefined = "unset";
		const shell = makeShell({
			boxes,
			runShell: async (_cmd, o) => {
				seenCwd = o.cwd;
				return { exitCode: 0, stdout: "", stderr: "", available: true };
			},
		});
		await shell("ls", { cwd: "packages/core" });
		expect(seenCwd).toBe("packages/core");
	});
});
