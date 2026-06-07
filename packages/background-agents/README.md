# opencode-drawer-agents

An [opencode](https://opencode.ai) plugin that runs agent tasks in the background. You launch a task from a session, your turn continues, and the task runs in its own child session independently. When it finishes, an idle parent session is woken to read the result automatically; a busy parent gets a TUI toast plus a line folded into its next message — so you never poll. State is persisted per task and survives an opencode restart.

The plugin registers four tools: `bg_task` (launch or resume), `bg_output` (read a result), `bg_cancel` (cancel), and `bg_list` (list this session's tasks).

## Install

Add the plugin to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-drawer-agents"]
}
```

### Local development

To run from a checkout instead of the published package, point at the plugin entry by absolute `file://` path. Dev-only — do not ship this form:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///abs/path/to/packages/background-agents/src/index.ts"]
}
```

## Tools

### `bg_task`

Launch a background agent task that runs independently of the current turn, or resume a terminal (completed/errored/cancelled) one. Pass `task_id` to resume — in that mode only `prompt` is read and every other argument is ignored. On launch, `task_id` is absent.

The tool returns immediately with the new task id and status. You are notified on completion; do not poll. Call `bg_output(task_id)` when notified.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `description` | string | — (required on launch) | Short title for the task, shown in the UI. |
| `prompt` | string | — (required) | The instruction for the background agent. On resume, the follow-up instruction. |
| `agent` | string | `"build"` | Agent to run the task as. |
| `model` | string | — (optional) | Model override, in `provider/model` form. |
| `task_id` | string | — (optional) | Resume an existing terminal task instead of launching. When set, only `prompt` is used. |
| `fork` | boolean | `false` | Inject the calling session's transcript as reference context before the task prompt. Launch only; ignored on resume. |

Depth is inferred from the calling session, not passed by the caller. A task launched from inside another task's session is one level deeper. Launching past the maximum depth (2) is rejected and returned as an honest error string.

### `bg_output`

Read a background task's result by id. Call this when notified that a task completed — do not poll. Set `block=true` to wait for an in-progress task to finish, bounded by `timeout_ms`. Set `full=true` to append the task's full transcript.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `task_id` | string | — (required) | The `bg_` task id to read. |
| `full` | boolean | `false` | Append the full filtered transcript after the summary. |
| `block` | boolean | `false` | Wait for the task to finish before reading. |
| `timeout_ms` | number | `60000` | Max ms to block, clamped to the range `[0, 300000]`. Only used when `block=true`. A non-finite value (`NaN`, `Infinity`) falls back to the default; a negative finite value clamps to `0` (immediate non-blocking check). |

### `bg_cancel`

Cancel a background task. Supply exactly one of `task_id` or `all` — both or neither returns an error string you can correct. Cancelling an already-terminal task is a no-op that returns its current state as-is.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `task_id` | string | — (optional) | The `bg_` task id to cancel. Omit when `all=true`. |
| `all` | boolean | `false` | Cancel every still-running task started from this session. |

### `bg_list`

List the background tasks started from the current session, one compact line per task: id, status, runtime (age while live, duration once done), and a truncated description. Use it to find a `task_id`. Takes no arguments.

## How notifications work

On each terminal transition three delivery paths fire, layered so a completion always reaches you:

1. **Active wake (idle parent).** If the parent session is idle when the task completes, the plugin wakes it: it sends one prompt into the parent carrying a demarcated `[task-notification]` notice with the retrieval hint and an explicit "automated notice, not the user" framing, so the assistant reads the result without you typing anything. Completions for the same parent are coalesced into a single wake, and a wake is attempted only the moment a notice arrives — there are no retry timers or polling loops.
2. **TUI toast.** A toast fires immediately via `client.tui.showToast`, with a `success` variant on completion, `error` on failure, and `info` on cancellation. Toast failures are swallowed and logged; a toast never breaks completion teardown.
3. **Next-message flush (fallback).** When the parent is **busy** (mid-turn) the wake is skipped — the host does not serialize concurrent session prompts, so a child cannot safely interrupt an in-flight turn. The notice instead waits in a per-parent FIFO queue until you send your next message; opencode's `chat.message` hook then drains the queue and folds two parts into the message: one visible human-readable line per notice (for example `✅ bg_abc12345 'description' completed in 32s`), and one model-only synthetic hint instructing the assistant to call `bg_output(task_id="…")`.

The wake and the flush share the same queue, so a completion is delivered **exactly once**: the wake consumes its notices only when the wake prompt succeeds, and any failure (busy parent, unreadable status, or a failed prompt) leaves them queued for the flush. The toast is always additive on top.

The flush hook runs inside the prompt pipeline, where a thrown error would kill your message before it reaches the model. The hook body is fully fenced — a queue or render failure is logged and your message proceeds untouched.

In a headless `opencode run`, the parent turn ends — and the server shuts down — when your single turn completes, so there is nothing to wake. Active wake is an interactive-session affordance; headless callers see the completion via the next-message flush only if the session is still alive.

## Persistence and restart

Each task is persisted as a single JSON file (`<taskId>.json`), written atomically (temp file then rename) so a crash mid-write never leaves a torn file. On startup the engine loads every persisted task back into the runner and re-queues any terminal task that was never delivered, silently — no toast storm on restart.

What survives a restart:

- Terminal tasks and their output remain readable via `bg_list` and `bg_output` in a fresh process.
- Undelivered completion notices are re-queued and flushed into the next message.

Terminal tasks are swept on load once older than 24 hours (by completion time). Running and pending tasks are never swept regardless of age. Corrupt or unreadable task files are skipped individually and logged; the rest still load.

Tasks live under the `tasks/` leaf of one canonical base directory (shared with the workflows plugin). The base is resolved in this order:

1. `$OPENCODE_DRAWERS_DATA_DIR`, if set and non-empty.
2. `$XDG_DATA_HOME/opencode-drawers`, if `XDG_DATA_HOME` is set.
3. `~/.local/share/opencode-drawers` otherwise.

Task files are then written to `<base>/tasks/`.

## Environment variables

| Variable | Effect |
|----------|--------|
| `OPENCODE_DRAWERS_DATA_DIR` | Base directory for persistence. Takes precedence over the XDG default. Task files live under its `tasks/` subdirectory (e.g. `$OPENCODE_DRAWERS_DATA_DIR/tasks`). |
| `XDG_DATA_HOME` | When `OPENCODE_DRAWERS_DATA_DIR` is unset, the base is `$XDG_DATA_HOME/opencode-drawers`; otherwise `~/.local/share/opencode-drawers`. Tasks live under `<base>/tasks`. |
