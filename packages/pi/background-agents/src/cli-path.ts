/**
 * Resolve the spawnable pi CLI entry (`dist/cli.js`) the SessionRunner hands to
 * the stock `RpcClient` as `cliPath`.
 *
 * Why this matters (proven against pi 0.79.3): the stock `RpcClient.start()`
 * spawns `node <cliPath> --mode rpc …` — the executable is HARDCODED `"node"`,
 * NOT `process.execPath` and NOT the `pi` bin. So `cliPath` MUST be a real `.js`
 * file on disk that `node` can execute. The stock default `"dist/cli.js"` is
 * relative and ENOENTs under any cwd that is not the package root, which is why
 * `@drawers/pi-core`'s factory REQUIRES an absolute `cliPath` and forbids the
 * relative default.
 *
 * A pi extension runs under pi via jiti, where `@earendil-works/pi-coding-agent`
 * is a VIRTUAL module — but the physical npm package is still on disk (that is
 * what jiti loads from). `import.meta.resolve` returns that real on-disk path
 * even through bun's isolated store, and `cli.js` sits beside `index.js`. This
 * is exactly the recipe the proven core smoke uses
 * (`core/test-harness/run-runner-smoke.ts`).
 *
 * Node-safe: no Bun.* APIs.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Operator escape hatch for exotic installs (Bun-binary, Nix store, wrappers). */
const CLI_OVERRIDE_ENV = "PI_DRAWER_AGENTS_CLI";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

function fromFileUrl(url: string): string {
	return url.startsWith("file:") ? fileURLToPath(url) : url;
}

/**
 * Resolve an absolute, existing path to pi's spawnable `dist/cli.js`. Resolution
 * order, first existing file wins:
 *
 *   1. `$PI_DRAWER_AGENTS_CLI` — explicit operator override.
 *   2. `import.meta.resolve(pi)` → swap `index.js` → `cli.js` (the primary path;
 *      proven by the core runner smoke).
 *   3. `createRequire(...).resolve(pi/package.json)` → `<pkgDir>/dist/cli.js`
 *      (subpath fallback for layouts where the bare-specifier resolve is shimmed).
 *
 * THROWS if none yields an existing file — a bg-agents extension with no
 * spawnable pi entry cannot launch anything, so failing loud at `session_start`
 * beats every `bg_task` silently erroring later. The message names the override
 * env so an operator can recover.
 */
export function resolvePiCliPath(): string {
	const candidates: Array<{ source: string; path: string | undefined }> = [];

	// (1) explicit override.
	const override = process.env[CLI_OVERRIDE_ENV];
	if (override && override.length > 0) {
		candidates.push({ source: CLI_OVERRIDE_ENV, path: override });
	}

	// (2) import.meta.resolve → cli.js beside index.js.
	try {
		const indexUrl = import.meta.resolve(PI_PACKAGE);
		const indexPath = fromFileUrl(indexUrl);
		candidates.push({
			source: "import.meta.resolve",
			path: indexPath.replace(/index\.js$/, "cli.js"),
		});
	} catch {
		// resolve can throw in pathological environments; fall through to (3).
	}

	// (3) package.json subpath → <pkgDir>/dist/cli.js.
	try {
		const require_ = createRequire(import.meta.url);
		const pkgJson = require_.resolve(`${PI_PACKAGE}/package.json`);
		candidates.push({
			source: "createRequire(package.json)",
			path: join(dirname(pkgJson), "dist", "cli.js"),
		});
	} catch {
		// not resolvable here either; the throw below reports it.
	}

	for (const { path } of candidates) {
		if (path && existsSync(path)) {
			return path;
		}
	}

	const tried = candidates
		.map((c) => `${c.source}=${c.path ?? "(unresolved)"}`)
		.join(", ");
	throw new Error(
		`pi-drawer-agents: could not resolve a spawnable pi CLI (dist/cli.js). ` +
			`Tried: ${tried || "(no candidates)"}. ` +
			`Set $${CLI_OVERRIDE_ENV} to the absolute path of the installed pi ` +
			`dist/cli.js.`,
	);
}
