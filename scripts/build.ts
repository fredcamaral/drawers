/**
 * Publish bundler for the two opencode plugins.
 *
 * `@drawers/core` is npm-private (never published) so it is INLINED into each
 * plugin's bundle; every real npm dependency is EXTERNAL (npm installs it). The
 * `./tui` entry additionally externalizes `@opentui/*` and `solid-js`: those are
 * host-provided peers, and bundling a second copy would re-introduce the
 * dual-instance "Orphan text" crash the viewer was fixed for. Output is ESM `.js`
 * under each package's `dist/`, which opencode loads via Bun like the `.ts` source.
 *
 * Run: `bun run scripts/build.ts` (or `bun run build`).
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";
// @ts-expect-error — `@opentui/solid/bun-plugin` ships no published types.
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin";
import type { BunPlugin } from "bun";

const ROOT = join(import.meta.dir, "..");

/**
 * `@opentui/solid`'s own Solid transform (babel-preset-solid, `generate: "universal"`).
 * Solid ships NO runtime jsx-runtime — `@opentui/solid/jsx-runtime` is a `.d.ts` stub —
 * so the JSX MUST be compiled by this transform, exactly as the opencode host does on
 * `.tsx` at load time. Without it `Bun.build` emits generic `jsxDEV()` calls against a
 * runtime with no implementation, and the loaded `dist/tui.js` crashes on the first JSX
 * call. With `@opentui/solid` + `solid-js` externalized, the compiled output references
 * the HOST instance (no dual instance, no second copy).
 */
const solidPlugin: BunPlugin = createSolidTransformPlugin();

/** Real npm deps shared by the server surfaces — externalized, never bundled. */
const SERVER_EXTERNALS = ["@opencode-ai/plugin", "@opencode-ai/sdk"];
/** opentui/solid peers — host-provided; bundling them re-creates the dual instance. */
const TUI_PEER_EXTERNALS = [
	"@opentui/core",
	"@opentui/keymap",
	"@opentui/solid",
	"solid-js",
];

interface Entry {
	entry: string;
	outName: string;
	external: string[];
	/** Build plugins (the `./tui` entry needs the Solid transform). */
	plugins?: BunPlugin[];
}

interface Target {
	pkgDir: string;
	entries: Entry[];
}

const TARGETS: Target[] = [
	{
		pkgDir: "packages/cadence",
		entries: [
			{
				entry: "src/index.ts",
				outName: "index.js",
				external: SERVER_EXTERNALS,
			},
		],
	},
	{
		pkgDir: "packages/background-agents",
		entries: [
			{
				entry: "src/index.ts",
				outName: "index.js",
				external: SERVER_EXTERNALS,
			},
		],
	},
	{
		pkgDir: "packages/workflows",
		entries: [
			{
				entry: "src/plugin/index.ts",
				outName: "index.js",
				external: [...SERVER_EXTERNALS, "acorn", "ajv"],
			},
			{
				entry: "src/index.ts",
				outName: "lib.js",
				external: [...SERVER_EXTERNALS, "acorn", "ajv"],
			},
			{
				entry: "src/tui/index.tsx",
				outName: "tui.js",
				external: [...SERVER_EXTERNALS, ...TUI_PEER_EXTERNALS],
				plugins: [solidPlugin],
			},
		],
	},
];

let failed = false;

for (const target of TARGETS) {
	const outdir = join(ROOT, target.pkgDir, "dist");
	await rm(outdir, { recursive: true, force: true });

	for (const e of target.entries) {
		const result = await Bun.build({
			entrypoints: [join(ROOT, target.pkgDir, e.entry)],
			target: "node",
			format: "esm",
			external: e.external,
			naming: e.outName,
			outdir,
			...(e.plugins !== undefined ? { plugins: e.plugins } : {}),
		});

		if (!result.success) {
			failed = true;
			console.error(`✗ ${target.pkgDir}/${e.entry}`);
			for (const log of result.logs) {
				console.error(`  ${log.message}`);
			}
			continue;
		}

		const out = join(outdir, e.outName);
		const bytes = (await Bun.file(out).text()).length;
		console.log(
			`✓ ${target.pkgDir}/dist/${e.outName}  (${(bytes / 1024).toFixed(1)} KB)`,
		);
	}
}

if (failed) {
	process.exit(1);
}
