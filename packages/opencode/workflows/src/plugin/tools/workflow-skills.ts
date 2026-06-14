/**
 * `workflow_skills` — list the skills installed in this opencode environment by
 * canonical name (Task 1.2.1).
 *
 * Skills are invisible to the SDK's delegation context (unlike agents, which the
 * parent already sees), so the authoring model has no way to learn their exact,
 * namespaced names without reading `SKILL.md` files off disk. This tool is a thin
 * renderer over {@link loadSkillCatalog} (the shared disk-scan from Epic 1.1): it
 * lists each skill as `${name} — ${description}` so a workflow author can bind the
 * right one via the `skills` option on `agent()` (the option lands in Phase 2; the
 * description naming it now is intentional forward guidance and harmless until then).
 *
 * Pure-render, fs-injectable: the disk access lives entirely in the catalog module,
 * keeping this tool unit-testable with an in-memory facade.
 */

import type { FsFacade } from "@drawers/core";
import { tool } from "@opencode-ai/plugin";
import { loadSkillCatalog } from "../skill-catalog";
import { oneLine } from "../text";

export interface WorkflowSkillsToolDeps {
	/** Project directory — the project `.opencode/skill` root resolution base. */
	directory: string;
	/** Injectable fs facade; tests pass in-memory. Defaults to node:fs/promises. */
	fs?: FsFacade;
}

/** Per-skill description cap: keep a many-skill catalog scannable on one line each. */
const DESCRIPTION_CAP = 200;

/**
 * The model-facing description: what the tool is and exactly when to reach for it.
 * It names the Phase-2 `skills` option deliberately so the author learns the full
 * loop (discover names here → bind them there) the moment that option exists.
 */
export const WORKFLOW_SKILLS_DESCRIPTION =
	"List the skills installed in this opencode environment, by canonical name. " +
	"Call this before authoring a workflow whose steps should bind a skill (the " +
	"`skills` option on `agent()`), so you use exact, valid skill names.";

export function createWorkflowSkillsTool(deps: WorkflowSkillsToolDeps) {
	const { directory, fs } = deps;

	return tool({
		description: WORKFLOW_SKILLS_DESCRIPTION,
		args: {
			filter: tool.schema
				.string()
				.optional()
				.describe(
					"case-insensitive substring filter over skill name + description",
				),
		},
		async execute(args) {
			const skills = await loadSkillCatalog({ directory, fs });
			if (skills.length === 0) {
				return "No skills are installed (looked under the user and project .opencode/skill roots).";
			}

			const filter = typeof args.filter === "string" ? args.filter.trim() : "";
			const matched =
				filter.length === 0
					? skills
					: skills.filter((s) => {
							const needle = filter.toLowerCase();
							return (
								s.name.toLowerCase().includes(needle) ||
								s.description.toLowerCase().includes(needle)
							);
						});

			if (matched.length === 0) {
				return `No skills match the filter "${filter}".`;
			}

			const header = `${matched.length} skill${matched.length === 1 ? "" : "s"} installed:`;
			const lines = matched.map(
				(s) => `${s.name} — ${oneLine(s.description, DESCRIPTION_CAP)}`,
			);
			return [header, ...lines].join("\n");
		},
	});
}
