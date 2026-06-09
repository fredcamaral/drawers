---
name: opencode-plugin-dev
description: >-
  Build, debug, and publish opencode plugins with the @opencode-ai/plugin SDK —
  hooks, custom tools, auth/model providers, and event handling. Use when working
  in an opencode plugin repo or anytime the task touches @opencode-ai/plugin or
  @opencode-ai/sdk. Use when: "create a plugin to block dangerous bash commands"
  (tool.execute.before), "add a custom tool the agent can call" (tool() helper),
  "show a toast on file edit" (event hook + tui), "build a custom auth/OAuth
  provider" (auth hook), "inject context on the first message of a session"
  (chat.message), "override temperature for the build agent" (chat.params),
  "run code when a session finishes" (session.idle event), "my plugin loads but
  the hook never fires", "console.log breaks the TUI", or "publish my plugin to
  npm". Covers the plural .opencode/plugins/ layout and opencode.json plugin array.
---

# opencode plugin development

A plugin is one async function exported from a TS/JS module. It receives a
context object and returns a `Hooks` object. opencode calls the hooks you
provide and ignores the rest. That is the whole model.

```typescript
import type { Plugin } from "@opencode-ai/plugin"

export const MyPlugin: Plugin = async ({ client, project, directory, worktree, $ }) => {
  // setup runs once at load
  return {
    // hooks go here
  }
}
```

<critical>
Two reference files are generated from the live opencode source and override
everything else, including any code you remember from training. Read them before
writing hook or tool code:
- `references/hooks.md` — the complete current `Hooks` interface, every signature.
- `references/events.md` — the complete current `Event` union for the `event` hook.
Vendored examples and blog posts go stale fast. The generated refs are truth.
</critical>

> **`file:line` citations are version-pinned anchors, not gospel.** The line numbers
> throughout these references point into specific opencode/SDK/opentui versions (each
> reference dates itself in its header) and **drift across releases**. Use them to
> *locate* — "find this symbol near here" — then verify against your installed
> version by matching on the surrounding code, not the literal line. `hooks.md` /
> `events.md` are regenerable (Step 1); the hand-written source cites are not.

## Gated workflow

Follow these steps in order. Steps 1 and 2 are gates — do not write code until
you have passed them.

| Step | Action | Read |
|------|--------|------|
| 1 | **Refresh the API refs** (gate) | run `scripts/extract-plugin-api.ts` |
| 2 | **Check feasibility** (gate) | this file → Feasibility gate |
| 3 | Design: pick hooks, pick layout | `references/hooks.md`, `references/events.md` |
| 4 | Implement | `references/custom-tools.md` (tools), `references/auth.md` (providers) |
| 5 | Add UI feedback (only if user-visible output is needed) | `references/ui-feedback.md` |
| 6 | Test | `references/testing.md` |
| 7 | Publish (only if shipping to npm) | `references/publishing.md` |

Re-skim this file partway through a long build; it is easy to drift from the
gated order once code starts flowing.

### Step 1 — Refresh the API refs (gate)

The SDK moves. Regenerate the references against the installed `@opencode-ai/plugin`
before designing anything:

```bash
bun run scripts/extract-plugin-api.ts
```

This rewrites `references/hooks.md` and `references/events.md` from the live
source. If the script fails or the SDK is not installed, say so and fall back to
the committed refs (note the date in their header) rather than guessing.

### Step 2 — Feasibility gate

Decide whether the request is achievable with the available hooks **before**
designing. If it is not, tell the user plainly and point them at the right tool.
The lists below are verified against the current `Hooks` interface.

**Feasible with a plugin:**
- Block or rewrite tool calls by **throwing** in `tool.execute.before` (the throw fails just that
  tool call; the turn survives — there is no "deny" return, and `permission.ask` does NOT work; see
  Common mistakes). To auto-answer a real permission prompt, post on the `permission.asked` event (see below).
- React to events — file edits, session idle/created/deleted, command runs (`event`).
- React when a subagent runs — the full hook set fires inside subagent sessions AND headless
  `opencode run`; the parent's `tool.execute.before/after` also fire for the `task`-tool dispatch.
- Add custom tools the model can call (`tool` + the `tool()` helper).
- Override sampling params, headers, or the small/fast model (`chat.params`, `chat.headers`, `experimental.provider.small_model`).
- Rewrite incoming user messages and inject context (`chat.message`).
- Append or replace the system prompt, and reshape message history (`experimental.chat.system.transform`, `experimental.chat.messages.transform`).
- Custom auth / OAuth / API-key flows and dynamic model lists for a provider (`auth`, `provider`).
- Customize session compaction and the auto-continue behavior (`experimental.session.compacting`, `experimental.compaction.autocontinue`).
- Inject defaults into config at startup — including agents and keybinds (`config`).
- Rewrite tool descriptions/params and post-process completed assistant text (`tool.definition`, `experimental.text.complete`).
- Inject or scrub env vars for spawned shells (`shell.env`).
- Show toasts / status in the TUI (via `client.tui`).

**Not feasible from a *server* plugin:**
- Custom TUI rendering, panes, or layout → not reachable from the server `Plugin` surface. It lives on a
  separate `./tui` plugin entrypoint: a `default` export shaped `{ id, tui }` that the runtime loads via
  `readV1Plugin` (`packages/opencode/src/plugin/shared.ts:285-301`); a single module exports `server()`
  OR `tui()`, never both (`shared.ts:293-295`). Note the published `@opencode-ai/plugin` type still pins
  `PluginModule.tui?: never` (`plugin/src/index.ts:79`) — the type lags the runtime. To **build** a TUI
  plugin (Solid-JSX/opentui panes, dialogs, routes, keybinds, v2 client), read `references/tui.md`. Such a
  plugin must be **bundled with the Solid transform** (`@opentui/solid`'s `createSolidTransformPlugin`),
  not plain `tsc`/`Bun.build` — `@opentui/solid`'s `./jsx-runtime` is a type-only stub, so an untransformed
  bundle emits `jsxDEV()` calls against a nonexistent runtime and crashes on load
  (`references/tui-rendering.md`, `references/publishing.md`). For
  server-side UI from a server plugin, use `client.tui.*` (toasts / prompt / dialogs) instead
  (`references/ui-feedback.md`).
- New built-in tools baked into the binary → contribute to `packages/opencode`, or add them as plugin tools instead.
- Intercepting the assistant response mid-stream / token-by-token → no hook for it. `experimental.text.complete` only runs *after* a text part finishes.
- Defining brand-new permission *types* → not registerable. The `permission.ask` hook is also **inert**
  (declared in the type but never triggered in the current source). To auto-approve/deny, either **throw**
  in `tool.execute.before` (pre-emptive veto), or answer the pending prompt via
  `client.postSessionIdPermissionsPermissionId({path:{id,permissionID},body:{response:"once"|"always"|"reject"}})`
  from the `event` hook on `permission.asked`.
- Rewriting opencode's internal file read/write implementation → not exposed.

Two runtime facts that shape what is safe to attempt (detail in `references/gotchas.md`):
- **Throw semantics are non-uniform.** Throwing in a tool hook (`tool.execute.before/after`, `shell.env`)
  fails only that tool call — the turn survives (de-facto veto). Throwing in a prompt-pipeline hook
  (`chat.*`, `*.transform`, `tool.definition`, `command.execute.before`, `experimental.text.complete`)
  hard-crashes the request. Never throw on bad input in a prompt-pipeline hook.
- **Mutation is by reference only.** Reassigning the `output` param does nothing; only in-place field
  mutation is read. Return values are ignored everywhere except `experimental.text.complete`.

> Note: igor's older snapshot listed "adding keybinds/commands" and "changing
> agent prompts" as impossible. That is no longer true — `config` injects keybinds
> and agents, and `experimental.chat.system.transform` rewrites the system prompt.
> Trust the lists above, which match the current refs.

If the answer is "not a plugin," the usual escapes are: an MCP server (external
tools), a shell script / git hook (simple automation), or a core contribution.

### Step 3 — Design

Read `references/hooks.md` and pick the smallest set of hooks that does the job.
Two-arg hooks mutate `output` in place; single-arg hooks (`event`, `config`,
`dispose`) are for observation and setup. If you use the `event` hook, read
`references/events.md` for the exact `type` strings and payload shapes.

File layout — splitting into modules is a **suggestion, not a rule**. A single
`index.ts` is fine for a focused plugin. Split into `hooks/`, `tools/`, `types.ts`
only when the plugin is genuinely large enough to benefit. Do not manufacture
structure for its own sake.

### Step 4 — Implement

- Custom tools → `references/custom-tools.md` (the `tool()` helper, `tool.schema.*`).
- Auth / model providers → `references/auth.md`.
- Always import the types: `import type { Plugin } from "@opencode-ai/plugin"`.

### Steps 5–7

UI feedback → `references/ui-feedback.md`. Testing → `references/testing.md`.
Publishing → `references/publishing.md`.

## Plugin anatomy

### Disk layout and registration

The auto-scan glob is `{plugin,plugins}/*.{ts,js}`, so **both `plugin/` (singular) and
`plugins/` (plural) load** — plural is the convention. The glob is **one level deep** (no nested
subdirs) and matches **only `.ts`/`.js`** (no `.tsx`/`.mjs`/`.cjs`). Files dropped here auto-load:

| Scope | Path |
|-------|------|
| Project | `.opencode/plugins/` (or `.opencode/plugin/`) |
| Global | `~/.config/opencode/plugins/` (or singular) |

Or register explicitly in `opencode.json` under the `plugin` array — npm packages
are installed automatically with Bun at startup; local file paths also work:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-wakatime",
    "@my-org/custom-plugin",
    "./local-plugin.ts"
  ]
}
```

Per-plugin options use the tuple form: `["@my-org/plugin", { "apiKey": "..." }]`,
delivered to the plugin's second argument.

### The context object (`PluginInput`)

The first argument carries everything the plugin needs. Current shape:

| Field | Type | Use |
|-------|------|-----|
| `client` | opencode SDK client | call the server API (`client.session.*`, `client.app.log`, `client.tui.*`) |
| `project` | `Project` | project id / metadata |
| `directory` | `string` | session cwd — prefer this over `process.cwd()` |
| `worktree` | `string` | git worktree root |
| `serverUrl` | `URL` | base URL of the running opencode server |
| `experimental_workspace` | `{ register(type, adapter) }` | register custom workspace adapters (remote/sandbox) |
| `$` | `BunShell` | Bun tagged-template shell runner |

The plugin function also takes an optional **second argument** — the per-plugin
options from the `opencode.json` tuple form:
`Plugin = (input, options?) => Promise<Hooks>`.

### Minimal complete plugin

A custom tool plus a guard hook plus an event listener — the three things most
plugins actually do:

```typescript
import { type Plugin, tool } from "@opencode-ai/plugin"

export const ExamplePlugin: Plugin = async ({ client, directory, $ }) => {
  // structured logging helper — never console.log (see Common mistakes)
  const log = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) =>
    client.app.log({ body: { service: "example-plugin", level, message, extra } })

  await log("info", "plugin loaded", { directory })

  return {
    // custom tool the model can call
    tool: {
      "example_branch": tool({
        description: "Return the current git branch",
        args: {
          short: tool.schema.boolean().optional().describe("strip refs/heads/ prefix"),
        },
        async execute(args, ctx) {
          const out = (await $`git -C ${ctx.directory} rev-parse --abbrev-ref HEAD`.text()).trim()
          return args.short ? out.replace(/^refs\/heads\//, "") : out
        },
      }),
    },

    // block a dangerous bash invocation before it runs
    "tool.execute.before": async (input, output) => {
      if (input.tool === "bash" && /rm\s+-rf\s+\//.test(output.args.command ?? "")) {
        throw new Error("blocked: rm -rf on an absolute path")
      }
    },

    // react to a session finishing (the reliable "turn done" signal)
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        await log("info", "session idle", { sessionID: event.properties.sessionID })
      }
    },
  }
}
```

### Logging shape

`client.app.log` is **body-wrapped**. Flat calls are wrong:

```typescript
await client.app.log({
  body: { service: "my-plugin", level: "info", message: "hello", extra: { foo: 1 } },
})
```

Route all diagnostics through it. Writing to `console.log`/stdout corrupts the
TUI render and the JSON-RPC stream.

## Which reference file to read

| You need to... | Read |
|----------------|------|
| Find the exact signature of any hook, the `PluginInput` / `Plugin` types, mutation contract | `references/hooks.md` |
| Find an event's `type` string and `properties` payload for the `event` hook | `references/events.md` |
| Define a custom tool — the `tool()` helper, `tool.schema.*` args, `ToolContext`, return shapes | `references/custom-tools.md` |
| Build an auth / OAuth / API-key flow or a dynamic model provider | `references/auth.md` |
| Avoid the production traps — session timing, subagent filtering, model preservation, logging | `references/gotchas.md` |
| Load the plugin locally and verify hooks actually fire (CLI vs TUI) | `references/testing.md` |
| Publish to npm, naming conventions, version-update notifications | `references/publishing.md` |
| Show toasts or inline status in the TUI from a *server* plugin (via `client.tui.*`) | `references/ui-feedback.md` |
| Render custom UI panes in the TUI (`./tui` entrypoint, v2 client) | `references/tui.md` |
| Build/compile a TUI plugin's JSX, lay out panes, ScrollBox + scroll-follow, TUI UX patterns | `references/tui-rendering.md` |
| Regenerate `hooks.md` / `events.md` from the installed SDK | `scripts/extract-plugin-api.ts` |

## Common mistakes

| Mistake | Fix |
|---------|-----|
| `client.registerTool()` | Does not exist. Register tools via the `tool` hook: `tool: { name: tool({...}) }`. |
| Raw `zod` import for tool args, or a `parameters:` field | Use `args:` with `tool.schema.*` (zod re-exported from `@opencode-ai/plugin`). No `parameters` key. |
| `console.log` / `console.error` in a plugin | Corrupts TUI + JSON-RPC. Use `client.app.log({ body: { service, level, message } })`. |
| Nested or `.tsx`/`.mjs` plugin files in the auto-scan dir | The glob is `{plugin,plugins}/*.{ts,js}` — one level deep, `.ts`/`.js` only. Both `plugin/` and `plugins/` load (plural is convention); subdirs and other extensions are ignored. |
| Flat `client.app.log({ service, level, message })` | Must be `body`-wrapped: `client.app.log({ body: { ... } })`. |
| Sync hook handler | Every hook is `async` and returns `Promise<void>`. Mark it `async` and `await` inside. |
| Returning a value to block a tool | Return values are ignored. To block, **throw** in `tool.execute.before` — the throw fails that tool call as a tool-error; the turn survives. |
| Relying on the `permission.ask` hook | It is declared in the type but **never triggered** in the current source — it silently never fires. Auto-deny by throwing in `tool.execute.before`; auto-answer a real prompt via `client.postSessionIdPermissionsPermissionId(...)` on the `permission.asked` event. |
| Reassigning `output` (`output = {...}`) or returning to change behavior | Only **in-place field mutation** of `output` is read (`output.x = ...`); reassigning the param or returning is ignored everywhere except `experimental.text.complete`. `input` is read-only context. |
| Importing the wrong SDK generation | `chat`/`tool` hooks + the `event` hook use `@opencode-ai/sdk` (v1) types; `auth`/`provider` hooks and ALL of `./tui` use `@opencode-ai/sdk/v2`. Importing the v1 `Model`/`Provider` into an auth hook (or vice versa) is a real footgun. |
| Reading `event.properties.isSubagent` / `parentSessionID` on `session.idle` | They are undefined. Track subagents at `session.created` via `event.properties.info.parentID` (a Set), filter on idle. See `references/gotchas.md`. |
| `session.prompt()` for first-message context injection | In TUI the model is set on the first message, not at `session.created` — injecting via `session.prompt` resets the model. Prepend in `chat.message` instead. See `references/gotchas.md`. |
| Treating the last `message.part.updated` as "turn finished" | Parts stream and reorder. Use the `session.idle` event as the reliable post-turn boundary. |
| Listening for `permission.updated` | It is in the v1 `Event` union but is a **phantom** — no source emits it. Use `permission.asked` / `permission.replied` instead. (`vcs.branch.updated` IS real.) Verify any event against `references/events.md`. |
| Depending on `tui.*` events in headless runs | `tui.*` events only fire under the TUI, not for CLI/headless server runs. |
| `process.cwd()` for paths | Prefer `directory` / `worktree` from `PluginInput` (or `ctx.directory` in a tool) — cwd may not be the session root. |
| Bundling a `./tui` plugin with `tsc` / plain `Bun.build` | The bundle crashes on load: `@opentui/solid`'s `jsx-runtime` is a **type-only stub**, so untransformed JSX emits `jsxDEV()` against no runtime. Bundle with the Solid transform (`createSolidTransformPlugin`) and externalize `@opentui/*` + `solid-js`. See `references/tui-rendering.md`. |

## Credits

This skill is a rewritten synthesis (no verbatim source text) of three community
skills, validated against the live opencode source as of 2026-06-06:

- **IgorWarzocha/Opencode-Workflows** — the gated 7-step workflow and feasibility gate.
- **alexismanuel/dotfiles** — battle-tested production gotchas (session timing, subagent filtering, model preservation, logging discipline).
- **pantheon-org/opencode-plugins** — current core API surface, auth coverage, idiomatic examples.

Where sources disagreed, `references/hooks.md` and `references/events.md`
(generated from source) won.
