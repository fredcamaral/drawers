# Testing a pi extension

> How to load and verify an extension. pi has no dedicated extension test harness —
> the loop is `pi -e`, plus optional `vitest` unit tests against your own logic.

## Load it for a one-off run

```bash
pi -e ./my-extension.ts                 # load for this run (repeatable: -e a.ts -e b.ts)
pi -e ./my-extension.ts "do the thing"   # with an initial prompt
pi -e ./ext-dir                          # a directory (index.ts or package.json pi.extensions)
pi -e npm:@you/ext  /  pi -e git:github.com/you/repo@v1   # temporary one-off install
```

`-e` paths are **not** hot-reloadable. For the `/reload` loop, drop the file in an
auto-discovered location (`~/.pi/agent/extensions/` or `.pi/extensions/`) and edit in
place. Note project-local `.pi/extensions/` only loads after the project is trusted.

## Tool-focused runs

```bash
pi --no-builtin-tools -e ./my-extension.ts   # only your extension's tools — clean slate
```

Useful when overriding a built-in (`read`, `bash`, …) so you can confirm your version
runs without the original shadowing behavior.

## Mode matters

`ctx.mode` is `"tui"` | `"rpc"` | `"json"` | `"print"`. Test the modes you support:

```bash
pi -e ./ext.ts                  # interactive TUI (mode: tui)
pi -p "prompt" -e ./ext.ts      # print mode — UI no-ops; dialogs return defaults
pi --mode json -e ./ext.ts      # json event stream — hasUI false
pi --mode rpc -e ./ext.ts       # rpc — dialogs work via JSON protocol; custom() returns undefined
```

If a dialog result drives control flow, exercise `print`/`json` to confirm your
`ctx.hasUI` fallback (e.g. "block by default when you cannot confirm").

## What to verify by hand

- The factory **registers** without touching action methods (no
  `"runtime not initialized"` throw at load).
- Each event handler fires when expected and returns the **right shape** (a wrong/absent
  return on `tool_call`/`context`/`input`/`project_trust` fails silently — see
  `events.md`).
- A tool that should fail **throws** (the LLM sees `isError`), and bounded output is
  truncated.
- After `/reload` and after `/new`/`/fork`, state reconstructs and you are not reusing a
  stale captured `ctx`/`pi`.

## Unit-testing your logic

The pi repo uses `vitest` (`globals: true`, `environment: node`). For an in-repo or
standalone extension, import your pure helpers and assert on them directly — there is no
official mock for `ExtensionAPI`/`ExtensionContext`, so either:

- factor decision logic into plain functions (e.g. `isDangerous(cmd)`,
  `nextTodos(state, action)`) and unit-test those, or
- hand-roll a minimal `pi`/`ctx` stub that records `registerTool`/`on` calls and feeds
  synthetic events, then assert the registrations/returns.

Provider extensions can be tested below the agent: build a `model` + `context` and call
the streaming function directly (the `custom-provider-gitlab-duo/test.ts` example does
this). Keep these tests **non-LLM** (no API keys, deterministic).

```typescript
// example: testing extracted logic, not the harness
import { describe, it, expect } from "vitest"
import { isDangerous } from "./guard"
describe("guard", () => {
  it("flags rm -rf", () => expect(isDangerous("rm -rf /")).toBe(true))
  it("allows ls",     () => expect(isDangerous("ls -la")).toBe(false))
})
```
