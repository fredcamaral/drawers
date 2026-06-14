# @drawers/pi-core

Shared engine for the `pi-drawer-*` plugins ([pi](https://pi.dev) /
`@earendil-works/pi-coding-agent`). Not meant to be installed directly — it's a
runtime dependency of the drawer plugins.

It provides the harness-agnostic machinery the plugins build on:

- **`SessionRunner`** — spawns one `pi --mode rpc` child per task and fuses
  `agent_end` + process-exit into an exactly-once terminal status.
- persistence (`TaskStore`), a per-parent notification queue, and a concurrency
  limiter.
- small shared utilities: id generation, duration formatting, an fs facade.

pi loads it as TypeScript via [jiti](https://github.com/unjs/jiti) — no build
step. See the [repo README](https://github.com/fredcamaral/drawers) for the
plugins that consume it.
