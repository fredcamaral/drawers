/**
 * Integration tests for the engine wiring — `createEngine` assembling the real
 * core collaborators (store + queue + runner) around a FAKE RpcClientFactory and
 * a canned transcript reader, against a real temp dataDir.
 *
 * These exercise the seam the four tools sit on END TO END: launch → await →
 * readOutput, cancel one/all, list states, the parent-child depth graph, restart
 * recovery, and the onNotify completion hook (the wake input). They use synthetic
 * pi children (no `pi --mode rpc` process) so the run is deterministic.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionTranscriptReader, TaskNotice } from "@drawers/pi-core";
import { createEngine, type Engine } from "./engine";
import {
	assistantMsg,
	endError,
	endOk,
	FakeFactory,
	flush,
} from "./test-fakes";

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "bg-agents-engine-"));
});
afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true });
});

interface Harness {
	engine: Engine;
	factory: FakeFactory;
	notices: TaskNotice[];
}

async function makeHarness(
	opts: {
		reader?: SessionTranscriptReader;
		configureFake?: (
			fake: import("./test-fakes").FakeRpcClient,
			n: number,
		) => void;
	} = {},
): Promise<Harness> {
	const factory = new FakeFactory();
	if (opts.configureFake) factory.configure = opts.configureFake;
	const notices: TaskNotice[] = [];
	const reader: SessionTranscriptReader = opts.reader ?? (async () => []);
	const engine = await createEngine({
		rpcFactory: factory,
		transcriptReader: reader,
		sessionDir: join(dataDir, "sessions"),
		dataDir,
		onNotify: (n) => notices.push(n),
	});
	return { engine, factory, notices };
}

function launchReq(over: Record<string, unknown> = {}) {
	return {
		parentSessionID: "parent_1",
		description: "do a thing",
		prompt: "go do it",
		agent: "build",
		model: "anthropic/opus",
		depth: 0,
		...over,
	} as import("@drawers/pi-core").LaunchRequest;
}

describe("engine — launch → await → output", () => {
	test("launch starts a child, completion resolves awaitCompletion, output reads from disk", async () => {
		const reader: SessionTranscriptReader = async () => [
			assistantMsg("stop", "disk answer"),
		];
		const { engine, factory } = await makeHarness({ reader });
		try {
			const task = await engine.runner.launch(launchReq());
			expect(task.status).toBe("running");
			expect(factory.last().log.startCount).toBe(1);
			expect(factory.last().log.prompts).toEqual(["go do it"]);

			factory.last().emit(endOk("final"));
			const done = await engine.runner.awaitCompletion(task.id);
			expect(done.status).toBe("completed");

			const out = await engine.runner.readOutput(task.id, { full: true });
			expect(out.status).toBe("completed");
			expect(out.summaryText).toBe("disk answer");
		} finally {
			await engine.dispose();
		}
	});

	test("fork contextParts are flattened ahead of the prompt by the runner", async () => {
		const { engine, factory } = await makeHarness();
		try {
			await engine.runner.launch(
				launchReq({
					contextParts: [{ type: "text", text: "FORK_CTX", synthetic: true }],
				}),
			);
			expect(factory.last().log.prompts[0]).toBe("FORK_CTX\n\ngo do it");
		} finally {
			await engine.dispose();
		}
	});
});

describe("engine — cancel", () => {
	test("cancel one: aborts + stops the child, terminal cancelled", async () => {
		const { engine, factory } = await makeHarness();
		try {
			const task = await engine.runner.launch(launchReq());
			const done = await engine.runner.cancel(task.id);
			expect(done.status).toBe("cancelled");
			expect(factory.last().log.abortCount).toBe(1);
			expect(factory.last().log.stopCount).toBe(1);
		} finally {
			await engine.dispose();
		}
	});

	test("cancel filters: only non-terminal tasks of the parent are listed", async () => {
		const { engine, factory } = await makeHarness();
		try {
			const a = await engine.runner.launch(launchReq());
			const b = await engine.runner.launch(launchReq());
			// complete a → terminal; b stays running.
			factory.created[0]?.emit(endOk());
			await engine.runner.awaitCompletion(a.id);

			const live = engine.runner
				.list("parent_1")
				.filter((t) => t.status !== "completed" && t.status !== "cancelled");
			expect(live.map((t) => t.id)).toEqual([b.id]);

			await engine.runner.cancel(b.id);
			expect(
				engine.runner.list("parent_1").every((t) => t.status !== "running"),
			).toBe(true);
		} finally {
			await engine.dispose();
		}
	});
});

describe("engine — list states", () => {
	test("reflects running / completed / cancelled, filterable by parent", async () => {
		const { engine, factory } = await makeHarness();
		try {
			const a = await engine.runner.launch(
				launchReq({ parentSessionID: "p1" }),
			);
			const b = await engine.runner.launch(
				launchReq({ parentSessionID: "p1" }),
			);
			const c = await engine.runner.launch(
				launchReq({ parentSessionID: "p2" }),
			);

			factory.created[0]?.emit(endOk());
			await engine.runner.awaitCompletion(a.id);
			await engine.runner.cancel(b.id);

			const p1 = engine.runner.list("p1");
			expect(p1.find((t) => t.id === a.id)?.status).toBe("completed");
			expect(p1.find((t) => t.id === b.id)?.status).toBe("cancelled");
			expect(engine.runner.list("p2").map((t) => t.id)).toEqual([c.id]);
		} finally {
			await engine.dispose();
		}
	});
});

describe("engine — depth / parent-child graph", () => {
	test("default launch disables bg_* tools in the child (spawn guard)", async () => {
		const { engine } = await makeHarness();
		try {
			const task = await engine.runner.launch(launchReq({ depth: 0 }));
			expect(task.tools?.bg_task).toBe(false);
			expect(task.tools?.bg_output).toBe(false);
			expect(task.depth).toBe(0);
		} finally {
			await engine.dispose();
		}
	});

	test("a launch at the max depth is rejected, no child created", async () => {
		const { engine, factory } = await makeHarness();
		try {
			await expect(
				engine.runner.launch(launchReq({ depth: 2 })),
			).rejects.toThrow(/depth/i);
			expect(factory.created.length).toBe(0);
		} finally {
			await engine.dispose();
		}
	});
});

describe("engine — wake on completion (onNotify hook)", () => {
	test("a completed task pushes exactly one terminal notice naming bg_output", async () => {
		const { engine, factory, notices } = await makeHarness();
		try {
			const task = await engine.runner.launch(launchReq());
			factory.last().emit(endOk());
			await engine.runner.awaitCompletion(task.id);
			await flush();

			expect(notices).toHaveLength(1);
			expect(notices[0]?.taskId).toBe(task.id);
			expect(notices[0]?.status).toBe("completed");
			expect(notices[0]?.parentSessionID).toBe("parent_1");
			expect(notices[0]?.hint).toContain("bg_output");
		} finally {
			await engine.dispose();
		}
	});

	test("an errored task notifies once with status error", async () => {
		const { engine, factory, notices } = await makeHarness();
		try {
			const task = await engine.runner.launch(launchReq());
			factory.last().emit(endError("model refused"));
			await engine.runner.awaitCompletion(task.id);
			await flush();
			expect(notices).toHaveLength(1);
			expect(notices[0]?.status).toBe("error");
		} finally {
			await engine.dispose();
		}
	});

	test("markNotified persists notified=true via the store", async () => {
		const { engine, factory, notices } = await makeHarness();
		try {
			const task = await engine.runner.launch(launchReq());
			factory.last().emit(endOk());
			await engine.runner.awaitCompletion(task.id);
			await flush();
			expect(notices).toHaveLength(1);

			// Draining the queue fires markNotified → store.save(notified:true).
			engine.queue.flushFor("parent_1");
			await engine.store.dispose();

			const reloaded = await engine.store.load();
			expect(reloaded.find((t) => t.id === task.id)?.notified).toBe(true);
		} finally {
			// store already disposed; runner dispose is still safe/idempotent.
			await engine.runner.dispose();
		}
	});
});

describe("engine — restart recovery", () => {
	test("persisted terminal task is recovered into list and seeds the queue", async () => {
		// First engine: launch + complete + persist, then dispose.
		const { engine, factory } = await makeHarness();
		const task = await engine.runner.launch(launchReq());
		factory.last().emit(endOk());
		await engine.runner.awaitCompletion(task.id);
		await flush();
		await engine.dispose();

		// Second engine over the SAME dataDir: recovers the terminal task.
		const reader: SessionTranscriptReader = async () => [
			assistantMsg("stop", "recovered answer"),
		];
		const factory2 = new FakeFactory();
		const notices2: TaskNotice[] = [];
		const engine2 = await createEngine({
			rpcFactory: factory2,
			transcriptReader: reader,
			sessionDir: join(dataDir, "sessions"),
			dataDir,
			onNotify: (n) => notices2.push(n),
		});
		try {
			const listed = engine2.runner.list();
			expect(listed.map((t) => t.id)).toEqual([task.id]);
			expect(listed[0]?.status).toBe("completed");
			// un-notified terminal → seeded into the queue silently (no onNotify).
			expect(engine2.queue.pending("parent_1").map((n) => n.taskId)).toEqual([
				task.id,
			]);
			expect(notices2).toHaveLength(0);
			// readable from disk via the reader.
			const out = await engine2.runner.readOutput(task.id);
			expect(out.summaryText).toBe("recovered answer");
		} finally {
			await engine2.dispose();
		}
	});
});
