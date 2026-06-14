import type { FsFacade } from "@drawers/pi-core";
import { type SkillInfo, scanSkillCatalog } from "./skill-catalog";

/**
 * Thrown when a requested skill name resolves to no installed skill. The
 * binding is an authoring bug (a typo that binds nothing), so the resolver
 * fails loudly rather than emitting an empty part — the deliberate contrast
 * with `contextDiff`, where empty is a legitimate runtime state.
 *
 * When the scan found SKILL.md files it could NOT read, the message names them
 * too: "not installed" and "installed but unreadable" are different bugs (a
 * typo vs. a permission/content problem), and a misleading "Installed skills:
 * (none)" would send the author hunting the wrong one.
 */
export class SkillNotFoundError extends Error {
	constructor(
		public readonly name: string,
		public readonly available: string[],
		unreadable: Array<{ path: string; error: string }> = [],
	) {
		const unreadableSeg =
			unreadable.length > 0
				? ` Additionally, ${unreadable.length} SKILL.md file${
						unreadable.length === 1 ? " was" : "s were"
					} found but UNREADABLE (present on disk, not missing): ${unreadable
						.map((u) => `${u.path} (${u.error})`)
						.join("; ")}.`
				: "";
		super(
			`Unknown skill: "${name}". Installed skills: ${
				available.length > 0 ? available.join(", ") : "(none)"
			}.${unreadableSeg}`,
		);
		this.name = "SkillNotFoundError";
	}
}

const STANDING_INSTRUCTION = [
	"The following skill is available for this task. Its bundled resources live under",
	"the skill dir below; read sibling files (e.g. shared-patterns/*.md) by relative",
	"path from that dir when the body references them.",
].join("\n");

/** Escape the XML-active characters for an attribute value (quotes included). */
function escapeAttr(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/** Escape `<`/`&` in element text so it cannot open or close a frame tag. */
function escapeText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

/** Neutralize any literal `</skill>` in a body so it cannot close the frame. */
function neutralizeBody(body: string): string {
	return body.replace(/<\/(skill)>/gi, "<\\/$1>");
}

/** Index a scanned skill list by canonical name. */
function indexByName(skills: SkillInfo[]): Map<string, SkillInfo> {
	const byName = new Map<string, SkillInfo>();
	for (const skill of skills) {
		byName.set(skill.name, skill);
	}
	return byName;
}

/** Frame a resolved skill into the fixed contextPart text shape (Epic 2.1). */
function frameSkill(skill: SkillInfo): string {
	return [
		`<skill name="${escapeAttr(skill.name)}">`,
		`<description>${escapeText(skill.description)}</description>`,
		STANDING_INSTRUCTION,
		"",
		`<skill-dir>${escapeText(skill.dir)}</skill-dir>`,
		"",
		neutralizeBody(skill.body),
		"</skill>",
	].join("\n");
}

/**
 * Resolve canonical skill names to synthetic text contextParts, one per name in
 * request order. Each part carries the framed `SKILL.md` body (frontmatter
 * stripped) plus the skill's absolute dir, ready to ride a synthetic part onto a
 * child launch exactly like `contextDiff` does.
 *
 * Disk access lives in the catalog scan (the plugin layer), never in the
 * runtime — and the scanned catalog already carries each SKILL.md body, so
 * resolution performs NO reads of its own (no rescan-plus-re-read per call; the
 * scan itself is TTL-cached per (fs, roots)). A requested name missing from the
 * cached catalog triggers ONE fresh rescan before failing — the cache TTL is a
 * perf knob, never a correctness gate. An unknown name then throws
 * {@link SkillNotFoundError} — fail-loud, never skip or emit empty — and the
 * error names any SKILL.md the scan found but could not read, so an unreadable
 * skill is reported as unreadable, not as uninstalled. Repeated names are NOT
 * de-duped (the author's call).
 */
export async function resolveSkillParts(
	names: string[],
	deps: { directory: string; fs?: FsFacade; configDir?: string },
): Promise<Array<{ type: "text"; text: string; synthetic: true }>> {
	let { skills, unreadable } = await scanSkillCatalog(deps);
	let byName = indexByName(skills);
	// Rescan-on-miss: a missing name may be CACHE STALENESS (a skill installed
	// after the cached walk), not a typo. Bypass the TTL exactly ONCE — a fresh
	// walk that also refreshes the cache entry — and fail loud only if the name
	// is still missing against current disk truth. The TTL stays a perf knob;
	// it can no longer fail a run.
	if (names.some((name) => !byName.has(name))) {
		({ skills, unreadable } = await scanSkillCatalog({ ...deps, fresh: true }));
		byName = indexByName(skills);
	}

	const parts: Array<{ type: "text"; text: string; synthetic: true }> = [];
	for (const name of names) {
		const skill = byName.get(name);
		if (skill === undefined) {
			throw new SkillNotFoundError(
				name,
				skills.map((s) => s.name),
				unreadable,
			);
		}
		parts.push({
			type: "text",
			text: frameSkill(skill),
			synthetic: true,
		});
	}
	return parts;
}
