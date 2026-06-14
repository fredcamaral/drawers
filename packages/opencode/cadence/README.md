# opencode-drawer-cadence

Session-level orchestration for OpenCode, mirroring Claude Code's `/loop` and
`/goal`. Two independent re-prompt mechanisms share one engine but never
cross-wire.

## Tools

### `loop` — interval-driven

Every `interval_ms` (floored at 1000ms), re-inject `instruction` into the current
session. With an optional `until` predicate the loop checks the last assistant
message for the `GOAL_COMPLETE` sentinel before each re-prompt and stops when it
appears. `max_iterations` (default 10) is the safety cap. Persisted and recovered
across plugin reloads — an active loop re-arms its timer on restart.

```
loop({ instruction, interval_ms, max_iterations?, until? })
```

### `goal` — idle-driven

On each `session.idle` for a session holding an active goal, read the last
assistant message: `GOAL_COMPLETE` means done; otherwise re-prompt the goal until
met or `max_iterations` (default 10). The anti-premature-completion bar — the
model must explicitly declare the objective satisfied.

```
goal({ goal, max_iterations? })
```

### `cadence_stop` / `cadence_list`

`cadence_stop({ id? })` stops one directive by id, or all active directives of the
session when `id` is omitted. `cadence_list()` lists the session's active
directives.

## Slash commands

`/loop <interval> <instruction>` and `/goal <objective>` wrap the tools.

## Persistence

Directives are JSON files under `<dataDir>/cadence/<id>.json` (atomic tmp+rename
write), where `<dataDir>` follows `$OPENCODE_DRAWERS_DATA_DIR` →
`$XDG_DATA_HOME/opencode-drawers` → `~/.local/share/opencode-drawers`.

## Residual risk

Re-prompts are fire-and-forget. A tick or idle that lands while the session is
mid-turn queues the prompt rather than failing; the `max_iterations` cap bounds
runaway re-prompting in either mechanism.
