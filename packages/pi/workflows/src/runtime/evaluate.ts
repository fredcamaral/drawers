import { ScriptSyntaxError } from "./meta";
import type { RuntimeApi } from "./types";

/**
 * Evaluates a workflow script body in a deterministic async sandbox (spec §3.1).
 *
 * The body is plain JavaScript that runs inside an `AsyncFunction`, so top-level
 * `await` works and the body's `return` value becomes the workflow result. The
 * nine runtime API members are injected as named parameters, and a set of shadow
 * parameters hide nondeterministic or out-of-scope globals.
 *
 * The threat model is resume-cache poisoning, not containment: the script author
 * already holds bash, so this is about keeping nondeterministic values
 * (`Date.now()`, `Math.random()`, argless `new Date()`) out of the values that
 * reach `agent()` prompts — which would void the deterministic replay cache (§7).
 * Shadowing by parameter injection is therefore the right weight: no `vm`, no
 * realms, just names that win over the globals inside the function scope. Strict
 * mode closes the accidental-global-write hole, and a frozen `globalThis` closes
 * the `globalThis.Date.now()` bypass that shadowing alone would miss.
 */

/** A nondeterministic operation was used in a workflow body (voids replay, §7). */
export class DeterminismError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DeterminismError";
	}
}

/** The nine RuntimeApi members, in the order they are passed to the body. */
const API_NAMES = [
	"agent",
	"pipeline",
	"parallel",
	"phase",
	"log",
	"args",
	"budget",
	"workflow",
	"shell",
] as const;

/** `Object.getPrototypeOf(async function () {}).constructor` — not a JS global. */
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
	...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

/**
 * Builds a thrown-stub factory: any call to the returned function throws a
 * DeterminismError carrying `message`. Used for scheduling primitives that have
 * no place in agent orchestration.
 */
function banned(message: string): () => never {
	return () => {
		throw new DeterminismError(message);
	};
}

/**
 * Evaluates a workflow body and resolves to its `return` value (`undefined` is
 * allowed). Determinism violations and banned globals throw `DeterminismError`
 * from inside the body; any other body throw propagates unchanged.
 *
 * @throws {ScriptSyntaxError} when the body fails to compile as an async function.
 */
export async function evaluateScript(
	bodySource: string,
	api: RuntimeApi,
): Promise<unknown> {
	const shadows = buildShadows(api);
	const paramNames = [...API_NAMES, ...Object.keys(shadows)];
	const apiValues = API_NAMES.map((name) => api[name]);
	const shadowValues = Object.values(shadows);

	let fn: (...args: unknown[]) => Promise<unknown>;
	try {
		// Strict mode turns accidental global writes (`x = 1`) into runtime throws.
		fn = new AsyncFunction(...paramNames, `"use strict";\n${bodySource}`);
	} catch (err) {
		if (err instanceof SyntaxError) {
			throw new ScriptSyntaxError(err.message);
		}
		throw err;
	}

	// Body throws (including DeterminismError) propagate to the caller as-is.
	return fn(...apiValues, ...shadowValues);
}

/**
 * Constructs the shadow bindings injected after the API parameters. Each key is a
 * global name; each value is the deterministic replacement the body sees instead.
 */
function buildShadows(api: RuntimeApi): Record<string, unknown> {
	return {
		Date: makeDateShadow(),
		Math: makeMathShadow(),
		// Freezing an empty object closes the `globalThis.Date.now()` bypass: the
		// real Date is unreachable through globalThis, and writes silently fail
		// (or throw in strict mode) rather than mutating shared state.
		globalThis: Object.freeze({}),
		process: undefined,
		require: undefined,
		module: undefined,
		exports: undefined,
		Bun: undefined,
		fetch: undefined,
		setTimeout: banned(
			"workflow scripts orchestrate agents; they do not schedule",
		),
		setInterval: banned(
			"workflow scripts orchestrate agents; they do not schedule",
		),
		setImmediate: banned(
			"workflow scripts orchestrate agents; they do not schedule",
		),
		queueMicrotask: banned(
			"workflow scripts orchestrate agents; they do not schedule",
		),
		console: makeConsoleShadow(api),
	};
}

/**
 * A `Date` subclass that bans the two nondeterministic entry points while leaving
 * everything else (timestamp/string construction, instance methods, `parse`,
 * `UTC`) intact.
 */
function makeDateShadow(): typeof Date {
	class WorkflowDate extends Date {
		// `unknown[]` rest (not `ConstructorParameters<typeof Date>`) so the
		// zero-arg branch is representable: the real Date overloads make the empty
		// tuple a type error, but it is exactly the case we must reject at runtime.
		constructor(...args: unknown[]) {
			if (args.length === 0) {
				throw new DeterminismError(
					"new Date() is banned in workflow scripts — pass timestamps via args",
				);
			}
			super(...(args as ConstructorParameters<typeof Date>));
		}

		static override now(): number {
			throw new DeterminismError(
				"Date.now() is banned in workflow scripts — pass timestamps via args",
			);
		}
	}
	// `parse` and `UTC` are pure functions of their inputs, so they pass through
	// via prototypal inheritance from the real Date; they need no override. The
	// cast bridges the intentional gap: DateConstructor is also callable as a
	// plain function (returns a string), which a class can never satisfy.
	return WorkflowDate as unknown as typeof Date;
}

/**
 * A `Math` proxy that throws on `random` and forwards every other property to the
 * real `Math` unchanged.
 */
function makeMathShadow(): Math {
	return new Proxy(Math, {
		get(target, prop, receiver) {
			if (prop === "random") {
				throw new DeterminismError(
					"Math.random() is banned in workflow scripts — vary prompts/labels per index instead",
				);
			}
			return Reflect.get(target, prop, receiver);
		},
	});
}

/**
 * A `console` stand-in whose familiar methods route to the injected `log()`, so a
 * reflexive `console.log` in a script surfaces through the workflow log rather
 * than the host stdout.
 */
function makeConsoleShadow(
	api: RuntimeApi,
): Record<string, (...parts: unknown[]) => void> {
	const forward = (...parts: unknown[]): void => {
		api.log(
			parts
				.map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
				.join(" "),
		);
	};
	return { log: forward, warn: forward, error: forward, info: forward };
}
