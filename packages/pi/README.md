# pi plugins

Plugins for [pi](https://pi.dev) — the agent harness whose plugin model is called
**extensions** (`@earendil-works/pi-coding-agent`). These are the pi port of the
opencode drawer set, named `pi-drawer-*`.

| Package | Tools / surface |
|---|---|
| [`core`](core) — `@drawers/pi-core` | Private shared engine: the pi-native `SessionRunner` (one `pi --mode rpc` child per task; `agent_end`+process-exit fused into an exactly-once terminal), persistence, notification queue, concurrency. Not published; consumed by the plugins. |
| [`background-agents`](background-agents) — `pi-drawer-agents` | `bg_task`, `bg_output`, `bg_cancel`, `bg_list` |
| [`workflows`](workflows) — `pi-drawer-workflows` | `workflow`, `workflow_status`, `workflow_stop`, `workflow_save`, `structured_output`, `/workflows` viewer |
| [`cadence`](cadence) — `pi-drawer-cadence` | `loop`, `goal`, `cadence_stop`, `cadence_list` |
| [`statusline`](statusline) — `pi-drawer-statusline` | a footer status line (dir / worktree / branch / status / pi version) |

pi loads extensions as TypeScript via [jiti](https://github.com/unjs/jiti) — no
build step. Each package is a workspace under the repo's `packages/*/*` glob.
Install one with `pi install <path-or-source>` (a local path references it in
place — edits to the repo reflect live) or via the `packages` array in pi's
`settings.json`. Per-package smokes spawn a real pi child: `bun run smoke:pi-agents`
/ `smoke:pi-workflows` / `smoke:pi-runner`.

To build or extend one, use the **`pi-plugin-dev`** skill at
[`.claude/skills/pi-plugin-dev/`](../../.claude/skills/pi-plugin-dev/SKILL.md).
