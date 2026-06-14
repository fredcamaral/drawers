# Publishing & distributing a pi extension

> Discovery, locations, trust, the jiti loader, hot reload, and how to package an
> extension as a pi package on npm or git. Grounded in `src/core/extensions/loader.ts`
> and `docs/packages.md`.

## How extensions are discovered

Auto-loaded, in this order (`loader.ts:557-604`); the same resolved path loads once:

1. **Project-local** `.pi/extensions/*.ts` and `.pi/extensions/*/index.ts` — only after
   the project is trusted.
2. **Global** `~/.pi/agent/extensions/*.ts` and `~/.pi/agent/extensions/*/index.ts`.
3. **CLI** `-e` / `--extension` paths (repeatable).
4. **`settings.json` `extensions`** array (local paths/dirs; globs + `!`/`+`/`-`
   include-exclude supported).
5. **`settings.json` `packages`** array (installed npm/git/local packages, resolved via
   their manifest).

A directory entry resolves (`loader.ts:470-508`): a `package.json` with a `pi` field
(its `pi.extensions` array wins) → else `index.ts` → else top-level `*.ts`/`*.js`.

**Project trust** gates project-local extensions and project-scoped packages. Saved in
`~/.pi/agent/trust.json`; `defaultProjectTrust` (`ask`/`always`/`never`) and
`--approve`/`--no-approve` control non-interactive modes. Check `ctx.isProjectTrusted()`
before honoring project-local config.

## The jiti loader

Extensions load through [jiti](https://github.com/unjs/jiti) — TypeScript runs with no
build step (`loader.ts:332-340`), `.ts` and `.js` accepted, ESM. The factory is the
module's `default` export. In the standalone Bun binary, the four pi packages
(`@earendil-works/pi-coding-agent`, `pi-agent-core`, `pi-tui`, `pi-ai`) and `typebox`
are provided as virtual modules — import them, don't bundle them.

## Hot reload (`/reload` / `ctx.reload()`)

Re-discovers and re-loads all extensions, then fires `resources_discover` with
`reason: "reload"` and re-runs factories. In-memory state is lost — reconstruct it in
`session_start` (see `tools.md`). Old captured `ctx`/`pi` go stale (see `gotchas.md` §2).

## Local development layouts

```
~/.pi/agent/extensions/
  my-extension.ts                 # single file
  my-extension/index.ts           # directory + helper modules
  my-extension/                   # package with deps:
    package.json                  #   { "pi": { "extensions": ["./src/index.ts"] }, "dependencies": {...} }
    package-lock.json
    node_modules/                 #   after `npm install`
    src/index.ts
```

With a `package.json` next to (or above) the extension, run `npm install` and imports
from `node_modules/` resolve automatically.

## Packaging as a distributable pi package

A pi package is an npm/git package that advertises resources via the `pi` manifest
field (`docs/packages.md:118-128`):

```json
{
  "name": "@you/pi-cool-extension",
  "version": "1.0.0",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./dist/index.js"],
    "skills":   ["./skills"],
    "prompts":  ["./prompts"],
    "themes":   ["./themes"]
  },
  "dependencies": { "ms": "^2.1.3" }
}
```

Paths are package-root-relative; arrays support globs + exclusions. Add the
`"pi-package"` keyword for gallery discoverability.

### Dependency rules (production install)

`pi install` does a **production** install (`npm install --omit=dev`), so runtime deps
must be in `dependencies`, not `devDependencies` (`docs/packages.md:149,167`):

- The pi packages + `typebox` are **provided by pi** — declare them as
  `peerDependencies` with `"*"` and do **not** bundle them.
- Real runtime deps go in `dependencies`. For the npm tarball to actually carry them,
  list them in **`bundledDependencies`** too (`docs/packages.md:171-186`).
- `npmCommand` in settings (e.g. `["mise","exec","node@20","--","npm"]`) pins npm
  operations to a wrapper; git packages then use plain `install`.

### Consuming

```bash
pi install npm:@you/pi-cool-extension@1.0.0     # → ~/.pi/agent/npm/...   (-l = project: .pi/npm/...)
pi install git:github.com/you/repo@v1            # → ~/.pi/agent/git/<host>/<path>
pi install ./local/path                          # referenced in place
pi list ; pi remove npm:@you/pi-cool-extension ; pi update [--extensions]
```

pi reads the installed `package.json`'s `pi.extensions`, loads those entries, and
registers their tools/commands/events; `pi.skills`/`prompts`/`themes` load the rest.

## Naming

There is no enforced prefix. For this drawers repo, name published pi extensions
`pi-drawer-*` (mirroring the `opencode-drawer-*` convention) and add the `pi-package`
keyword. Keep the npm package `name` stable once published — renaming breaks
`pi install` for existing users.
