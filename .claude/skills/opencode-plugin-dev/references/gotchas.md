# Production Gotchas

> Battle-tested failure modes. Each entry is a trap someone hit in a shipped
> plugin, plus the working fix. Code is correct against the current API
> (`@opencode-ai/plugin` dev = `0.0.0-dev-202606061403`); when in doubt defer to
> `hooks.md` / `events.md`, which are generated from live source.

The single rule behind half of these: **opencode owns stdout and the model's
context.** Anything you write to the terminal corrupts the TUI; anything you
re-send to a session can silently reset its model. Work through the API, not
around it.

---

## 1. Never log to `console` — route everything through `client.app.log`

`console.log` / `console.error` go to the same stream the TUI renders into and
the JSON-RPC transport uses. They will not show up in opencode's log viewer and
they can garble the display or the protocol. Use the structured logger, which is
**body-wrapped** (a flat call is wrong):

```typescript
await client.app.log({
  body: {
    service: "my-plugin",          // required, namespaces your lines
    level: "info",                  // "debug" | "info" | "warn" | "error"
    message: "Something happened",  // required
    extra: { sessionID, err: String(e) }, // optional Record<string, unknown>
  },
})
```

Build a closure once at init so call sites stay terse:

```typescript
export const MyPlugin: Plugin = async ({ client }) => {
  const log = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) =>
    client.app.log({ body: { service: "my-plugin", level, message, extra } })

  return {
    event: async ({ event }) => { await log("info", `event ${event.type}`) },
  }
}
```

When `client.app.log` output isn't reachable (e.g. you're chasing an init-order
bug), drop to a temporary file logger — and rip it out before committing:

```typescript
import { appendFileSync } from "node:fs"
const dbg = (m: string) => { try { appendFileSync("/tmp/my-plugin.log", `${new Date().toISOString()} ${m}\n`) } catch {} }
```

---

## 2. TUI vs CLI: the model is attached at *different times*

This is the highest-value gotcha. Where the selected model lives depends on how
the session was started:

- **CLI** (`opencode run --model X "msg"`): the model is set on the session at
  creation. `session.created` already knows the model.
- **TUI** (`opencode`, pick a model via `/models`, then send): the model is
  **not** on the session when `session.created` fires. It rides in on the first
  message instead.

So reading `event.properties.info.model` inside `session.created` returns
`undefined` under the common TUI flow. If you then feed that `undefined` into a
`client.session.prompt` call, you reset the session to the default model.

```typescript
// WRONG — under TUI, session.model is undefined here
event: async ({ event }) => {
  if (event.type === "session.created") {
    const s = event.properties.info
    await client.session.prompt({
      path: { id: s.id },
      body: { parts: [{ type: "text", text: "bootstrap" }], model: s.model }, // undefined → default!
    })
  }
}
```

Always test both flows when your logic touches model/session timing.

---

## 3. Inject first-message context via `chat.message`, not `session.prompt`

The corollary to #2. If you want to prepend context to a user's first message,
do it by mutating the message text in `chat.message`. That mutation is *part of
the same turn* — no second API call, so the user's model selection is untouched.
Marking the session as bootstrapped on `session.created` and acting in
`chat.message` sidesteps the timing trap entirely:

```typescript
const bootstrapped = new Set<string>()

return {
  event: async ({ event }) => {
    if (event.type === "session.created") bootstrapped.delete(event.properties.info.id)
    if (event.type === "session.deleted") bootstrapped.delete(event.properties.info.id)
  },

  "chat.message": async (input, output) => {
    const text = output.parts.find((p) => p.type === "text")
    if (!text || bootstrapped.has(input.sessionID)) return
    text.text = "Bootstrap context\n\n" + text.text  // same turn, model preserved
    bootstrapped.add(input.sessionID)
  },
}
```

`input.sessionID` is reliably present in `chat.message`, which makes it the right
place for per-session first-touch logic.

---

## 4. When you *must* call `session.prompt`, carry model and agent forward

`session.prompt` defaults to the workspace default model/agent for any field you
omit. If you inject after the session already has a model (e.g. on
`session.compacted`, where the model is settled), fetch the session first and
pass its `model` and `agent` explicitly:

```typescript
const inject = async (sessionID: string, content: string) => {
  const session = await client.session.get({ path: { id: sessionID } })
  await client.session.prompt({
    path: { id: sessionID },
    body: {
      noReply: true,                                   // don't trigger an assistant turn
      parts: [{ type: "text", text: content }],
      model: session?.model,                           // preserve
      agent: session?.agent,                           // preserve
    },
  })
}
```

Rule of thumb: `chat.message` for first-message injection (model not yet
settled), `session.prompt` only after the model is known (post-compaction,
explicit user-driven flows).

---

## 5. Subagent events carry no flag — correlate via `parentID` at creation

There is no `isSubagent` or `parentSessionID` on `session.idle`. Filtering on
those fields silently never matches. The only signal is `Session.parentID`,
which is set on child sessions and present on the `session.created` payload.
Capture child session IDs at birth and consult the set later:

```typescript
const subagents = new Set<string>()

return {
  event: async ({ event }) => {
    if (event.type === "session.created" && event.properties.info.parentID) {
      subagents.add(event.properties.info.id)          // it's a child/subagent session
    }

    if (event.type === "session.idle") {
      const id = event.properties.sessionID
      if (subagents.has(id)) {
        subagents.delete(id)                           // cleanup, then skip
        return
      }
      // ...root session finished its turn
    }
  },
}
```

If you only have a `sessionID` (not the full `info`), fetch the session through
`client` and read `parentID` off it — same correlation, one round trip.

---

## 6. Use `session.idle` as the "turn finished" signal

Don't try to detect completion from the last `message.part.updated` — parts
stream and reorder, and you'll fire early or repeatedly. `session.idle` is the
reliable post-turn boundary. (See `events.md`.)

Forward-compat caveat: `session.idle` is marked `// deprecated` in source
(`session/status.ts:42`). It still fires today and remains the simplest
turn-finished signal in the v1 `Event` union the `event` hook is typed against, so
keep using it — but don't be blindsided if a future opencode steers you to the
`session.status` / `session.next.step.ended` family (which aren't in the v1 union
yet).

**Orchestrating background/child sessions? `session.idle` + a quiet-poll is not
enough.** If you build your own completion gate (waking on idle, or polling for "no
events for N seconds + some assistant output present"), beware: silent windows >5s
with *zero* SDK events are **normal mid-turn** — first-token latency on a large
prompt can be 20–30s, and an API `ECONNRESET` + retry backoff looks identical to
"done." A quiet-time heuristic will mark a task complete *mid-flight*, and
downstream reads (e.g. a structured-output registry) then see an empty result. Add
a **liveness veto** before completing, from two best-effort signals: (1)
`client.session.status()` — if it reports `busy`/`retry` (or the read itself
*throws*), the turn is live, do not complete; (2) the newest post-watermark
assistant message lacking `time.completed` means the turn is still streaming. Route
every completion path through one `assessTurn → {valid, live}` choke point,
status-veto first. Testing footgun: a *blocking in-session tool* cannot reproduce
this — it starves the turn events and the status reads simultaneously; unit-test the
gate logic rather than relying on a sleeping-tool e2e.

---

## 7. Throw semantics are NOT uniform — it depends on the hook

A thrown error means different things at different hooks. `trigger()` does not
catch; the outcome is decided entirely by the Effect boundary at the call site
(source `plugin/index.ts:286-299`). Two regimes:

| Hook group | Throw outcome |
| ---------- | ------------- |
| **Tool-execution** — `tool.execute.before`/`after` (native + MCP), `shell.env` at the bash-tool site | AI-SDK `tool-error`: that one tool call fails, the model sees the error, **the turn survives**. A de-facto veto. |
| **Prompt-pipeline** — `chat.message`, `chat.params`, `chat.headers`, `tool.definition`, `command.execute.before`, both `*.transform` (main site), `experimental.text.complete`, and the **`task`-tool** `tool.execute.before` | Defect → `prompt.ts:139` `Effect.catch(Effect.die)` → **hard crash of the whole request**. These hooks must not throw on bad input. |
| `shell.env` at the PTY site | aborts PTY creation. |
| Compaction hooks | propagates to the compaction caller. |
| `config` / `dispose` | swallowed (logged). `event`: escapes into the listener fiber (no per-hook catch — riskiest). `provider.models`: propagates into provider init. |

**Tool veto** — throw in `tool.execute.before` is the intended kill switch:

```typescript
"tool.execute.before": async (input, output) => {
  // input: { tool, sessionID, callID }   output: { args }
  if (input.tool === "read" && String(output.args.filePath).includes(".env")) {
    throw new Error("Reading .env files is blocked")
  }
}
```

To *modify* rather than block, mutate `output.args` in place.

**Mandatory for prompt-pipeline hooks**: a throw here takes down the turn, so wrap
any observational side effect in try/catch — never let an incidental failure
escape a `chat.*`, `*.transform`, or `tool.definition` hook:

```typescript
"chat.message": async (input, output) => {
  try { await sideEffect(input) } catch (e) { await log("error", `non-blocking: ${e}`) }
}
```

The same try/catch is good hygiene in tool hooks but is only *load-bearing* in the
prompt pipeline, where the blast radius is the entire request.

---

## 8. `tool.execute.after` input now includes `args`

The post-execution hook input is `{ tool, sessionID, callID, args }` — the
(possibly rewritten) arguments are available alongside the result. Older
snapshots omit `args`. Mutate `output` (`title`, `output`, `metadata`) to
rewrite what the model and UI see — redact secrets, truncate noise, annotate:

```typescript
"tool.execute.after": async (input, output) => {
  // input: { tool, sessionID, callID, args }
  output.output = output.output.replace(/sk-[A-Za-z0-9]+/g, "[redacted]")
}
```

---

## 9. `permission.ask` never fires — auto-approve the real way

The `permission.ask` hook is **declared in the `Hooks` type but never triggered**
anywhere in `packages/opencode/src` (it exists only as the type at
`packages/plugin/src/index.ts:261`; permission flow runs through the
`Permission.ask` *service* at `session/processor.ts:542`, not this hook). Write a
`permission.ask` hook and it silently never runs. Do not rely on it.

Two mechanisms actually work:

**A — pre-emptive veto: throw in `tool.execute.before`.** A thrown error fails
that one tool call (see §7); the model gets a tool-error, the turn survives. This
is the de-facto "deny" for a tool you can predict.

```typescript
"tool.execute.before": async (input, output) => {
  if (input.tool === "bash" && /rm\s+-rf\s+\//.test(output.args.command ?? "")) {
    throw new Error("Blocked dangerous command")
  }
}
```

**B — answer a pending prompt: respond to `permission.asked` from the `event` hook.**
opencode emits `permission.asked` (real, `permission/index.ts:14`) when it needs a
decision. Answer it programmatically — note the flat, ungrouped client method name:

```typescript
event: async ({ event }) => {
  if (event.type !== "permission.asked") return
  const p = event.properties               // the Permission request
  if (p.type === "bash" && String(p.pattern ?? "").startsWith("git ")) {
    await client.postSessionIdPermissionsPermissionId({
      path: { id: p.sessionID, permissionID: p.id },
      body: { response: "always" },         // "once" | "always" | "reject"
    })
  }
}
```

There is no `client.permission.*` group — the method lives flat on `client`
(`sdk.gen.ts:1161`). `response: "reject"` denies; `"once"`/`"always"` approve.

---

## 10. Every hook is async — `await` your side effects

All hooks return `Promise<void>`. Fire-and-forget calls (a missing `await`) may
not finish before the hook returns and opencode moves on, so notifications get
dropped and ordering is non-deterministic:

```typescript
// WRONG — may never complete
event: async ({ event }) => { sendNotification() }

// CORRECT
event: async ({ event }) => { await sendNotification() }
```

The one deliberate exception is a true background task you *want* detached —
e.g. the update checker (`publishing.md`), which uses `setTimeout` and must
**not** be awaited so it never blocks init.

---

## 11. Fail soft on init: return `{}` to disable cleanly

If a plugin can't initialize (missing config, unreachable dependency), don't
throw out of the plugin function — return an empty hooks object. The plugin
loads as a no-op instead of breaking the whole session:

```typescript
export const MyPlugin: Plugin = async ({ client, directory }) => {
  const log = (level, message, extra) => client.app.log({ body: { service: "my-plugin", level, message, extra } })
  const config = loadConfig(directory)
  if (!config) {
    await log("warn", "disabled — no config found")
    return {}
  }
  return { /* hooks */ }
}
```

---

## 12. Dependencies: `package.json` beside the plugin, not `npm install`

For a local (file-loaded) plugin that imports npm packages, declare them in a
`package.json` next to the plugin directory:

```jsonc
// ~/.config/opencode/package.json   or   <project>/.opencode/package.json
{ "dependencies": { "ignore": "^5.3.0", "lodash": "^4.17.21" } }
```

opencode installs these at startup so users don't have to. The install runs
through `@npmcli/arborist` (`reify`, `core/src/npm.ts`), **not** `bun install` —
and with `ignoreScripts: true`, so a dependency's own `postinstall` scripts do
NOT run. (For published plugins, deps are handled by the package's own manifest;
see `publishing.md`.)

---

## 13. TUI toasts: body-wrapped, and may be unavailable

`client.tui.showToast` is body-wrapped like the logger. The TUI is not present in
headless/CLI runs, so the call can fail — never let it crash the plugin:

```typescript
try {
  await client.tui.showToast({ body: { title: "My Plugin", message: "Done", variant: "info" } })
} catch { /* no TUI — ignore */ }
```

Likewise, `tui.*` events only fire under the TUI. Don't build core logic on them.
(See `events.md`.)

---

## 14. Prefer `directory` / `worktree` over `process.cwd()`

The plugin context and tool context both expose `directory` (session cwd) and
`worktree` (git root). `process.cwd()` is the opencode process's directory, which
is frequently *not* where the user's work lives. Use the provided values.

---

## 15. `$` (Bun shell) can be `undefined` at runtime

`PluginInput.$` is typed non-optional (`BunShell`), but core sets it to
`undefined` outside Bun — `$: typeof Bun === "undefined" ? undefined : Bun.$` with
a `@ts-expect-error` (`plugin/index.ts:162`). A plugin that calls `$` unguarded
crashes on a non-Bun host. Guard it:

```typescript
export const MyPlugin: Plugin = async ({ $ }) => {
  if (!$) return {}                 // no shell here — degrade or disable
  const out = await $`git rev-parse HEAD`.text()
  return { /* hooks */ }
}
```

Separately, the `BunShell` *type* is imported-but-not-re-exported by
`@opencode-ai/plugin`, so `import type { BunShell } from "@opencode-ai/plugin"`
does **not** resolve. Derive it from the input type instead:
`type BunShell = PluginInput["$"]`.

---

## 16. A tool guard double-fires for subagents

The full hook set fires *inside* subagent sessions (subagents run the same
`prompt`/`processor`/`session/tools` machinery). Additionally, the **parent's**
`tool.execute.before`/`after` fire for the `task`-tool dispatch itself
(`prompt.ts:340`/`419`). So when the model spawns a subagent that then calls
`read`, your `tool.execute.before` fires twice: once with `input.tool === "task"`
(the dispatch), once with `input.tool === "read"` (inside the child). If you only
want the real tool call, skip the dispatch:

```typescript
"tool.execute.before": async (input, output) => {
  if (input.tool === "task") return          // the subagent dispatch, not a real tool
  // ...guard the actual tool
}
```

There is no `isSubagent` flag on most hook inputs; correlate child sessions via
`Session.parentID` at `session.created` instead (see §5).

---

## 17. `config` can inject providers/models — it runs first

The `config` hook fires once at init, **before the provider layer reads config**
(by design: `provider.ts:1342-1345` calls `plugin.list()` precisely so the
config-mutation hook has already run). So mutating providers/models in `config`
works — the provider layer honors what you injected. Mutate `cfg` in place; the
return value is ignored, and a throw here is swallowed (logged), so it can't break
startup.

The same hook injects **agents, keybinds, and slash commands** — mutate
`cfg.agent`, `cfg.keybind`, `cfg.command` in place. There is **no** dedicated
"register a command" plugin API: a user-facing `/command` is just a `cfg.command`
entry. This is how Claude-Code-style loaders work — they read `.claude/commands` /
`.opencode/command/*.md` markdown (with `$ARGUMENTS`) and translate each into a
`cfg.command` entry, project scope overriding user scope.

---

## TUI rendering (Solid/opentui surface)

These four are about the *TUI* plugin surface, not the server one. Depth, full
API tables, and the scroll-follow patterns live in `references/tui-rendering.md`;
these are the traps that bite first.

## 18. `solid-js` / `@opentui` value imports belong in `.tsx` only

opencode's host transforms `.tsx`/`.jsx` at load and the transformed code
resolves Solid/opentui to the **host's single instance**. A `.ts` file under the
TUI source is *not* transformed, so any value import of `solid-js`/`@opentui` in
it binds to this package's nested copy — a **second** Solid/opentui runtime — and
you get `Orphan text error: "" must have a <text> as a parent` at navigate time.
Keep all Solid/opentui imports in `.tsx`; pure logic stays Solid-free `.ts` (e.g.
`paths.ts`, the JSX-free helper). The index header documents this as load-bearing
(`packages/workflows/src/tui/index.tsx:12-26`) and a test enforces it — every
non-`.tsx` file under `src/tui` must import no `solid-js`/`@opentui`
(`packages/workflows/src/tui/paths.test.ts:77-84`). See `references/tui-rendering.md`.

## 19. The TUI dist must be bundled *with* the Solid transform

`@opentui/solid`'s `./jsx-runtime` and `./jsx-dev-runtime` both point at a
**type-only** `.d.ts` — there is no runtime jsx factory (`@opentui/solid`
`package.json:41-42`). The host injects the real factory via its load-time
transform; a plain `tsc`/`Bun.build` does **not** inherit it and emits generic
`jsxDEV()`/`jsx()` calls against that nonexistent runtime, so `dist/tui.js`
crashes on the first JSX call. This shipped as `opencode-drawer-workflows@1.0.0`
and crashed the viewer. Fix in `scripts/build.ts`: import
`createSolidTransformPlugin` from `@opentui/solid/bun-plugin`, pass it as a
`plugins:[…]` entry on the `.tsx` TUI entry **only**, and externalize `@opentui/*`
+ `solid-js` so the bundle uses the host's single instance
(`scripts/build.ts:16-17,31,36-41,80-85`). See `references/tui-rendering.md`.

## 20. Validating `src` is not validating the `dist`

The host re-compiles `.tsx` from **source** at load, so a TUI plugin loaded via
`file://` or a config path "works" in dev even when the bundler is misconfigured.
A published `.js` dist gets **no** such transform (the host filter matches only
`.tsx`/`.jsx`, `@opentui/solid` `scripts/solid-plugin.ts:100`), so `opencode run`
against source can pass while the npm bundle crashes on load — exactly the 1.0.0
trap. Therefore smoke-test the **built bundle**, not just source: grep `dist/tui.js`
for `jsxDEV` (must be 0) and `createComponent` (must be >0). Note: this repo's only
smoke harness drives the *server* source, not the dist
(`packages/workflows/test-harness/run-smoke.ts`); the static guard against the
dual-instance crash is `paths.test.ts:77-84`, not a built-bundle grep — so the dist
gap is currently unprotected. See `references/tui-rendering.md`.

## 21. `ScrollBox` culling renders off-viewport rows black; flex panes need `minWidth={0}`

`ScrollBoxOptions.viewportCulling` defaults to **true** and drops children outside
the measured viewport (`@opentui/core` `ScrollBox.d.ts:18-126`); in practice in-box
rows got dropped to the background ("black") unless each scrollable row is
`flexShrink={0}` so it takes its natural height — see the live comment at
`packages/workflows/src/tui/route.tsx:452-453`, fixed with `viewportCulling={false}`
for small lists (`route.tsx:454`) and `<text flexShrink={0}>` per row
(`route.tsx:469,475`). Separately, flex panes sharing a row need `minWidth={0}` or a
child's min-content width blocks shrinking and the split + scrollbar gutter drift
(`route.tsx:446-456`). See `references/tui-rendering.md`.

## 22. A `./tui` plugin and a server plugin are SEPARATE PROCESSES — talk via files

The TUI plugin runs in the opencode **TUI process**; a server/`"."` plugin runs in
the **server process**. They share no memory — a viewer pane **cannot call the
server plugin's in-memory engine** directly. Any "viewer drives the engine" feature
(cancel a run from a panel, save it, read live run state) must cross the process
boundary through the filesystem:

- **Control channel (viewer → engine):** the viewer writes a sentinel file
  (e.g. `<dataDir>/<ns>-control/<id>.cancel`); the engine runs a **poll loop** over
  that dir, acts, then deletes the sentinel. Poll, don't `fs.watch` — watch is
  platform-flaky and most engine FS abstractions don't expose it. Put any payload
  (e.g. a save name) in the sentinel body and read it before consuming.
- **Data channel (engine → viewer):** the engine appends to a JSONL **feed file**;
  the viewer tails it. Frame it — a `run:start` first line and a `run:end` last line
  as the termination marker the viewer keys on. The viewer holds **no state of its
  own**: it re-renders a settled run purely from the feed file, so it survives a TUI
  restart.
- Serialize every append through a single promise-chain queue (one
  `JSON.stringify(ev)+"\n"` at a time) so concurrent writes never interleave a
  half-line, and fence it with a dead-latch (first FS error logs once, flips dead,
  drops later writes — a broken disk must never break a run).
- **Ordering footgun:** on a *cancel*, in-flight children's `*:end` events can land
  *after* you wrote `run:end`, breaking the "run:end is terminal" invariant the
  viewer trusts. A closure holding a direct writer reference keeps appending after
  you drop it from a map — emit `run:end` only from the run's own settle branch
  (after the abort has flushed the in-flight ends), or seal the writer first.

Because the viewer is a detached reader, its toasts are **optimistic** — they
confirm the sentinel was *written*, not that the engine validated and acted. Expose
the same operation as a server-plugin tool when the caller needs the real outcome.

---

## Debugging checklist

1. Structured logging only — `client.app.log`, never `console`.
2. Log `event.type` to confirm which events actually fire in your scenario.
3. Build a minimal one-hook plugin to isolate behavior before wiring it together.
4. Hook names are exact strings — a typo means the hook silently never runs.
5. Test CLI and TUI flows separately whenever model/session timing matters.
6. Temporary file logging when the structured log stream isn't visible (remove
   before commit).

---

## Dropped on purpose (contradicted by live source)

- **Both `plugin/` and `plugins/` load.** The auto-scan glob is
  `{plugin,plugins}/*.{ts,js}` (`config/plugin.ts:21`) — singular AND plural are
  scanned, one level deep, `.ts`/`.js` only. Plural is the convention; singular
  works too (the auth-override test loads from `.opencode/plugin/`). The earlier
  "singular is stale, use plural" claim was wrong.
- **`permission.ask` hook is inert.** Declared in the type, never triggered. See
  §9 for the mechanisms that actually work.

## Phantom events (in the v1 union type, never emitted at runtime)

The `event` hook is typed against the v1 SDK `Event` union, which contains
members the runtime never `EventV2.define`s. These will never fire — do not build
on them:

- **`permission.updated`** — in the v1 union (`types.gen.ts:440`) but no source
  emits it. The real permission events are `permission.asked` and
  `permission.replied` (both emitted; `permission.replied` is the "user decided"
  signal). The earlier "`permission.updated` exists, doubt was unfounded" note was
  itself wrong.
- `vcs.branch.updated` **is** real (`project/vcs.ts:243`) — keep using it.

See `events.md` for the full runtime-vs-type gap.
