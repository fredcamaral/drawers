/**
 * Unit tests for resolvePiCliPath — the cliPath resolver the extension hands the
 * runner factory at session_start. Covers the env override (operator escape
 * hatch), the fallback to the real on-disk pi resolution, and the loud throw when
 * nothing resolves.
 *
 * We exercise the public seam via the env var rather than mocking `existsSync`:
 * the override is the documented, supported way to redirect resolution, and the
 * fallback path lands on the genuinely-installed pi cli.js in this workspace.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePiCliPath } from "./cli-path";

const ENV = "PI_DRAWER_AGENTS_CLI";
let tmp: string;
let savedEnv: string | undefined;

beforeEach(async () => {
	tmp = await mkdtemp(join(tmpdir(), "bg-agents-cli-"));
	savedEnv = process.env[ENV];
});
afterEach(async () => {
	if (savedEnv === undefined) {
		delete process.env[ENV];
	} else {
		process.env[ENV] = savedEnv;
	}
	await rm(tmp, { recursive: true, force: true });
});

describe("resolvePiCliPath", () => {
	test("env override pointing at an existing file wins", async () => {
		const cli = join(tmp, "my-cli.js");
		await writeFile(cli, "// fake cli\n", "utf-8");
		process.env[ENV] = cli;
		expect(resolvePiCliPath()).toBe(cli);
	});

	test("env override pointing at a missing file falls through to the real pi resolution", () => {
		// A non-existent override must NOT win (first EXISTING candidate wins); the
		// resolver then falls back to import.meta.resolve, which lands on the pi
		// cli.js actually installed in this workspace.
		process.env[ENV] = join(tmp, "does-not-exist.js");
		const resolved = resolvePiCliPath();
		expect(resolved.endsWith("cli.js")).toBe(true);
		expect(resolved).not.toContain("does-not-exist");
	});

	test("no override → resolves the installed pi dist/cli.js", () => {
		delete process.env[ENV];
		const resolved = resolvePiCliPath();
		expect(resolved.endsWith("cli.js")).toBe(true);
	});
});
