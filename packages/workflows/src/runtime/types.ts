/**
 * The workflow runtime phase's internal contract module (spec §3.3).
 *
 * These are the globals a workflow script body programs against once the harness
 * has bound them, plus the supporting view/event/error types the runtime layer
 * shares. The composition primitives (`pipeline`, `parallel`) are typed here with
 * permissive signatures — Task 3.2.2 implements them; this module only fixes the
 * shape the script sees.
 */

/** A single `agent()` call's options (spec §3.3 "agent() options"). */
export interface AgentOpts {
	/** Display label for the progress tree; defaults to the prompt prefix. */
	label?: string;
	/** Progress group; preferred over the global `phase()` state when set. */
	phase?: string;
	/** JSON Schema for structured output (lands in Task 3.3.2). */
	schema?: object;
	/** Model override; default is to inherit the session model. */
	model?: string;
	/** Fresh git worktree — expensive, only for parallel file mutation. */
	isolation?: "worktree";
	/** Custom subagent type from the same registry as the `Agent` tool. */
	agentType?: string;
}

/** Spawn a subagent; resolves to its final text, a validated object, or `null`. */
export type AgentFn = (prompt: string, opts?: AgentOpts) => Promise<unknown>;

/** The token budget as the script sees it (spec §6). */
export interface BudgetView {
	/** The hard ceiling for the turn, or `null` if none was set. */
	total: number | null;
	/** Output tokens spent this turn across the shared pool. */
	spent(): number;
	/** `max(0, total − spent())`, or `Infinity` with no target. */
	remaining(): number;
}

/** A progress signal emitted as the runtime drives `agent()` calls. */
export type ProgressEvent =
	| { type: "agent:start"; label: string; phase?: string }
	| { type: "agent:end"; label: string; status: string }
	| { type: "log"; message: string }
	| { type: "warn"; message: string };

/** Sink for {@link ProgressEvent}s; renders to `/workflows` and narrator lines. */
export type ProgressEmitter = (e: ProgressEvent) => void;

/**
 * The complete set of globals available to a workflow script body (spec §3.3).
 * `pipeline`/`parallel` keep permissive signatures here — their concrete typing
 * arrives with their implementation (Task 3.2.2).
 */
export interface RuntimeApi {
	agent: AgentFn;
	pipeline: (...args: unknown[]) => Promise<unknown[]>;
	parallel: (...args: unknown[]) => Promise<unknown[]>;
	phase: (title: string) => void;
	log: (message: string) => void;
	args: unknown;
	budget: BudgetView;
	/** Sub-workflows are unsupported in this phase; always throws. */
	workflow: (...args: unknown[]) => never;
}

/** The lifetime agent-count cap (1,000) was hit — a runaway-loop backstop (§5). */
export class AgentCapError extends Error {
	constructor(message = "workflow exceeded the 1000-agent lifetime cap") {
		super(message);
		this.name = "AgentCapError";
	}
}

/** The token budget is exhausted; further `agent()` calls are refused (§6). */
export class BudgetExhaustedError extends Error {
	constructor(message = "workflow token budget exhausted") {
		super(message);
		this.name = "BudgetExhaustedError";
	}
}

// ItemCapError's canonical home is compose.ts (it carries count/cap fields the
// composition functions populate); re-exported here so the error-class family
// stays importable from one module.
export { ItemCapError } from "./compose";

/** A primitive/option that is recognized but not yet implemented in this phase. */
export class NotYetSupportedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NotYetSupportedError";
	}
}
