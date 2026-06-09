# Rendering a TUI Plugin Well

> How to actually render an opentui panel — the JSX-compile trap, the `.tsx`-only
> discipline, flexbox/Yoga layout, ScrollBox, and a UX checklist. Companion to
> `references/tui.md` (which owns the API/loading surface). Verified against
> `@opentui/core@0.3.2` / `@opentui/solid@0.3.2`, this repo's
> `packages/workflows/src/tui/` (route.tsx, index.tsx, format.ts), `scripts/build.ts`,
> and a local `sst/opencode@dev` clone (`routes/session/{index,sidebar,footer}.tsx`),
> 2026-06-08. Trust this file over training memory — opentui is new and undocumented.
> The `file:line` cites (especially into the opencode clone) are **anchors pinned to
> those versions and drift across releases** — match on the symbol/surrounding code,
> not the literal line, and verify against your installed version.

## How the JSX actually compiles

The single most expensive thing to misunderstand about opentui TUI plugins: **there
is no runtime JSX factory in `@opentui/solid`.** The JSX gets compiled by a Solid
babel transform at load time, and if your bundler doesn't reproduce that transform,
the published bundle crashes on the first JSX call.

1. **`@opentui/solid`'s `jsx-runtime` is type-only.** Both `"./jsx-runtime"` and
   `"./jsx-dev-runtime"` map to the same `.d.ts` — a `declare namespace JSX` stub
   with no `jsx-runtime.js` anywhere in the package
   (`@opentui/solid@0.3.2/package.json:41-42`). There is nothing to call at runtime.
2. **The host transforms `.tsx`/`.jsx` at load; an independent bundler does not.**
   opencode's host registers a Bun runtime `onLoad` hook filtered on
   `/\.(js|ts)x$/` that runs babel `transformAsync` with
   `[solid, { moduleName, generate: "universal" }]`
   (`@opentui/solid@0.3.2/scripts/solid-plugin.ts:100-135`, invoked via
   `ensureRuntimePluginSupport` at
   `opencode/.../tui/plugin/runtime.ts:47`). Because it is a **host-process Bun
   runtime hook**, a separate `Bun.build`/`tsc` never inherits it.
3. **No transform → `jsxDEV()` against a runtime that doesn't exist → crash.** Without
   the Solid transform, `Bun.build` emits generic `jsxDEV()`/`jsx()` calls bound to
   the type-only runtime, and the loaded `dist/tui.js` crashes on the first JSX call
   (`scripts/build.ts:22-30`). This is not hypothetical: it shipped as
   `opencode-drawer-workflows@1.0.0` and crashed the viewer (commit `4a97b59`).

★ Why dev hides this: opencode loads source `.tsx` *with* its own transform, so a
`file://`-against-`src` plugin works in dev even when the build is misconfigured. A
published `.js` dist is **not** re-transformed (the filter is `.tsx`/`.jsx` only), so
source can pass while the npm bundle crashes on load. Test the **built bundle**, not
just the source — see `references/testing.md`.

The fix (build-script recipe in `references/publishing.md`): import
`createSolidTransformPlugin` from `@opentui/solid/bun-plugin`, attach it as a plugin
**only on the `.tsx` TUI entry**, and externalize `@opentui/*` + `solid-js` so the
bundle binds to the host's single instance (`scripts/build.ts:16-17,31,36-41,80-85`).
`createSolidTransformPlugin()` takes no args here; `generate:"universal"` and
`moduleName:"@opentui/solid"` are the plugin's internal defaults, not call-site
options (`solid-plugin.ts:105,129`). A correctly built bundle has **0 `jsxDEV`** and
**`>0` `createComponent`** — grep the built `packages/workflows/dist/tui.js` to verify
(don't pin the exact count; it shifts with every `.tsx` edit).

## Keep solid/opentui imports in `.tsx` only

The corollary discipline, and a second way to crash: **any `.ts` file under your TUI
source that value-imports `solid-js` or `@opentui/*` spins up a SECOND nested Solid
runtime** — a different instance from the host's — and you get
`Orphan text error: "" must have a <text> as a parent` at navigate time
(`packages/workflows/src/tui/index.tsx:12-26`). A `.ts` entry isn't transformed, so
its `solid-js`/`@opentui` imports resolve to *this* package's nested copy rather than
the host's.

The rule, stated once:

| File kind | Allowed to import | Job |
|---|---|---|
| `.tsx` | `solid-js`, `@opentui/*`, JSX | render |
| `.ts`  | **zero** solid/opentui value imports (types-only is fine) | pure logic |

This repo keeps `paths.ts` (path consts + cancel-sentinel writer) as the JSX-free
helper module the `index.tsx` header cites, with `format.ts`/`reducer.ts`/`runs.ts`
likewise solid-free. The discipline is **enforced by a test**, not just a comment:
`paths.test.ts:77-84` asserts every non-`.tsx` file under `src/tui` imports no
`solid-js`/`@opentui`. opencode's own `cwd-status.tsx` is the canonical
external-plugin shape. (See `references/gotchas.md` for the broader dual-instance
discussion.)

## Layout with opentui (flexbox/Yoga)

opentui lays out with Yoga (flexbox). Every renderable accepts Yoga `LayoutOptions`:
`flexGrow`, `flexShrink`, `flexBasis`, `minWidth`, `minHeight`
(`@opentui/core@0.3.2/Renderable.d.ts:31-49`, applied via `RenderableOptions extends
Partial<LayoutOptions>` at `:66`). These props are valid on **`<text>`** too in this JSX layer
— `<text flexShrink={0} …>` typechecks (`route.tsx:469,475`; full `tsc --noEmit`
passes).

- **`minWidth={0}` on flex panes that share a row.** A child's min-content width
  otherwise prevents the pane from shrinking, so a `flexGrow` split drifts and the
  scrollbar gutter walks to the screen edge. Both panes set `minWidth={0}`
  (`route.tsx:446-456` scrollbox `flexGrow={3} minWidth={0}`; `route.tsx:494-496`
  Detail pane `flexGrow={2} minWidth={0}`). This is the most common layout bug in a
  two-pane TUI.
- **`<text>` defaults to `wrapMode: "word"`**
  (`@opentui/core@0.3.2`, `TextBufferRenderable._defaultOptions`, `truncate: false`).
  Word-wrap is fine for prose, but it makes row geometry variable-height, which
  fights scroll-follow math.
- **Truncate for stable geometry.** When you need one line per row (so row index maps
  to scroll line), truncate to a width budget instead of wrapping: `truncateLine`
  (`format.ts:96`) applied inside each `<text>` row against the pane width
  (`route.tsx:470,482`, comment at `439-441`: "Each row is ONE truncated line, so the
  row index equals its scroll line").

## ScrollBox: the API and the traps

`ScrollBoxRenderable` is the scroll primitive
(`@opentui/core@0.3.2/renderables/ScrollBox.d.ts:18-126`).

| Member | Kind | Notes |
|---|---|---|
| `scrollTop` / `scrollLeft` | get + **set** | assignable; set `scrollTop` to drive follow by hand |
| `scrollWidth` / `scrollHeight` | get only | total content extent |
| `scrollBy(delta, unit?)` | method | `delta: number \| {x,y}` |
| `scrollTo(position)` | method | `position: number \| {x,y}` |
| `scrollChildIntoView(childId)` | method | the built-in scroll-follow |
| `viewport` | readonly `BoxRenderable` | `.height` = **visible row count** (box minus scrollbar gutter) |
| `content` | readonly `ContentRenderable` | host for scrollable children |
| `wrapper` / `verticalScrollBar` | readonly | inner boxes |

`ScrollBoxOptions`: `viewportCulling`, `stickyScroll`, `stickyStart`, `scrollX`,
`scrollY`, `viewportOptions`, `verticalScrollbarOptions`.

**Trap: `viewportCulling` defaults to `true` and can drop rows to background.**
`ContentRenderable._getVisibleChildren()` calls `getObjectsInViewport()` when culling
is on; off-fold or mis-measured in-box rows get dropped — observed live as rows
rendering **black** (`route.tsx:452-453` comment "culling was dropping in-box rows to
black"). The opentui source confirms the mechanism (constructor `viewportCulling =
true`; content box created `flexShrink: 0`) but not the "black" artifact itself. Two
fixes, both used here:

- `flexShrink={0}` on every scrollable row so each takes its natural height and isn't
  mis-measured (`route.tsx:469,475`).
- `viewportCulling={false}` for small lists where culling buys nothing
  (`route.tsx:454`).

**Robust scroll-follow: drive it from real child geometry, never index == line.**
Give each row a stable `id` and let the scrollbox find it — do not assume row N lives
on line N (a spacer or a wrapped row breaks that mapping). **Prefer the built-in:**

```ts
sb.scrollChildIntoView(rowId(idx))   // ScrollBox.d.ts:84 — does the geometry for you
```

It resolves the child via `content.findDescendantById` and scrolls by the delta in the
correct coordinate space. This repo uses exactly this (`route.tsx:386-389`).

⚠️ **`child.y` is SCREEN-absolute, not content-relative.** `Renderable.get y()`
returns `this.parent.y + this._y + this._translateY` recursively
(`@opentui/core@0.3.2`, compiled `get y()`), so a hand-rolled follow that compares
`child.y` *directly* against `sb.scrollTop` (a content-space offset) over-scrolls by
the scrollbox's own screen offset — the header/box top. If you hand-roll, you **must**
subtract the scroll origin, which is exactly what opencode's idiom does with the
`- scroll.y` term:

```ts
const child = scroll.getChildren().find((c) => c.id === targetID)
if (child) scroll.scrollBy(child.y - scroll.y - 1)   // - scroll.y is mandatory, not cosmetic
```

(`opencode/.../routes/session/index.tsx:427-428`, also `538-539,561-562,862-865`.)
This is a real trap: an earlier version of this repo's viewer compared `child.y` to
`scrollTop` without the origin term and over-scrolled past the followed row. When in
doubt, use `scrollChildIntoView` and skip the coordinate question entirely.

## TUI UX checklist

The opencode idioms, as an opinionated checklist. Each line is how the reference
actually does it.

- [ ] **Confirm destructive actions; never bind them to a bare muscle-memory letter.**
  Guard with EITHER a two-step "press again to confirm" (delete armed on first press,
  executed on second, bound to `ctrl+d` —
  `opencode/.../component/dialog-session-list.tsx:202,257-298`;
  `config/keybind.ts:93`) OR a `DialogConfirm.show` modal that resolves a boolean
  (`ui/dialog-confirm.tsx:93-108`, used for the self-update prompt at
  `app.tsx:1023-1035`). `s` is bound only to a non-destructive toggle
  (`keybind.ts:73`). See also `references/ui-feedback.md`.
- [ ] **Sticky-bottom for live content.** `stickyScroll={true} stickyStart="bottom"`
  keeps the active row visible instead of a frozen top-pinned list
  (`opencode/.../routes/session/index.tsx:1196-1197`).
- [ ] **Dual-code status: glyph + color, never color alone.** Themes and terminals
  vary, so carry a non-color marker glyph. `footer.tsx:64-83` uses `△`/`•`/`⊙`
  alongside `theme.warning`/`success`/`error`; `WorkspaceLabel`
  (`component/workspace-label.tsx:7-18`) prefixes `●` with a status-driven color.
- [ ] **Distinct empty / loading / error states — not one generic "waiting…".** Empty:
  `DialogSelect` renders an explicit "No results found"
  (`ui/dialog-select.tsx:522-528`). Loading: phased
  ("Loading plugins…" vs "Finishing startup…",
  `component/startup-loading.tsx:8`). Error: a dedicated component with stack copy and
  an issue-report URL (`component/error-component.tsx:8-13`).
- [ ] **Label detail fields; identify by name, not id.** Show a human title + an
  absolute time/date label (clock time via `Locale.time`, date grouping like "Today")
  rather than a relative "ago" or a raw id
  (`component/dialog-session-list.tsx:189,202,216-217`; `routes/session/sidebar.tsx:56-61`,
  where the raw session id shows only muted on non-stable channels). Carry the name
  **through** the pipeline: a failed workspace lookup passes the raw `workspaceID` as
  the name with an `error` status rather than dropping it (`sidebar.tsx:62-66`).
- [ ] **Mouse + page/home/end navigation on long lists.** Rows clickable via
  `onMouseDown`/`onMouseUp`, hover via `onMouseMove`/`onMouseOver`, switching input
  mode to mouse (`ui/dialog-select.tsx:564-586`); `page_up`/`page_down`/`home`/`end`
  commands plus center-on-current (`ui/dialog-select.tsx:311-348`), bound to
  `pageup`/`pagedown`/`home`/`end` (`config/keybind.ts:203-206`). Keep keyboard hints
  in a footer row (`ui/dialog-select.tsx:638-647`).
