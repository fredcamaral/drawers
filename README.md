# opencode-drawers

A drawer of independently installable [OpenCode](https://opencode.ai) plugins that share one background-session engine.

A "drawer" is a Bun-workspace monorepo: each plugin is published and installed on its own, but they sit on a common foundation. That foundation is `@drawers/core`, a private package providing the shared engine — SDK client adaptation, the completion gate over OpenCode's `session.idle` / `session.error` stream, the per-parent notification queue, and toast notifiers. The plugins are thin entries; the durable machinery lives in core.

Three plugins ship today. Two of them — agents and workflows — spawn child sessions, watch them to completion, and feed results back into the parent's next message. The third, cadence, re-prompts the *current* session on an interval or until a goal is met, sharing the same completion-gate machinery.

## Plugins

| Package | What it gives you | Docs |
|---|---|---|
| `opencode-drawer-agents` | Fire-and-forget background agents — launch a task in a child session and pull its output later, without blocking the main loop. Tools: `bg_task`, `bg_output`, `bg_cancel`, `bg_list`. | [README](packages/background-agents/README.md) |
| `opencode-drawer-workflows` | Deterministic multi-agent orchestration — author a workflow as JavaScript that fans out subagents, runs barriers and conditionals, and returns schema-conforming results. A port of Claude Code's Workflows feature, with the six named orchestration patterns, per-agent git-worktree isolation, a `deep-research` built-in, and save-a-run-as-workflow (one documented deviation: token budgets count workflow children only). Tools: `workflow`, `workflow_status`, `workflow_stop`, `workflow_save_run` (plus a global `structured_output` tool), and a native `/workflows` TUI viewer. | [README](packages/workflows/README.md) |
| `opencode-drawer-cadence` | Session-level re-prompting that mirrors Claude Code's `/loop` and `/goal`: drive the current session on a fixed interval, or until the model declares a goal met. Tools: `loop`, `goal`, `cadence_stop`, `cadence_list`. | [README](packages/cadence/README.md) |

## Quickstart

Add the plugins you want to your `opencode.json`:

```json
{
  "plugin": [
    "opencode-drawer-agents",
    "opencode-drawer-workflows",
    "opencode-drawer-cadence"
  ]
}
```

Install any subset — they are independent. See each package README for tool parameters and usage.

## Development

```bash
bun install          # install workspace dependencies
bun test             # run the test suite
bun run typecheck    # tsc --noEmit across core, agents, workflows, cadence
bun run lint         # biome check .
```

Smoke harnesses exercise the plugins end to end against OpenCode:

```bash
bun run smoke:agents     # background-agents smoke
bun run smoke:workflows  # workflows smoke
bun run smoke            # core harness
```

The `smoke:*` scripts require a real `opencode` binary on your PATH and hit a live model — they cost tokens and take real wall-clock time.

## Repository layout

```
packages/
  core/                # @drawers/core — private shared engine
  background-agents/   # opencode-drawer-agents
  workflows/           # opencode-drawer-workflows
  cadence/             # opencode-drawer-cadence
docs/
```

## License

MIT
