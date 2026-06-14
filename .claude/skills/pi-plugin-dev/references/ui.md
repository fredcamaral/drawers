# pi extension UI

> `ctx.ui` (an `ExtensionUIContext`, `types.ts:124-275`) is the whole user-interaction
> surface — dialogs, notifications, status/widgets/footer/header, fully custom
> components and overlays, a custom editor, and theming. Components come from
> `@earendil-works/pi-tui`. Upstream component doc: `packages/coding-agent/docs/tui.md`.

**Always guard:** `ctx.ui.custom()` / terminal input only work when `ctx.mode === "tui"`;
dialogs need `ctx.hasUI`; in `print`/`json` everything is a no-op. See `gotchas.md` §8.

## Dialogs (await a result)

```typescript
const choice = await ctx.ui.select("Pick one:", ["A", "B", "C"])   // string | undefined
const ok     = await ctx.ui.confirm("Delete?", "Cannot be undone")  // boolean
const name   = await ctx.ui.input("Name:", "placeholder")           // string | undefined
const body   = await ctx.ui.editor("Edit:", "prefill")              // string | undefined (multi-line)
ctx.ui.notify("Done!", "info")                                      // "info" | "warning" | "error" (non-blocking)
```

**Timeout / cancel:** dialogs accept `{ timeout, signal }`. On timeout `select`/`input`
return `undefined`, `confirm` returns `false`. Use an `AbortController` to tell "timed
out" from "user cancelled" (check `signal.aborted`).

## Status, widgets, footer, header

```typescript
ctx.ui.setStatus("my-ext", "Processing…")          // footer status; undefined clears
ctx.ui.setWidget("my-ext", ["Line 1", "Line 2"])   // above editor; { placement: "belowEditor" } | undefined clears
ctx.ui.setWidget("my-ext", (tui, theme) => new Text(theme.fg("accent", "Custom"), 0, 0))
ctx.ui.setFooter((tui, theme, footerData) => ({ render: (w) => [theme.fg("dim", "footer")], invalidate() {} }))  // undefined restores
ctx.ui.setHeader((tui, theme) => /* Component */)  // undefined restores
ctx.ui.setTitle("pi — my-project")                 // terminal title
ctx.ui.setEditorText("prefill") ; ctx.ui.getEditorText() ; ctx.ui.pasteToEditor("…")

// streaming "working" row:
ctx.ui.setWorkingMessage("Thinking deeply…")        // undefined restores default
ctx.ui.setWorkingVisible(false)                     // hide the row entirely
ctx.ui.setWorkingIndicator({ frames: [theme.fg("accent", "●")], intervalMs: 120 })  // undefined restores spinner

// tool output expansion:
const was = ctx.ui.getToolsExpanded(); ctx.ui.setToolsExpanded(true)
```

Indicator frames are rendered verbatim — colorize them yourself with `ctx.ui.theme.fg(...)`.

## Custom components — `ctx.ui.custom()`

Temporarily replaces the editor with your component until `done(value)` is called;
the promise resolves to that value (TUI mode only — returns `undefined` elsewhere).

```typescript
import { Text } from "@earendil-works/pi-tui"

const result = await ctx.ui.custom<boolean>((tui, theme, keybindings, done) => {
  const t = new Text("Enter = ok, Esc = cancel", 1, 1)
  t.onKey = (key) => { if (key === "return") done(true); if (key === "escape") done(false); return true }
  return t
})
```

Callback args: `tui` (dimensions/focus), `theme`, `keybindings` (use the injected
manager — don't call `getKeybindings()`), `done(value)`.

### Overlays (floating modal, screen kept)

```typescript
const r = await ctx.ui.custom<string | null>(
  (tui, theme, kb, done) => new MyOverlay({ onClose: done }),
  { overlay: true, overlayOptions: { anchor: "top-right", width: "50%", margin: 2 },
    onHandle: (h) => { h.focus() /* h.unfocus({target}) ; h.setHidden(b) ; h.hide() */ } },
)
```

`OverlayOptions`: `anchor` (`center`/`top-left`/`top-right`/…), `width`/`row`/`col`
(absolute or `"%"`), `offsetX`/`offsetY`, `margin`, `visible(termW, termH)`. A focused
visible overlay intercepts input; `handle.unfocus({ target })` yields it back.

## Custom editor

Extend `CustomEditor` (not the base `Editor` — `CustomEditor` keeps app keybindings:
escape-to-abort, model switch, etc.). Call `super.handleInput(data)` for keys you don't
handle.

```typescript
import { CustomEditor } from "@earendil-works/pi-coding-agent"
import { matchesKey } from "@earendil-works/pi-tui"

class VimEditor extends CustomEditor {
  private mode: "normal" | "insert" = "insert"
  handleInput(data: string) {
    if (matchesKey(data, "escape") && this.mode === "insert") { this.mode = "normal"; return }
    if (this.mode === "normal" && data === "i") { this.mode = "insert"; return }
    super.handleInput(data)
  }
}
pi.on("session_start", (_e, ctx) =>
  ctx.ui.setEditorComponent((_tui, theme, keybindings) => new VimEditor(theme, keybindings)))
```

To compose with another extension's editor, capture `ctx.ui.getEditorComponent()`
first and wrap it. `setEditorComponent(undefined)` restores the default.

## Autocomplete providers

`ctx.ui.addAutocompleteProvider(factory)` stacks on top of the built-in slash/path
provider. Set `triggerCharacters` for custom triggers (`#`, `$`); inspect text before
the cursor, return your suggestions when your syntax matches, else delegate to
`current.getSuggestions(...)` / `current.applyCompletion(...)`.

## Message rendering

```typescript
pi.registerMessageRenderer("my-ext", (message, options, theme) => {
  let text = theme.fg("accent", `[${message.customType}] `) + message.content
  if (options.expanded && message.details) text += "\n" + theme.fg("dim", JSON.stringify(message.details, null, 2))
  return new Text(text, 0, 0)
})
// messages with that customType come from pi.sendMessage({ customType: "my-ext", content, display: true, details })
```

## Tool rendering (`renderCall` / `renderResult`)

Return a `Component`. Defaults: `renderCall` → tool name, `renderResult` → raw `content`.
Use `Text(content, 0, 0)` (the default `Box` handles padding); `\n` for multi-line;
handle `options.isPartial` for streaming and `options.expanded` for detail-on-demand.
The `context` arg carries `args`, `state` (shared across call+result slots),
`lastComponent` (reuse to mutate in place), `invalidate()`, `toolCallId`, `cwd`,
`isError`, etc. Set `renderShell: "self"` to own framing/background instead of the
default `Box`.

```typescript
import { Text } from "@earendil-works/pi-tui"
import { keyHint, highlightCode, getLanguageFromPath } from "@earendil-works/pi-coding-agent"

renderResult(result, { expanded }, theme, ctx) {
  if (result.details?.error) return new Text(theme.fg("error", `Error: ${result.details.error}`), 0, 0)
  let text = theme.fg("success", "✓ Done")
  if (!expanded) text += ` (${keyHint("app.tools.expand", "to expand")})`   // respects keybinding config
  return new Text(text, 0, 0)
}
```

Keybinding helpers: `keyHint(id, desc)`, `keyText(id)`, `rawKeyHint(key, desc)` — use
namespaced ids (`app.*` for coding-agent, `tui.*` for shared TUI; full list in pi's
`docs/keybindings.md`). Syntax highlight tool output with `highlightCode(code, lang,
theme)` + `getLanguageFromPath(path)`.

## Theme

```typescript
theme.fg("accent" | "success" | "error" | "warning" | "muted" | "dim" | "toolTitle" | …, text)
theme.bold(text) ; theme.italic(text) ; theme.strikethrough(text)
ctx.ui.theme            // current theme
ctx.ui.getAllThemes() ; ctx.ui.getTheme("light") ; ctx.ui.setTheme("light" | themeObject)  // { success, error? }
```

## Built-in pi-tui components

`Text`, `Box`, `Container`, `Spacer`, `Markdown`, `Image`, `SelectList`,
`SettingsList`, `Input`, `Editor`, `DynamicBorder`. A `Component` is
`{ render(width): string[]; invalidate(): void; handleInput?(data): void }`. Keyboard:
`matchesKey(data, Key.up)` / `Key.ctrl("c")`. For IME, emit the cursor marker and
propagate `focused` to embedded `Input`/`Editor` children (see `docs/tui.md`).
