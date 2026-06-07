/**
 * The `workflow(nameOrRef, args?)` global — run another workflow inline (spec §8).
 *
 * This factory owns the sub-workflow semantics; `runtime/index.ts` wires it with
 * a `runChild` closure that builds the actual child {@link createWorkflowRun}
 * sharing the parent's gate / counters / budget / registry / liveTasks / abort box.
 * Keeping the child-construction in index.ts (not here) avoids a circular import
 * and keeps THIS module free of the runner assembly.
 *
 * Behaviour (all per spec §8):
 *   - No `resolveSubWorkflow` → this is a CHILD run; `workflow()` throws
 *     {@link NestingError}. Depth 1 is enforced structurally — index.ts builds the
 *     child with `resolveSubWorkflow: undefined`.
 *   - Resolve the child SOURCE via the resolver; an unknown name / unreadable path
 *     surfaces as the resolver's rejection (a catchable script error).
 *   - SYNTHETIC JOURNAL BOUNDARY: one {@link computeWorkflowKey} over the resolved
 *     source + args consumes ONE callIndex slot, exactly like `agent()`. On a
 *     replay, the boundary key shifts its per-key occurrence queue (Task 7.3.1) —
 *     a hit resolves the journaled child result WITHOUT running the child at all;
 *     a miss/empty queue runs the child live, its result recorded under the new
 *     boundary key. Matching is position-independent, so editing one boundary does
 *     not void a later unchanged one (field finding R4).
 *   - Live child: completed → return its `returnValue`; error → THROW
 *     `Error(child.error)` (catchable, unlike `agent()`'s null).
 *   - The boundary counts against the SHARED lifetime cap (the child's own agents
 *     also count, since the child shares the counter).
 */

import { computeWorkflowKey } from "./keys";
import {
	AgentCapError,
	type JournalEntry,
	NestingError,
	type ProgressEmitter,
	type ProgressEvent,
	type WorkflowFn,
} from "./types";

/** Lifetime agent-count backstop per workflow (spec §5); mirrors agent-call.ts. */
const AGENT_LIFETIME_CAP = 1_000;

/** The terminal outcome of a child run, as the sub-workflow primitive consumes it. */
export interface ChildRunResult {
	status: "completed" | "error";
	returnValue?: unknown;
	error?: string;
}

/** Everything the `workflow()` primitive needs from the surrounding runtime. */
export interface SubWorkflowDeps {
	/**
	 * Resolve a name/ref to the child script SOURCE (the plugin supplies fs +
	 * saved-name resolution; the library stays fs-free). ABSENT marks a child run —
	 * `workflow()` then throws {@link NestingError} (depth-1 structural guard).
	 */
	resolveSubWorkflow?: (
		nameOrRef: string | { scriptPath: string },
	) => Promise<string>;
	/**
	 * Run the resolved child source to completion, sharing the parent's boxes. The
	 * `onProgress` it receives forwards the child's events upward (already
	 * label-prefixed by this factory). index.ts wires this to createWorkflowRun.
	 */
	runChild: (
		source: string,
		childArgs: unknown,
		onProgress?: ProgressEmitter,
	) => Promise<ChildRunResult>;
	/** Lifetime agent counter shared with the parent (the boundary counts as one). */
	counters: { agents: number };
	/** Run-level deterministic call ordinal (shared with agent(), the ordering anchor). */
	callIndex: { value: number };
	/** Parent progress sink (already fenced upstream). */
	emit: ProgressEmitter;
	/** The active progress phase, used for the boundary's own log line context. */
	currentPhase: () => string | undefined;
	/**
	 * Deterministic-resume seam (spec §7/§8). When present, a matching boundary key
	 * at this index replays the journaled child result; every live boundary records.
	 */
	replay?: { entries: JournalEntry[]; onRecord: (e: JournalEntry) => void };
}

/** A short display name for the child, from a name string or a `{ scriptPath }`. */
function childName(nameOrRef: string | { scriptPath: string }): string {
	if (typeof nameOrRef === "string") {
		return nameOrRef;
	}
	const p = nameOrRef.scriptPath;
	const slash = p.lastIndexOf("/");
	return slash === -1 ? p : p.slice(slash + 1);
}

/**
 * Build a progress forwarder that prefixes the child's name onto agent labels
 * (`<childName>/<label>`) so the parent's progress tree nests visibly. Non-agent
 * events (log/warn) pass through unchanged — they are already the child's voice.
 */
function prefixedEmitter(name: string, emit: ProgressEmitter): ProgressEmitter {
	return (e: ProgressEvent) => {
		if (e.type === "agent:start") {
			emit({ ...e, label: `${name}/${e.label}` });
		} else if (e.type === "agent:end") {
			emit({ ...e, label: `${name}/${e.label}` });
		} else {
			emit(e);
		}
	};
}

export function createSubWorkflowPrimitive(deps: SubWorkflowDeps): WorkflowFn {
	const { resolveSubWorkflow, runChild, counters, callIndex, emit, replay } =
		deps;

	// Task 7.3.1: per-key occurrence queues, identical to agent-call.ts. The
	// boundary's `workflow:`-prefixed keys share the SAME byKey namespace as agent
	// keys (the prefix keeps them collision-free), so resume replay is uniform and
	// position-independent — editing one boundary no longer voids later unchanged
	// ones (field finding R4). Entries queue in journal-file (completion) order;
	// for byte-identical boundaries the cached child results are interchangeable.
	const byKey = new Map<string, JournalEntry[]>();
	if (replay !== undefined) {
		for (const entry of replay.entries) {
			const queue = byKey.get(entry.key);
			if (queue === undefined) {
				byKey.set(entry.key, [entry]);
			} else {
				queue.push(entry);
			}
		}
	}

	return async function workflow(
		nameOrRef: string | { scriptPath: string },
		args?: unknown,
	): Promise<unknown> {
		// Depth-1 guard: a child run carries no resolver, so workflow() is unavailable.
		if (resolveSubWorkflow === undefined) {
			throw new NestingError();
		}

		const name = childName(nameOrRef);

		// 0. Claim this boundary's deterministic ordinal — one slot, like agent().
		const index = callIndex.value;
		callIndex.value += 1;

		// 1. Resolve the child SOURCE (resolver throws propagate — catchable, §8).
		const source = await resolveSubWorkflow(nameOrRef);
		const key = computeWorkflowKey(source, args);

		// 2. Replay (spec §7/§8, Task 7.3.1): shift this boundary's key queue. A hit
		// resolves the cached child result WITHOUT running the child — independent of
		// position, so an earlier edited boundary never voids this unchanged one
		// (field finding R4). A miss/empty queue runs the child live. The shared cap
		// still applies where the original hit it.
		const cached = byKey.get(key)?.shift();
		if (cached !== undefined) {
			if (counters.agents >= AGENT_LIFETIME_CAP) {
				throw new AgentCapError();
			}
			counters.agents += 1;
			emit({ type: "log", message: `workflow ${name}: cached` });
			// Re-record into the NEW journal (current index) so a resumed run is
			// self-contained and densely ordered.
			replay?.onRecord({ index, key, status: "ok", result: cached.result });
			return cached.result;
		}

		// 3. Shared lifetime cap — count the boundary BEFORE running the child.
		if (counters.agents >= AGENT_LIFETIME_CAP) {
			throw new AgentCapError();
		}
		counters.agents += 1;

		// 4. Run the child live, forwarding its progress with prefixed labels.
		const result = await runChild(source, args, prefixedEmitter(name, emit));

		if (result.status === "error") {
			// Spec §8: child errors THROW out of workflow() (catchable), unlike agent().
			throw new Error(result.error ?? `workflow ${name} failed`);
		}

		// Completed: record the boundary, return the child's value.
		replay?.onRecord({ index, key, status: "ok", result: result.returnValue });
		return result.returnValue;
	};
}
