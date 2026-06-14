import { describe, expect, test } from "bun:test";
import { adaptSdkClient, type SdkSessionClient } from "./sdk-adapter";
import type { WakeClient } from "./wake-notifier";

/**
 * A scripted fake of the real SDK client's `session` surface, modelling the REAL
 * envelope semantics of `@opencode-ai/sdk` 1.16.2: the generated client defaults
 * `ThrowOnError = false`, so EVERY call — success or HTTP error — RESOLVES with a
 * `{ data, error, request, response }` envelope. An HTTP error resolves as
 * `{ data: undefined, error }`; nothing ever rejects. Each method records the
 * exact options object it was called with so we can assert the adapter narrows
 * to `{ data }`, forwards the call shape verbatim, and THROWS on `error`.
 */
interface Call {
	method: string;
	opts: unknown;
}

/** A real-shaped success envelope: `error` present-but-undefined + metadata. */
function ok(data: unknown): unknown {
	return { data, error: undefined, request: {}, response: {} };
}

/** A real-shaped HTTP-error envelope: `data` undefined, `error` populated. */
function httpError(error: unknown): unknown {
	return { data: undefined, error, request: {}, response: {} };
}

function makeFake(overrides: Partial<Record<string, unknown>> = {}): {
	client: SdkSessionClient;
	calls: Call[];
} {
	const calls: Call[] = [];
	const record =
		(method: string, result: unknown) =>
		async (opts: unknown): Promise<unknown> => {
			calls.push({ method, opts });
			return result;
		};

	const client = {
		session: {
			create: record("create", ok({ id: "ses_new", extra: "ignored" })),
			promptAsync: record("promptAsync", ok({ messageID: "msg_1" })),
			abort: record("abort", ok(true)),
			messages: record(
				"messages",
				ok([
					{ info: { role: "assistant", time: { created: 1000 } }, parts: [] },
				]),
			),
			get: record("get", ok({ id: "ses_new" })),
			status: record("status", ok({ ses_child: { type: "busy" } })),
			...overrides,
		},
	} as unknown as SdkSessionClient;

	return { client, calls };
}

describe("adaptSdkClient", () => {
	test("create: forwards { body } and narrows to { data: { id } }", async () => {
		const { client, calls } = makeFake();
		const engine = adaptSdkClient(client);

		const res = await engine.session.create({
			body: { parentID: "ses_parent", title: "a task" },
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({
			method: "create",
			opts: { body: { parentID: "ses_parent", title: "a task" } },
		});
		// Narrowed to exactly { id } — extra fields dropped.
		expect(res).toEqual({ data: { id: "ses_new" } });
	});

	test("create: undefined data (no-content success) narrows to { data: undefined }", async () => {
		const { client } = makeFake({
			create: async () => ok(undefined),
		});
		const engine = adaptSdkClient(client);

		const res = await engine.session.create({ body: { title: "x" } });
		expect(res).toEqual({ data: undefined });
	});

	test("create: forwards query.directory verbatim when present (Epic H.1)", async () => {
		const { client, calls } = makeFake();
		const engine = adaptSdkClient(client);

		await engine.session.create({
			body: { parentID: "ses_parent", title: "a task" },
			query: { directory: "/tmp/wt-abc" },
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({
			method: "create",
			opts: {
				body: { parentID: "ses_parent", title: "a task" },
				query: { directory: "/tmp/wt-abc" },
			},
		});
	});

	test("create: omits query when absent (byte-identical to today)", async () => {
		const { client, calls } = makeFake();
		const engine = adaptSdkClient(client);

		await engine.session.create({ body: { title: "x" } });

		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({
			method: "create",
			opts: { body: { title: "x" } },
		});
	});

	test("promptAsync: forwards { path, body } verbatim", async () => {
		const { client, calls } = makeFake();
		const engine = adaptSdkClient(client);

		const body = {
			agent: "build",
			tools: { bg_task: false },
			parts: [{ type: "text" as const, text: "go" }],
		};
		await engine.session.promptAsync({ path: { id: "ses_1" }, body });

		expect(calls[0]).toEqual({
			method: "promptAsync",
			opts: { path: { id: "ses_1" }, body },
		});
	});

	test("abort: forwards { path } only", async () => {
		const { client, calls } = makeFake();
		const engine = adaptSdkClient(client);

		await engine.session.abort({ path: { id: "ses_1" } });

		expect(calls[0]).toEqual({
			method: "abort",
			opts: { path: { id: "ses_1" } },
		});
	});

	test("messages: forwards { path } and narrows to { data }", async () => {
		const { client, calls } = makeFake();
		const engine = adaptSdkClient(client);

		const res = await engine.session.messages({ path: { id: "ses_1" } });

		expect(calls[0]).toEqual({
			method: "messages",
			opts: { path: { id: "ses_1" } },
		});
		expect(res).toEqual({
			data: [
				{ info: { role: "assistant", time: { created: 1000 } }, parts: [] },
			],
		});
	});

	test("messages: null data narrows to { data: undefined }", async () => {
		const { client } = makeFake({
			messages: async () => ok(null),
		});
		const engine = adaptSdkClient(client);

		const res = await engine.session.messages({ path: { id: "ses_1" } });
		expect(res).toEqual({ data: undefined });
	});

	test("get: forwards { path }", async () => {
		const { client, calls } = makeFake();
		const engine = adaptSdkClient(client);

		await engine.session.get({ path: { id: "ses_1" } });

		expect(calls[0]).toEqual({
			method: "get",
			opts: { path: { id: "ses_1" } },
		});
	});

	test("status: forwards the no-arg call and narrows a populated map", async () => {
		const { client, calls } = makeFake();
		const engine = adaptSdkClient(client);

		const res = await engine.session.status();

		expect(calls[0]).toEqual({ method: "status", opts: undefined });
		// Narrowed to exactly { data } — the canned map from makeFake().
		expect(res).toEqual({ data: { ses_child: { type: "busy" } } });
	});

	test("status: empty map passes through as { data: {} }", async () => {
		const { client } = makeFake({
			status: async () => ok({}),
		});
		const engine = adaptSdkClient(client);

		const res = await engine.session.status();
		expect(res).toEqual({ data: {} });
	});

	test("status: null data narrows to { data: undefined }", async () => {
		const { client } = makeFake({
			status: async () => ok(null),
		});
		const engine = adaptSdkClient(client);

		const res = await engine.session.status();
		expect(res).toEqual({ data: undefined });
	});
});

/**
 * Finding #1: the real client RESOLVES HTTP errors as `{ error, data: undefined }`
 * (ThrowOnError defaults false; nothing in this repo passes throwOnError). The
 * engine was written assuming throw semantics, so the adapter — "the single place
 * that breaks loudly" — must convert an `error`-carrying envelope into a THROW on
 * EVERY method of both adapters. Without this, six downstream error paths
 * (session-gone detection, restart recovery, resume verification, prompt-failure
 * flips, the status veto, wake suppression) are dead code.
 */
describe("adaptSdkClient — error envelopes throw (finding #1)", () => {
	const methods = [
		{
			name: "create",
			call: (engine: ReturnType<typeof adaptSdkClient>) =>
				engine.session.create({ body: { title: "x" } }),
		},
		{
			name: "promptAsync",
			call: (engine: ReturnType<typeof adaptSdkClient>) =>
				engine.session.promptAsync({
					path: { id: "ses_1" },
					body: { parts: [{ type: "text" as const, text: "go" }] },
				}),
		},
		{
			name: "abort",
			call: (engine: ReturnType<typeof adaptSdkClient>) =>
				engine.session.abort({ path: { id: "ses_1" } }),
		},
		{
			name: "messages",
			call: (engine: ReturnType<typeof adaptSdkClient>) =>
				engine.session.messages({ path: { id: "ses_1" } }),
		},
		{
			name: "get",
			call: (engine: ReturnType<typeof adaptSdkClient>) =>
				engine.session.get({ path: { id: "ses_1" } }),
		},
		{
			name: "status",
			call: (engine: ReturnType<typeof adaptSdkClient>) =>
				engine.session.status(),
		},
	] as const;

	for (const m of methods) {
		test(`${m.name}: { error } resolution throws instead of passing the envelope through`, async () => {
			const { client } = makeFake({
				[m.name]: async () =>
					httpError({ data: { message: "Session not found" } }),
			});
			const engine = adaptSdkClient(client);

			await expect(m.call(engine)).rejects.toThrow(/Session not found/);
		});
	}

	test("an Error-instance error is rethrown as-is (not re-wrapped)", async () => {
		const boom = new Error("connection refused");
		const { client } = makeFake({ get: async () => httpError(boom) });
		const engine = adaptSdkClient(client);

		await expect(engine.session.get({ path: { id: "ses_1" } })).rejects.toBe(
			boom,
		);
	});

	test("a non-Error error is wrapped in new Error(JSON.stringify(...))", async () => {
		const { client } = makeFake({
			status: async () => httpError({ code: 404, message: "gone" }),
		});
		const engine = adaptSdkClient(client);

		await expect(engine.session.status()).rejects.toThrow(
			JSON.stringify({ code: 404, message: "gone" }),
		);
	});

	test("create with { error }: surfaces the REAL error, never a bare envelope (finding #1g)", async () => {
		const { client } = makeFake({
			create: async () => httpError({ data: { message: "model not found" } }),
		});
		const engine = adaptSdkClient(client);

		// The error must carry the server's message — NOT degrade into the launch
		// path's generic "session.create returned no session id".
		await expect(
			engine.session.create({ body: { title: "x" } }),
		).rejects.toThrow(/model not found/);
	});
});

/**
 * Review finding #5: the wake notifier rides the SAME adapted client as the
 * engine — `WakeClient` is a structural subset of `EngineClient`. The
 * assignment below is the compile-time proof; the tests re-verify the two wake
 * design constraints (a failed status read / promptAsync must THROW so the
 * notifier's catches suppress the wake and leave notices queued) through the
 * single adapter.
 */
describe("adaptSdkClient as WakeClient", () => {
	test("the adapted engine client satisfies WakeClient structurally", async () => {
		const { client, calls } = makeFake();
		const wake: WakeClient = adaptSdkClient(client);

		const res = await wake.session.status();
		expect(res).toEqual({ data: { ses_child: { type: "busy" } } });

		const body = { parts: [{ type: "text" as const, text: "wake up" }] };
		await wake.session.promptAsync({ path: { id: "ses_parent" }, body });
		expect(calls[1]).toEqual({
			method: "promptAsync",
			opts: { path: { id: "ses_parent" }, body },
		});
	});

	test("status: { error } resolution THROWS so wake-notifier's catch suppresses the wake", async () => {
		// wake-notifier's design constraint: a FAILED status read must surface as a
		// throw (its catch logs + leaves notices queued). With envelope semantics, a
		// pass-through `{ error }` would read as "absent = idle" and wake a parent
		// whose state was never actually read.
		const { client } = makeFake({
			status: async () => httpError({ data: { message: "boom" } }),
		});
		const wake: WakeClient = adaptSdkClient(client);

		await expect(wake.session.status()).rejects.toThrow(/boom/);
	});

	test("promptAsync: { error } resolution THROWS so notices stay queued for the passive flush", async () => {
		const { client } = makeFake({
			promptAsync: async () =>
				httpError({ data: { message: "prompt failed" } }),
		});
		const wake: WakeClient = adaptSdkClient(client);

		await expect(
			wake.session.promptAsync({
				path: { id: "ses_parent" },
				body: { parts: [{ type: "text", text: "wake" }] },
			}),
		).rejects.toThrow(/prompt failed/);
	});
});
