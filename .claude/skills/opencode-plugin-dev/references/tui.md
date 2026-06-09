# TUI Plugin Reference

> The `./tui` entrypoint of `@opencode-ai/plugin` — custom panes, dialogs, routes,
> keybinds, and slot UI rendered inside the opencode terminal. A **different
> surface** from the server `Plugin`. Verified against a local `sst/opencode@dev`
> clone, 2026-06-06. Ground truth: `packages/plugin/src/tui.ts` (the `./tui` types),
> `packages/opencode/src/cli/cmd/tui/plugin/runtime.ts` (how TUI plugins load),
> `packages/opencode/src/plugin/shared.ts` (`readV1Plugin`, the export detector).
> Trust this file over training memory — opentui-backed TUI plugins are new and
> the published types lag the runtime (see Type-lag gotcha).

## TUI plugin vs server plugin

Two entirely separate plugin surfaces, loaded by different runtimes:

| | **Server plugin** (`references/hooks.md`) | **TUI plugin** (this file) |
|---|---|---|
| Export | `export const X: Plugin = async (input) => Hooks` (named/`server`) | `export default { id, tui }` (`default` export only) |
| Entrypoint | package `"."` / `main`, or auto-scan `{plugin,plugins}/*.{ts,js}` | package `"./tui"` export, or a `tui.json` origin |
| Runs in | the opencode **server** process | the opencode **TUI** (terminal) process |
| Receives | `PluginInput` (`client`, `project`, `directory`, `$`, …) | `TuiPluginApi` (`api.ui`, `api.slots`, `api.route`, `api.client`, …) |
| SDK client | **v1** `@opencode-ai/sdk` (`PluginInput.client`) | **v2** `@opencode-ai/sdk/v2` (`api.client`) — do not conflate |
| Job | observe/modify model behavior (hooks, tools, auth) | render custom UI: panes, dialogs, routes, keybinds, toasts |
| Headless | full hook set fires under `opencode run` | **never** — no TUI process, no render |

A single default-exported module provides **`server()` OR `tui()`, never both**
(`shared.ts:293-295`). One package can still ship *both* surfaces by exposing two
**separate exports** (`"."` for server, `"./tui"` for tui) — each is a distinct
module that `readV1Plugin` loads independently with its `kind`.

If your goal is reachable from a server hook (toast, prompt manipulation, status),
stay on the server surface and use `client.tui.*` (`references/ui-feedback.md`).
Reach for a TUI plugin only when you need to **render your own components**.

## What a TUI plugin can build

`api` (`TuiPluginApi`, `tui.ts:581-626`) is the whole surface. Highlights:

| Capability | API | Source |
|---|---|---|
| Inject UI into host regions (sidebar, prompt, footer, …) | `api.slots.register({ order, slots })` | `tui.ts:512-517`, host slot map `tui.ts:455-486` |
| Register a full-screen pane / custom route | `api.route.register([{ name, render }])`, `api.route.navigate(name, params)` | `tui.ts:589-598`, `TuiRouteDefinition` `tui.ts:69-72` |
| Open dialogs (alert/confirm/prompt/select/custom) | `api.ui.DialogAlert` / `DialogConfirm` / `DialogPrompt` / `DialogSelect` / `Dialog`, `api.ui.dialog` stack | `tui.ts:599-609`, dialog props `tui.ts:122-181` |
| Fire a toast | `api.ui.toast({ variant, title, message, duration })` | `tui.ts:607`, `TuiToast` `tui.ts:226-231` |
| Register keybinds / commands | `api.keymap.registerLayer({ commands, bindings })` (`api.command` is the deprecated v1 shim) | `tui.ts:591`, deprecated `TuiCommand` `tui.ts:91-120` |
| Read live session/config/provider state | `api.state` (`session.messages/todo/diff/status`, `config`, `provider`, `vcs`, `lsp`, `mcp`) | `TuiState` `tui.ts:375-399` |
| Read/write theme | `api.theme.current` (RGBA palette), `api.theme.set(name)`, `api.theme.install(path)` | `tui.ts:359-367` |
| Subscribe to events | `api.event.on(type, handler)` (typed against the v2 `Event` union) | `tui.ts:519-521` |
| Persist small state | `api.kv.get/set` | `tui.ts:369-373` |
| Desktop notify + sound | `api.attention.notify(...)`, `api.attention.soundboard` | `tui.ts:298-301` |
| Call the server | `api.client` (**v2** `OpencodeClient`) | `tui.ts:614` |
| Manage other plugins | `api.plugins.list/activate/deactivate/add/install` | `tui.ts:618-624` |
| Cleanup | `api.lifecycle.onDispose(fn)`, `api.lifecycle.signal` (AbortSignal) | `TuiLifecycle` `tui.ts:525-528` |

Most registration calls return a disposer; the runtime **auto-tracks** anything
registered through the scoped `api` and tears it down when the plugin
deactivates (`runtime.ts:611-621`, `createScopedKeymap`/`slots.register`). You do
not normally call the disposer yourself — register and forget.

## The v2 SDK client (NOT the v1 client)

`api.client` is the **v2** client, imported `from "@opencode-ai/sdk/v2"`
(`tui.ts:1-18` imports `OpencodeClient` and all the v2 model/event types). This is
the *same generation* the `auth`/`provider` server hooks use, and a **different
generation** from the server plugin's `PluginInput.client` (v1). The `event` hook
on a server plugin gets the v1 `Event` union; `api.event.on` here is typed against
the **v2** `Event` union (`tui.ts:519-521`). Importing a v1 `Model`/`Event` type
into TUI code (or the reverse) is a real type mismatch — keep your imports `/v2`.

## Rendering model: Solid-JSX over opentui

Renders are **Solid components returning `@opentui/solid` JSX** — not React, not
HTML. Slot/route renderers return `JSX.Element` (`tui.ts:71`, `tui.ts:500`). Use
opentui intrinsics (`<box>`, `<text>`) and Solid primitives (`createSignal`,
`createMemo`, `For`, `Show`) from `solid-js`. State is read reactively off `api`
(e.g. `api.state.session.todo(id)`, `api.theme.current`).

For the rendering deep-dive — layout/flex traps, `ScrollBox` + scroll-follow
patterns, and the `.tsx`-only rule (a `.ts` importing `solid-js`/`@opentui` spins a
second runtime instance and crashes with `Orphan text`) — see
`references/tui-rendering.md`.

Canonical shape (the internal sidebar-todo plugin, verbatim structure):

```tsx
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createMemo, For, Show } from "solid-js"

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.session.todo(props.session_id))
  return (
    <Show when={list().length > 0}>
      <box>
        <text fg={theme().text}><b>Todo</b></text>
        <For each={list()}>{(item) => <text fg={theme().textMuted}>{item.content}</text>}</For>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 400,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

export default { id: "my-org:my-pane", tui }
```

`TuiPlugin` is `(api, options?, meta) => Promise<void>` (`tui.ts:628`). The factory
**registers** slots/routes/keybinds and returns; it does not return a hooks object.
Pass per-plugin `options` via the same `opencode.json` tuple form server plugins
use; `meta` carries load metadata (`first`/`updated`/`same`, version, fingerprint).

## opentui peer deps (optional)

`@opencode-ai/plugin` declares `@opentui/core`, `@opentui/keymap`, `@opentui/solid`
(`>=0.3.2`) as **optional** peer dependencies (`packages/plugin/package.json:24-39`,
each `optional: true` in `peerDependenciesMeta`). Server-only plugins never install
them. A TUI plugin must provide them — they supply the runtime values
(`@opentui/solid`'s `createComponent`/render core), key/RGBA types, and the
`SolidPlugin` slot core that `tui.ts` re-exports. Install them in your plugin
package when you ship a `./tui` entrypoint.

**They do NOT supply a JSX runtime.** `@opentui/solid`'s `./jsx-runtime` and
`./jsx-dev-runtime` exports both point at a **type-only `.d.ts` stub**
(`@opentui/solid/package.json:41-42`), so the JSX must be compiled away by the
Solid transform — which the host applies to `.tsx`/`.jsx` at load but a bundler
does not inherit, the crash that shipped as `opencode-drawer-workflows@1.0.0`. The
full mechanism and the build fix live in `references/tui-rendering.md` (rendering
mechanics) and `references/publishing.md` (wiring the transform into your build).

## Registration and loading

A TUI plugin reaches the runtime three ways:

1. **Package `"./tui"` export** — `"exports": { "./tui": "./dist/tui.js" }`, mirroring
   `@opencode-ai/plugin`'s own (`package.json:11-15`). The installer detects the
   export and records a `kind: "tui"` target (`install.ts:156-165`, `exportTarget`).
2. **`tui.json` origin** — the TUI config collects `plugin_origins`
   (`cli/cmd/tui/config/tui.ts:35,185-189`); each becomes an external TUI plugin.
3. **`opencode plugin install <spec>`** — patches config and adds the target;
   `installPluginBySpec` returns `{ ok, tui: boolean }` (`runtime.ts:921-1012`).

Load path at runtime (`runtime.ts:1074-1129`):
- Internal TUI plugins load first (`internalTuiPlugins(flags)`, the sidebars / footer /
  notifications / plugin-manager), then externals in config order.
- `Flag.OPENCODE_PURE` skips all external TUI plugins (`runtime.ts:1095-1098`).
- Each external module is read through `readV1Plugin(mod, spec, "tui")`
  (`runtime.ts:699`), which **requires** a `tui()` and rejects a `server()`-only module.
- Activation runs `await plugin.plugin(api, options, meta)` inside a disposable scope
  (`runtime.ts:534-568`); plugins run **sequentially** for deterministic
  keybind/route ordering (`runtime.ts:1118-1125`).

`readV1Plugin` (`shared.ts:272-304`) is the export detector both runtimes share. It
reads `mod.default`, pulls `value.server` (`shared.ts:285`) and `value.tui`
(`shared.ts:286`), type-checks each is a function (`shared.ts:287-292`), forbids
declaring both (`shared.ts:293-295`), and for `kind === "tui"` demands `tui` be
present (`shared.ts:299-301`). The id comes from the module's `id` field or the
package name (`resolvePluginId`, `shared.ts:306-323`); a **file** (path) TUI plugin
**must** export `id` explicitly (`shared.ts:313-315`).

## Type-lag gotcha (verify before trusting the published type)

The **published** `@opencode-ai/plugin` `PluginModule` type pins TUI to `never`:

```typescript
// packages/plugin/src/index.ts:76-80
export type PluginModule = {
  id?: string
  server: Plugin
  tui?: never        // ← line 79: declares TUI is NOT a PluginModule field
}
```

But the runtime **does** load `tui()` from the default export. `readV1Plugin`
explicitly inspects and accepts `value.tui` (`shared.ts:286,290-292,299-301`), and
the TUI runtime reads `entry.module.tui` to get the plugin function
(`runtime.ts:830`, `plugin: entry.module.tui`). **The type lags the runtime.** The
real TUI module shape is the separately-exported `TuiPluginModule`
(`tui.ts:630-634`: `{ id?; tui: TuiPlugin; server?: never }`) from the `./tui`
entrypoint — the inverse of `index.ts`'s `PluginModule`. Author TUI plugins against
`@opencode-ai/plugin/tui` types, not the `"."`-export `PluginModule`; do not let
`tui?: never` convince you TUI plugins are impossible.

Exact cites for the type-lag claim:
- Type says `never`: `packages/plugin/src/index.ts:79` (block `:76-80`).
- Runtime loads `tui()`: `packages/opencode/src/plugin/shared.ts:286` (reads `value.tui`),
  `:290-292` (type-checks it), `:299-301` (requires it for `kind: "tui"`); and
  `packages/opencode/src/cli/cmd/tui/plugin/runtime.ts:830` (`plugin: entry.module.tui`).
- Correct TUI module type: `packages/plugin/src/tui.ts:630-634` (`TuiPluginModule`).
