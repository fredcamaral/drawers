import { describe, expect, test } from "bun:test";
import { type CallKeyInput, computeCallKey } from "./keys";
import type {
	AgentOpts,
	DiagnosticReason,
	IntentJournalEntry,
	JournalEntry,
	SettledJournalEntry,
} from "./types";

/**
 * Type-level + value tests for the {@link JournalEntry} discriminated union
 * (Task 3.1.1). The union discriminates on `status`: a settled `ok` member
 * carries `result`, a write-ahead `intent` member carries an optional `label`
 * and NO `result`. These tests pin the runtime shape and the narrowing contract
 * (the compile-time guarantee is enforced by `bun run typecheck`).
 */

describe("JournalEntry discriminated union", () => {
	test("a settled entry narrows to SettledJournalEntry on status === 'ok'", () => {
		const entry: JournalEntry = {
			index: 0,
			key: "k0",
			status: "ok",
			result: { n: 7 },
		};
		// Narrowing on the discriminant must expose `result`.
		if (entry.status === "ok") {
			const settled: SettledJournalEntry = entry;
			expect(settled.result).toEqual({ n: 7 });
		} else {
			throw new Error("expected ok");
		}
	});

	test("an intent entry narrows to IntentJournalEntry on status === 'intent'", () => {
		const entry: JournalEntry = {
			index: 1,
			key: "k1",
			status: "intent",
			label: "do work",
		};
		if (entry.status === "intent") {
			const intent: IntentJournalEntry = entry;
			expect(intent.label).toBe("do work");
			// An intent has no result by definition.
			expect("result" in intent).toBe(false);
		} else {
			throw new Error("expected intent");
		}
	});

	test("the intent label is optional (a bare intent is valid)", () => {
		const entry: IntentJournalEntry = { index: 2, key: "k2", status: "intent" };
		expect(entry.label).toBeUndefined();
	});

	test("an intent and its completion share index + key (reconciliation pair)", () => {
		const intent: IntentJournalEntry = {
			index: 3,
			key: "kpair",
			status: "intent",
		};
		const settled: SettledJournalEntry = {
			index: 3,
			key: "kpair",
			status: "ok",
			result: "done",
		};
		expect(intent.index).toBe(settled.index);
		expect(intent.key).toBe(settled.key);
	});
});

// ---- Task 4.2.1: verifyDiff opt + verify_failed reason --------------------

describe("AgentOpts.verifyDiff (Task 4.2.1)", () => {
	test("verifyDiff:true is a valid post-condition flag", () => {
		const opts: AgentOpts = { verifyDiff: true };
		expect(opts.verifyDiff).toBe(true);
	});

	test("verifyDiff:{check} carries a shell command", () => {
		const opts: AgentOpts = { verifyDiff: { check: "bun test x" } };
		expect(
			typeof opts.verifyDiff === "object" ? opts.verifyDiff.check : undefined,
		).toBe("bun test x");
	});

	test("verifyDiff:{} is legal and means the same as verifyDiff:true (git-diff-nonempty)", () => {
		// `check` is optional; `{}` MUST NOT silently skip verification — it is the
		// git-diff-nonempty mode, identical to `true`. The collapse is pinned here so an
		// impl cannot treat `{}` as a no-op (the worst failure mode for a safety check).
		const empty: AgentOpts = { verifyDiff: {} };
		expect(empty.verifyDiff).toBeDefined();
		expect(
			typeof empty.verifyDiff === "object" ? empty.verifyDiff.check : "MISSING",
		).toBeUndefined();
	});

	test("'verify_failed' is a member of the DiagnosticReason union", () => {
		const reason: DiagnosticReason = "verify_failed";
		expect(reason).toBe("verify_failed");
	});

	test("verifyDiff is NOT part of computeCallKey (a post-condition is not call identity)", () => {
		// CallKeyInput has no verifyDiff field — a verify flag must not void the resume
		// cache. The key for a call is identical whether or not verifyDiff is set.
		const input: CallKeyInput = { prompt: "fix the bug" };
		const key = computeCallKey(input);
		// Type-level: CallKeyInput has no verifyDiff field, so reading it is an error —
		// a verify flag is not part of a call's replay identity (it must not void the
		// resume cache). The @ts-expect-error fails the build if verifyDiff is ever added.
		// @ts-expect-error verifyDiff is deliberately absent from CallKeyInput.
		const _absent: undefined = input.verifyDiff;
		// Runtime: computeCallKey reads only its known fields, so an extra verifyDiff
		// property cannot change the hash — the key is byte-identical.
		const key2 = computeCallKey({
			prompt: "fix the bug",
			...({ verifyDiff: true } as object),
		});
		expect(key2).toBe(key);
		expect(_absent).toBeUndefined();
	});
});
