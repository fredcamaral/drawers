# pi custom tools

> Tools the model can call. Registered with `pi.registerTool(def)` — at load **or** at
> runtime (from `session_start`, a command, any handler); runtime-added tools are
> immediately callable, no `/reload`. Full type in `api.md`. Schemas use `typebox`.

## Anatomy

```typescript
import { type ExtensionAPI, defineTool } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { StringEnum } from "@earendil-works/pi-ai"

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "todo",                       // snake_case; the LLM-facing tool name
    label: "Todo",                      // short TUI label
    description: "List or add project todos",   // shown to the LLM — be precise
    promptSnippet: "Manage a project todo list",  // one line in "Available tools" (omit ⇒ not listed)
    promptGuidelines: ["Use todo for task planning instead of editing files directly."], // NAME the tool
    parameters: Type.Object({
      action: StringEnum(["list", "add"] as const),   // NOT Type.Union/Literal — Google compat
      text: Type.Optional(Type.String()),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: "text", text: "working…" }] })   // stream progress (optional)
      if (params.action === "add" && !params.text) throw new Error("text required")  // THROW to fail
      // …do work…
      return {
        content: [{ type: "text", text: "done" }],   // sent to the LLM
        details: { items: [/* … */] },               // for rendering + state reconstruction
        // terminate: true,                           // see "Early termination"
      }
    },
  })
}
```

Use `defineTool({...})` when assigning to a variable or putting tools in an array — it
preserves `Static<TParams>` inference for `params` in `execute`.

## `execute` contract

`execute(toolCallId, params, signal, onUpdate, ctx)` returns
`{ content, details?, terminate? }`.

- **Fail by throwing.** The runtime sets `isError: true` and reports the message to the
  LLM. A returned `isError` field is ignored.
- **`content`** goes to the LLM (`{ type: "text" | "image", … }[]`). **`details`** is
  arbitrary data for your `renderResult` and for state reconstruction — it is *not* the
  LLM-facing text.
- **`onUpdate?.({ content, details? })`** streams interim progress to the TUI.
- **`signal`** is the abort signal — check `signal?.aborted` in long loops and pass it
  to `pi.exec`, `fetch`, model calls.
- **`ctx`** is an `ExtensionContext` (not command context) — `ctx.cwd`, `ctx.ui`, etc.

### Early termination — `terminate: true`

Hints that the follow-up LLM call should be skipped after this tool batch. It only
takes effect when **every** finalized tool in the batch returns `terminate: true`.
Canonical use: a final `structured_output` tool that ends the agent on a structured
answer.

```typescript
defineTool({
  name: "structured_output",
  description: "Return the final structured answer",
  parameters: Type.Object({ headline: Type.String(), items: Type.Array(Type.String()) }),
  async execute(_id, params) {
    return { content: [{ type: "text", text: `Saved: ${params.headline}` }],
             details: params, terminate: true }
  },
})
```

## `prepareArguments` — resume compatibility, not a second schema

Optional. Runs **before** validation. Use it only to fold an *older* stored arg shape
(from a resumed session) into the current schema. Keep `parameters` strict; do not add
deprecated fields just to keep old sessions alive.

```typescript
prepareArguments(args) {
  const a = args as { oldText?: string; newText?: string; edits?: unknown[] }
  if (typeof a.oldText === "string" && typeof a.newText === "string")
    return { ...a, edits: [...(a.edits ?? []), { oldText: a.oldText, newText: a.newText }] }
  return args
}
```

## Output truncation (mandatory for anything unbounded)

```typescript
import { truncateHead, formatSize, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent"

const t = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES })
let text = t.content
if (t.truncated) {
  const tmp = writeTempFile(output)   // your helper
  text += `\n\n[truncated: ${t.outputLines}/${t.totalLines} lines, ${formatSize(t.outputBytes)} of ${formatSize(t.totalBytes)}. Full output: ${tmp}]`
}
return { content: [{ type: "text", text }] }
```

`truncateHead` keeps the start (file reads, search); `truncateTail` keeps the end
(logs, command output). Always tell the model where the full output is.

## File mutations — share the queue

Tools run in parallel by default; a custom file-writer racing built-in `edit`/`write`
loses writes. Queue the whole read-modify-write on the resolved absolute path:

```typescript
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent"
import { resolve } from "node:path"

const abs = resolve(ctx.cwd, params.path)   // resolve relative to cwd; the queue realpaths existing files
return withFileMutationQueue(abs, async () => { /* read → modify → write → return result */ })
```

## State + branching

Persist durable state in `details`, reconstruct on `session_start` and `session_tree`:

```typescript
let items: Item[] = []
const reconstruct = (ctx) => {
  items = []
  for (const e of ctx.sessionManager.getBranch())
    if (e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "todo")
      items = e.message.details?.items ?? items
}
pi.on("session_start", (_e, ctx) => reconstruct(ctx))
pi.on("session_tree",  (_e, ctx) => reconstruct(ctx))   // branches diverge — rebuild
```

## Overriding a built-in tool

Register a tool with a built-in name (`read`, `bash`, `edit`, `write`, `grep`, `find`,
`ls`) to replace it (the TUI warns). Rendering is resolved per slot: omit `renderCall`
or `renderResult` and the built-in renderer is reused (diffs, highlighting). Your
result **must match the built-in's `details` shape** — the UI and session logic depend
on it. `promptSnippet`/`promptGuidelines` are **not** inherited; redeclare them.

Or start with `pi --no-builtin-tools` (extension tools only) for a clean slate.

## Pluggable backends (remote / sandbox)

Built-in tools accept custom `operations` (and bash a `spawnHook`) so you can route
them to SSH, a container, or a micro-VM:

```typescript
import { createReadTool, createBashTool } from "@earendil-works/pi-coding-agent"

const remoteRead = createReadTool(ctx.cwd, { operations: { readFile, access } })
const bash = createBashTool(ctx.cwd, { spawnHook: ({ command, cwd, env }) =>
  ({ command: `source ~/.profile\n${command}`, cwd: `/mnt/sandbox${cwd}`, env: { ...env, CI: "1" } }) })
```

Operation interfaces: `ReadOperations`, `WriteOperations`, `EditOperations`,
`BashOperations`, `LsOperations`, `GrepOperations`, `FindOperations`. For `!`/`!!`
intercepts, wrap pi's local backend with `createLocalBashOperations()` in a `user_bash`
handler (see `events.md`).

## Custom rendering

`renderCall(args, theme, ctx)` and `renderResult(result, options, theme, ctx)` return a
`@earendil-works/pi-tui` `Component`. Defaults: `renderCall` shows the tool name,
`renderResult` shows raw `content` text. See `ui.md` for the component/theme API,
`renderShell: "self"`, and `keyHint()`.
