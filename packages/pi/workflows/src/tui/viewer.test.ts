import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { registerWorkflowsCommand, summaryLine } from "./command";
import type { AgentView, PhaseView, RunViewState } from "./reducer";
import {
	buildDetailLines,
	buildHeaderLine,
	buildTreeLines,
	joinPanes,
} from "./viewer";

/**
 * View-model tests for the `/workflows` viewer render layer (Task 8.3.3, pi port).
 *
 * The TUI PIXELS are not unit-testable (manual verification owns the visual); what
 * IS testable is the pure view-model the renderer consumes — the exported
 * string-in/string-out line-builders and the headless `summaryLine`. Every test
 * uses an IDENTITY theme (`fg`/`bold` pass text through unchanged) so assertions
 * read against the raw text content + structure (line counts, ordering, the `▸`
 * selection prefix, the divider, the four distinct fallbacks) WITHOUT fighting ANSI
 * color codes — color choice is a pixel concern, not a logic one. The width is held
 * wide so `truncateToWidth` never clips the assertion target.
 *
 * The viewer's selection/follow latch + run-switch live in private methods of the
 * `WorkflowsViewer` class, which builds its tailer against the real `node:fs` seam
 * with no injection point; driving them would be a timer-dependent on-disk
 * integration test, not a focused unit. That behavior is covered by the manual
 * render verification (see the task's VERIFY note), so it is intentionally not
 * exercised here — only the pure, deterministic view-model is.
 */

/** Identity theme: strip color/bold so tests assert on raw text, not ANSI. */
const identityTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const WIDE = 200;

/** Minimal {@link AgentView} with overridable fields. */
function agent(overrides: Partial<AgentView> = {}): AgentView {
	return { label: "agent", ...overrides };
}

/** Minimal {@link PhaseView}; agents default empty, marker defaults pending. */
function phase(name: string, agents: AgentView[], marker = "·"): PhaseView {
	const done = agents.filter((a) => a.status !== undefined).length;
	return { name, done, total: agents.length, marker, agents };
}

/** A {@link RunViewState} with sensible defaults for the running case. */
function view(overrides: Partial<RunViewState> = {}): RunViewState {
	return { status: "running", phases: [], ...overrides };
}

describe("buildHeaderLine", () => {
	test("renders identity, status, run position, and age segments", () => {
		const line = buildHeaderLine(
			identityTheme,
			view({ name: "demo-flow", status: "running", startedAt: 1000 }),
			"wf_1",
			0,
			3,
			181_000, // 180s after startedAt → "3m"
			WIDE,
		);
		expect(line).toContain("Workflows");
		expect(line).toContain("demo-flow");
		expect(line).toContain("running");
		expect(line).toContain("run 1/3");
		expect(line).toContain("3m");
	});

	test("falls back to runId when name is absent, and drops the run-position segment for a single run", () => {
		const line = buildHeaderLine(
			identityTheme,
			view({ status: "completed" }),
			"wf_only",
			0,
			1,
			0,
			WIDE,
		);
		expect(line).toContain("wf_only");
		expect(line).not.toContain("run 1/1");
	});

	test("shows the no-active-run identity when both name and runId are absent", () => {
		const line = buildHeaderLine(
			identityTheme,
			view({ status: "completed" }),
			undefined,
			0,
			0,
			0,
			WIDE,
		);
		expect(line).toContain("no active run");
	});
});

describe("buildTreeLines", () => {
	test("interleaves phase headers and indented agent rows, mapping each agent to its flat index", () => {
		const lines = buildTreeLines(
			identityTheme,
			view({
				phases: [
					phase("plan", [agent({ label: "research" })]),
					phase("build", [
						agent({ label: "impl" }),
						agent({ label: "review" }),
					]),
				],
			}),
			-1,
			true,
			true,
			WIDE,
		);
		// 2 phase headers + 3 agent rows.
		expect(lines).toHaveLength(5);
		expect(lines[0]?.agentIndex).toBe(-1); // plan header
		expect(lines[0]?.text).toContain("plan");
		expect(lines[1]?.agentIndex).toBe(0); // research
		expect(lines[1]?.text).toContain("research");
		expect(lines[2]?.agentIndex).toBe(-1); // build header
		expect(lines[3]?.agentIndex).toBe(1); // impl
		expect(lines[4]?.agentIndex).toBe(2); // review
		expect(lines[4]?.text).toContain("review");
	});

	test("marks the followed agent with a leading ▸ and leaves the others un-pointed", () => {
		const lines = buildTreeLines(
			identityTheme,
			view({
				phases: [
					phase("build", [
						agent({ label: "impl" }),
						agent({ label: "review" }),
					]),
				],
			}),
			1, // follow the second agent (flat index 1 = "review")
			true,
			true,
			WIDE,
		);
		const impl = lines.find((l) => l.agentIndex === 0);
		const review = lines.find((l) => l.agentIndex === 1);
		expect(review?.text).toContain("▸ ");
		expect(impl?.text).not.toContain("▸ ");
	});

	test("phase header carries the done/total count once any agent has settled", () => {
		const lines = buildTreeLines(
			identityTheme,
			view({
				phases: [
					phase("build", [
						agent({ label: "impl", status: "completed" }),
						agent({ label: "review" }),
					]),
				],
			}),
			-1,
			true,
			true,
			WIDE,
		);
		expect(lines[0]?.text).toContain("1/2");
	});

	test("fallback: no runs at all", () => {
		const lines = buildTreeLines(
			identityTheme,
			view({ status: "completed" }),
			-1,
			false, // hasRuns
			false, // hasRun
			WIDE,
		);
		expect(lines).toHaveLength(1);
		expect(lines[0]?.text).toContain("No workflow runs yet");
	});

	test("fallback: a run errored before reporting any agents", () => {
		const lines = buildTreeLines(
			identityTheme,
			view({ status: "error" }),
			-1,
			true, // hasRuns
			true, // hasRun
			WIDE,
		);
		expect(lines[0]?.text).toContain("Run failed before reporting any agents");
	});

	test("fallback: runs exist but none is selected", () => {
		const lines = buildTreeLines(
			identityTheme,
			view({ status: "running" }),
			-1,
			true, // hasRuns
			false, // hasRun
			WIDE,
		);
		expect(lines[0]?.text).toContain("(no run selected)");
	});

	test("fallback: a run is selected but its first event has not arrived", () => {
		const lines = buildTreeLines(
			identityTheme,
			view({ status: "running" }),
			-1,
			true, // hasRuns
			true, // hasRun
			WIDE,
		);
		expect(lines[0]?.text).toContain("waiting for the first event");
	});
});

describe("buildDetailLines", () => {
	test("renders (no agent selected) when nothing is selected", () => {
		const lines = buildDetailLines(identityTheme, undefined, WIDE);
		expect(lines.some((l) => l.includes("(no agent selected)"))).toBe(true);
	});

	test("a running agent leads with the live running status, before any conclusion", () => {
		const lines = buildDetailLines(
			identityTheme,
			agent({
				label: "impl",
				status: undefined, // running
				model: "anthropic/claude-opus-4-8",
				tokens: 1234,
				toolCalls: 3,
				lastTools: ["read(a.ts)", "edit(b.ts)"],
				prompt: "implement the thing",
			}),
			WIDE,
		);
		const text = lines.join("\n");
		expect(text).toContain("running");
		expect(text).toContain("stats");
		expect(text).toContain("3 tools");
		expect(text).toContain("tools");
		expect(text).toContain("prompt");
		// A running agent has no conclusion section.
		expect(text).not.toContain("conclusion");
	});

	test("a settled, completed agent surfaces its conclusion and status", () => {
		const lines = buildDetailLines(
			identityTheme,
			agent({
				label: "impl",
				status: "completed",
				tokens: 500,
				durationMs: 4200,
				result: "all green",
			}),
			WIDE,
		);
		const text = lines.join("\n");
		expect(text).toContain("status: ");
		expect(text).toContain("completed");
		expect(text).toContain("conclusion");
		expect(text).toContain("all green");
	});

	test("a failed agent surfaces its note as an error section", () => {
		const lines = buildDetailLines(
			identityTheme,
			agent({
				label: "impl",
				status: "failed",
				note: "ran out of budget",
			}),
			WIDE,
		);
		const text = lines.join("\n");
		expect(text).toContain("failed");
		expect(text).toContain("ran out of budget");
		// failed → the note section is labelled "error", not "note".
		expect(text).toContain("── error");
		expect(text).not.toContain("── note");
	});

	test("omits the model/session/stats sections when their fields are absent", () => {
		const lines = buildDetailLines(
			identityTheme,
			agent({ label: "bare", status: "completed" }),
			WIDE,
		);
		const text = lines.join("\n");
		expect(text).not.toContain("model:");
		expect(text).not.toContain("session:");
		expect(text).not.toContain("stats");
	});
});

describe("joinPanes", () => {
	test("joins each row with a divider and pads to the requested height", () => {
		const out = joinPanes(
			identityTheme,
			["left-a", "left-b"],
			["right-a"],
			10, // treeWidth
			10, // detailWidth
			4, // height — more than either pane has
		);
		expect(out).toHaveLength(4);
		// Every joined line carries the divider.
		for (const line of out) {
			expect(line).toContain("│");
		}
		// First row holds both panes' content.
		expect(out[0]).toContain("left-a");
		expect(out[0]).toContain("right-a");
		// Padding rows beyond the content are still emitted with the divider.
		expect(out[3]).toContain("│");
	});
});

describe("summaryLine (headless fallback)", () => {
	test("aggregates done/total across phases and reports status + age", () => {
		const line = summaryLine(
			view({
				name: "demo",
				status: "running",
				startedAt: 1000,
				phases: [
					phase("plan", [agent({ status: "completed" })]),
					phase("build", [
						agent({ status: "completed" }),
						agent(), // running
					]),
				],
			}),
			"wf_1",
			181_000, // 3m after start
		);
		expect(line).toContain("demo");
		expect(line).toContain("running");
		expect(line).toContain("2/3 agents");
		expect(line).toContain("3m");
	});

	test("falls back to runId when the run has no name, and includes duration once settled", () => {
		const line = summaryLine(
			view({
				status: "completed",
				startedAt: 1000,
				endedAt: 5000,
				phases: [phase("only", [agent({ status: "completed" })])],
			}),
			"wf_anon",
			6000,
		);
		expect(line).toContain("wf_anon");
		expect(line).toContain("completed");
		expect(line).toContain("1/1 agents");
		// startedAt + endedAt present → a duration segment appears.
		expect(line).toContain("4s");
	});

	test("a run with no startedAt omits both age and duration segments", () => {
		const line = summaryLine(
			view({ status: "running", phases: [] }),
			"wf_empty",
			9999,
		);
		expect(line).toBe("wf_empty: running · 0/0 agents");
	});
});

describe("registerWorkflowsCommand", () => {
	test("registers the /workflows command at load", () => {
		const registered: Array<{ name: string; description?: string }> = [];
		const pi = {
			registerCommand: (name: string, def: { description?: string }) => {
				registered.push({ name, description: def.description });
			},
		} as unknown as ExtensionAPI;

		registerWorkflowsCommand(pi, {
			feedDir: "/tmp/wf-feed",
			controlDir: "/tmp/wf-control",
		});

		const names = registered.map((c) => c.name);
		expect(names).toContain("workflows");
		const cmd = registered.find((c) => c.name === "workflows");
		expect(cmd?.description).toBeDefined();
	});
});
