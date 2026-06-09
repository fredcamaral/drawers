# Publishing Plugins

> Package a plugin for npm and let opencode install it for users automatically.

## Ask before packaging

These are user/product decisions — confirm them before generating a package:

1. **Package name** — unscoped (`opencode-my-plugin`) or scoped
   (`@you/opencode-my-plugin`). Scoped requires a public-access flag (below).
2. **Starting version** — default `0.1.0`.
3. **License** — default MIT.
4. **One-line description.**

Do not guess the name; it's the one thing you can't change cheaply post-publish.

## How opencode installs plugins (no `npm install`)

Users never run `npm install`. They add the package to the `plugin` array in
`opencode.json`, and opencode resolves it at startup:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-my-plugin",        // no version → resolves "latest", updates on launch
    "opencode-my-plugin@1.2.0",  // pinned → cached, will NOT auto-update
    "@you/opencode-my-plugin"    // scoped works the same
  ]
}
```

On launch opencode installs each entry into a per-package cache dir, caches
pinned versions until the config changes, and for unpinned entries resolves and
caches the actual `latest`. **Consequence for your README: do not tell users to
`npm install`** — tell them to add the package to their config.

### Mechanism: `@npmcli/arborist`, not `bun add` (and `ignoreScripts: true`)

The install runs through `@npmcli/arborist`'s `reify()`, not `bun add`
(`packages/core/src/npm.ts:78-135`). One flag is load-bearing for authors:
**`ignoreScripts: true`** (`npm.ts:90`) — your package's npm lifecycle scripts
(`postinstall`, `install`, `prepare`) **will NOT run** when opencode installs the
plugin. If your plugin currently relies on a `postinstall` to fetch a binary,
generate code, or set anything up, that step silently never happens. Do the work
at plugin-init time (in your `Plugin` factory) instead, or ship the artifact
prebuilt in the tarball.

Spec parsing is `npm-package-arg`: bare `foo` → `latest`, `foo@1.2.3` → pinned,
npm-alias forms supported (`shared.ts:22-34`).

### Set `engines.opencode` to avoid silent load-skips

npm plugins are checked against the running opencode version via the package's
`engines.opencode` semver range; an incompatible host **skips the plugin with a
warning** (`shared.ts:194-205`). The gate is bypassed when the host version is
invalid or major 0 (dev builds). File/`file://` plugins skip this gate entirely
(treated as local dev code). If your plugin needs a minimum opencode, declare it
so old hosts fail loudly instead of loading a plugin that then misbehaves:

```jsonc
{ "engines": { "opencode": ">=1.0.0" } }
```

## Package layout

```
my-plugin/
├── src/index.ts          # plugin entry (default export or named Plugin)
├── dist/                 # compiled output (gitignored, published)
├── package.json
├── tsconfig.json
├── README.md
├── LICENSE
├── example-opencode.json # copy-paste config for users
├── .gitignore
└── .npmignore
```

## package.json

```jsonc
{
  "name": "<PACKAGE_NAME>",
  "version": "<VERSION>",
  "description": "<DESCRIPTION>",
  "type": "module",                 // required — opencode loads ESM
  "main": "dist/index.js",          // compiled JS, not the .ts source
  "types": "dist/index.d.ts",
  "files": ["dist", "README.md", "LICENSE"],
  "keywords": ["opencode", "opencode-plugin", "plugin"],
  "license": "<LICENSE>",
  "peerDependencies": {
    "@opencode-ai/plugin": "^1.0.0" // opencode provides this at runtime
  },
  "devDependencies": {
    "@opencode-ai/plugin": "^1.0.0",
    "@types/bun": "^1.2.0",
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0"
  },
  "scripts": {
    "clean": "rm -rf dist",
    "build": "npm run clean && tsc",
    "prepublishOnly": "npm run build"
  },
  "publishConfig": { "access": "public" } // required for scoped packages
}
```

- `@opencode-ai/plugin` belongs in **peerDependencies** — the host supplies it;
  don't bundle a second copy.
- `type: "module"` and a JS `main` are non-negotiable: a missing `type` or a
  `main` pointing at `.ts` is the most common publish failure.
- Scoped packages 404 on install without `publishConfig.access: "public"`.
- **Do NOT copy `@opencode-ai/plugin`'s own package layout.** The upstream
  package ships TS source — its `exports` map points at `./src/*.ts` while
  `files: ["dist"]` (`packages/plugin/package.json:11-19`); those two are
  inconsistent and only work inside the monorepo where consumers compile the TS.
  An external plugin must compile to `dist/` and ship JS (the layout above), or
  it will publish a broken/empty tarball.

## Building a TUI plugin for publish (NOT just tsc)

The `"build": "tsc"` above is correct for a **server** plugin. For a **TUI**
plugin it ships a crashing bundle. opencode's host transforms `.tsx`/`.jsx` at
load with babel-preset-solid (filter `/\.(js|ts)x$/`, `solid-plugin.ts:100`),
but a separate bundler (`tsc`, or a plain `Bun.build`) does **not** inherit that
transform. And there is nothing for the runtime to fall back to:
`@opentui/solid`'s `./jsx-runtime` and `./jsx-dev-runtime` both point at the
same `.d.ts` — a **type-only** stub with no runtime jsx factory
(`@opentui/solid/package.json:41-42`). So an un-transformed `.tsx` entry emits
generic `jsxDEV()`/`jsx()` calls against a runtime that does not exist, and the
bundle crashes on the first JSX call.

**Post-mortem (`opencode-drawer-workflows@1.0.0`):** the published `dist/tui.js`
was built without the Solid transform, emitted `jsxDEV()` against the type-only
runtime, and crashed the viewer on load. The trap is that it *worked in dev* —
opencode re-compiles the `.tsx` from source at load — so the misconfigured
bundler is invisible until you smoke-test the **built** bundle. See
`references/tui.md` for why the runtime is type-only and what the transform
produces.

The fix: bundle the `.tsx` entry with the Solid transform and externalize the
host-provided peers. Worked example from `scripts/build.ts`:

```typescript
// @ts-expect-error — `@opentui/solid/bun-plugin` ships no published types.
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"; // build.ts:16-17

const solidPlugin: BunPlugin = createSolidTransformPlugin();            // build.ts:31

// build.ts:36-41 — host-provided peers; bundling a second copy re-creates
// the dual-instance "Orphan text" crash (see references/tui.md).
const TUI_PEER_EXTERNALS = ["@opentui/core", "@opentui/keymap", "@opentui/solid", "solid-js"];

// build.ts:80-85 — ONLY the .tsx TUI entry carries plugins.
{
  entry: "src/tui/index.tsx",
  outName: "tui.js",
  external: [...SERVER_EXTERNALS, ...TUI_PEER_EXTERNALS],
  plugins: [solidPlugin],
}
```

`createSolidTransformPlugin()` is called with **no arguments**; its defaults are
`moduleName: "@opentui/solid"` and `generate: "universal"`
(`solid-plugin.ts:105,129`) — the same transform the host applies. Externalizing
`@opentui/*` + `solid-js` makes the compiled output reference the **host's**
single instance, so there is no second copy and no dual-instance crash.

**The rule:** the built TUI dist must contain **0** occurrences of `jsxDEV` and
**>0** of `createComponent`. The fixed `dist/tui.js` greps to `0 jsxDEV` /
`22 createComponent`. Grep the bundle as a publish gate — see
`references/testing.md` for the smoke test.

## Export shape: named `Plugin`, or the structured `{ id, server }` module

Two export shapes load (`applyPlugin` → `readV1Plugin` in `shared.ts:272-304`):

1. **Legacy named/default function** — `export const MyPlugin: Plugin = ...` or a
   default-export function. opencode treats every function export as a plugin. No
   `id` needed; npm packages identify by package name.
2. **V1 module object** — a `default` export shaped
   `{ id?: string; server: Plugin; tui?: never }` (`PluginModule`, plugin index
   `index.ts:76-80`). A package exports `server` OR `tui`, never both.

The `id` gotcha: it is required **only** for the V1 module shape loaded from a
**file source** — a `default`-exported object carrying `id`/`server` from a
`file://` plugin must include `id`, or load throws `Path plugin … must export id`
(`shared.ts:313-315`). npm packages fall back to the package name. A file plugin
using the legacy named-export shape needs no `id`. Simplest portable choice for a
published package: the named-export `Plugin` (shown throughout this doc).

## example-opencode.json

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["<PACKAGE_NAME>"]
}
```

## README install section

```markdown
## Installation

Add to your `opencode.json`:

    { "plugin": ["<PACKAGE_NAME>"] }

opencode installs the plugin and its dependencies automatically at startup.
```

## Publish

```bash
npm publish --access public   # scoped, first publish
npm publish                   # unscoped, or subsequent publishes
```

`prepublishOnly` builds first, so `dist/` is fresh in the tarball.

## Version pinning semantics

| Config entry          | Behavior                                                     |
| --------------------- | ----------------------------------------------------------- |
| `plugin@1.2.0`        | Pinned. Cached. No auto-update — stable, but user is stuck. |
| `plugin` (no version) | Tracks `latest`; opencode re-resolves on each launch.       |

Pinning is what makes the update-notification pattern below worth shipping.

## Shipping an update-available toast (for pinned users)

A pinned user never sees new releases. A published plugin can check npm on
startup and surface an info toast suggesting they bump the version in their
config. Make it **non-blocking** (fire-and-forget, never `await`) and
**fail-silent** (network problems must not break the plugin).

```typescript
function isNewer(current: string, latest: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number)
  const [a, b] = [parse(current), parse(latest)]
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0
    if (x < y) return true
    if (x > y) return false
  }
  return false
}

async function fetchLatest(pkg: string): Promise<string | null> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 5000)
    const res = await fetch(`https://registry.npmjs.org/${pkg}`, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    })
    clearTimeout(t)
    if (!res.ok) return null
    return (await res.json())["dist-tags"]?.latest ?? null
  } catch {
    return null
  }
}

// Call during init. DO NOT await — see gotchas.md §10.
function checkForUpdates(opts: {
  packageName: string
  currentVersion: string
  pluginName: string
  client: { tui: { showToast: (p: any) => Promise<unknown> } }
  delay?: number
}): void {
  const { packageName, currentVersion, pluginName, client, delay = 8000 } = opts
  setTimeout(async () => {
    try {
      const latest = await fetchLatest(packageName)
      if (!latest || !isNewer(currentVersion, latest)) return
      await client.tui.showToast({
        body: {
          title: `${pluginName}: update available`,
          message: `v${currentVersion} → v${latest}\nbump @${latest} in opencode.json`,
          variant: "info",
          duration: 10000,
        },
      })
    } catch { /* non-critical */ }
  }, delay)
}
```

Wire it at init, reading the version from your own manifest:

```typescript
import type { Plugin } from "@opencode-ai/plugin"
import pkg from "../package.json" with { type: "json" }

const plugin: Plugin = async ({ client }) => {
  checkForUpdates({
    packageName: pkg.name,
    currentVersion: pkg.version,
    pluginName: "My Plugin",
    client,            // fire-and-forget
  })
  return { /* hooks */ }
}
export default plugin
```

Guidance:
- **Never `await`** the check — it must not block plugin init.
- **8–10 s delay** so the TUI is fully up before the toast.
- **`info` variant** — an update is not urgent.
- Only relevant for **published** plugins where users **pin**. Skip it for
  local/`file://` plugins or anyone on unpinned `latest`.
- Optionally gate behind a config flag (`checkForUpdates !== false`) to respect
  users who don't want the nudge.

## Common mistakes

| Mistake                              | Fix                                       |
| ------------------------------------ | ----------------------------------------- |
| Missing `type: "module"`             | Add it — opencode loads ESM               |
| `main` points at `.ts`               | Point at compiled `dist/index.js`         |
| Forgot to build before publish       | `prepublishOnly: "npm run build"`         |
| `@opencode-ai/plugin` as a hard dep  | Move to `peerDependencies`                |
| Scoped package 404 on install        | `publishConfig.access: "public"`          |
| README says `npm install`            | Tell users to add to `opencode.json` only |
| Awaiting the update check            | Fire-and-forget; never block init         |
| `tsc`-built TUI bundle               | Bundle with the Solid transform; `tsc`/plain `Bun.build` emit `jsxDEV` against a type-only runtime |
| TUI dist passes in dev, crashes from npm | Smoke-test the BUILT bundle: 0 `jsxDEV`, >0 `createComponent` |
