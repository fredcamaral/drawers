import { describe, expect, test } from "bun:test";
import tuiModule, { writeCancelSentinel } from "./index";

/**
 * Smoke test for the `./tui` entry (Task 8.3.3). The JSX render body is NOT
 * mounted (live rendering is out of automated scope) — the test asserts the module
 * SHAPE (a `TuiPluginModule` with `id` + async `tui`), that `tui(api)` registers
 * exactly one `workflows` route and one `palette` `workflows.open` command against a
 * hand-rolled fake `TuiPluginApi`, and that the `x` cancel handler writes
 * `<dir>/<runId>.cancel` through an injected fs (the exact external touch Task 8.2.3
 * proved end-to-end). No opentui runtime is involved.
 */

/** A registered route, captured by the fake `api.route.register`. */
interface CapturedRoute {
	name: string;
	render: (input: { params?: Record<string, unknown> }) => unknown;
}

/** A registered command, captured by the fake `api.keymap.registerLayer`. */
interface CapturedCommand {
	name: string;
	namespace?: unknown;
	slashName?: unknown;
	run: (ctx: unknown) => unknown;
}

/** A hand-rolled `TuiPluginApi` double recording route + keymap registrations. */
function fakeApi() {
	const routes: CapturedRoute[] = [];
	const commands: CapturedCommand[] = [];
	const layers: unknown[] = [];
	const navigations: { name: string; params?: Record<string, unknown> }[] = [];
	const api = {
		route: {
			register(defs: CapturedRoute[]) {
				routes.push(...defs);
				return () => {};
			},
			navigate(name: string, params?: Record<string, unknown>) {
				navigations.push({ name, params });
			},
			current: { name: "home" as const },
		},
		keymap: {
			registerLayer(layer: { commands?: CapturedCommand[] }) {
				layers.push(layer);
				if (layer.commands !== undefined) {
					commands.push(...layer.commands);
				}
				return () => {};
			},
		},
		slots: {
			register() {
				return "";
			},
		},
		ui: {
			dialog: {
				clear() {},
			},
		},
	};
	return { api, routes, commands, layers, navigations };
}

describe("tui module shape", () => {
	test("default export is a TuiPluginModule with id and an async tui", () => {
		expect(typeof tuiModule.id).toBe("string");
		expect(tuiModule.id.length).toBeGreaterThan(0);
		expect(typeof tuiModule.tui).toBe("function");
	});
});

describe("tui(api) registration", () => {
	test("registers exactly one workflows route", async () => {
		const { api, routes } = fakeApi();
		// biome-ignore lint/suspicious/noExplicitAny: the fake api is a structural double, not the full TuiPluginApi.
		await tuiModule.tui(api as any, undefined, {} as any);
		expect(routes).toHaveLength(1);
		expect(routes[0]?.name).toBe("workflows");
		expect(typeof routes[0]?.render).toBe("function");
	});

	test("registers exactly one palette workflows.open command", async () => {
		const { api, commands } = fakeApi();
		// biome-ignore lint/suspicious/noExplicitAny: the fake api is a structural double, not the full TuiPluginApi.
		await tuiModule.tui(api as any, undefined, {} as any);
		const open = commands.filter((c) => c.name === "workflows.open");
		expect(open).toHaveLength(1);
		expect(open[0]?.namespace).toBe("palette");
		expect(open[0]?.slashName).toBe("workflows");
	});

	test("the open command navigates to the workflows route", async () => {
		const { api, commands, navigations } = fakeApi();
		// biome-ignore lint/suspicious/noExplicitAny: the fake api is a structural double, not the full TuiPluginApi.
		await tuiModule.tui(api as any, undefined, {} as any);
		const open = commands.find((c) => c.name === "workflows.open");
		expect(open).toBeDefined();
		open?.run({});
		expect(navigations).toHaveLength(1);
		expect(navigations[0]?.name).toBe("workflows");
	});
});

describe("writeCancelSentinel", () => {
	test("writes <controlDir>/<runId>.cancel through the injected fs", async () => {
		const calls: { mkdir: string[]; write: { path: string; data: string }[] } =
			{
				mkdir: [],
				write: [],
			};
		const fs = {
			async mkdir(path: string, _opts: { recursive: true }) {
				calls.mkdir.push(path);
			},
			async writeFile(path: string, data: string) {
				calls.write.push({ path, data });
			},
		};
		await writeCancelSentinel({
			controlDir: "/data/workflow-control",
			runId: "wf_801501pc",
			fs,
		});
		expect(calls.mkdir).toEqual(["/data/workflow-control"]);
		expect(calls.write).toHaveLength(1);
		expect(calls.write[0]?.path).toBe(
			"/data/workflow-control/wf_801501pc.cancel",
		);
		expect(calls.write[0]?.data).toBe("");
	});
});
