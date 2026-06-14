# pi extension API

> Distilled from a pinned `pi-mono` snapshot (`packages/coding-agent/src/core/extensions/types.ts`,
> `index.ts`). `file:line` anchors drift — match on surrounding code. Installed pi wins.

Everything is imported from `@earendil-works/pi-coding-agent`; tool schemas from
`typebox`; string enums from `@earendil-works/pi-ai`; TUI components from
`@earendil-works/pi-tui`.

## `ExtensionAPI` — the `pi` argument (`types.ts:1125-1347`)

The factory's only argument. **During the factory call, only the registration
methods are valid** — action methods throw `"Extension runtime not initialized"`
until the runtime binds (see `gotchas.md`).

### Registration (valid in the factory)

```typescript
on(event, handler): void                       // see events.md for the overload table (types.ts:1125-1163)

registerTool<TParams extends TSchema>(tool: ToolDefinition<TParams>): void   // (1170) — also valid at runtime
registerCommand(name: string, opts: Omit<RegisteredCommand,"name"|"sourceInfo">): void   // (1179)
registerShortcut(key: KeyId, opts: { description?: string; handler: (ctx) => void|Promise<void> }): void  // (1182)
registerFlag(name: string, opts: { description?: string; type: "boolean"|"string"; default?: boolean|string }): void  // (1191)
getFlag(name: string): boolean | string | undefined                                       // (1201)
registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void        // (1208)
registerProvider(name: string, config: ProviderConfig): void                              // (1329) — see providers.md
unregisterProvider(name: string): void                                                    // (1344)
```

`RegisteredCommand` (`types.ts:1097-1103`): `{ name, sourceInfo, description?,
getArgumentCompletions?(prefix) => AutocompleteItem[]|null, handler(args: string, ctx:
ExtensionCommandContext) => Promise<void> }`. Same command name from multiple
extensions → suffixed `/name:1`, `/name:2` in load order.

### Actions (valid after load — from handlers/commands/tools)

```typescript
sendMessage<T>(msg: Pick<CustomMessage<T>,"customType"|"content"|"display"|"details">,
               opts?: { triggerTurn?: boolean; deliverAs?: "steer"|"followUp"|"nextTurn" }): void  // (1215)
sendUserMessage(content: string | (TextContent|ImageContent)[],
                opts?: { deliverAs?: "steer"|"followUp" }): void                                    // (1223)
appendEntry<T>(customType: string, data?: T): void          // persist state, NOT LLM-visible (1230)
setSessionName(name: string): void  /  getSessionName(): string | undefined                        // (1237)
setLabel(entryId: string, label: string | undefined): void  // /tree bookmark (1243)
exec(command: string, args: string[], opts?: ExecOptions): Promise<ExecResult>   // {stdout,stderr,code,killed} (1246)
getCommands(): SlashCommandInfo[]                                                                   // (1248)
getActiveTools(): string[]  /  getAllTools(): ToolInfo[]  /  setActiveTools(names: string[]): void  // (1252-1258)
setModel(model: Model): Promise<boolean>   // false if no API key (1265)
getThinkingLevel(): ThinkingLevel  /  setThinkingLevel(level): void   // off|minimal|low|medium|high|xhigh (1268)
events: EventBus                            // pi.events.on/emit — cross-extension bus (1347)
```

`deliverAs`: `"steer"` (default) delivers after the current assistant turn's tool
calls, before the next LLM call; `"followUp"` waits until the agent has no more tool
calls; `"nextTurn"` queues for the next user prompt (no interrupt). `sendUserMessage`
always triggers a turn; when streaming it **requires** an explicit `deliverAs`.

`registerTool` works at runtime too — call it from `session_start` or a command and
the tool is immediately callable (no `/reload`). `setActiveTools` enables/disables
both built-in and dynamic tools.

## `ExtensionContext` (`types.ts:300-333`)

Passed to every event handler. Read-only context.

```typescript
interface ExtensionContext {
  ui: ExtensionUIContext                 // see ui.md
  mode: "tui" | "rpc" | "json" | "print"
  hasUI: boolean                         // true in tui+rpc; false in print+json
  cwd: string
  sessionManager: ReadonlySessionManager // getSessionFile/getEntries/getBranch/getLeafId/getLabel
  modelRegistry: ModelRegistry
  model: Model | undefined
  signal: AbortSignal | undefined        // active-turn abort; often undefined when idle
  isIdle(): boolean
  isProjectTrusted(): boolean            // honors temp + CLI trust, not just saved
  abort(): void
  hasPendingMessages(): boolean
  shutdown(): void                       // graceful; deferred to idle in interactive/rpc
  getContextUsage(): { tokens: number|null; contextWindow: number; percent: number|null } | undefined
  compact(opts?: { customInstructions?; onComplete?(result); onError?(err) }): void  // fire-and-forget
  getSystemPrompt(): string              // chained value during before_agent_start
}
```

## `ExtensionCommandContext` (`types.ts:339-373`)

Passed to **command handlers only** — extends `ExtensionContext` with session
control. These methods can deadlock if called from event handlers, so they live
here on purpose.

```typescript
interface ExtensionCommandContext extends ExtensionContext {
  getSystemPromptOptions(): BuildSystemPromptOptions   // treat as sensitive (may hold context file contents)
  waitForIdle(): Promise<void>
  newSession(opts?: { parentSession?: string; setup?(sm: SessionManager): Promise<void>;
                      withSession?(ctx: ReplacedSessionContext): Promise<void> }): Promise<{ cancelled: boolean }>
  fork(entryId: string, opts?: { position?: "before"|"at"; withSession? }): Promise<{ cancelled: boolean }>
  switchSession(path: string, opts?: { withSession? }): Promise<{ cancelled: boolean }>
  navigateTree(targetId: string, opts?: { summarize?; customInstructions?; replaceInstructions?; label? }): Promise<{ cancelled: boolean }>
  reload(): Promise<void>     // same as /reload — treat `await ctx.reload(); return;` as terminal
}
```

### `ReplacedSessionContext` (`types.ts:380-390`)
The `withSession(ctx => …)` callback receives this — a fresh command context bound to
the **replacement** session, with **async** `sendMessage()` / `sendUserMessage()`.
After a switch/fork/new, the old `pi`/`ctx` are stale and throw — do post-replacement
work here, capturing only plain data (strings, ids) across the boundary. See
`gotchas.md`.

Discover sessions to switch to via static `SessionManager.list(cwd)` /
`SessionManager.listAll()` (import `SessionManager` from the package).

## Tool definition (`types.ts:435-497`)

```typescript
interface ToolDefinition<TParams extends TSchema, TDetails = unknown, TState = any> {
  name: string
  label: string
  description: string                  // shown to the LLM
  promptSnippet?: string               // one-line entry in "Available tools" (omitted ⇒ not listed there)
  promptGuidelines?: string[]          // bullets appended to Guidelines while the tool is active — NAME the tool in each
  parameters: TParams                  // a typebox schema (Type.Object({...}))
  executionMode?: "sequential" | "parallel"
  renderShell?: "default" | "self"
  prepareArguments?(args: unknown): Static<TParams>   // runs BEFORE validation — fold legacy shapes for resumed sessions
  execute(toolCallId: string, params: Static<TParams>, signal: AbortSignal | undefined,
          onUpdate: ((p: { content; details? }) => void) | undefined, ctx: ExtensionContext)
    : Promise<{ content: (TextContent|ImageContent)[]; details?: TDetails; terminate?: boolean }>
  renderCall?(args, theme, context): Component
  renderResult?(result, options, theme, context): Component
}
```

Use `defineTool({...})` (`types.ts:493`) when assigning to a variable or putting tools
in an array — it preserves param type inference. Full tool guidance in `tools.md`.

**`execute` contract:** return `{ content, details?, terminate? }`. To FAIL, **throw**
— the runtime sets `isError: true` and reports it to the LLM. A returned `isError`
field does nothing. `terminate: true` skips the follow-up LLM call only if every
finalized tool in the batch also terminates.

## Type guards & helpers (exported from the package)

```typescript
// Narrow tool events (index.ts:144-152) — built-ins typed, custom tools via type params:
isToolCallEventType("bash"|"read"|"edit"|"write"|"grep"|"find"|"ls", event): boolean
isToolCallEventType<TName, TInput>(name, event): event is { toolName: TName; input: TInput }
isBashToolResult | isReadToolResult | isEditToolResult | isWriteToolResult
  | isGrepToolResult | isFindToolResult | isLsToolResult (event): boolean

// Tools (tools.md):
defineTool(def)
withFileMutationQueue(absPath, async () => {...})         // serialize file mutations vs built-in edit/write
truncateHead | truncateTail (content, { maxLines?, maxBytes? }): TruncationResult
truncateLine(line, maxBytes) ; formatSize(bytes) ; DEFAULT_MAX_BYTES (50000) ; DEFAULT_MAX_LINES (2000)
createBashTool | createReadTool | createWriteTool | createEditTool
  | createGrepTool | createFindTool | createLsTool (cwd, { operations?, spawnHook? })   // pluggable backends
create*ToolDefinition(cwd, opts)                          // the ToolDefinition form
createLocalBashOperations(): BashOperations               // wrap pi's local shell in a user_bash handler

// UI / rendering (ui.md):
CustomEditor                                              // base class for custom editors
keyHint(id, desc) ; keyText(id) ; rawKeyHint(key, desc)  // app.* / tui.* namespaced keybinding ids
highlightCode(code, lang, theme) ; getLanguageFromPath(path)

// Session:
SessionManager                                            // static list()/listAll(); appendMessage/appendEntry on instances
```
