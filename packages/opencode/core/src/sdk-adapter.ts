/**
 * Real-SDK → {@link EngineClient} adapter.
 *
 * The engine programs against {@link EngineClient} — a minimal structural type
 * covering exactly the five `session.*` calls the launch/completion paths make,
 * with concrete `{ path, body }` argument shapes and narrowed `{ data }` return
 * shapes (see session-runner.ts and docs/sdk-surface-audit.md rows a–e).
 *
 * The real opencode SDK client (`ReturnType<typeof createOpencodeClient>`) carries
 * far more surface, and its generic, `Options<...>`-shaped method signatures are
 * NOT directly assignable to EngineClient's concrete ones. So we wrap it in a thin
 * adapter that calls each method with the exact shape the engine uses and narrows
 * the `RequestResult`-style `{ data, ... }` result down to what the engine reads.
 *
 * ERROR SEMANTICS (the load-bearing part): the generated client defaults
 * `ThrowOnError = false` — an HTTP error RESOLVES as `{ data: undefined, error }`,
 * it does not reject (verified against `@opencode-ai/sdk` 1.16.2; nothing in this
 * repo passes `throwOnError`). The engine was written assuming throw semantics:
 * session-gone detection, restart recovery, resume verification, prompt-failure
 * flips, the completion gate's status veto, and the wake notifier's suppression
 * all live in `catch` blocks. So {@link unwrap} converts every `error`-carrying
 * envelope into a THROW, on EVERY method of this adapter. This is the single
 * choke point that restores throw semantics for the whole engine.
 *
 * Both the Phase 2 (`background-agents`) and Phase 4 (`workflows`) plugins need
 * this identical adapter, so it lives in core, written once — and the wake
 * notifier's `WakeClient` is a structural SUBSET of {@link EngineClient}, so the
 * ONE adapted client serves both the engine and the wake (review finding #5; the
 * former `adaptWakeClient` duplicate was deleted). The smoke harness (Task
 * 1.5.1 / 2.3.2) re-verifies it live against a real opencode process.
 *
 * Input is typed STRUCTURALLY ({@link SdkSessionClient}) rather than by importing
 * `ReturnType<typeof createOpencodeClient>`: the structural type sidesteps
 * `verbatimModuleSyntax` import friction and keeps core free of a value-level SDK
 * dependency, while the real client remains assignable to it (it has these methods
 * with broader, compatible signatures).
 */

import type { GateMessage } from "./completion";
import type {
	EngineClient,
	SessionCreateBody,
	SessionPromptAsyncBody,
	SessionStatusMap,
} from "./session-runner";

/**
 * A `RequestResult`-style envelope: the SDK resolves method calls to an object
 * carrying `data` and `error` (plus request/response metadata the adapter
 * ignores). Exactly one of the two is populated: success → `{ data, error:
 * undefined }`; HTTP error → `{ data: undefined, error }`. `data` may also be
 * `undefined`/`null` on no-content successes.
 */
interface SdkResult<T> {
	data?: T | null;
	error?: unknown;
}

/**
 * Restore throw semantics at the adapter boundary: an envelope carrying `error`
 * becomes a rejection. An `Error` instance is rethrown as-is (preserves stack);
 * anything else (the SDK's structured error payloads) is wrapped so the message
 * carries the full payload.
 */
function unwrap<T extends { error?: unknown }>(res: T): T {
	if (res.error !== undefined) {
		throw res.error instanceof Error
			? res.error
			: new Error(JSON.stringify(res.error));
	}
	return res;
}

/**
 * The structural subset of the real SDK client's `session` surface the adapter
 * forwards to. Each method accepts the engine's concrete call shape; the real
 * generated client satisfies this (its generic signatures are broader). Return
 * types are the raw `{ data, error }` envelope, which the adapter unwraps
 * (throw-on-error) and narrows.
 */
export interface SdkSessionClient {
	session: {
		create(opts: {
			body?: SessionCreateBody;
			/**
			 * Create-time query (SDK `SessionCreateData.query`). The real generated
			 * client's `create` accepts `query?: { directory?: string }`, so this
			 * structural widening stays assignable. The engine forwards only
			 * `directory` (Epic H.1, host-probed green) — re-roots the worker cwd.
			 */
			query?: { directory?: string };
		}): Promise<SdkResult<{ id: string }>>;
		promptAsync(opts: {
			path: { id: string };
			body: SessionPromptAsyncBody;
		}): Promise<SdkResult<unknown>>;
		abort(opts: { path: { id: string } }): Promise<SdkResult<unknown>>;
		messages(opts: { path: { id: string } }): Promise<SdkResult<GateMessage[]>>;
		get(opts: { path: { id: string } }): Promise<SdkResult<unknown>>;
		/** Global turn-liveness status map (audit row f) — Task 7.1.1 completion veto. */
		status(): Promise<SdkResult<SessionStatusMap>>;
	};
}

/**
 * Wrap a real SDK client as the engine's structural {@link EngineClient}. Each
 * method forwards the engine's call shape verbatim, THROWS when the envelope
 * carries `error` (see {@link unwrap} — the engine's catch-based error paths
 * depend on it), and narrows the `{ data }` result to exactly what the engine
 * reads. This is the single place that breaks loudly if the live SDK ever
 * drifts from the audited shapes.
 */
export function adaptSdkClient(client: SdkSessionClient): EngineClient {
	return {
		session: {
			create: async (opts) => {
				const res = unwrap(
					await client.session.create({
						body: opts.body,
						// Epic H.1 (inert seam): forward the create-time directory query ONLY
						// when present, so the live SDK call is byte-identical to today when
						// no query is passed — preserving this adapter's "single drift-
						// detection point" contract.
						...(opts.query !== undefined ? { query: opts.query } : {}),
					}),
				);
				return { data: res.data ? { id: res.data.id } : undefined };
			},
			promptAsync: async (opts) =>
				unwrap(
					await client.session.promptAsync({
						path: opts.path,
						body: opts.body,
					}),
				),
			abort: async (opts) =>
				unwrap(await client.session.abort({ path: opts.path })),
			messages: async (opts) => {
				const res = unwrap(await client.session.messages({ path: opts.path }));
				return { data: res.data ?? undefined };
			},
			// An HTTP-404 `get` THROWS (via unwrap), so `sessionExists` /
			// restart-recovery / `resume()` verification observe a rejection — the
			// session-gone semantics the runner's catch blocks were written for.
			get: async (opts) =>
				unwrap(await client.session.get({ path: opts.path })),
			// A failed status read THROWS, so the gate's conservative veto blocks
			// completion instead of misreading the failure as "absent = idle".
			status: async () => {
				const res = unwrap(await client.session.status());
				return { data: res.data ?? undefined };
			},
		},
	};
}
