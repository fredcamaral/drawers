import { describe, expect, test } from "bun:test";
import type { FsFacade } from "@drawers/core";
import { loadSkillCatalog, scanSkillCatalog } from "./skill-catalog";
import { nodeFs } from "./tools/workflow";

/**
 * An in-memory {@link FsFacade} over a flat `path -> content` map. Directories are
 * implicit (any path that is a strict prefix of a stored file's path, split on
 * `/`). `readdir` lists the immediate child names of a dir and THROWS on a file
 * path or an unknown path — mirroring how the real facade lets the catalog
 * distinguish dirs from files (a `readdir` throw means "this is a file").
 */
function memFs(files: Record<string, string>): FsFacade {
	const has = (p: string) => Object.hasOwn(files, p);
	const norm = (p: string) => (p.endsWith("/") ? p.slice(0, -1) : p);
	return {
		mkdir: async () => undefined,
		writeFile: async (path, data) => {
			files[path] = data;
		},
		rename: async () => undefined,
		rm: async () => undefined,
		readFile: async (path) => {
			const content = files[path];
			if (content === undefined) {
				throw new Error(`ENOENT: ${path}`);
			}
			return content;
		},
		readdir: async (path) => {
			const dir = norm(path);
			if (has(dir)) {
				// It is a file, not a directory.
				throw new Error(`ENOTDIR: ${dir}`);
			}
			const prefix = `${dir}/`;
			const children = new Set<string>();
			for (const full of Object.keys(files)) {
				if (full.startsWith(prefix)) {
					const rest = full.slice(prefix.length);
					const name = rest.split("/")[0];
					if (name) {
						children.add(name);
					}
				}
			}
			if (children.size === 0) {
				throw new Error(`ENOENT: ${dir}`);
			}
			return [...children];
		},
	};
}

/** Wrap a facade counting readdir/readFile invocations (cache + walk-cost probes). */
function countingFs(inner: FsFacade): FsFacade & {
	counts: { readdir: number; readFile: number };
} {
	const counts = { readdir: 0, readFile: 0 };
	return {
		...inner,
		counts,
		readdir: (path) => {
			counts.readdir += 1;
			return inner.readdir(path);
		},
		readFile: (path, enc) => {
			counts.readFile += 1;
			return inner.readFile(path, enc);
		},
	};
}

const USER = "/home/u/.config/opencode/skill";
const PROJECT = "/proj/.opencode/skill";

function run(files: Record<string, string>) {
	return loadSkillCatalog({
		directory: "/proj",
		configDir: USER,
		fs: memFs(files),
	});
}

describe("loadSkillCatalog", () => {
	test("parses a valid SKILL.md (name, description, dir, source, body)", async () => {
		const skills = await run({
			[`${USER}/pm-team/writing-trds/SKILL.md`]: [
				"---",
				"name: ring:writing-trds",
				'description: "Write technical requirement docs"',
				"---",
				"# Writing TRDs",
				"body",
			].join("\n"),
		});
		expect(skills).toHaveLength(1);
		expect(skills[0]).toEqual({
			name: "ring:writing-trds",
			description: "Write technical requirement docs",
			dir: `${USER}/pm-team/writing-trds`,
			source: "user",
			body: "# Writing TRDs\nbody",
		});
	});

	test("excludes non-SKILL.md files like shared-patterns/foo.md", async () => {
		const skills = await run({
			[`${USER}/dev-team/x/shared-patterns/foo.md`]: [
				"---",
				"name: should-not-load",
				"---",
				"body",
			].join("\n"),
		});
		expect(skills).toEqual([]);
	});

	test("skips a SKILL.md with no frontmatter block", async () => {
		const skills = await run({
			[`${USER}/team/no-fm/SKILL.md`]: "# No frontmatter here\njust a body",
		});
		expect(skills).toEqual([]);
	});

	test("skips a SKILL.md with frontmatter but no name", async () => {
		const skills = await run({
			[`${USER}/team/no-name/SKILL.md`]: [
				"---",
				'description: "has a description but no name"',
				"---",
				"body",
			].join("\n"),
		});
		expect(skills).toEqual([]);
	});

	test("project skill overrides a same-named user skill (precedence)", async () => {
		const skills = await run({
			[`${USER}/team/dup/SKILL.md`]: [
				"---",
				"name: ring:dup",
				'description: "user version"',
				"---",
			].join("\n"),
			[`${PROJECT}/team/dup/SKILL.md`]: [
				"---",
				"name: ring:dup",
				'description: "project version"',
				"---",
			].join("\n"),
		});
		expect(skills).toHaveLength(1);
		expect(skills[0]).toEqual({
			name: "ring:dup",
			description: "project version",
			dir: `${PROJECT}/team/dup`,
			source: "project",
			body: "",
		});
	});

	test("missing root degrades to empty, never throws", async () => {
		// No skill files at all → both roots' readdir throws → empty result.
		await expect(run({})).resolves.toEqual([]);
	});

	test("sorts by name and parses bare (unquoted) description values", async () => {
		const skills = await run({
			[`${USER}/a/zebra/SKILL.md`]: [
				"---",
				"name: ring:zebra",
				"description: bare value to end of line",
				"---",
			].join("\n"),
			[`${USER}/a/alpha/SKILL.md`]: ["---", "name: ring:alpha", "---"].join(
				"\n",
			),
		});
		expect(skills.map((s) => s.name)).toEqual(["ring:alpha", "ring:zebra"]);
		expect(skills[0]?.description).toBe("");
		expect(skills[1]?.description).toBe("bare value to end of line");
	});

	test("folded block scalar (description: >) joins continuation lines with spaces", async () => {
		const skills = await run({
			[`${USER}/a/folded/SKILL.md`]: [
				"---",
				"name: ring:folded",
				"description: >",
				"  Use when the user wants a deep,",
				"  multi-source research report.",
				"---",
				"body",
			].join("\n"),
		});
		expect(skills[0]?.description).toBe(
			"Use when the user wants a deep, multi-source research report.",
		);
	});

	test("folded block scalar with chomping indicator (description: >-)", async () => {
		const skills = await run({
			[`${USER}/a/chomped/SKILL.md`]: [
				"---",
				"name: ring:chomped",
				"description: >-",
				"  First line",
				"  second line",
				"---",
			].join("\n"),
		});
		expect(skills[0]?.description).toBe("First line second line");
	});

	test("literal block scalar (description: |) keeps lines, joined by newlines", async () => {
		const skills = await run({
			[`${USER}/a/literal/SKILL.md`]: [
				"---",
				"name: ring:literal",
				"description: |",
				"  line one",
				"  line two",
				"---",
			].join("\n"),
		});
		expect(skills[0]?.description).toBe("line one\nline two");
	});

	test("block scalar stops at the next same-indent key", async () => {
		const skills = await run({
			[`${USER}/a/stops/SKILL.md`]: [
				"---",
				"description: >",
				"  the folded value",
				"name: ring:stops",
				"---",
			].join("\n"),
		});
		expect(skills[0]?.name).toBe("ring:stops");
		expect(skills[0]?.description).toBe("the folded value");
	});

	test("depth cap: a SKILL.md at depth 8 is found, at depth 9 is not", async () => {
		const at8 = `${USER}/${"d/".repeat(7)}skill8`; // 8 dirs below the root
		const at9 = `${USER}/${"d/".repeat(8)}skill9`; // 9 dirs below the root
		const skills = await run({
			[`${at8}/SKILL.md`]: ["---", "name: ring:depth8", "---"].join("\n"),
			[`${at9}/SKILL.md`]: ["---", "name: ring:depth9", "---"].join("\n"),
		});
		expect(skills.map((s) => s.name)).toEqual(["ring:depth8"]);
	});

	test("an unbounded dir tree (symlink-cycle shape) terminates instead of hanging", async () => {
		// Every readdir returns one subdir — the in-memory analogue of a cyclic
		// symlink, an infinite virtual tree. The depth cap must bound the walk.
		let readdirs = 0;
		const cyclic: FsFacade = {
			mkdir: async () => undefined,
			writeFile: async () => undefined,
			rename: async () => undefined,
			rm: async () => undefined,
			readFile: async (path) => {
				throw new Error(`ENOENT: ${path}`);
			},
			readdir: async () => {
				readdirs += 1;
				return ["loop"];
			},
		};
		const skills = await loadSkillCatalog({
			directory: "/proj",
			configDir: USER,
			fs: cyclic,
		});
		expect(skills).toEqual([]);
		// 2 roots × a single-branch chain capped at depth 8 → strictly bounded.
		expect(readdirs).toBeLessThan(50);
	});

	test("skips the user root when configDir, XDG_CONFIG_HOME, and HOME are all unset", async () => {
		const savedXdg = process.env.XDG_CONFIG_HOME;
		const savedHome = process.env.HOME;
		delete process.env.XDG_CONFIG_HOME;
		delete process.env.HOME;
		const inner = memFs({
			[`${PROJECT}/team/here/SKILL.md`]: ["---", "name: ring:here", "---"].join(
				"\n",
			),
		});
		const seen: string[] = [];
		const spied: FsFacade = {
			...inner,
			readdir: (path) => {
				seen.push(path);
				return inner.readdir(path);
			},
		};
		try {
			const skills = await loadSkillCatalog({ directory: "/proj", fs: spied });
			expect(skills.map((s) => s.name)).toEqual(["ring:here"]);
			// No fabricated "undefined/.config/..." root was ever scanned.
			expect(seen.some((p) => p.startsWith("undefined/"))).toBe(false);
		} finally {
			if (savedXdg !== undefined) process.env.XDG_CONFIG_HOME = savedXdg;
			if (savedHome !== undefined) process.env.HOME = savedHome;
		}
	});

	test("rescans are cached per (fs, roots) within the TTL and re-walked after it", async () => {
		const files: Record<string, string> = {
			[`${USER}/a/one/SKILL.md`]: ["---", "name: ring:one", "---"].join("\n"),
		};
		const fs = countingFs(memFs(files));
		const deps = (now: number) => ({
			directory: "/proj",
			configDir: USER,
			fs,
			now: () => now,
		});

		expect(await loadSkillCatalog(deps(0))).toHaveLength(1);
		const walked = fs.counts.readdir;
		expect(walked).toBeGreaterThan(0);

		// Within the TTL: served from cache — zero additional fs traffic, and a
		// skill added after the scan is intentionally NOT visible yet.
		files[`${USER}/a/two/SKILL.md`] = ["---", "name: ring:two", "---"].join(
			"\n",
		);
		expect(await loadSkillCatalog(deps(1_000))).toHaveLength(1);
		expect(fs.counts.readdir).toBe(walked);

		// Past the TTL: a fresh walk picks the new skill up.
		expect((await loadSkillCatalog(deps(10_000))).map((s) => s.name)).toEqual([
			"ring:one",
			"ring:two",
		]);
		expect(fs.counts.readdir).toBeGreaterThan(walked);
	});

	test("fresh: true bypasses the TTL and refreshes the cache entry", async () => {
		const files: Record<string, string> = {
			[`${USER}/a/one/SKILL.md`]: ["---", "name: ring:one", "---"].join("\n"),
		};
		const fs = countingFs(memFs(files));
		const deps = (now: number, fresh?: boolean) => ({
			directory: "/proj",
			configDir: USER,
			fs,
			now: () => now,
			fresh,
		});

		expect(await loadSkillCatalog(deps(0))).toHaveLength(1);
		const afterFirst = fs.counts.readdir;

		// Installed after the cached walk, requested within the TTL — but fresh
		// bypasses the cache and sees it.
		files[`${USER}/a/two/SKILL.md`] = ["---", "name: ring:two", "---"].join(
			"\n",
		);
		expect(await loadSkillCatalog(deps(1_000, true))).toHaveLength(2);
		expect(fs.counts.readdir).toBeGreaterThan(afterFirst);
		const afterFresh = fs.counts.readdir;

		// The fresh scan REPLACED the cache entry: a non-fresh call inside the
		// TTL serves the refreshed result with zero additional fs traffic.
		expect(await loadSkillCatalog(deps(1_500))).toHaveLength(2);
		expect(fs.counts.readdir).toBe(afterFresh);
	});

	test("real fs: a cyclic symlink under the skill root terminates via the realpath visited-set", async () => {
		const { mkdir, mkdtemp, rm, symlink, writeFile } = await import(
			"node:fs/promises"
		);
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");

		const tmp = await mkdtemp(join(tmpdir(), "skill-cycle-"));
		try {
			const team = join(tmp, ".opencode/skill/team");
			const alpha = join(team, "alpha");
			await mkdir(alpha, { recursive: true });
			await writeFile(
				join(alpha, "SKILL.md"),
				["---", "name: ring:alpha", "---", "body"].join("\n"),
				"utf-8",
			);
			// The cycle: team/loop -> team. readdir follows symlinks, so without a
			// guard the walk re-enters team through loop on every level.
			await symlink(team, join(team, "loop"));

			const real = nodeFs();
			let readdirs = 0;
			const counting: FsFacade = {
				...real,
				readdir: (path) => {
					readdirs += 1;
					return real.readdir(path);
				},
			};
			const skills = await loadSkillCatalog({
				directory: tmp,
				configDir: join(tmp, "no-user-root"),
				fs: counting,
			});
			// The skill is found exactly once, and the walk visited each REAL dir
			// once — a guardless walk would re-list team through the symlink chain
			// (ELOOP-bounded at dozens of levels), not stay in single digits.
			expect(skills.map((s) => s.name)).toEqual(["ring:alpha"]);
			expect(readdirs).toBeLessThanOrEqual(10);
		} finally {
			await rm(tmp, { recursive: true, force: true });
		}
	});

	test("distinct fs facades never share a cache entry", async () => {
		const a = await run({
			[`${USER}/a/x/SKILL.md`]: ["---", "name: ring:a", "---"].join("\n"),
		});
		const b = await run({
			[`${USER}/a/x/SKILL.md`]: ["---", "name: ring:b", "---"].join("\n"),
		});
		expect(a.map((s) => s.name)).toEqual(["ring:a"]);
		expect(b.map((s) => s.name)).toEqual(["ring:b"]);
	});
});

describe("scanSkillCatalog", () => {
	test("records a found-but-unreadable SKILL.md instead of silently skipping it", async () => {
		const inner = memFs({
			[`${USER}/team/locked/SKILL.md`]: "irrelevant — the read is blocked",
			[`${USER}/team/open/SKILL.md`]: ["---", "name: ring:open", "---"].join(
				"\n",
			),
		});
		const locked = `${USER}/team/locked/SKILL.md`;
		const fs: FsFacade = {
			...inner,
			readFile: (path, enc) => {
				if (path === locked) {
					throw new Error(`EACCES: permission denied, open '${locked}'`);
				}
				return inner.readFile(path, enc);
			},
		};
		const scan = await scanSkillCatalog({
			directory: "/proj",
			configDir: USER,
			fs,
		});
		expect(scan.skills.map((s) => s.name)).toEqual(["ring:open"]);
		expect(scan.unreadable).toHaveLength(1);
		expect(scan.unreadable[0]?.path).toBe(locked);
		expect(scan.unreadable[0]?.error).toContain("EACCES");
	});
});
