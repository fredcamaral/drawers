/**
 * `workflow_skills` — list the skills installed in this pi environment by
 * canonical name (Task 1.2.1, pi port).
 *
 * Skills are invisible to the model's delegation context (unlike agents), so the
 * authoring model has no way to learn their exact, namespaced names without
 * reading `SKILL.md` files off disk. This tool is a thin renderer over
 * {@link loadSkillCatalog} (the shared disk-scan from Epic 1.1): it lists each
 * skill as `${name} — ${description}` so a workflow author can bind the right one
 * via the `skills` option on `agent()`.
 *
 * Pure-render, fs-injectable: the disk access lives entirely in the catalog
 * module, keeping this tool unit-testable with an in-memory facade. The project
 * `directory` is resolved through a getter (session-scoped, captured at load).
 *
 * Node-safe: no Bun.* APIs.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { FsFacade } from "../fs";
import { loadSkillCatalog } from "../skill-catalog";
import { oneLine } from "../text";

export interface WorkflowSkillsToolDeps {
	/** Project directory — the project `.pi/skill` root resolution base. */
	directory: () => string;
	/** Injectable fs facade; tests pass in-memory. Defaults to node:fs/promises. */
	fs?: FsFacade;
}

/** Per-skill description cap: keep a many-skill catalog scannable on one line each. */
const DESCRIPTION_CAP = 200;

/** A model-readable tool result. */
function text(message: string) {
	return { content: [{ type: "text" as const, text: message }], details: {} };
}

/**
 * The model-facing description: what the tool is and exactly when to reach for it.
 * It names the `skills` option deliberately so the author learns the full loop
 * (discover names here → bind them there).
 */
export const WORKFLOW_SKILLS_DESCRIPTION =
	"List the skills installed in this pi environment, by canonical name. " +
	"Call this before authoring a workflow whose steps should bind a skill (the " +
	"`skills` option on `agent()`), so you use exact, valid skill names.";

export function createWorkflowSkillsTool(deps: WorkflowSkillsToolDeps) {
	const fs = deps.fs;

	return defineTool({
		name: "workflow_skills",
		label: "Workflow skills",
		description: WORKFLOW_SKILLS_DESCRIPTION,
		promptSnippet:
			"List installed skills by canonical name for agent() binding",
		parameters: Type.Object({
			filter: Type.Optional(
				Type.String({
					description:
						"case-insensitive substring filter over skill name + description",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const directory = deps.directory();
			const skills = await loadSkillCatalog({
				directory,
				...(fs !== undefined ? { fs } : {}),
			});
			if (skills.length === 0) {
				return text(
					"No skills are installed (looked under the user and project .pi/skill roots).",
				);
			}

			const filter =
				typeof params.filter === "string" ? params.filter.trim() : "";
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
				return text(`No skills match the filter "${filter}".`);
			}

			const header = `${matched.length} skill${matched.length === 1 ? "" : "s"} installed:`;
			const lines = matched.map(
				(s) => `${s.name} — ${oneLine(s.description, DESCRIPTION_CAP)}`,
			);
			return text([header, ...lines].join("\n"));
		},
	});
}
