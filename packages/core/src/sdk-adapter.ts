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
 * Both the Phase 2 (`background-agents`) and Phase 4 (`workflows`) plugins need
 * this identical adapter, so it lives in core, written once. The smoke harness
 * (Task 1.5.1 / 2.3.2) re-verifies it live against a real opencode process.
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
} from "./session-runner";
import type { WakeClient, WakeSessionStatusMap } from "./wake-notifier";

/**
 * A `RequestResult`-style envelope: the SDK resolves method calls to an object
 * carrying `data` (plus request/response metadata the adapter ignores). `data`
 * may be `undefined`/`null` on no-content responses.
 */
interface SdkResult<T> {
	data?: T | null;
}

/**
 * The structural subset of the real SDK client's `session` surface the adapter
 * forwards to. Each method accepts the engine's concrete call shape; the real
 * generated client satisfies this (its generic signatures are broader). Return
 * types are the raw `{ data }` envelope, which the adapter narrows.
 */
export interface SdkSessionClient {
	session: {
		create(opts: {
			body?: SessionCreateBody;
		}): Promise<SdkResult<{ id: string }>>;
		promptAsync(opts: {
			path: { id: string };
			body: SessionPromptAsyncBody;
		}): Promise<unknown>;
		abort(opts: { path: { id: string } }): Promise<unknown>;
		messages(opts: { path: { id: string } }): Promise<SdkResult<GateMessage[]>>;
		get(opts: { path: { id: string } }): Promise<unknown>;
	};
}

/**
 * The structural subset the wake notifier (Task 6.3.1) needs: the GLOBAL
 * `session.status` map read (audit row f) and `session.promptAsync` to the parent
 * (audit row b). The real generated client satisfies this (broader, compatible
 * generic signatures); like {@link SdkSessionClient} this avoids importing the
 * full client type and keeps core free of a value-level SDK dependency.
 */
export interface SdkWakeSessionClient {
	session: {
		status(): Promise<SdkResult<WakeSessionStatusMap>>;
		promptAsync(opts: {
			path: { id: string };
			body: {
				agent?: string;
				parts: Array<{ type: "text"; text: string }>;
			};
		}): Promise<unknown>;
	};
}

/**
 * Wrap a real SDK client as the engine's structural {@link EngineClient}. Each
 * method forwards the engine's call shape verbatim and narrows the `{ data }`
 * result to exactly what the engine reads. This is the single place that breaks
 * loudly if the live SDK ever drifts from the audited shapes.
 */
export function adaptSdkClient(client: SdkSessionClient): EngineClient {
	return {
		session: {
			create: async (opts) => {
				const res = await client.session.create({ body: opts.body });
				return { data: res.data ? { id: res.data.id } : undefined };
			},
			promptAsync: async (opts) =>
				client.session.promptAsync({ path: opts.path, body: opts.body }),
			abort: async (opts) => client.session.abort({ path: opts.path }),
			messages: async (opts) => {
				const res = await client.session.messages({ path: opts.path });
				return { data: res.data ?? undefined };
			},
			get: async (opts) => client.session.get({ path: opts.path }),
		},
	};
}

/**
 * Wrap a real SDK client as the wake notifier's structural {@link WakeClient}
 * (Task 6.3.2). Narrows `session.status`'s `{ data }` envelope to the global
 * status map and forwards `session.promptAsync` (no `agent` — the parent keeps its
 * own). Written once in core; both plugins consume it from their entry, keeping
 * the wake wiring thin composition rather than per-plugin SDK plumbing.
 */
export function adaptWakeClient(client: SdkWakeSessionClient): WakeClient {
	return {
		session: {
			status: async () => {
				const res = await client.session.status();
				return { data: res.data ?? undefined };
			},
			promptAsync: async (opts) =>
				client.session.promptAsync({ path: opts.path, body: opts.body }),
		},
	};
}
