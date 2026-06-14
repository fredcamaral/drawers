/**
 * Agent resolver — maps a pi agent NAME to the pi-native child knobs.
 *
 * pi 0.79.3 has NO `--agent` flag. The "agent" concept is resolved by the CALLER
 * (here), exactly as the pi subagent example does: an agent is a markdown file
 * with optional YAML frontmatter (`model`, `tools`) and a body that becomes the
 * appended system prompt. We look the name up in pi's standard agent locations
 * — verified against
 * `.references/pi/packages/coding-agent/examples/extensions/subagent/agents.ts`
 * (`discoverAgents`):
 *   - PROJECT: the nearest `.pi/agents/<name>.md` walking up from `cwd`;
 *   - USER:    `<getAgentDir()>/agents/<name>.md` (i.e. `~/.pi/agent/agents`,
 *     `getAgentDir` honoring `$PI_AGENT_DIR`).
 * Project wins over user when both define the same name (the example's `"both"`
 * scope sets user first, then overwrites with project).
 *
 * The resolved knobs are threaded into the runner's {@link LaunchRequest} as
 * `appendSystemPrompt`/`tools`/`model`. If the name is absent OR does not resolve
 * to a file, we return `undefined` and the child runs pi's DEFAULT coding
 * assistant (no append, no error) — resolution failure is NOT a launch failure.
 *
 * Frontmatter parsing reuses pi's own `parseFrontmatter` so the body/tomatter
 * split matches pi exactly (the example does the same). Unlike the example we do
 * NOT require `name`/`description` frontmatter: a bare-body agent file still
 * yields a usable system prompt.
 *
 * Node-safe: no Bun.* APIs. fs/dir resolution is injected so unit tests stay
 * hermetic (no real `~/.pi`).
 */

import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

/** The pi-native child knobs an agent definition resolves to. */
export interface ResolvedAgent {
	/** The markdown body → child `--append-system-prompt`. */
	appendSystemPrompt: string;
	/** The `tools` frontmatter (CSV → array) → child `--tools`. Absent when unset. */
	tools?: string[];
	/** The `model` frontmatter → child `--model`. Absent when unset. */
	model?: string;
	/** Absolute path of the resolved file, for diagnostics. */
	filePath: string;
	/** Where it resolved. */
	source: "project" | "user";
}

/** Injected filesystem + dir-resolution seam (defaults to the real pi locations). */
export interface AgentResolverDeps {
	/** Reads a UTF-8 file, or throws ENOENT-style if absent. */
	readFile?: (path: string) => string;
	existsDir?: (path: string) => boolean;
	/** User agents dir. Defaults to `<getAgentDir()>/agents`. */
	userAgentsDir?: string;
}

const md = (name: string): string => `${name}.md`;

function defaultReadFile(path: string): string {
	return fs.readFileSync(path, "utf-8");
}

function defaultExistsDir(path: string): boolean {
	try {
		return fs.statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** Read + parse one candidate agent file → knobs, or `undefined` if unreadable. */
function loadAgentFile(
	filePath: string,
	source: "project" | "user",
	readFile: (path: string) => string,
): ResolvedAgent | undefined {
	let content: string;
	try {
		content = readFile(filePath);
	} catch {
		return undefined; // absent / unreadable → not resolved here
	}
	const { frontmatter, body } =
		parseFrontmatter<Record<string, unknown>>(content);
	const rawTools = frontmatter.tools;
	const tools =
		typeof rawTools === "string"
			? rawTools
					.split(",")
					.map((t) => t.trim())
					.filter(Boolean)
			: undefined;
	const model =
		typeof frontmatter.model === "string" && frontmatter.model.length > 0
			? frontmatter.model
			: undefined;
	return {
		appendSystemPrompt: body,
		tools: tools && tools.length > 0 ? tools : undefined,
		model,
		filePath,
		source,
	};
}

/**
 * Resolve an agent NAME to its pi-native knobs. Returns `undefined` when:
 *   - `name` is absent/empty (the bg_task default), or
 *   - no `.pi/agents/<name>.md` (project) nor `<userAgentsDir>/<name>.md` exists.
 * Project resolution wins over user. A resolved file with an empty body yields an
 * empty `appendSystemPrompt` — still a valid resolution (the model/tools knobs may
 * be the point), and the runner simply emits `--append-system-prompt ""`.
 */
export function resolveAgent(
	name: string | undefined,
	cwd: string,
	deps: AgentResolverDeps = {},
): ResolvedAgent | undefined {
	if (!name || name.length === 0) {
		return undefined;
	}
	const readFile = deps.readFile ?? defaultReadFile;
	const existsDir = deps.existsDir ?? defaultExistsDir;
	const userAgentsDir = deps.userAgentsDir ?? join(getAgentDir(), "agents");

	// Project: nearest ancestor `.pi/agents` from cwd up to (and including) home,
	// then root. Mirrors the example's findNearestProjectAgentsDir walk.
	const projectDir = findNearestProjectAgentsDir(cwd, existsDir);
	if (projectDir) {
		const fromProject = loadAgentFile(
			join(projectDir, md(name)),
			"project",
			readFile,
		);
		if (fromProject) {
			return fromProject;
		}
	}

	// User: <getAgentDir()>/agents/<name>.md.
	return loadAgentFile(join(userAgentsDir, md(name)), "user", readFile);
}

/** Walk up from `cwd` to the nearest existing `.pi/agents` dir (or null). */
function findNearestProjectAgentsDir(
	cwd: string,
	existsDir: (path: string) => boolean,
): string | null {
	let current = cwd;
	while (true) {
		const candidate = join(current, ".pi", "agents");
		if (existsDir(candidate)) {
			return candidate;
		}
		const parent = dirname(current);
		// dirname() of the filesystem root returns the root again — stop there.
		if (parent === current) {
			return null;
		}
		current = parent;
	}
}
