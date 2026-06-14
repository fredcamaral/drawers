---
description: Re-inject a prompt into this session on an interval until a goal is met or a cap is hit
---

Arm an interval-driven loop on the CURRENT session using the `loop` tool.

Parse the arguments below into the tool call. The first token may be an interval
(e.g. `5m`, `30s`, `5000ms`); convert it to milliseconds and pass it as
`interval_ms`. The remaining text is the `instruction` to re-inject each interval.
If the user describes a stopping condition ("until X", "stop when Y"), pass it as
`until` — the loop halts once the last assistant message contains `GOAL_COMPLETE`.
If no interval is given, default `interval_ms` to 300000 (5 minutes).

Call `loop` with those args, then relay the confirmation (directive id, cadence,
and cap). Do not start looping turn-by-turn yourself — the plugin drives it.

Arguments: $ARGUMENTS
