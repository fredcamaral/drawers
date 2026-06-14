# opencode-drawer-statusline

A compact status line rendered under the OpenCode session prompt. One muted line,
read live from the session state:

```
opencode-drawers | wt feature-x | branch main | status busy | oc 1.16.2
```

Segments collapse when empty — the worktree segment only shows when it differs from
the directory, `branch` only on a repo, `status` only while a session is active.

## Install

Add the plugin to your OpenCode config (`opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-drawer-statusline"]
}
```

To run from a local checkout — for development of the plugin itself — register it by
absolute `file://` path instead. **This form is for development only**; published
installs use the npm form above.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///abs/path/to/packages/statusline/src/index.ts"]
}
```

## How it loads

This drawer is **TUI-only**: all behaviour lives in the `./tui` surface. The package
exposes two exports — `"."` (a no-op server anchor) and `"./tui"` (the status line).
OpenCode discovers a package's `./tui` export only when the package is listed in the
`plugin` array, so the `"."` anchor exists solely to give the array something to point
at; OpenCode then loads the status line in its TUI process automatically. There is no
separate install.

> ⚠️ **The single-instance rule: solid/opentui usage lives ONLY in `.tsx` files.** The
> host rewrites a plugin's `solid-js`/`@opentui/*` imports to its OWN already-loaded
> runtime instance, but its Solid transform only runs on files matching `/\.(js|ts)x$/`.
> A `.ts` file that imports solid/opentui at runtime resolves to this package's *nested*
> copy = a **second** instance, which throws `Orphan text error` at render time. The
> entry is therefore `src/tui/index.tsx` and registers with inline JSX render callbacks
> so the host transform owns component creation.

## Pinned-version note

The `"./tui"` plugin API is newer and less settled than the server plugin API, and its
published types lag the runtime. This surface is built and tested against:

- **OpenCode `1.16.2`** (`@opencode-ai/plugin@1.16.2`, which provides the `/tui` type entry).
- **opentui `0.3.2`** (`@opentui/solid`) — the version OpenCode `1.16.2` bundles.

Treat breakage on an OpenCode/opentui bump as expected maintenance: re-pin `@opentui/solid`
to the new host version and re-run `bun run typecheck` (it includes `tsconfig.tui.json`).
