---
name: pi-plugin-dev
description: >-
  Build, debug, and publish pi (the agent harness from earendil-works,
  @earendil-works/pi-coding-agent) extensions — the default-export factory,
  lifecycle event hooks, custom tools, slash commands, shortcuts, CLI flags,
  custom model/OAuth providers, and full TUI. Use when working in a pi extension
  repo or anytime the task touches @earendil-works/pi-coding-agent, a `.pi/`
  or `~/.pi/agent/` extensions dir, or `pi -e`. Use when: "block rm -rf before it
  runs" (tool_call → {block}), "add a tool the model can call" (registerTool +
  typebox), "confirm before a destructive command" (ctx.ui.confirm), "add a
  /command" (registerCommand), "inject context on every prompt" (before_agent_start),
  "register a custom model provider / proxy / OAuth login" (registerProvider),
  "persist a todo list across restarts" (appendEntry + reconstruct), "spawn a
  subagent" (subprocess tool), "draw a status line / widget / footer" (ctx.ui),
  "my extension's hook never fires", or "publish my extension as a pi package".
  Covers the `~/.pi/agent/extensions/` + `.pi/extensions/` layout, settings.json
  `extensions`/`packages`, and `pi install npm:/git:`.
---

# pi extension development

An extension is one **default-exported factory function** from a TS/JS module.
It receives the `ExtensionAPI` object and *registers* things on it — event
handlers, tools, commands, shortcuts, flags, providers. pi loads the module via
[jiti](https://github.com/unjs/jiti) (no build step), calls the factory once, and
then drives the things you registered. That is the whole model.

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

export default function (pi: ExtensionAPI) {
  // factory runs once at load — REGISTER ONLY (see the factory rule below)
  pi.on("session_start", async (event, ctx) => {
    ctx.ui.notify("loaded", "info")
  })
}
```

The factory may be `async` — pi awaits it before startup completes (before
`session_start`, before `resources_discover`, before queued provider
registrations flush). Use that for one-time async setup like discovering remote
models.

<critical>
Two reference files carry the exact, current contract and override anything you
remember from training. Read the relevant one before writing hook or tool code:
- `references/events.md` — every lifecycle event, its payload, and **what
  returning a value actually does** (block / cancel / modify / ignored).
- `references/api.md` — the full `ExtensionAPI`, `ExtensionContext`,
  `ExtensionCommandContext`, and tool-definition types, with signatures.

The single source of truth upstream is pi's own
`packages/coding-agent/docs/extensions.md` plus the type exports of
`@earendil-works/pi-coding-agent`. These skill references are distilled from a
pinned snapshot — when a citation and the installed pi disagree, the installed
pi wins.
</critical>

> **`file:line` citations are version-pinned anchors, not gospel.** Line numbers
> point into a specific pi snapshot (`pi-mono` / `@earendil-works/pi-coding-agent`)
> and **drift across releases**. Use them to *locate* a symbol, then verify against
> your installed version by matching the surrounding code, not the literal line.

## Gated workflow

Follow in order. Steps 1–2 are gates — do not write code until you pass them.

| Step | Action | Read |
|------|--------|------|
| 1 | **Confirm the contract** (gate) — check the installed pi version's surface | `references/api.md`, `references/events.md` |
| 2 | **Feasibility gate** — is this an extension at all? | this file → Feasibility gate |
| 3 | Design: pick events/tools, pick layout | `references/events.md`, `references/api.md` |
| 4 | Implement tools / providers | `references/tools.md`, `references/providers.md` |
| 5 | Add UI (only if user-visible output is needed) | `references/ui.md` |
| 6 | Avoid the traps | `references/gotchas.md` |
| 7 | Test | `references/testing.md` |
| 8 | Publish (only if shipping) | `references/publishing.md` |

Re-skim this file partway through a long build; it is easy to drift from the
gated order once code starts flowing.

### Step 1 — Confirm the contract (gate)

pi moves fast and its extension surface is large. Before designing, ground
yourself in the installed version:

- If pi source/docs are available (a `pi-mono` checkout, or
  `node_modules/@earendil-works/pi-coding-agent`), skim its `docs/extensions.md`
  and the exported types. That is upstream truth.
- Otherwise rely on `references/events.md` + `references/api.md` here and note
  they reflect a pinned snapshot.

Do not guess an event name or a return shape. The cost of a wrong return
contract is a silently-ignored handler (best case) or a hard error (worst case).

### Step 2 — Feasibility gate

Decide whether the request is achievable as an extension **before** designing.
If it is not, say so plainly and point at the right tool.

**Feasible with an extension:**
- Register tools the model can call (`registerTool` + `typebox` schemas), including
  **overriding a built-in** tool by re-registering its name (`read`, `bash`, `edit`, …).
- **Block** a tool call (`tool_call` → `return { block: true, reason }`) or **rewrite
  its arguments** in place (mutate `event.input`).
- **Modify a tool result** before the model sees it (`tool_result` → partial patch).
- **Intercept / transform / handle** user input before the LLM (`input` event).
- Inject a message and/or rewrite the system prompt **per turn** (`before_agent_start`).
- Non-destructively reshape the message list before each LLM call (`context`).
- Inspect or **replace the raw provider payload** (`before_provider_request`); read
  response status/headers (`after_provider_response`).
- React to the full lifecycle — session start/shutdown/switch/fork/compact/tree,
  agent/turn/message lifecycle, `model_select`, `thinking_level_select`.
- Add `/commands` (`registerCommand`), keybindings (`registerShortcut`), CLI flags
  (`registerFlag`).
- Register custom **model providers**, proxies, and **OAuth `/login`** flows
  (`registerProvider`).
- Drive the TUI: dialogs, notifications, status/widgets/footer/header, fully custom
  components and overlays (`ctx.ui.custom`), a custom editor (`CustomEditor`), and
  custom tool/message rendering.
- Control sessions from a command (`newSession`, `fork`, `switchSession`,
  `navigateTree`, `reload`, `waitForIdle`).
- Persist state across restarts (`appendEntry` + reconstruct from `sessionManager`).
- Spawn subagents (subprocess via `pi.exec` / RPC), route tools to SSH / a sandbox
  / a micro-VM (pluggable tool *operations*).
- Contribute skill / prompt / theme paths at discovery (`resources_discover`).
- Decide project trust (`project_trust`).
- Steer or queue messages (`sendMessage` / `sendUserMessage`, `deliverAs`).

**Not an extension (use the right escape):**
- **Rewriting the assistant response token-by-token mid-stream.** `message_update`
  is observe-only; you cannot edit tokens as they stream. `message_end` can replace
  the *finalized* message (same `role`), and `context` can reshape *prior* messages.
- **Baking a brand-new tool into the pi binary.** Register it as an extension tool,
  or contribute to pi core.
- **Doing work when no session ever starts.** The factory runs, but action methods
  (`sendMessage`, `appendEntry`, …) **throw during load** — only registration is
  valid there. Defer to `session_start`.
- **Just giving the model on-demand instructions / reference.** That is a *skill*
  (`SKILL.md` + assets), not an extension. Ship a skill when there is no programmatic
  hook to install. An extension can *contribute* skill paths via `resources_discover`.

Two runtime facts that shape what is safe (full list in `references/gotchas.md`):
- **The factory registers; it does not act.** During the factory call, action
  methods throw `"Extension runtime not initialized"`. Only `on`, `registerTool`,
  `registerCommand`, `registerShortcut`, `registerFlag`, `registerMessageRenderer`,
  `registerProvider`/`unregisterProvider` are valid. Background resources (watchers,
  sockets, timers) start in `session_start`, not the factory.
- **Return contracts are per-event and non-uniform.** Some events read a typed
  return (`tool_call`→`{block}`, `context`→`{messages}`, `before_agent_start`→
  `{message,systemPrompt}`, `input`→`{action}`, `session_before_*`→`{cancel}`,
  `project_trust`→**required** `{trusted}`); most are notification-only and ignore
  whatever you return. Check `references/events.md` per event.

### Step 3 — Design

Read `references/events.md`, pick the **smallest** set of events that does the job,
and confirm each one's return contract. If you register a tool, read
`references/tools.md`. A single `index.ts` is fine; split into modules only when the
extension is genuinely large. Do not manufacture structure.

### Steps 4–8

Tools → `references/tools.md`. Providers/OAuth → `references/providers.md`. UI →
`references/ui.md`. Traps → `references/gotchas.md`. Testing → `references/testing.md`.
Publishing → `references/publishing.md`.

## Extension anatomy

### Disk layout and registration

Extensions **auto-load** from trusted locations (project-local entries load only
after the project is trusted). Single file or a directory with `index.ts`:

| Scope | Path |
|-------|------|
| Global (all projects) | `~/.pi/agent/extensions/*.ts` or `~/.pi/agent/extensions/*/index.ts` |
| Project-local | `.pi/extensions/*.ts` or `.pi/extensions/*/index.ts` |

Only auto-discovered locations support hot reload via `/reload`. Use `pi -e ./x.ts`
(`--extension`, repeatable) for quick one-off tests. Add more paths or installed
packages in `settings.json`:

```json
{
  "packages": ["npm:@foo/bar@1.0.0", "git:github.com/user/repo@v1"],
  "extensions": ["/path/to/local/extension.ts", "/path/to/extension/dir"]
}
```

`pi install npm:…` / `pi install git:…` fetches packages; a package advertises its
entry points through the `pi.extensions` array in its `package.json`. See
`references/publishing.md`.

### The `ExtensionAPI` (the `pi` argument)

`pi` is how you register everything. The headline methods (full list +
signatures in `references/api.md`):

| Method | Use |
|--------|-----|
| `pi.on(event, handler)` | Subscribe to a lifecycle event. |
| `pi.registerTool(def)` | Add a tool the model can call. Works at load *and* at runtime. |
| `pi.registerCommand(name, opts)` | Add a `/command`. |
| `pi.registerShortcut(key, opts)` / `pi.registerFlag(name, opts)` | Keybindings / CLI flags. |
| `pi.registerProvider(name, cfg)` / `pi.unregisterProvider(name)` | Custom model provider / OAuth. |
| `pi.sendMessage(msg, opts)` / `pi.sendUserMessage(content, opts)` | Inject a custom or user message (`deliverAs: "steer"\|"followUp"\|"nextTurn"`). |
| `pi.appendEntry(type, data)` | Persist extension state to the session (not LLM-visible). |
| `pi.exec(cmd, args, opts)` | Run a shell command (abortable via `signal`). |
| `pi.getAllTools()` / `pi.getActiveTools()` / `pi.setActiveTools(names)` | Inspect / toggle active tools. |
| `pi.events` | Cross-extension event bus. |

### The context (`ctx`)

Every handler receives `ctx: ExtensionContext` (commands get
`ExtensionCommandContext`, a superset with session-control methods). The fields
you reach for most:

| Field | Use |
|-------|-----|
| `ctx.ui` | All user interaction — `select` / `confirm` / `input` / `editor` / `notify`, status / widgets / footer, `custom()`. |
| `ctx.mode` | `"tui"` \| `"rpc"` \| `"json"` \| `"print"` — guard TUI-only features. |
| `ctx.hasUI` | `true` in tui+rpc; `false` in print/json — guard dialogs. |
| `ctx.cwd` | Working directory — prefer over `process.cwd()`. |
| `ctx.sessionManager` | Read-only session state (`getEntries`, `getBranch`, `getLeafId`). |
| `ctx.signal` | Abort signal for the active turn — **often `undefined` when idle**. Thread into `fetch`/model calls. |
| `ctx.modelRegistry` / `ctx.model` | Models + API keys. |
| `ctx.shutdown()` / `ctx.compact()` / `ctx.getContextUsage()` | Lifecycle controls. |

### Minimal complete extension

A custom tool + a guard hook + an event listener — the three things most
extensions do:

```typescript
import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

export default function (pi: ExtensionAPI) {
  // 1. a tool the model can call
  pi.registerTool({
    name: "current_branch",
    label: "Current branch",
    description: "Return the current git branch",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _onUpdate, ctx) {
      const r = await pi.exec("git", ["-C", ctx.cwd, "rev-parse", "--abbrev-ref", "HEAD"], { signal })
      return { content: [{ type: "text", text: r.stdout.trim() }], details: {} }
      // to FAIL a tool: throw — never return an isError flag (it is ignored)
    },
  })

  // 2. block a dangerous bash call before it runs
  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("bash", event) && /\brm\s+-rf?\b/.test(event.input.command)) {
      if (!ctx.hasUI) return { block: true, reason: "rm -rf blocked (no UI to confirm)" }
      const ok = await ctx.ui.confirm("Dangerous", `Allow: ${event.input.command}?`)
      if (!ok) return { block: true, reason: "Blocked by user" }
    }
  })

  // 3. react to the reliable per-prompt boundary
  pi.on("agent_end", async (event, ctx) => {
    ctx.ui.setStatus("example", `done: ${event.messages.length} msgs`)
  })
}
```

### Output discipline

Route user-facing output through `ctx.ui.*` (`notify`, `setStatus`, `setWidget`).
In TUI mode the terminal is owned by pi's differential renderer; writing raw
`stdout` can disrupt it. `console.log` appears in pi examples for one-off provider
debugging, but it is not a UI channel — do not use it for anything the user is meant
to read. In `print`/`json` modes UI methods are no-ops, so never depend on a dialog
result for control flow without a `ctx.hasUI` guard.

## Which reference file to read

| You need to… | Read |
|--------------|------|
| Every lifecycle event, payload, and exact return contract (block/cancel/modify/ignored) | `references/events.md` |
| `ExtensionAPI` / `ExtensionContext` / `ExtensionCommandContext` signatures, session control, type guards | `references/api.md` |
| Define a tool — `registerTool`, `typebox` + `StringEnum`, `prepareArguments`, `execute` return, truncation, file-mutation queue, `terminate`, rendering | `references/tools.md` |
| Register a model provider, proxy a built-in, or build an OAuth `/login` | `references/providers.md` |
| Dialogs, status/widgets/footer, `ctx.ui.custom()` + overlays, `CustomEditor`, message rendering, theme | `references/ui.md` |
| Avoid the production traps — factory rule, stale context after reload/replacement, parallel tools, signal, StringEnum, truncation | `references/gotchas.md` |
| Load and verify an extension (`pi -e`, `--no-builtin-tools`, modes, test patterns) | `references/testing.md` |
| Discovery, locations, trust, jiti, hot reload, packaging (`pi.extensions`), `pi install`, npm/git distribution, naming | `references/publishing.md` |

## Common mistakes

| Mistake | Fix |
|---------|-----|
| Calling `pi.sendMessage` / `ctx.appendEntry` / other **action** methods from the factory body | They throw `"Extension runtime not initialized"` during load. Only *registration* is valid in the factory; act from `session_start` or a handler. |
| Returning `{ isError: true }` from a tool's `execute` to signal failure | Ignored. **Throw** to mark the tool errored and report it to the model. |
| `Type.Union` / `Type.Literal` for a string enum in tool params | Use `StringEnum([...] as const)` from `@earendil-works/pi-ai` — `Type.Union` breaks Google's API. |
| Reusing a captured `pi` / `ctx` after `ctx.reload()`, `newSession`, `fork`, or `switchSession` | Those references go **stale and throw**. For `reload`, treat `await ctx.reload(); return;` as terminal. For session replacement, do post-switch work in the `withSession(ctx => …)` callback with *its* `ctx`. |
| Expecting a return value to do something on a notification-only event (`agent_*`, `turn_*`, `model_select`, `message_start/update`, `session_start/shutdown`, `tool_execution_*`, `after_provider_response`) | They ignore returns. Side-effect via `ctx`. Check `references/events.md`. |
| `project_trust` handler that returns nothing | It **must** return `{ trusted: "yes" \| "no" \| "undecided" }`. Returning undecided defers to the next handler / built-in flow. |
| Mutating `event.input` in `tool_call` and *also* returning it | Mutate **in place** to rewrite args; the return value only controls `{ block, reason }`. No re-validation runs after your mutation. |
| Tool that mutates a file without `withFileMutationQueue` | Tools run in **parallel** by default; two writers can clobber each other. Queue the whole read-modify-write on the resolved absolute path. |
| Tool that dumps unbounded output | Tools MUST truncate (~50KB / 2000 lines). Use `truncateHead`/`truncateTail` and tell the model where the full output went. |
| Using `ctx.signal` assuming it is always set | It is `undefined` outside an active turn (session events, idle shortcuts). Guard before threading it into `fetch`/model calls. |
| `ctx.ui.custom()` / terminal input in `rpc`/`json`/`print` | `custom()` returns `undefined` outside `tui`. Guard with `ctx.mode === "tui"`; guard dialogs with `ctx.hasUI`. |
| Calling `waitForIdle` / `newSession` / `fork` from an **event** handler | Session-control methods live on `ExtensionCommandContext` (commands only) — they can deadlock from event handlers. |
| Treating the last `message_update` as "turn finished" | Use `agent_end` (per prompt) or `turn_end` (per LLM response) as the reliable boundary. |
| Path arg that fails when the model prefixes `@` | Some models emit `@path`. Built-in tools strip a leading `@`; normalize it in your tool too. |

## Credits

Synthesized from pi's own `packages/coding-agent/docs/extensions.md` and the
`@earendil-works/pi-coding-agent` type exports (`src/core/extensions/`), validated
against a `pi-mono` snapshot. Upstream docs are the maintained truth; these
references distill them into a gated build workflow.
