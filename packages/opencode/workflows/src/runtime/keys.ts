/**
 * Replay-identity hashing for the workflow runtime (Task 4.3.2).
 *
 * These were born in `../plugin/journal` (where the journal that consumes them
 * lives), but the runtime layer must stay free of any plugin import: both
 * `agent-call.ts` (per-call key) and `sub-workflow.ts` (the synthetic boundary
 * key) hash here. journal.ts re-exports {@link computeCallKey}/{@link CallKeyInput}
 * for back-compat, so existing plugin imports keep working.
 *
 * Two key flavours, ONE stable-stringify:
 *   - {@link computeCallKey} — a single `agent()` call's `(prompt, opts)` identity.
 *   - {@link computeWorkflowKey} — a `workflow()` boundary's identity over the
 *     RESOLVED child source + its args, prefixed `workflow:` so it never collides
 *     with an agent key in the same journal stream.
 */

import { createHash } from "node:crypto";

/** The shape {@link computeCallKey} hashes — a call's identity for replay. */
export interface CallKeyInput {
	prompt: string;
	schema?: object;
	model?: string;
	agentType?: string;
}

/**
 * Stable, recursive, key-sorted JSON of an arbitrary JSON-ish value. Object keys
 * are emitted in sorted order so that `{ a, b }` and `{ b, a }` stringify
 * identically; arrays preserve order (order is meaningful); primitives defer to
 * `JSON.stringify`. `undefined` members are dropped (matching JSON semantics) so
 * an absent option does not perturb the hash.
 */
export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "null";
	}
	if (Array.isArray(value)) {
		return `[${value.map((v) => stableStringify(v)).join(",")}]`;
	}
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj)
		.filter((k) => obj[k] !== undefined)
		.sort();
	const body = keys
		.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
		.join(",");
	return `{${body}}`;
}

/**
 * The replay identity of an `agent()` call: a sha256 hex over a stable stringify
 * of its `(prompt, opts)` inputs. Field order and schema key order are irrelevant
 * (sorted); the prompt, model, schema, and agentType all change the key.
 *
 * `label` and `phase` are DELIBERATELY excluded: they are display/grouping metadata
 * the agent worker never sees, so reorganizing them on a resume (renaming a label,
 * moving an agent to another phase) is a cosmetic edit that must NOT void the cached
 * verdict — otherwise the tool's per-item replay promise ("only changed, new, and
 * previously-failed calls run live") would re-run identical work at full token cost.
 */
export function computeCallKey(input: CallKeyInput): string {
	const canonical = stableStringify({
		prompt: input.prompt,
		schema: input.schema,
		model: input.model,
		agentType: input.agentType,
	});
	return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The replay identity of a `workflow()` boundary (spec §8): a sha256 hex over the
 * RESOLVED child source plus a stable stringify of its args, prefixed `workflow:`
 * so it occupies a distinct namespace from `agent()` keys in the same journal.
 *
 * Hashing the FULL child source (not its name) is what makes the boundary correct
 * yet coarse: any edit to the child — even one its parent never sees — changes the
 * key, voiding the cached child result from the boundary onward. The child's own
 * internal agent calls get no individual journal entries; this one key covers them
 * all (documented in sub-workflow.ts).
 */
export function computeWorkflowKey(source: string, args: unknown): string {
	const canonical = stableStringify({ source, args });
	return `workflow:${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * The replay identity of a `shell()` call: a sha256 hex over the command plus its
 * cwd and expected exit code, prefixed `shell:` so it occupies a distinct namespace
 * from `agent()` and `workflow()` keys in the same journal stream.
 *
 * `label` and `timeoutMs`-style display/operational options are DELIBERATELY
 * excluded — they do not change the command's identity (mirrors the `agent()` key's
 * label/phase exclusion). `cwd` and `expectExitCode` ARE included: the same command
 * in a different directory is a different call, and a changed pass threshold must
 * re-derive its verdict rather than replay a stale one.
 */
export function computeShellKey(
	command: string,
	opts: { cwd?: string; expectExitCode?: number },
): string {
	const canonical = stableStringify({
		command,
		cwd: opts.cwd,
		expectExitCode: opts.expectExitCode,
	});
	return `shell:${createHash("sha256").update(canonical).digest("hex")}`;
}
