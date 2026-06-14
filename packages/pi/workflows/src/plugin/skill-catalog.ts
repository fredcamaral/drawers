import { join } from "node:path";
import type { FsFacade } from "@drawers/pi-core";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { nodeFs } from "./fs";
import { joinPath } from "./resolve-source";

/**
 * One installed skill, as discovered by scanning the pi skill roots for
 * `SKILL.md` files and parsing their frontmatter. The shape is the shared
 * contract consumed by the `workflow_skills` discovery tool and the
 * `resolveSkills` embedding seam — both depend on it staying fixed.
 */
export interface SkillInfo {
	/** Frontmatter `name` — the canonical, namespaced id (e.g. "ring:writing-trds"). */
	name: string;
	/** Frontmatter `description`; "" when absent. */
	description: string;
	/** Absolute dir containing SKILL.md — Phase 2 passes this for bundled-resource resolution. */
	dir: string;
	source: "user" | "project";
	/**
	 * The SKILL.md body with the frontmatter block stripped and trimmed. Carried
	 * from the ONE read the scan already performs, so the resolver never re-reads
	 * the file it just cataloged.
	 */
	body: string;
}

/**
 * A full catalog scan: the parsed skills plus every `SKILL.md` the walk FOUND
 * but could not read. The unreadable list is the resolver's fail-loud context —
 * it lets a SkillNotFoundError distinguish "not installed" from "installed but
 * unreadable" instead of misreporting a permission error as a typo.
 */
export interface SkillCatalogScan {
	skills: SkillInfo[];
	unreadable: Array<{ path: string; error: string }>;
}

export interface SkillCatalogDeps {
	/** Project directory — the project `.pi/skill` root resolution base. */
	directory: string;
	/** Injectable fs facade; tests pass in-memory. Defaults to node:fs/promises. */
	fs?: FsFacade;
	/** Override the user skill root (tests). */
	configDir?: string;
	/** Clock seam for the scan cache TTL (tests); defaults to Date.now. */
	now?: () => number;
	/**
	 * Bypass the TTL cache for THIS call: walk the roots now and refresh the
	 * cache entry with the result (so the next call within the TTL is served
	 * from the fresh scan, not a second walk). The resolver uses this once on a
	 * requested-skill miss, making the TTL a pure perf knob — a just-installed
	 * skill resolves immediately instead of fail-louding until the TTL lapses.
	 */
	fresh?: boolean;
}

/**
 * Maximum directory depth scanned below each skill root — the FALLBACK cycle
 * bound for facades without `realpath` (e.g. in-memory test fs). When the
 * facade provides `realpath` (the production node facade does), the walk keeps
 * a visited-set of resolved real paths instead: cyclic symlinks terminate
 * exactly, and legitimate trees deeper than this cap still scan fully.
 */
const MAX_SCAN_DEPTH = 8;

/**
 * Unconditional safety bound, applied even with the realpath visited-set: the
 * set cannot collapse bind-mount loops (each lap mints fresh real paths), and
 * a pathological acyclic tree would otherwise be bounded only by the
 * filesystem. No legitimate skill root nests anywhere near this deep.
 */
const MAX_SCAN_DEPTH_HARD = 32;

/** How long one scan result is reused before the roots are walked again. */
const CATALOG_TTL_MS = 5_000;

/** The default-facade singleton — a stable WeakMap key for the scan cache. */
let defaultFsSingleton: FsFacade | undefined;

function resolveFs(fs: FsFacade | undefined): FsFacade {
	if (fs !== undefined) {
		return fs;
	}
	defaultFsSingleton ??= nodeFs();
	return defaultFsSingleton;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * The user-level pi skill root: `<getAgentDir()>/skill` — i.e. `~/.pi/agent/skill`,
 * with `getAgentDir` honoring `$PI_AGENT_DIR` (the same root resolution the agent
 * resolver uses for `<getAgentDir()>/agents`). `process.env` / pi-helper access is
 * fine here — this is the plugin layer, not the runtime layer. A throw (no HOME, a
 * pi internals drift) degrades to `undefined` (the user root is skipped) rather than
 * fabricating a bogus path and silently scanning nothing.
 */
function resolveUserConfigDir(): string | undefined {
	try {
		const dir = getAgentDir();
		if (typeof dir === "string" && dir.length > 0) {
			return join(dir, "skill");
		}
	} catch {
		// pi internals unavailable / no HOME → skip the user root.
	}
	return undefined;
}

/**
 * Split a SKILL.md into its frontmatter block (the text between the first `---`
 * line and the next) and the body after it (trimmed). Returns undefined when
 * there is no closed frontmatter block — such files are not skills.
 */
function splitFrontmatter(
	content: string,
): { frontmatter: string; body: string } | undefined {
	const lines = content.split("\n");
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]?.trim() === "---") {
			start = i;
			break;
		}
	}
	if (start === -1) {
		return undefined;
	}
	for (let i = start + 1; i < lines.length; i++) {
		if (lines[i]?.trim() === "---") {
			return {
				frontmatter: lines.slice(start + 1, i).join("\n"),
				body: lines
					.slice(i + 1)
					.join("\n")
					.trim(),
			};
		}
	}
	return undefined;
}

/** Strip a single pair of matching surrounding quotes (single or double). */
function unquote(value: string): string {
	if (value.length >= 2) {
		const first = value[0];
		const last = value[value.length - 1];
		if ((first === '"' || first === "'") && first === last) {
			return value.slice(1, -1);
		}
	}
	return value;
}

/** Leading-whitespace width of a raw line (the YAML indentation level proxy). */
function indentOf(raw: string): number {
	return raw.length - raw.trimStart().length;
}

/**
 * A focused line scanner for a single top-level `key: value` in a frontmatter
 * block — avoids a YAML dependency for the two fields we need. Handles plain
 * scalars (trimmed, unquoted) AND block scalars (`>` / `|`, with optional
 * chomping indicators), where the value is the joined run of following lines
 * more indented than the key — folded with spaces for `>`, kept as lines for
 * `|`. Returns undefined when the key is absent.
 */
function scanField(frontmatter: string, key: string): string | undefined {
	const prefix = `${key}:`;
	const lines = frontmatter.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i] ?? "";
		const line = raw.trimStart();
		if (!line.startsWith(prefix)) {
			continue;
		}
		const value = line.slice(prefix.length).trim();
		const blockScalar = /^([>|])[+-]?$/.exec(value);
		if (blockScalar === null) {
			return unquote(value);
		}
		// Block scalar: consume following lines while blank or more indented.
		const keyIndent = indentOf(raw);
		const collected: string[] = [];
		for (let j = i + 1; j < lines.length; j++) {
			const cont = lines[j] ?? "";
			if (cont.trim().length === 0) {
				collected.push("");
				continue;
			}
			if (indentOf(cont) <= keyIndent) {
				break;
			}
			collected.push(cont.trim());
		}
		while (collected.length > 0 && collected[collected.length - 1] === "") {
			collected.pop();
		}
		const folded =
			blockScalar[1] === ">"
				? collected.filter((part) => part.length > 0).join(" ")
				: collected.join("\n");
		return folded.trim();
	}
	return undefined;
}

/** A `SKILL.md` the walk read successfully: its containing dir + raw content. */
interface ScanEntry {
	dir: string;
	content: string;
}

/**
 * Recursively collect every readable file named exactly `SKILL.md` under `dir`,
 * carrying its content out of the walk (one read per skill, ever). A `SKILL.md`
 * child is probed readFile-FIRST — success proves "readable file" with no extra
 * stat call; on failure one `readdir` disambiguates a directory named SKILL.md
 * (ignored) from an unreadable file (recorded in `unreadable`). Other children
 * are classified by attempting `readdir` — the throw-as-stat probe survives
 * there because not every facade offers `stat`/`lstat`.
 *
 * Cycle guard: when `visited` is provided (the facade has `realpath`), every
 * directory's REAL path is registered after its listing succeeds and a revisit
 * returns immediately — a cyclic symlink becomes a no-op instead of an
 * unbounded recursion, bounded only by {@link MAX_SCAN_DEPTH_HARD} (the
 * visited-set cannot collapse bind-mount loops). Registering
 * every dir (not just symlinks) is what makes the guard complete, which is why
 * `lstat` is not needed here: the cycle's re-entry point is always a real path
 * already in the set, however it was reached. Without `realpath` the
 * {@link MAX_SCAN_DEPTH} cap is the fallback bound.
 */
async function walk(
	fs: FsFacade,
	dir: string,
	depth: number,
	found: ScanEntry[],
	unreadable: Array<{ path: string; error: string }>,
	visited: Set<string> | undefined,
): Promise<void> {
	if (depth > (visited === undefined ? MAX_SCAN_DEPTH : MAX_SCAN_DEPTH_HARD)) {
		return;
	}
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch {
		// A plain file, or a missing root — nothing to collect either way.
		return;
	}
	// Guard AFTER the listing: a plain file never costs a realpath, and the
	// guard still fires before any child of a revisited dir is walked again.
	if (visited !== undefined && fs.realpath !== undefined) {
		let real: string;
		try {
			real = await fs.realpath(dir);
		} catch {
			return; // vanished between readdir and realpath — nothing to collect
		}
		if (visited.has(real)) {
			return;
		}
		visited.add(real);
	}
	for (const name of names) {
		const child = joinPath(dir, name);
		if (name === "SKILL.md") {
			try {
				found.push({ dir, content: await fs.readFile(child, "utf-8") });
			} catch (readErr) {
				let isDir = false;
				try {
					await fs.readdir(child);
					isDir = true;
				} catch {
					isDir = false;
				}
				if (!isDir) {
					unreadable.push({ path: child, error: errorMessage(readErr) });
				}
			}
			continue;
		}
		await walk(fs, child, depth + 1, found, unreadable, visited);
	}
}

/** Parse a scanned SKILL.md into a {@link SkillInfo}, or undefined when unusable. */
function parseSkill(
	entry: ScanEntry,
	source: "user" | "project",
): SkillInfo | undefined {
	const split = splitFrontmatter(entry.content);
	if (split === undefined) {
		return undefined;
	}
	const name = scanField(split.frontmatter, "name")?.trim() ?? "";
	if (name.length === 0) {
		return undefined;
	}
	const description = scanField(split.frontmatter, "description") ?? "";
	return { name, description, dir: entry.dir, source, body: split.body };
}

/** The uncached scan: walk both roots, parse, dedupe by name (project wins). */
async function scanRoots(
	fs: FsFacade,
	userRoot: string | undefined,
	projectRoot: string,
): Promise<SkillCatalogScan> {
	const byName = new Map<string, SkillInfo>();
	const unreadable: Array<{ path: string; error: string }> = [];
	// User first, project second: project last-write-wins on a name collision.
	const roots: Array<[string | undefined, "user" | "project"]> = [
		[userRoot, "user"],
		[projectRoot, "project"],
	];
	for (const [root, source] of roots) {
		if (root === undefined) {
			continue;
		}
		// One visited-set PER ROOT: if the two roots alias the same real dir
		// (e.g. a symlinked project root), each must still be scanned under its
		// own source label so project-wins precedence holds.
		const visited =
			typeof fs.realpath === "function" ? new Set<string>() : undefined;
		const found: ScanEntry[] = [];
		await walk(fs, root, 0, found, unreadable, visited);
		for (const entry of found) {
			const skill = parseSkill(entry, source);
			if (skill) {
				byName.set(skill.name, skill);
			}
		}
	}
	return {
		skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
		unreadable,
	};
}

/**
 * The scan memo: keyed by fs facade identity (WeakMap — a test's in-memory fs
 * never collides with another's), then by the resolved root pair. Entries live
 * for {@link CATALOG_TTL_MS}, so a skill-bound `agent()` storm (up to the
 * 1000-agent cap) amortizes to one recursive disk walk per TTL window instead
 * of one per call. The PROMISE is cached, so concurrent resolutions share a
 * single in-flight walk.
 */
const scanCache = new WeakMap<
	FsFacade,
	Map<string, { at: number; scan: Promise<SkillCatalogScan> }>
>();

/**
 * Scan the user + project skill roots, with the per-(fs, roots) TTL cache.
 * The detailed variant of {@link loadSkillCatalog}: same skills, plus the
 * unreadable-SKILL.md list the resolver folds into its fail-loud error.
 */
export function scanSkillCatalog(
	deps: SkillCatalogDeps,
): Promise<SkillCatalogScan> {
	const fs = resolveFs(deps.fs);
	const userRoot = deps.configDir ?? resolveUserConfigDir();
	const projectRoot = joinPath(deps.directory, ".pi/skill");
	const now = deps.now ?? Date.now;

	const cached = scanCache.get(fs);
	const perFs: Map<string, { at: number; scan: Promise<SkillCatalogScan> }> =
		cached ?? new Map();
	if (cached === undefined) {
		scanCache.set(fs, perFs);
	}
	const key = `${userRoot ?? ""} ${projectRoot}`;
	const hit = perFs.get(key);
	if (
		deps.fresh !== true &&
		hit !== undefined &&
		now() - hit.at < CATALOG_TTL_MS
	) {
		return hit.scan;
	}
	const scan = scanRoots(fs, userRoot, projectRoot);
	perFs.set(key, { at: now(), scan });
	// A rejected scan must not be served from cache (scanRoots fences all fs
	// access, so this is a defensive evict, not an expected path).
	scan.catch(() => {
		perFs.delete(key);
	});
	return scan;
}

/**
 * Load every installed skill from the user and project `.pi/skill` roots.
 *
 * Walks each root recursively (depth-capped) for files named exactly `SKILL.md`,
 * parses `name`/`description` from the frontmatter block (plain and `>`/`|`
 * block-scalar values), and skips files with no frontmatter or no `name`.
 * Non-`SKILL.md` resources (e.g. `shared-patterns/*`) are ignored. On a name
 * collision the project skill wins over the user skill. A missing root degrades
 * to nothing — never an error. The result is sorted by `name` for stable output
 * and served from a short-TTL cache per (fs, roots).
 */
export async function loadSkillCatalog(
	deps: SkillCatalogDeps,
): Promise<SkillInfo[]> {
	return (await scanSkillCatalog(deps)).skills;
}
