# pi extension events

> Distilled from a pinned `pi-mono` snapshot: `packages/coding-agent/src/core/extensions/types.ts`
> and `docs/extensions.md`. `file:line` anchors drift across releases — match on the
> surrounding code, not the literal line. When this disagrees with the installed
> `@earendil-works/pi-coding-agent`, the installed version wins.

Subscribe with `pi.on(eventName, handler)`. The handler is
`(event, ctx) => Promise<R | void> | R | void` (`types.ts:1115`). `ctx` is an
`ExtensionContext` (see `api.md`).

## The one rule that bites everyone

**Whether a returned value does anything is per-event.** Returning the wrong shape,
or returning to a notification-only event, fails silently. The "Returns" column
below is the contract. When in doubt, side-effect through `ctx` instead of relying
on a return.

## Lifecycle overview

```
pi starts
  ├─ project_trust            (user/global + CLI -e extensions only, pre project resources)
  ├─ session_start { reason: "startup" }
  └─ resources_discover { reason: "startup" }

user sends a prompt
  ├─ (extension /commands matched first — bypass input if found)
  ├─ input                    (intercept / transform / handle)
  ├─ (skill + template expansion if not handled)
  ├─ before_agent_start       (inject message, rewrite system prompt)
  ├─ agent_start
  ├─ message_start / message_update / message_end
  │   ┌── turn (repeats while the LLM calls tools) ──┐
  │   ├─ turn_start
  │   ├─ context                       (reshape messages for this LLM call)
  │   ├─ before_provider_request       (inspect / replace raw payload)
  │   ├─ after_provider_response       (status + headers)
  │   │   ├─ tool_execution_start
  │   │   ├─ tool_call                 (BLOCK / mutate args)
  │   │   ├─ tool_execution_update
  │   │   ├─ tool_result               (modify result)
  │   │   └─ tool_execution_end
  │   └─ turn_end
  └─ agent_end

/new or /resume   → session_before_switch (cancel) → session_shutdown → session_start { "new"|"resume" } → resources_discover
/fork or /clone   → session_before_fork (cancel)   → session_shutdown → session_start { "fork" }        → resources_discover
/compact          → session_before_compact (cancel / custom summary)  → session_compact
/tree             → session_before_tree (cancel / custom summary)     → session_tree
/model or Ctrl+P  → thinking_level_select (if clamped) → model_select
exit / signals    → session_shutdown
```

## Return-contract cheat sheet

| Event | Returns (what the runner reads) |
|-------|---------------------------------|
| `project_trust` | **required** `{ trusted: "yes"\|"no"\|"undecided"; remember?: boolean }` |
| `resources_discover` | `{ skillPaths?, promptPaths?, themePaths? }` |
| `session_before_switch` | `{ cancel?: boolean }` |
| `session_before_fork` | `{ cancel?: boolean; skipConversationRestore?: boolean }` |
| `session_before_compact` | `{ cancel?: boolean; compaction?: CompactionResult }` |
| `session_before_tree` | `{ cancel?, summary?, customInstructions?, replaceInstructions?, label? }` |
| `before_agent_start` | `{ message?, systemPrompt? }` (chained across handlers) |
| `context` | `{ messages?: AgentMessage[] }` |
| `message_end` | `{ message?: AgentMessage }` (replacement must keep the same `role`) |
| `before_provider_request` | the new payload (return value replaces it); `undefined` = unchanged |
| `tool_call` | `{ block?: boolean; reason?: string }` — and/or mutate `event.input` in place |
| `tool_result` | partial patch `{ content?, details?, isError? }` (omitted fields kept) |
| `input` | `{ action: "continue" }` \| `{ action: "transform", text, images? }` \| `{ action: "handled" }` |
| `user_bash` | `{ operations?: BashOperations }` \| `{ result?: BashResult }` |
| **everything else** | **notification-only — return ignored** (`session_start`, `session_shutdown`, `session_compact`, `session_tree`, `agent_start`, `agent_end`, `turn_start`, `turn_end`, `message_start`, `message_update`, `tool_execution_*`, `model_select`, `thinking_level_select`, `after_provider_response`) |

---

## Startup events

### `project_trust` — `types.ts:503-525`
Fired before pi decides to trust a project's dynamic config (`.pi`, `.agents/skills`).
**Only user/global and CLI `-e` extensions participate** (project-local ones load
after trust). `ctx` is a limited `ProjectTrustContext` (`cwd`, `mode`, `hasUI`, and a
4-method `ui`).
- Event: `{ type, cwd }`
- **Must return** `{ trusted: "yes"|"no"|"undecided", remember?: boolean }`. First
  yes/no wins and suppresses the built-in prompt; `remember: true` persists it.
  `"undecided"` defers. Guard with `ctx.hasUI` before prompting.

### `resources_discover` — `types.ts:528-539`
Fired after `session_start` so extensions can contribute resource paths.
- Event: `{ type, cwd, reason: "startup"|"reload" }`
- Returns `{ skillPaths?, promptPaths?, themePaths? }`.

## Session events

### `session_start` — `types.ts:546-552`
- Event: `{ type, reason: "startup"|"reload"|"new"|"resume"|"fork", previousSessionFile? }`
- Notification. The place to start background resources and rebuild in-memory state.

### `session_before_switch` — `types.ts:555-559`
`/new` or `/resume`. Event: `{ type, reason: "new"|"resume", targetSessionFile? }`.
Return `{ cancel: true }` to abort.

### `session_before_fork` — `types.ts:562-566`
`/fork` (`position: "before"`) or `/clone` (`"at"`). Event: `{ type, entryId, position }`.
Return `{ cancel: true }` or `{ skipConversationRestore: true }`.

### `session_before_compact` / `session_compact` — `types.ts:569-582`
See `gotchas.md` and tool/compaction patterns. `before` can `{ cancel: true }` or
supply `{ compaction: { summary, firstKeptEntryId, tokensBefore } }`. `session_compact`
is notification (`{ compactionEntry, fromExtension }`).

### `session_before_tree` / `session_tree` — `types.ts:608-621`
`/tree` navigation. `before` can `{ cancel }` or `{ summary, customInstructions,
replaceInstructions, label }`. `session_tree` is notification.

### `session_shutdown` — `types.ts:585-590`
Fired before a started session runtime is torn down (`reason: "quit"|"reload"|"new"|
"resume"|"fork"`, `targetSessionFile?`). **Idempotently** clean up anything you
opened in `session_start`. Notification.

## Agent events

### `before_agent_start` — `types.ts:657-667`
After the user submits, before the agent loop. Chained across handlers.
- Event: `{ type, prompt, images?, systemPrompt, systemPromptOptions }` — `systemPrompt`
  reflects earlier handlers' edits; `systemPromptOptions` exposes the structured inputs
  pi used (custom prompt, active tools, tool snippets, guidelines, cwd, context files,
  skills).
- Returns `{ message?: {customType,content,display,details}, systemPrompt? }`. `message`
  is persisted + sent to the LLM; `systemPrompt` replaces it for this turn.

### `agent_start` / `agent_end` — `types.ts:670-678`
Once per prompt. `agent_end` event: `{ type, messages }`. Both notification.
`agent_end` is the reliable "prompt finished" boundary.

### `turn_start` / `turn_end` — `types.ts:681-693`
Once per LLM response. `turn_start`: `{ turnIndex, timestamp }`. `turn_end`:
`{ turnIndex, message, toolResults }`. Notification.

### `message_start` / `message_update` / `message_end` — `types.ts:696-712`
- `message_start` / `message_end` fire for user, assistant, and toolResult messages.
- `message_update` fires for assistant streaming (`{ message, assistantMessageEvent }`)
  — **observe only; you cannot rewrite streaming tokens**.
- `message_end` can `return { message }` to replace the finalized message — the
  replacement must keep the same `role`. Used to e.g. patch usage/cost or normalize a
  provider's overflow error string (see `providers.md`).

## Tool events

### `tool_execution_start` / `update` / `end` — `types.ts:715-738`
Lifecycle telemetry (`toolCallId`, `toolName`, `args`/`partialResult`/`result`+`isError`).
Notification. In parallel mode: `start` in assistant source order during preflight,
`update` may interleave, `end` in completion order.

### `tool_call` — `types.ts:806-865`
After `tool_execution_start`, **before** the tool runs. **Can block.**
- Narrow with `isToolCallEventType("bash", event)` (built-ins get typed `event.input`)
  or `isToolCallEventType<"my_tool", MyInput>("my_tool", event)` for custom tools.
- `event.input` is **mutable** — mutate in place to patch args; later handlers see it;
  **no re-validation** runs after.
- Return `{ block: true, reason? }` to fail just that call (the turn survives). The
  return value *only* controls blocking.
- `ctx.sessionManager` is synced through the current assistant message before this
  fires, but in parallel mode is **not** guaranteed to include sibling tool results.

### `tool_result` — `types.ts:867-924`
After execution, before the result message + `tool_execution_end`. **Can modify.**
- Narrow with `isBashToolResult(event)` etc. for typed `details`.
- Handlers **chain like middleware** in load order; each sees prior edits. Return a
  partial patch `{ content?, details?, isError? }`; omitted fields keep their value.
- Use `ctx.signal` for nested async (so Esc can cancel your `fetch`).

## Provider events

### `before_provider_request` — `types.ts:644-647`
After the provider payload is built, before the request. Event: `{ type, payload }`.
Return a new value to **replace** the payload (for later handlers + the real request);
`undefined` keeps it. Payload-level edits are NOT reflected by `ctx.getSystemPrompt()`.
Mainly for debugging serialization / cache behavior.

### `after_provider_response` — `types.ts:650-654`
After the HTTP response, before its stream body is consumed. Event:
`{ type, status, headers }`. Notification. Header availability is provider-dependent.

## Model events

### `model_select` — `types.ts:747-752`
Model changed via `/model`, `Ctrl+P` cycling, or restore. Event:
`{ type, model, previousModel?, source: "set"|"cycle"|"restore" }`. Notification —
update status bars / do model-specific init here.

### `thinking_level_select` — `types.ts:755-759`
Event: `{ type, level, previousLevel }`. Notification.

## Input events

### `input` — `types.ts:784-800`
After extension `/commands` are checked, **before** skill/template expansion (sees raw
`/skill:foo`, `/template`).
- Event: `{ type, text, images?, source: "interactive"|"rpc"|"extension", streamingBehavior?: "steer"|"followUp" }`.
- Return `{ action: "continue" }` (default), `{ action: "transform", text, images? }`
  (rewrite, then expansion continues — transforms chain), or `{ action: "handled" }`
  (skip the agent entirely; first handler to return this wins). Route by
  `event.source === "extension"` to avoid re-processing your own injected messages.

### `user_bash` — `types.ts:766-774`
Fired on `!` / `!!` commands. **Can intercept.** Event:
`{ type, command, excludeFromContext, cwd }`. Return `{ operations: BashOperations }`
to swap the backend (e.g. SSH — see `createLocalBashOperations()` to wrap the local
one) or `{ result: BashResult }` for full replacement.
