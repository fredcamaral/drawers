import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeFsFacade } from "./fs";

describe("nodeFsFacade", () => {
	let dir: string;
	const fs = nodeFsFacade();

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "drawers-fs-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("returns the same singleton on every call", () => {
		expect(nodeFsFacade()).toBe(fs);
	});

	test("write/read/readdir/rename/rm round-trip", async () => {
		const a = join(dir, "a.txt");
		const b = join(dir, "b.txt");
		await fs.writeFile(a, "hello", "utf-8");
		expect(await fs.readFile(a, "utf-8")).toBe("hello");
		await fs.rename(a, b);
		expect(await fs.readdir(dir)).toEqual(["b.txt"]);
		await fs.rm(b, { force: true });
		expect(await fs.readdir(dir)).toEqual([]);
		// force-rm of an absent file is a no-op, not a throw.
		await fs.rm(b, { force: true });
	});

	test("mkdir recursive creates nested directories", async () => {
		const nested = join(dir, "x", "y", "z");
		await fs.mkdir(nested, { recursive: true });
		await fs.writeFile(join(nested, "f.txt"), "ok", "utf-8");
		expect(await fs.readFile(join(nested, "f.txt"), "utf-8")).toBe("ok");
	});

	test("appendFile appends without clobbering prior content", async () => {
		const p = join(dir, "log.jsonl");
		expect(fs.appendFile).toBeDefined();
		await fs.appendFile?.(p, "one\n", "utf-8");
		await fs.appendFile?.(p, "two\n", "utf-8");
		expect(await fs.readFile(p, "utf-8")).toBe("one\ntwo\n");
	});

	test("stat classifies files vs directories (follows symlinks)", async () => {
		const file = join(dir, "f.txt");
		await fs.writeFile(file, "x", "utf-8");
		const sub = join(dir, "sub");
		await fs.mkdir(sub, { recursive: true });
		const link = join(dir, "link-to-sub");
		await symlink(sub, link);

		expect(fs.stat).toBeDefined();
		expect((await fs.stat?.(file))?.isDirectory()).toBe(false);
		expect((await fs.stat?.(sub))?.isDirectory()).toBe(true);
		// stat FOLLOWS the symlink: a link to a dir reads as a dir.
		expect((await fs.stat?.(link))?.isDirectory()).toBe(true);
		await expect(fs.stat?.(join(dir, "missing"))).rejects.toThrow();
	});

	test("lstat does NOT follow symlinks and flags them", async () => {
		const sub = join(dir, "sub");
		await fs.mkdir(sub, { recursive: true });
		const link = join(dir, "link-to-sub");
		await symlink(sub, link);

		expect(fs.lstat).toBeDefined();
		const linkStat = await fs.lstat?.(link);
		expect(linkStat?.isSymbolicLink()).toBe(true);
		expect(linkStat?.isDirectory()).toBe(false);
		const dirStat = await fs.lstat?.(sub);
		expect(dirStat?.isSymbolicLink()).toBe(false);
		expect(dirStat?.isDirectory()).toBe(true);
	});

	test("realpath resolves a symlink to its canonical target", async () => {
		const sub = join(dir, "sub");
		await fs.mkdir(sub, { recursive: true });
		const link = join(dir, "link-to-sub");
		await symlink(sub, link);

		expect(fs.realpath).toBeDefined();
		const canonicalSub = await fs.realpath?.(sub);
		const viaLink = await fs.realpath?.(link);
		expect(viaLink).toBe(canonicalSub as string);
	});
});
