# pi extension gotchas

> The production traps. Each is grounded in the pinned `pi-mono` snapshot; verify
> against the installed pi. Read before shipping.

## 1. The factory registers — it does not act

The default-export factory runs during **load**, before the runtime binds. Action
methods (`pi.sendMessage`, `pi.sendUserMessage`, `pi.appendEntry`, `ctx.*`) **throw**
`"Extension runtime not initialized. Action methods cannot be called during extension
loading."` there (`loader.ts:125-127`). Only registration is valid in the factory:
`on`, `registerTool`, `registerCommand`, `registerShortcut`, `registerFlag`,
`registerMessageRenderer`, `registerProvider`/`unregisterProvider`.

```typescript
export default function (pi: ExtensionAPI) {
  // ❌ pi.sendMessage(...)               // throws — runtime not bound yet
  // ❌ const watcher = chokidar.watch()  // do NOT start background resources here either
  pi.on("session_start", async (_e, ctx) => {
    // ✅ now action methods work; start watchers/sockets/timers here
  })
}
```

**Background resources start in `session_start`, not the factory** — the factory may
run in an invocation that never opens a session (`pi --list-models`, install hooks).
Register an **idempotent** `session_shutdown` to tear them down.

The one async exception: an `async` factory is awaited before startup, so use it for
one-time fetches (e.g. discovering remote models to `registerProvider`) — but still
only *register*, don't *act*.

## 2. Stale context after reload / session replacement

After `ctx.reload()`, `ctx.newSession()`, `ctx.fork()`, or `ctx.switchSession()`, any
captured `pi` or command `ctx` is **stale and throws** (`runner.ts:510-524`):

```
"This extension ctx is stale after session replacement or reload."
```

- **reload:** `await ctx.reload(); return;` — treat as terminal. Code after it runs in
  the *old* frame against invalidated state.
- **replacement (new/fork/switch):** do post-switch work inside the `withSession(ctx =>
  …)` callback using **its** `ctx`. The callback runs after `session_shutdown` +
  rebind, so your own shutdown cleanup may already have run — capture only plain data
  (strings, ids) across the boundary, never a `SessionManager` or `ctx` reference.

```typescript
pi.registerCommand("handoff", { handler: async (_args, ctx) => {
  const kickoff = "Continue in the new session"          // ✅ plain string survives
  await ctx.newSession({ withSession: async (ctx) => {   // ✅ fresh ctx
    await ctx.sendUserMessage(kickoff)
  }})
}})
```

## 3. Tool errors are thrown, never returned

`execute` signals failure by **throwing**. A returned `{ isError: true }` is ignored.
The thrown error is caught, the result is marked `isError`, and it is reported to the
LLM so it can recover.

```typescript
async execute(_id, params) {
  if (!valid(params.x)) throw new Error(`bad input: ${params.x}`)   // ✅ sets isError
  return { content: [{ type: "text", text: "ok" }], details: {} }
}
```

## 4. `StringEnum`, not `Type.Union`/`Type.Literal`

For string-enum tool params use `StringEnum([...] as const)` from
`@earendil-works/pi-ai`. `Type.Union`/`Type.Literal` serialize in a way Google's API
rejects. Also: pi does not apply schema *defaults* to raw incoming values — coerce
defensively, and treat an omitted optional as possibly `undefined`.

## 5. Tools run in parallel — guard file mutations

Sibling tool calls from one assistant message run **concurrently** by default. Two
tools (yours + built-in `edit`, or two of yours) can read the same file and the last
write wins, silently losing the other. Wrap the **entire** read-modify-write on the
resolved absolute path in `withFileMutationQueue()` so it shares the per-file queue
with built-in `edit`/`write`:

```typescript
const abs = resolve(ctx.cwd, params.path)
return withFileMutationQueue(abs, async () => { /* read → modify → write */ })
```

Relatedly: in `tool_call`, `ctx.sessionManager` is **not** guaranteed to include
sibling tool results from the same assistant message (parallel preflight).

## 6. Always truncate tool output

Unbounded output overflows context, breaks compaction, and degrades the model. The
built-in budget is ~**50KB / 2000 lines** (`DEFAULT_MAX_BYTES` / `DEFAULT_MAX_LINES`).
Use `truncateHead` (file reads, search — beginning matters) or `truncateTail` (logs,
command output — end matters), and tell the model where the full output went.

## 7. `ctx.signal` is often `undefined`

It is defined during active-turn events (`tool_call`, `tool_result`, `message_update`,
`turn_end`) and `undefined` in idle/non-turn contexts (session events, shortcuts fired
while idle, commands while idle). Guard before threading it into `fetch`/model calls,
and pass it through so Esc can cancel your async work.

## 8. Mode / hasUI guards

| | `tui` | `rpc` | `json` | `print` (`-p`) |
|--|--|--|--|--|
| `ctx.hasUI` | true | true | false | false |
| dialogs (`select`/`confirm`/`input`/`editor`) | ✅ | ✅ (JSON protocol) | no-op | no-op |
| `ctx.ui.custom()` / terminal input / `setEditorComponent` | ✅ | returns `undefined` / no-op | no-op | no-op |
| fire-and-forget (`notify`/`setStatus`/`setWidget`/`setTitle`) | ✅ | ✅ | no-op | no-op |

Guard real-TUI features with `ctx.mode === "tui"`; guard dialogs whose result drives
control flow with `ctx.hasUI` (and provide a non-interactive fallback — e.g. block by
default when you cannot confirm).

## 9. Session-control methods are command-only

`waitForIdle`, `newSession`, `fork`, `switchSession`, `navigateTree`, `reload` live on
`ExtensionCommandContext` (command handlers), not `ExtensionContext` (event handlers) —
calling them from an event handler can deadlock. To let the model trigger one, expose
a tool that queues the command: `pi.sendUserMessage("/my-command", { deliverAs: "followUp" })`.

## 10. The "turn finished" boundary

`message_update` streams and the parts reorder; do not treat the last one as "done".
Use `turn_end` (one LLM response + its tools) or `agent_end` (the whole prompt) as the
reliable boundary.

## 11. State + branching

In-memory state is lost on `/reload` and diverges across `/tree` branches. Store
durable state in the tool result's `details`, and **reconstruct** it on `session_start`
*and* `session_tree` by walking `ctx.sessionManager.getBranch()` for your tool's results.
(`pi.appendEntry` persists non-LLM-visible state the same way.)

## 12. The model sometimes prefixes paths with `@`

Built-in tools strip a leading `@` before resolving a path. If your tool takes a path,
normalize `@foo` → `foo` too.

## 13. `before_provider_request` edits are invisible to `getSystemPrompt()`

`getSystemPrompt()` returns pi's *system-prompt string*, not the serialized provider
payload. If you rewrite system instructions at the payload level in
`before_provider_request`, `getSystemPrompt()` will not reflect it. Likewise, later-
loaded extensions can still change what is ultimately sent after your handler runs.
