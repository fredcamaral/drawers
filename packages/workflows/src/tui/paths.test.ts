import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	ROUTE_WORKFLOWS,
	SENTINEL_SUFFIX,
	SIDEBAR_SLOT_ORDER,
	slugifyWorkflowName,
	SUBDIR_CONTROL,
	SUBDIR_FEED,
	writeCancelSentinel,
} from "./paths";

/**
 * Unit tests for the JSX-free core of the `./tui` surface. The `.tsx` entry, route,
 * and sidebar are NOT imported here — mounting opentui JSX is out of `bun test` scope
 * (it needs the host's Solid transform + runtime). The entry's shape is enforced by
 * `satisfies TuiPluginModule` at typecheck and by the manual host walkthrough.
 */

describe("slugifyWorkflowName", () => {
	test("spaced display names become hyphenated, filesystem-safe names", () => {
		expect(slugifyWorkflowName("Deep Review")).toBe("Deep-Review");
	});

	test("invalid chars collapse to a single dash and edges are stripped", () => {
		expect(slugifyWorkflowName("  my/weird name!  ")).toBe("my-weird-name");
	});

	test("path-traversal attempts are defanged", () => {
		expect(slugifyWorkflowName("../escape")).toBe("escape");
		expect(slugifyWorkflowName("..")).toBe("workflow");
	});

	test("an all-invalid or empty name falls back to 'workflow'", () => {
		expect(slugifyWorkflowName("")).toBe("workflow");
		expect(slugifyWorkflowName("   ")).toBe("workflow");
		expect(slugifyWorkflowName("///")).toBe("workflow");
	});

	test("an already-valid name is preserved", () => {
		expect(slugifyWorkflowName("deep-research")).toBe("deep-research");
		expect(slugifyWorkflowName("my_flow.v2")).toBe("my_flow.v2");
	});
});

describe("path/layout constants", () => {
	test("match the engine's subdir layout (the feed is the bus)", () => {
		expect(SUBDIR_FEED).toBe("workflow-feed");
		expect(SUBDIR_CONTROL).toBe("workflow-control");
		expect(SENTINEL_SUFFIX).toBe(".cancel");
		expect(ROUTE_WORKFLOWS).toBe("workflows");
		expect(typeof SIDEBAR_SLOT_ORDER).toBe("number");
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

/**
 * Regression guard for the dual-instance crash (the viewer threw `Orphan text error`
 * the first time it opened). Root cause: the host's Solid transform only rewrites
 * `solid-js`/`@opentui/*` imports to the host's runtime instance for files matching
 * `/\.(js|ts)x$/` — `.tsx`/`.jsx` ONLY. A `.ts` file that imports solid/opentui at
 * runtime resolves to THIS package's nested copy = a SECOND instance, and mounting
 * host JSX built from a second instance fails the host renderer's `instanceof` checks.
 * So: every `.ts` (non-`.tsx`) file under `src/tui` MUST be free of `solid-js`/
 * `@opentui/*` imports. Solid/opentui usage belongs ONLY in `.tsx` files.
 */
describe("dual-instance guard: no solid/opentui imports in .ts files", () => {
	const dir = import.meta.dir;
	const tsFiles = readdirSync(dir).filter(
		(f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".tsx"),
	);

	// A value OR type import of these specifiers in a non-.tsx file is forbidden.
	const forbidden =
		/^\s*import\b[^\n]*\bfrom\s+["'](solid-js|@opentui\/[^"']+)["']/m;

	test("at least one .ts file is scanned (sanity)", () => {
		expect(tsFiles.length).toBeGreaterThan(0);
	});

	for (const file of tsFiles) {
		test(`${file} imports no solid-js/@opentui (would resolve to a nested instance)`, () => {
			const source = readFileSync(join(dir, file), "utf8");
			const offending = source
				.split("\n")
				.filter((line) => forbidden.test(line));
			expect(offending).toEqual([]);
		});
	}
});
