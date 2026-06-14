/**
 * pi-drawer-statusline — a compact status line in pi's footer.
 *
 * The pi-native port of opencode-drawer-statusline: one muted line of context —
 * `<dir> | wt <worktree> | branch <branch> | status <state> | pi <version>`.
 *
 * opencode renders this as a TUI slot wrapping the prompt, reading host-cached
 * `api.state` (path/vcs/session/version). pi has no prompt-slot model and exposes
 * no cached vcs state to extensions, so the faithful equivalent is a footer status
 * segment (`ctx.ui.setStatus`) refreshed on the session/agent lifecycle: git facts
 * are read with `pi.exec` and cached between turns; the pi version is read once at
 * session start. `setStatus` is a no-op outside tui/rpc, so no mode guard is needed.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const KEY = "drawer-statusline";

function basename(p: string): string {
	const parts = p.replace(/[/\\]+$/, "").split(/[/\\]+/);
	return parts.at(-1) || p;
}

export default function (pi: ExtensionAPI) {
	let piVersion: string | undefined;
	let branch: string | undefined;
	let worktree: string | undefined;
	let state = "idle";

	const sh = async (
		cmd: string,
		args: string[],
	): Promise<string | undefined> => {
		try {
			const r = await pi.exec(cmd, args);
			return r.code === 0 ? r.stdout.trim() : undefined;
		} catch {
			return undefined;
		}
	};

	const refreshGit = async (cwd: string) => {
		branch = await sh("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
		worktree = await sh("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
	};

	const render = (ctx: ExtensionContext) => {
		const dir = basename(ctx.cwd);
		const segments = [dir];
		if (worktree) {
			const wt = basename(worktree);
			if (wt && wt !== dir) segments.push(`wt ${wt}`);
		}
		if (branch) segments.push(`branch ${branch}`);
		segments.push(`status ${state}`);
		if (piVersion) segments.push(`pi ${piVersion}`);
		ctx.ui.setStatus(KEY, ctx.ui.theme.fg("dim", segments.join(" | ")));
	};

	pi.on("session_start", async (_event, ctx) => {
		// Read the pi version once; "" on failure so we neither retry nor render it.
		if (piVersion === undefined)
			piVersion = (await sh("pi", ["--version"])) ?? "";
		state = "idle";
		await refreshGit(ctx.cwd);
		render(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		state = "working";
		render(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		state = "idle";
		await refreshGit(ctx.cwd); // a turn may have switched branches
		render(ctx);
	});
}
