---
description: Hold this session to a goal — re-prompt on every idle until it is explicitly met
---

Arm an idle-driven goal on the CURRENT session using the `goal` tool.

Pass the text below as `goal`. On each `session.idle`, the plugin checks the last
assistant message: if it does not contain `GOAL_COMPLETE`, the goal is re-prompted
until it is met or the iteration cap (default 10) is reached. This is the
anti-premature-completion bar — you must explicitly declare the objective met by
replying with exactly `GOAL_COMPLETE` on its own line.

Call `goal` with the argument, then relay the confirmation (directive id and cap).
Do not loop turn-by-turn yourself — the plugin drives the re-prompts on idle.

Goal: $ARGUMENTS
