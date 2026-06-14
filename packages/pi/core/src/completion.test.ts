/**
 * Unit tests for the CompletionFuser — the exactly-once terminal-transition core.
 *
 * The fuser is driven entirely through injected collaborators (no wall-clock
 * sleeps, no real child). A manual timer factory exposes pending timers so the
 * prompt watchdog and awaitCompletion timeout can be fired deterministically.
 */

import { describe, expect, test } from "bun:test";
import {
	type CompletionFuser,
	type CompletionFuserDeps,
	classifyAgentEnd,
	createCompletionFuser,
	type TimerHandle,
} from "./completion";
import type { PiAgentMessage, RpcAgentEvent } from "./rpc-client";
import type { BgTask, Clock } from "./types";

// --- test harness ----------------------------------------------------------

/** A manual timer registry: timers do not fire until explicitly flushed. */
function makeTimers() {
	let seq = 0;
	const pending = new Map<number, { cb: () => void; ms: number }>();
	const factory = (cb: () => void, ms: number): TimerHandle => {
		const id = ++seq;
		pending.set(id, { cb, ms });
		return {
			clear: () => {
				pending.delete(id);
			},
		};
	};
	return {
		factory,
		/** Number of armed (uncleared) timers. */
		count: () => pending.size,
		/** Fire every armed timer (clearing each first, so a re-arm inside is safe). */
		fireAll: () => {
			const entries = [...pending.entries()];
			pending.clear();
			for (const [, t] of entries) {
				t.cb();
			}
		},
		/** Fire the single armed timer; throws if not exactly one. */
		fireOnly: () => {
			const entries = [...pending.entries()];
			if (entries.length !== 1) {
				throw new Error(`expected exactly 1 timer, found ${entries.length}`);
			}
			pending.clear();
			entries[0]![1].cb();
		},
		msOfOnly: () => {
			const entries = [...pending.values()];
			if (entries.length !== 1) {
				throw new Error(`expected exactly 1 timer, found ${entries.length}`);
			}
			return entries[0]!.ms;
		},
	};
}

const clock: Clock = { now: () => 1000 };

interface HarnessOpts {
	promptWatchdogMs?: number;
}

/**
 * Build a fuser over a single in-memory task plus spies for every collaborator.
 * The task starts `running` unless overridden.
 */
function makeHarness(opts: HarnessOpts = {}) {
	const timers = makeTimers();
	const task: BgTask = {
		id: "bg_test001",
		parentSessionID: "parent",
		description: "d",
		agent: "build",
		status: "running",
		createdAt: 1,
		depth: 0,
		concurrencyKey: "anthropic/opus",
		sessionID: "bg_test001",
	};
	const calls = {
		freeSlot: 0,
		teardownChild: 0,
		persist: 0,
		onTaskComplete: 0,
	};
	let teardownChildResolve: (() => void) | undefined;
	let blockTeardown = false;

	const deps: CompletionFuserDeps = {
		getTask: (id) => (id === task.id ? task : undefined),
		freeSlot: () => {
			calls.freeSlot += 1;
		},
		teardownChild: async () => {
			calls.teardownChild += 1;
			if (blockTeardown) {
				await new Promise<void>((res) => {
					teardownChildResolve = res;
				});
			}
		},
		clock,
		persist: async () => {
			calls.persist += 1;
		},
		onTaskComplete: () => {
			calls.onTaskComplete += 1;
		},
		setTimer: timers.factory,
		promptWatchdogMs: opts.promptWatchdogMs,
	};
	const fuser = createCompletionFuser(deps);
	return {
		fuser,
		task,
		timers,
		calls,
		releaseTeardown: () => teardownChildResolve?.(),
		setBlockTeardown: (v: boolean) => {
			blockTeardown = v;
		},
	};
}

function agentEnd(
	messages: PiAgentMessage[],
	willRetry = false,
): RpcAgentEvent {
	return { type: "agent_end", messages, willRetry };
}

function assistant(
	stopReason: "stop" | "length" | "toolUse" | "error" | "aborted" | undefined,
	text = "done",
	errorMessage?: string,
): PiAgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason,
		errorMessage,
	};
}

// --- classifyAgentEnd ------------------------------------------------------

describe("classifyAgentEnd", () => {
	test("stop / length / toolUse → completed", () => {
		for (const sr of ["stop", "length", "toolUse"] as const) {
			expect(classifyAgentEnd([assistant(sr)]).terminal).toBe("completed");
		}
	});

	test("error → error with errorMessage as reason", () => {
		const c = classifyAgentEnd([assistant("error", "x", "boom")]);
		expect(c.terminal).toBe("error");
		expect(c.reason).toBe("boom");
	});

	test("error with no errorMessage → error, reason undefined (fuser applies the default)", () => {
		const c = classifyAgentEnd([assistant("error", "x")]);
		expect(c.terminal).toBe("error");
		expect(c.reason).toBeUndefined();
	});

	test("aborted → cancelled", () => {
		expect(classifyAgentEnd([assistant("aborted")]).terminal).toBe("cancelled");
	});

	test("no assistant / unknown stopReason / non-array → completed (benign terminus)", () => {
		expect(classifyAgentEnd([]).terminal).toBe("completed");
		expect(classifyAgentEnd(undefined).terminal).toBe("completed");
		expect(classifyAgentEnd([assistant(undefined)]).terminal).toBe("completed");
		expect(classifyAgentEnd([{ role: "user", content: "hi" }]).terminal).toBe(
			"completed",
		);
	});

	test("uses the LAST assistant message", () => {
		const c = classifyAgentEnd([
			assistant("stop"),
			{ role: "user", content: "more" },
			assistant("error", "x", "second"),
		]);
		expect(c.terminal).toBe("error");
		expect(c.reason).toBe("second");
	});
});

// --- terminal agent_end ----------------------------------------------------

describe("CompletionFuser — terminal agent_end", () => {
	test("willRetry:false stop → completed; awaitCompletion resolves after teardown", async () => {
		const h = makeHarness();
		h.fuser.onEvent(h.task.id, agentEnd([assistant("stop")]));
		expect(h.task.status).toBe("completed");
		const t = await h.fuser.awaitCompletion(h.task.id);
		expect(t.status).toBe("completed");
		// teardown ran in order: slot freed, child torn down, persisted, hook fired.
		expect(h.calls.freeSlot).toBe(1);
		expect(h.calls.teardownChild).toBe(1);
		expect(h.calls.persist).toBe(1);
		expect(h.calls.onTaskComplete).toBe(1);
		expect(h.task.completedAt).toBe(1000);
	});

	test("willRetry:false error → error with reason; cancelled stopReason → cancelled", async () => {
		const e = makeHarness();
		e.fuser.onEvent(e.task.id, agentEnd([assistant("error", "x", "kaboom")]));
		expect(e.task.status).toBe("error");
		// status flips synchronously; the error text is stamped in detached teardown,
		// observable once awaitCompletion joins it.
		await e.fuser.awaitCompletion(e.task.id);
		expect(e.task.error).toBe("kaboom");

		const c = makeHarness();
		c.fuser.onEvent(c.task.id, agentEnd([assistant("aborted")]));
		expect(c.task.status).toBe("cancelled");
	});
});

// --- non-terminal events ---------------------------------------------------

describe("CompletionFuser — non-terminal events do NOT complete", () => {
	test("willRetry:true agent_end is ignored; the following willRetry:false completes", async () => {
		const h = makeHarness();
		h.fuser.onEvent(
			h.task.id,
			agentEnd([assistant("error", "x", "transient")], true),
		);
		expect(h.task.status).toBe("running");
		expect(h.calls.freeSlot).toBe(0);
		// the retry succeeds → terminal
		h.fuser.onEvent(h.task.id, agentEnd([assistant("stop")], false));
		expect(h.task.status).toBe("completed");
		await h.fuser.awaitCompletion(h.task.id);
		expect(h.calls.teardownChild).toBe(1);
	});

	test("auto_retry_start / auto_retry_end / turn_* / message_* are ignored", () => {
		const h = makeHarness();
		const events: RpcAgentEvent[] = [
			{
				type: "auto_retry_start",
				attempt: 1,
				maxAttempts: 3,
				delayMs: 10,
				errorMessage: "e",
			},
			{ type: "auto_retry_end", success: true, attempt: 1 },
			{ type: "turn_start" } as RpcAgentEvent,
			{ type: "message_update" } as RpcAgentEvent,
		];
		for (const e of events) {
			h.fuser.onEvent(h.task.id, e);
		}
		expect(h.task.status).toBe("running");
		expect(h.calls.freeSlot).toBe(0);
	});

	test("extension_error records a pending reason but does NOT complete; surfaces on an error agent_end with no message", async () => {
		const h = makeHarness();
		h.fuser.onEvent(h.task.id, {
			type: "extension_error",
			extensionPath: "/ext/foo.ts",
			event: "before_agent_start",
			error: "bad config",
		});
		expect(h.task.status).toBe("running");
		// terminal error agent_end carrying NO errorMessage → falls back to ext error
		h.fuser.onEvent(
			h.task.id,
			agentEnd([{ role: "assistant", content: [], stopReason: "error" }]),
		);
		expect(h.task.status).toBe("error");
		await h.fuser.awaitCompletion(h.task.id);
		expect(h.task.error).toContain("bad config");
		expect(h.task.error).toContain("/ext/foo.ts");
	});
});

// --- process exit ----------------------------------------------------------

describe("CompletionFuser — onExit", () => {
	test("exit while still running → error", async () => {
		const h = makeHarness();
		h.fuser.onExit(h.task.id, { code: 1 });
		expect(h.task.status).toBe("error");
		await h.fuser.awaitCompletion(h.task.id);
		expect(h.task.error).toContain("code=1");
	});

	test("error exit → error carrying the message", async () => {
		const h = makeHarness();
		h.fuser.onExit(h.task.id, { code: null, error: new Error("spawn died") });
		expect(h.task.status).toBe("error");
		await h.fuser.awaitCompletion(h.task.id);
		expect(h.task.error).toContain("spawn died");
	});

	test("exit AFTER a terminal flip is a no-op (the normal stop() teardown)", async () => {
		const h = makeHarness();
		h.fuser.onEvent(h.task.id, agentEnd([assistant("stop")]));
		await h.fuser.awaitCompletion(h.task.id);
		const beforeFree = h.calls.freeSlot;
		h.fuser.onExit(h.task.id, { code: 0 }); // clean stop() exit
		expect(h.task.status).toBe("completed");
		expect(h.calls.freeSlot).toBe(beforeFree); // no second teardown
	});

	test("double-signal: agent_end then exit completes exactly once", async () => {
		const h = makeHarness();
		h.fuser.onEvent(h.task.id, agentEnd([assistant("stop")]));
		h.fuser.onExit(h.task.id, { code: null, error: new Error("late crash") });
		await h.fuser.awaitCompletion(h.task.id);
		expect(h.task.status).toBe("completed");
		expect(h.calls.freeSlot).toBe(1);
		expect(h.calls.teardownChild).toBe(1);
		expect(h.calls.onTaskComplete).toBe(1);
	});
});

// --- the mutex -------------------------------------------------------------

describe("CompletionFuser — exactly-once mutex", () => {
	test("first tryComplete wins; subsequent flips are denied no-ops", () => {
		const h = makeHarness();
		expect(h.fuser.tryComplete(h.task.id, "completed")).toBe(true);
		expect(h.fuser.tryComplete(h.task.id, "error", "x")).toBe(false);
		expect(h.fuser.tryComplete(h.task.id, "cancelled")).toBe(false);
		expect(h.task.status).toBe("completed");
	});

	test("tryComplete on an unknown task returns false", () => {
		const h = makeHarness();
		expect(h.fuser.tryComplete("nope", "completed")).toBe(false);
	});

	test("awaitCompletion on an already-terminal task joins in-flight teardown", async () => {
		const h = makeHarness();
		h.setBlockTeardown(true);
		h.fuser.onEvent(h.task.id, agentEnd([assistant("stop")]));
		// teardown is blocked: persist/hook not run yet.
		expect(h.calls.persist).toBe(0);
		let resolved = false;
		const p = h.fuser.awaitCompletion(h.task.id).then((t) => {
			resolved = true;
			return t;
		});
		await Promise.resolve();
		expect(resolved).toBe(false); // joined the blocked teardown
		h.releaseTeardown();
		const t = await p;
		expect(t.status).toBe("completed");
		expect(h.calls.persist).toBe(1);
		expect(h.calls.onTaskComplete).toBe(1);
	});
});

// --- awaitCompletion timeout -----------------------------------------------

describe("CompletionFuser — awaitCompletion timeout", () => {
	test("timeout rejects without completing the task", async () => {
		const h = makeHarness();
		const p = h.fuser.awaitCompletion(h.task.id, 5000);
		expect(h.timers.count()).toBe(1);
		expect(h.timers.msOfOnly()).toBe(5000);
		h.timers.fireOnly();
		await expect(p).rejects.toThrow(/timeout/i);
		expect(h.task.status).toBe("running"); // NOT flipped
	});

	test("completion before timeout clears the timer and resolves", async () => {
		const h = makeHarness();
		const p = h.fuser.awaitCompletion(h.task.id, 5000);
		h.fuser.onEvent(h.task.id, agentEnd([assistant("stop")]));
		const t = await p;
		expect(t.status).toBe("completed");
		expect(h.timers.count()).toBe(0); // timer cleared on resolve
	});

	test("awaitCompletion on an unknown task rejects", async () => {
		const h = makeHarness();
		await expect(h.fuser.awaitCompletion("nope")).rejects.toThrow(
			/Unknown task/,
		);
	});
});

// --- the prompt watchdog (C1) ----------------------------------------------

describe("CompletionFuser — prompt watchdog (the C1 silent-preflight guard)", () => {
	test("armed watchdog fires → task flipped to error with a diagnosable reason", async () => {
		const h = makeHarness({ promptWatchdogMs: 90000 });
		h.fuser.armPromptWatchdog(h.task.id);
		expect(h.timers.count()).toBe(1);
		expect(h.timers.msOfOnly()).toBe(90000);
		h.timers.fireOnly();
		expect(h.task.status).toBe("error");
		const t = await h.fuser.awaitCompletion(h.task.id);
		expect(t.status).toBe("error");
		expect(h.task.error).toMatch(/no agent activity|preflight/i);
		expect(h.calls.freeSlot).toBe(1); // slot released via teardown
	});

	test("agent_start disarms the watchdog (a long real run is NOT misclassified)", () => {
		const h = makeHarness({ promptWatchdogMs: 90000 });
		h.fuser.armPromptWatchdog(h.task.id);
		expect(h.timers.count()).toBe(1);
		h.fuser.onEvent(h.task.id, { type: "agent_start" });
		expect(h.timers.count()).toBe(0); // disarmed
		expect(h.task.status).toBe("running"); // still running, NOT errored
	});

	test("terminal agent_end disarms the watchdog", () => {
		const h = makeHarness({ promptWatchdogMs: 90000 });
		h.fuser.armPromptWatchdog(h.task.id);
		h.fuser.onEvent(h.task.id, agentEnd([assistant("stop")]));
		expect(h.task.status).toBe("completed");
		expect(h.timers.count()).toBe(0);
	});

	test("re-arm replaces the prior timer (no leak across turns)", () => {
		const h = makeHarness({ promptWatchdogMs: 90000 });
		h.fuser.armPromptWatchdog(h.task.id);
		h.fuser.armPromptWatchdog(h.task.id);
		expect(h.timers.count()).toBe(1); // exactly one armed
	});

	test("watchdog disabled (ms unset) arms nothing", () => {
		const h = makeHarness(); // no promptWatchdogMs
		h.fuser.armPromptWatchdog(h.task.id);
		expect(h.timers.count()).toBe(0);
	});

	test("watchdog disabled (ms <= 0) arms nothing", () => {
		const h = makeHarness({ promptWatchdogMs: 0 });
		h.fuser.armPromptWatchdog(h.task.id);
		expect(h.timers.count()).toBe(0);
	});

	test("an agent_start for one turn does not suppress a re-armed watchdog on the next", () => {
		const h = makeHarness({ promptWatchdogMs: 90000 });
		h.fuser.armPromptWatchdog(h.task.id);
		h.fuser.onEvent(h.task.id, { type: "agent_start" });
		expect(h.timers.count()).toBe(0);
		// next turn re-arms; if it never starts, it must still fire
		h.fuser.armPromptWatchdog(h.task.id);
		expect(h.timers.count()).toBe(1);
		h.timers.fireOnly();
		expect(h.task.status).toBe("error");
	});
});

// --- resetForResume + dispose ----------------------------------------------

describe("CompletionFuser — resetForResume", () => {
	test("clears a stale extension-error so a fresh error terminus does not inherit it", async () => {
		const h = makeHarness();
		h.fuser.onEvent(h.task.id, {
			type: "extension_error",
			extensionPath: "/ext/foo.ts",
			event: "before_agent_start",
			error: "stale",
		});
		h.fuser.resetForResume(h.task);
		h.fuser.onEvent(
			h.task.id,
			agentEnd([{ role: "assistant", content: [], stopReason: "error" }]),
		);
		expect(h.task.status).toBe("error");
		await h.fuser.awaitCompletion(h.task.id);
		expect(h.task.error).not.toContain("stale");
		expect(h.task.error).toBe("agent error");
	});
});

describe("CompletionFuser — dispose", () => {
	test("dispose rejects pending waiters and clears armed watchdogs", async () => {
		const h = makeHarness({ promptWatchdogMs: 90000 });
		h.fuser.armPromptWatchdog(h.task.id);
		const p = h.fuser.awaitCompletion(h.task.id);
		expect(h.timers.count()).toBe(1); // watchdog only (await has no timeout)
		const disposed = h.fuser.dispose();
		await expect(p).rejects.toThrow(/disposed/i);
		await disposed;
		expect(h.timers.count()).toBe(0); // watchdog cleared
	});

	test("dispose drains in-flight teardown before rejecting waiters", async () => {
		const h = makeHarness();
		h.setBlockTeardown(true);
		h.fuser.onEvent(h.task.id, agentEnd([assistant("stop")]));
		const disposeP = h.fuser.dispose();
		let disposeSettled = false;
		void disposeP.then(() => {
			disposeSettled = true;
		});
		await Promise.resolve();
		expect(disposeSettled).toBe(false); // blocked on the teardown
		h.releaseTeardown();
		await disposeP;
		expect(h.calls.persist).toBe(1); // the persist was NOT lost
	});

	test("onEvent / onExit after dispose are no-ops", () => {
		const h = makeHarness();
		void h.fuser.dispose();
		h.fuser.onEvent(h.task.id, agentEnd([assistant("error", "x", "y")]));
		h.fuser.onExit(h.task.id, { code: 1 });
		expect(h.task.status).toBe("running"); // unchanged
	});
});
