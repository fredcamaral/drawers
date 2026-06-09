# Testing Plugins Locally

> Iterate on a plugin from source — no npm publish, no reinstall between edits.

The mechanism: opencode loads a plugin from a local path the moment you point its
config at it. A `file://` entry in `opencode.json` runs your TypeScript/JavaScript
directly, so the edit-run loop is just save-and-rerun.

## 1. Point a config at your plugin source

Create (or reuse) a folder with an `opencode.json` whose `plugin` array contains a
`file://` URL to your entry file. Absolute path required.

```jsonc
// <test-folder>/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///Users/you/my-plugin/src/index.ts"]
}
```

`file://` tells opencode to load straight from source — no build step, no
`@opencode-ai/plugin` published version required. You can also test by dropping
the file into an auto-load directory instead of listing it. The scan glob is
`{plugin,plugins}/*.{ts,js}` (`config/plugin.ts:21`) — **both singular and plural
load**, one level deep, `.ts`/`.js` only:

- Project: `.opencode/plugins/` or `.opencode/plugin/`
- Global: `~/.config/opencode/plugins/` or `~/.config/opencode/plugin/`

The `file://` config entry is preferable while iterating because the plugin path
is explicit and you can keep the source anywhere.

## 2. Smoke test: confirm it loads

Run a throwaway prompt from the test folder. This boots opencode, loads every
plugin including yours, runs the prompt, and exits:

```bash
opencode run hi
```

Watch the output for:
- plugin initialization errors,
- missing dependency resolution (deps install at startup via arborist — see
  `gotchas.md` §12),
- TypeScript compile errors.

A plugin that returns `{}` on bad config (the fail-soft pattern) will load
cleanly here even when effectively disabled — check your logs to confirm it
actually wired the hooks you expect.

## 3. Interactive testing

```bash
opencode
```

Drive each hook by triggering its condition:

| Hook                   | How to exercise it                                          |
| ---------------------- | ----------------------------------------------------------- |
| `event`                | Perform actions that emit events; inspect your log output   |
| `tool`                 | Ask the model to call your custom tool                      |
| `tool.execute.before`  | Run the intercepted tool; verify it's blocked or rewritten  |
| `tool.execute.after`   | Run a tool; verify your output mutation lands               |
| `event` (`permission.asked`) | Trigger a prompt; verify you answer it via `client.postSessionIdPermissionsPermissionId` — the `permission.ask` hook never fires (`gotchas.md` §9) |
| `chat.message`         | Send a first message; verify injected context               |
| `chat.params`          | Observe behavior change (e.g. temperature)                  |
| `config`               | Verify config mutations take effect at startup              |
| `auth`                 | Run the auth flow for your provider                         |

If the plugin shows toasts, trigger them and confirm variant, message, and
duration — and that the plugin survives a no-TUI context without crashing
(`gotchas.md` §13).

## 4. The fast loop

Because `file://` loads from source, iterating is: edit file → rerun
`opencode run ...` (or restart the interactive session). No `npm publish`, no
reinstall, no version bump. Plugin init runs once per process, so a restart is
how you pick up code changes.

Mind load order if more than one plugin is active: later plugins can override
earlier ones (a custom `tool` named like a built-in overrides the built-in).
Isolate by testing with a config that loads *only* your plugin, or use the env
flags for a clean bed:

- `OPENCODE_PURE=1` — skips ALL external plugins (`index.ts:176`). Internal
  built-ins (the auth plugins) still load. (Flag resolved in
  `packages/core/src/flag/flag.ts:65-67`; the Effect layer also reads it at
  `opencode/src/effect/runtime-flags.ts:18`.)
- `OPENCODE_DISABLE_DEFAULT_PLUGINS=1` (CLI `-n`) — skips the built-in auth plugins
  (`index.ts:165`). External plugins still load. (Resolved in the Effect layer
  `opencode/src/effect/runtime-flags.ts:19`, NOT in `flag.ts`.)

```bash
OPENCODE_PURE=1 opencode run hi   # only your file:// / config-listed plugin runs
```

## 5. Validate the BUILT bundle, not just source (TUI plugins)

Everything above iterates from **source** (`file://`). For a server plugin that is
the whole story — the host loads your `.ts` directly. For a **TUI** plugin it is a
trap: `file://` dev can pass while the published npm bundle crashes on load.

The reason is a transform asymmetry. opencode's host loader compiles `.tsx`/`.jsx`
at load time with `@opentui/solid`'s Solid transform — the `onLoad` filter is
`/\.(js|ts)x$/` (`@opentui/solid/scripts/solid-plugin.ts:100`). So when you point a
config at `src/index.tsx`, the host **re-compiles the JSX itself** and it works.
A published `.js` dist is *not* re-transformed (the filter is `.tsx`/`.jsx` only),
so whatever your bundler emitted is what runs. If your `Bun.build` did not inherit
the Solid transform, it emits generic `jsxDEV()` calls against a runtime with no
implementation, and `dist/tui.js` crashes on the first JSX call
(`scripts/build.ts:22-30`). That is exactly what shipped as
`opencode-drawer-workflows@1.0.0` — source-tested green, bundle dead on load. A
package shipping both surfaces (`"exports": { ".": "./dist/index.js", "./tui":
"./dist/tui.js" }`, `packages/workflows/package.json:19-23`) loads them by
independent runtimes; this gap is the **TUI dist's** alone. See
`references/tui.md` §loading for the dual-surface mechanics and
`references/tui-rendering.md` for the build-transform fix in `scripts/build.ts`.

> Smoke-testing source proves nothing about the dist. **Smoke-test the artifact.**

This repo does **not** yet ship this guard — `test-harness/run-smoke.ts` drives
`opencode run` against the *server* source (`src/plugin/index.ts` via `file://`)
and never touches `dist/tui.js`. The closest existing protection is
`src/tui/paths.test.ts:69-92`, a *source*-level static check that no `.ts` under
`src/tui` imports `solid-js`/`@opentui` (the dual-instance guard). Neither covers
the src-vs-dist gap. Add the two checks below.

**Grep the built bundle.** A correctly transformed TUI bundle has the Solid
universal-runtime calls and none of the generic JSX-runtime calls:

```bash
test "$(grep -c jsxDEV packages/workflows/dist/tui.js)" -eq 0    # generic runtime → MUST be 0
test "$(grep -c 'createComponent' packages/workflows/dist/tui.js)" -gt 0  # Solid universal → MUST be >0
```

On the current dist this passes: `jsxDEV` → 0, `createComponent` → `>0`
(`packages/workflows/dist/tui.js`; don't pin the exact count — it moves with the
`.tsx`). A nonzero `jsxDEV` means the transform did not run on that entry — the 1.0.0
failure mode.

**Import-smoke the bundle in Bun.** Grep proves the call shape; evaluating the
module proves it actually loads against the externalized host instance without
throwing:

```bash
bun -e 'await import("./packages/workflows/dist/tui.js"); console.log("tui bundle loaded")'
```

Run both after every build, before publish. Source iteration (§1–§4) and these two
checks together cover load-time correctness for a dual-surface package.

## 6. Render behaviors are NOT unit-testable — do a manual TUI pass

Load-time checks (above) and the unit tests (below) cover wiring and pure logic.
They say nothing about how the TUI actually draws. Scroll-follow, viewport
culling, and flex layout under resize have no headless assertion — opentui renders
to a real terminal. Budget a manual validation pass and eyeball:

- **Scroll-follow** — drive the active row off-screen (down past the fold, then
  back up); the view should track it, not freeze top-pinned. See
  `references/tui-rendering.md` for the real-geometry follow pattern.
- **Culling / black rows** — scroll a list with many rows; rows must not drop to
  background as they cross the viewport edge (the `viewportCulling` trap —
  `references/tui-rendering.md`).
- **Layout under resize** — shrink and grow the terminal width; flex panes must
  re-split cleanly and the scrollbar gutter must stay flush, not drift.
- **Truncation** — at narrow widths each row stays one line (no wrap-induced
  geometry drift that breaks scroll math).

## 7. Unit testing (optional, for complex plugins)

The plugin function is a plain async function — call it with a mocked context and
invoke hooks directly. No opencode process needed.

```typescript
import { MyPlugin } from "./src/index"

const client = {
  app: { log: async (p: any) => { console.log("log:", p.body) } },
  tui: { showToast: async (p: any) => { console.log("toast:", p.body) } },
  session: { get: async () => ({ model: undefined, agent: undefined }), prompt: async () => {} },
} as any

const ctx = { client, project: {} as any, directory: "/tmp", worktree: "/tmp", $: Bun.$ as any } as any

const hooks = await MyPlugin(ctx)

// drive a hook (current input shapes — see hooks.md)
await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "s1" } } as any })
await hooks["tool.execute.before"]?.(
  { tool: "read", sessionID: "s1", callID: "c1" },
  { args: { filePath: ".env" } },
)
```

```bash
bun run test-plugin.ts
```

Keep mock shapes in sync with `hooks.md` — e.g. `tool.execute.after` input now
carries `args`, and `client.app.log` is body-wrapped.

Note: the trigger `await`s whatever a hook returns, so a **synchronous** hook
(no `async`, mutates `output` and returns) works too — proven by
`test/plugin/trigger.test.ts` ("runs synchronous hooks without crashing"). Keep
writing hooks `async` (the right default — see `gotchas.md` §10), but a sync hook
in a test won't break anything.
