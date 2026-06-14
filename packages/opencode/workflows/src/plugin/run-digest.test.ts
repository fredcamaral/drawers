import { describe, expect, test } from "bun:test";
import type { RunRecord } from "./engine";
import { renderRunDigest } from "./run-digest";

const tokens = (input: number, output = 0) => ({
	input,
	output,
	reasoning: 0,
	cacheRead: 0,
	cacheWrite: 0,
});

function record(over: Partial<RunRecord> = {}): RunRecord {
	return {
		id: "wf_abc",
		parentSessionID: "ses_p",
		status: "completed",
		description: "demo",
		createdAt: 1000,
		completedAt: 1000 + 428_000, // 7m 8s
		scriptPath: "/tmp/wf.js",
		...over,
	};
}

describe("renderRunDigest", () => {
	test("header carries status, duration, agent tally, and total tokens", () => {
		const digest = renderRunDigest(
			record({
				agents: [
					{
						label: "review",
						phase: "Review",
						status: "completed",
						tokens: tokens(400_000, 29_700),
						toolCalls: 7,
						durationMs: 41_000,
						result: '{"status":"completed"}',
					},
					{ label: "cachedwork", phase: "Build", status: "cached" },
					{
						label: "boom",
						phase: "Build",
						status: "error",
						note: "null — verify_failed (git/command post-condition failed)",
					},
				],
			}),
		);
		const header = digest.split("\n")[0];
		expect(header).toContain("Workflow wf_abc 'demo' completed in 7m 8s");
		// One completed + one cached + one failed.
		expect(header).toContain("3 agents (1 completed, 1 cached, 1 failed)");
		// Total tokens summed across agents that carried a snapshot (429.7k).
		expect(header).toContain("429.7k tok");
	});

	test("agents are grouped by phase with conclusion and note rows", () => {
		const digest = renderRunDigest(
			record({
				agents: [
					{
						label: "review",
						phase: "Review",
						status: "completed",
						tokens: tokens(400_000, 29_700),
						toolCalls: 7,
						durationMs: 41_000,
						result: "phase 4 is safe to start",
					},
					{
						label: "boom",
						phase: "Build",
						status: "error",
						note: "null — verify_failed",
					},
				],
			}),
		);
		expect(digest).toContain("Review:");
		expect(digest).toContain("✓ review  429.7k tok · 7 tools · 41s");
		expect(digest).toContain("→ phase 4 is safe to start");
		expect(digest).toContain("Build:");
		expect(digest).toContain("✗ boom");
		expect(digest).toContain("! null — verify_failed");
	});

	test("a cached agent shows a cached marker and its replayed conclusion", () => {
		const digest = renderRunDigest(
			record({
				agents: [
					{
						label: "cachedwork",
						phase: "P",
						status: "cached",
						result: "replayed conclusion",
					},
				],
			}),
		);
		expect(digest).toContain("✓ cachedwork  cached");
		expect(digest).toContain("→ replayed conclusion");
	});

	test("a long conclusion is collapsed to one line and truncated", () => {
		const long = `${"x ".repeat(400)}END`;
		const digest = renderRunDigest(
			record({
				agents: [
					{ label: "verbose", phase: "P", status: "completed", result: long },
				],
			}),
		);
		const line = digest.split("\n").find((l) => l.includes("→"));
		expect(line).toBeDefined();
		// Truncated well under the raw length, ends with an ellipsis, no inner newlines.
		expect(line?.length).toBeLessThan(420);
		expect(line?.endsWith("…")).toBe(true);
		expect(line).not.toContain("END");
	});

	test("a run with no agents renders the header and the retrieval pointer only", () => {
		const digest = renderRunDigest(record({ agents: [] }));
		expect(digest).toContain(
			"Workflow wf_abc 'demo' completed in 7m 8s — no agents",
		);
		expect(digest).toContain("Inspect with workflow_status run_id=wf_abc.");
		// No phase blocks.
		expect(digest).not.toContain("→");
	});

	test("the retrieval pointer is always appended", () => {
		const digest = renderRunDigest(
			record({
				agents: [
					{ label: "x", phase: "P", status: "completed", result: "done" },
				],
			}),
		);
		expect(
			digest.trimEnd().endsWith("Inspect with workflow_status run_id=wf_abc."),
		).toBe(true);
	});

	test("a stale on-disk record (missing description, bad timestamps) renders defensively", () => {
		// The persistence layer validates only id/parentSessionID/status — a stale
		// record may lack the rest. The header must never print 'undefined' or NaN.
		const stale = {
			id: "wf_stale",
			parentSessionID: "ses_p",
			status: "completed",
		} as unknown as RunRecord;
		const digest = renderRunDigest(stale);
		const header = digest.split("\n")[0] ?? "";
		expect(header).toContain("Workflow wf_stale '(unknown)' completed");
		expect(header).not.toContain("undefined");
		expect(header).not.toContain("NaN");
		expect(digest).toContain("Inspect with workflow_status run_id=wf_stale.");
	});

	test("a non-finite createdAt suppresses the duration segment", () => {
		const digest = renderRunDigest(
			record({ createdAt: Number.NaN, completedAt: 5000 }),
		);
		const header = digest.split("\n")[0] ?? "";
		expect(header).toContain("Workflow wf_abc 'demo' completed —");
		expect(header).not.toContain(" in ");
		expect(header).not.toContain("NaN");
	});

	test("an error run still renders its agents (post-mortem)", () => {
		const digest = renderRunDigest(
			record({
				status: "error",
				agents: [
					{ label: "x", phase: "P", status: "error", note: "await_failed" },
				],
			}),
		);
		expect(digest.split("\n")[0]).toContain("'demo' error in");
		expect(digest).toContain("✗ x");
		expect(digest).toContain("! await_failed");
	});
});
