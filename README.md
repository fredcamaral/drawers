# drawers

My drawers of independently installable plugins for two agent harnesses —
[opencode](https://opencode.ai) and [pi](https://pi.dev).

A "drawer" is a Bun-workspace monorepo: each plugin is published and installed on
its own, but plugins sit on shared foundations and are grouped by the harness they
target — `packages/opencode/*` and `packages/pi/*`.

## opencode plugins

The opencode plugins share `@drawers/core`, a private package providing the common
engine — SDK client adaptation, the completion gate over opencode's `session.idle`
/ `session.error` stream, the per-parent notification queue, and toast notifiers.
The plugins are thin entries; the durable machinery lives in core.

| Package | What it gives you | Docs |
|---|---|---|
| `opencode-drawer-agents` | Fire-and-forget background agents — launch a task in a child session and pull its output later, without blocking the main loop. Tools: `bg_task`, `bg_output`, `bg_cancel`, `bg_list`. | [README](packages/opencode/background-agents/README.md) |
| `opencode-drawer-workflows` | Deterministic multi-agent orchestration — author a workflow as JavaScript that fans out subagents, runs barriers and conditionals, and returns schema-conforming results. A port of Claude Code's Workflows feature, with the six named orchestration patterns, per-agent git-worktree isolation, a `deep-research` built-in, and save-a-run-as-workflow. Tools: `workflow`, `workflow_status`, `workflow_stop`, `workflow_save_run` (plus a global `structured_output` tool), and a native `/workflows` TUI viewer. | [README](packages/opencode/workflows/README.md) |
| `opencode-drawer-cadence` | Session-level re-prompting that mirrors Claude Code's `/loop` and `/goal`: drive the current session on a fixed interval, or until the model declares a goal met. Tools: `loop`, `goal`, `cadence_stop`, `cadence_list`. | [README](packages/opencode/cadence/README.md) |
| `opencode-drawer-statusline` | A compact prompt status line — directory, worktree, branch, session status, and opencode version under every prompt. | [README](packages/opencode/statusline/README.md) |

Add the plugins you want to your `opencode.json`:

```json
{
  "plugin": [
    "opencode-drawer-agents",
    "opencode-drawer-workflows",
    "opencode-drawer-cadence",
    "opencode-drawer-statusline"
  ]
}
```

Install any subset — they are independent. See each package README for tool
parameters and usage.

## pi plugins

The pi port of the same set, targeting [pi](https://pi.dev), whose plugin model is
called **extensions** (`@earendil-works/pi-coding-agent`). They share
`@drawers/pi-core` — the pi-native engine: a `SessionRunner` that spawns one
`pi --mode rpc` child per task and fuses `agent_end` + process-exit into an
exactly-once terminal (replacing opencode's `session.idle` completion gate), plus
the harness-agnostic persistence / notification-queue / concurrency layers under
the `pi-drawers` data namespace.

| Package | What it gives you | Source |
|---|---|---|
| `pi-drawer-agents` | Fire-and-forget background agents — launch a task in a child pi session and pull its output later. Tools: `bg_task`, `bg_output`, `bg_cancel`, `bg_list`. | [src](packages/pi/background-agents) |
| `pi-drawer-workflows` | Deterministic multi-agent orchestration — author a workflow as JavaScript that fans out child pi sessions, runs barriers and conditionals, and returns schema-conforming results; per-agent git-worktree isolation, a `deep-research` built-in, save-a-run-as-workflow. Tools: `workflow`, `workflow_status`, `workflow_stop`, `workflow_save` (plus a global `structured_output` tool), and a `/workflows` TUI viewer. | [src](packages/pi/workflows) |
| `pi-drawer-cadence` | Session-level re-prompting: `loop` (interval-driven) and `goal` (idle-driven, stops on a `GOAL_COMPLETE` sentinel). Tools: `loop`, `goal`, `cadence_stop`, `cadence_list`. | [src](packages/pi/cadence) |
| `pi-drawer-statusline` | A compact status line in pi's footer — directory, worktree, branch, session status, and pi version. | [src](packages/pi/statusline) |

pi loads extensions as TypeScript via jiti (no build step). Install a package with
`pi install <source>` (a local path references it in place; npm/git sources are
fetched) or add it to the `packages` array in pi's `settings.json`:

```bash
pi install npm:pi-drawer-agents       # once published
pi install ./packages/pi/workflows    # local, pulled from this repo
```

## Building plugins

Two Claude Code skills in this repo do the heavy lifting when adding a drawer:

| Skill | For | SDK |
|---|---|---|
| [`opencode-plugin-dev`](.claude/skills/opencode-plugin-dev/SKILL.md) | opencode plugins | `@opencode-ai/plugin` |
| [`pi-plugin-dev`](.claude/skills/pi-plugin-dev/SKILL.md) | pi extensions | `@earendil-works/pi-coding-agent` |

## Development

```bash
bun install          # install workspace dependencies (glob: packages/*/*)
bun test             # run the test suite (opencode + pi packages)
bun run typecheck    # tsc --noEmit across every package
bun run lint         # biome check .
```

Smoke harnesses exercise the plugins end to end against the real harness. The
opencode smokes need an `opencode` binary on PATH; the pi smokes spawn a real
`pi --mode rpc` child. All hit a live model — they cost tokens and take real
wall-clock time, so they are gated out of `bun test`:

```bash
bun run smoke:agents       # opencode background-agents
bun run smoke:workflows    # opencode workflows
bun run smoke              # opencode core harness
bun run smoke:pi-runner    # pi @drawers/pi-core SessionRunner (real pi child)
bun run smoke:pi-agents    # pi background-agents (bg_task -> bg_output)
bun run smoke:pi-workflows # pi workflows (one-agent workflow -> result)
```

## Repository layout

```
packages/
  opencode/
    core/                # @drawers/core — private shared engine
    background-agents/   # opencode-drawer-agents
    workflows/           # opencode-drawer-workflows
    cadence/             # opencode-drawer-cadence
    statusline/          # opencode-drawer-statusline
  pi/
    core/                # @drawers/pi-core — private shared engine (SessionRunner)
    background-agents/   # pi-drawer-agents
    workflows/           # pi-drawer-workflows
    cadence/             # pi-drawer-cadence
    statusline/          # pi-drawer-statusline
.claude/skills/          # opencode-plugin-dev, pi-plugin-dev
docs/
```

## License

MIT
