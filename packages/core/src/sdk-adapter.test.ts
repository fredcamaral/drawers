import { describe, expect, test } from "bun:test";
import { adaptSdkClient, type SdkSessionClient } from "./sdk-adapter";

/**
 * A scripted fake of the real SDK client's `session` surface. Each method records
 * the exact options object it was called with, and returns a canned
 * `RequestResult`-shaped payload (`{ data, ... }`) so we can assert the adapter
 * narrows to `{ data }` and forwards the call shape verbatim.
 */
interface Call {
	method: string;
	opts: unknown;
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
			create: record("create", {
				data: { id: "ses_new", extra: "ignored" },
				request: {},
				response: {},
			}),
			promptAsync: record("promptAsync", {
				data: { messageID: "msg_1" },
			}),
			abort: record("abort", { data: true }),
			messages: record("messages", {
				data: [{ info: { role: "assistant" }, parts: [] }],
			}),
			get: record("get", { data: { id: "ses_new" } }),
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

	test("create: undefined data narrows to { data: undefined }", async () => {
		const { client } = makeFake({
			create: async () => ({ data: undefined }),
		});
		const engine = adaptSdkClient(client);

		const res = await engine.session.create({ body: { title: "x" } });
		expect(res).toEqual({ data: undefined });
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
		expect(res).toEqual({ data: [{ info: { role: "assistant" }, parts: [] }] });
	});

	test("messages: null data narrows to { data: undefined }", async () => {
		const { client } = makeFake({
			messages: async () => ({ data: null }),
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
});
