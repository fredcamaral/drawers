# pi plugins

Plugins for [pi](https://pi.dev) — the agent harness whose plugin model is called
**extensions** (`@earendil-works/pi-coding-agent`). These are the pi port of the
opencode drawer set, named `pi-drawer-*`.

**Engine + core drawer set:**

| Package | Tools / surface |
|---|---|
| [`core`](core) — `@drawers/pi-core` | Private shared engine: the pi-native `SessionRunner` (one `pi --mode rpc` child per task; `agent_end`+process-exit fused into an exactly-once terminal), persistence, notification queue, concurrency. Not published; consumed by the plugins. |
| [`background-agents`](background-agents) — `pi-drawer-agents` | `bg_task`, `bg_output`, `bg_cancel`, `bg_list` |
| [`workflows`](workflows) — `pi-drawer-workflows` | `workflow`, `workflow_status`, `workflow_stop`, `workflow_save`, `structured_output`, `/workflows` viewer |
| [`cadence`](cadence) — `pi-drawer-cadence` | `loop`, `goal`, `cadence_stop`, `cadence_list` |
| [`statusline`](statusline) — `pi-drawer-statusline` | a footer status line (dir / worktree / branch / status / pi version) |

**Ported from the Lerian extension set** (`@mariozechner/pi` 0.65 → `@earendil-works/pi` 0.79):

| Package | Tools / surface |
|---|---|
| [`ask-user`](ask-user) — `pi-drawer-ask-user` | `ask_user` — a tool that puts a structured multiple-choice question to the user |
| [`btw`](btw) — `pi-drawer-btw` | `/btw` — a side discussion that doesn't pollute the main thread |
| [`pierre-diffs`](pierre-diffs) — `pi-drawer-pierre-diffs` | overrides the `edit` tool's `renderResult` with a Pierre-inspired diff view |
| [`personas`](personas) — `pi-drawer-personas` | `/personas` — switch the live session's agent persona |
| [`tui-bars`](tui-bars) — `pi-drawer-tui-bars` | status bars + session auto-naming. **Replaces the footer** (`setFooter`) — mutually exclusive with `statusline` |
| [`handoff`](handoff) — `pi-drawer-handoff` | `/handoff`, `/handoff-view`, `/handoff-tree`, `/handoff-approved` — SQLite-backed session handoffs (`~/.pi/agent/handoffs.db`) |
| [`subagents`](subagents) — `pi-drawer-subagents` | tmux-supervised named subagents (`/agents`, `/teams`, `spawn_agent`, `send_message`, `worker_control`, `team_*`) + todo (`/todo`, `/todo-clear`) + `/oracle` |

pi loads extensions as TypeScript via [jiti](https://github.com/unjs/jiti) — no
build step. Each package is a workspace under the repo's `packages/*/*` glob, so
`bun install` at the repo root links them all and `bun run typecheck` is their
build gate.

**Local dev install** (load straight from this repo — edits reflect live, no publish):
add the package dir to the `packages` array in pi's `~/.pi/agent/settings.json`,
or run `pi install <path>`. To exercise one in isolation without touching the
daily config, run `pi -e packages/pi/<name>/src/index.ts`. Per-package smokes spawn
a real pi child: `bun run smoke:pi-agents` / `smoke:pi-workflows` / `smoke:pi-runner`.

To build or extend one, use the **`pi-plugin-dev`** skill at
[`.claude/skills/pi-plugin-dev/`](../../.claude/skills/pi-plugin-dev/SKILL.md).
