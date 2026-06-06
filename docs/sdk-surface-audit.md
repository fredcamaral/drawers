# Typed SDK Surface Audit

> Ground truth: the installed TypeScript declarations, not docs.
> Audited against the `.d.ts` shipped in `node_modules`, cross-checked against the
> `.references/opencode` source checkout (git `github-v1.2.25-173-g4519a1da3`, both
> `packages/sdk` and `packages/plugin` at `1.16.2` — identical to the installed pin).

## Pinned versions

| Package | Version | Pin |
|---|---|---|
| `@opencode-ai/sdk` | `1.16.2` | exact |
| `@opencode-ai/plugin` | `1.16.2` | exact |
| `zod` (re-exported via `tool.schema`) | `4.1.8` | transitive, plugin dep |

Declaration roots (paths shortened, all under
`node_modules/.bun/@opencode-ai+<pkg>@1.16.2/node_modules/@opencode-ai/<pkg>/dist`):

- SDK client class: `gen/sdk.gen.d.ts`
- SDK request/response/payload types: `gen/types.gen.d.ts`
- Plugin hooks + `Plugin`/`PluginInput`: `@opencode-ai/plugin/dist/index.d.ts`
- `tool()` helper: `@opencode-ai/plugin/dist/tool.d.ts`

The client is generated (openapi-style): each method takes `Options<XxxData>` and returns
`RequestResult<XxxResponses, XxxErrors, ...>`. The **body type lives in `XxxData.body`** in
`types.gen.d.ts`; the method declaration in `sdk.gen.d.ts` only references it. "Signature" below
quotes the `body` shape, which is what callers actually construct.

## Verdicts

| # | Surface | Verdict | Signature / evidence (`types.gen.d.ts` unless noted) |
|---|---|---|---|
| a | `client.session.create` — `parentID`? `title`? | typed ✅ | `SessionCreateData.body?: { parentID?: string; title?: string }` (`:1811-1815`). Both present and typed. Returns `Session` (`SessionCreateResponses[200]`, `:1833`). |
| b | `session.prompt` / `session.promptAsync` — body | typed ✅ | Both exist. `sdk.gen.d.ts:174` (`prompt`), `:182` (`promptAsync`). Identical bodies: `SessionPromptData.body` (`:2244-2258`) and `SessionPromptAsyncData.body` (`:2329-2343`) = `{ messageID?; model?: {providerID; modelID}; agent?; noReply?; system?; tools?: {[key]: boolean}; parts: Array<TextPartInput \| FilePartInput \| AgentPartInput \| SubtaskPartInput> }`. `prompt` returns `{ info: AssistantMessage; parts: Part[] }` (`:2285-2288`); `promptAsync` returns `204: void` (`:2370`). |
| c | `client.session.messages` — return shape | typed ✅ | `SessionMessagesData` query `{ directory?; limit? }`, path `{ id }` (`:2209-2221`). Returns `Array<{ info: Message; parts: Array<Part> }>` (`:2238-2241`). `Message = UserMessage \| AssistantMessage` (`:128`). |
| d | `client.session.abort` | typed ✅ | `sdk.gen.d.ts:150`. `SessionAbortData` path `{ id }`, `body?: never` (`:2059-2067`). Returns `200: boolean` (`:2084`). |
| e | `client.session.get` | typed ✅ | `sdk.gen.d.ts:126`. `SessionGetData` path `{ id }` (`:1888-1896`). Returns `Session` (`:1913`). `Session.parentID?: string` (`:469`). |
| f | `client.session.status` — typed call at all? | typed ✅ | `sdk.gen.d.ts:118`. `SessionStatusData` body `never`, query `{ directory? }`, **no path id** (`:1836-1842`) — it is the global `/session/status` endpoint, not per-session. Returns `{ [key: string]: SessionStatus }` (`:1855-1857`), keyed by session id. `SessionStatus = { type: "idle" } \| { type: "retry"; attempt; message; next } \| { type: "busy" }` (`:396-405`). |
| g | event stream — `client.event.subscribe` and plugin `event` hook | typed ✅ | SDK: `client.event.subscribe()` (`sdk.gen.d.ts:375`) returns `ServerSentEventsResult<EventSubscribeResponses>`; payload is the `Event` union. Plugin hook: `Hooks.event?: (input: { event: Event }) => Promise<void>` (`plugin/dist/index.d.ts:175-177`), `Event` imported from `@opencode-ai/sdk` (`:1`). Same union both paths. |
| h | `client.tui.showToast` — params | typed ✅ | `sdk.gen.d.ts:364`. `TuiShowToastData.body?: { title?: string; message: string; variant: "info"\|"success"\|"warning"\|"error"; duration?: number }` (`:3264-3273`). Returns `200: boolean`. No `as any` needed; fallback path (decision: untyped toast) not required. The `@opencode-ai/plugin` main entry does **not** re-export a toast helper — toast is SDK-client only (the `/tui` subpath peer-dep is the OpenTUI render surface, irrelevant here). |
| i | `client.app.log` — params | typed ✅ | `sdk.gen.d.ts:259`. `AppLogData.body?: { service: string; level: "debug"\|"info"\|"error"\|"warn"; message: string; extra?: { [key]: unknown } }` (`:2842-2862`). Returns `200: boolean`. |
| j | Event payloads + discriminated union | typed ✅ | `Event` is a 32-member discriminated union on `type` (`:602`). Members: `EventSessionIdle = { type: "session.idle"; properties: { sessionID: string } }` (`:413-418`); `EventSessionCreated = { type: "session.created"; properties: { info: Session } }` (`:493-497`) — `Session.parentID?: string` **exists** (`:469`); `EventSessionError = { type: "session.error"; properties: { sessionID?: string; error?: <union> } }` (`:518-524`) — both optional, narrow first; `EventMessageUpdated = { type: "message.updated"; properties: { info: Message } }` (`:129-134`); also `EventSessionStatus` (`:406-412`), `EventSessionUpdated/Deleted` (`:499-510`). Narrowable on `event.type`. |
| k | `tool()` helper + `tool.schema` | typed ✅ | `tool/dist/tool.d.ts:47-58`. `tool<Args extends z.ZodRawShape>(input: { description: string; args: Args; execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<ToolResult> })`. `tool.schema` is `typeof z` (`:57`) where `z` is imported from `zod` (`:1`). **Zod v4.1.8** (plugin dep). `ToolResult = string \| { title?; output: string; metadata?; attachments? }` (`:39-46`). |
| l | per-prompt `tools` override `{ [name]: boolean }` (recursion guard) | typed ✅ | `SessionPromptData.body.tools?: { [key: string]: boolean }` (`:2254-2256`) and identical on `SessionPromptAsyncData` (`:2339-2341`). The map is `string -> boolean`; setting a tool `false` is type-legal per-prompt. **Load-bearing recursion guard is fully typed.** |
| m | assistant message token/usage metadata | typed ✅ | `AssistantMessage.tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }` (`:117-125`), plus `cost: number` (`:116`). Returned by `session.prompt` (`info`), `session.messages`/`session.message` (when role is assistant), and carried in `EventMessageUpdated.properties.info`. **Phase 4 budget accounting has typed input/output/reasoning/cache(read,write) + cost.** |

## Design impact

Every audited surface is **typed ✅**. No `as any`, no index-signature escape hatch, nothing absent.
This clears the plan's decision 3 ("Typed SDK surface only — anything untyped is treated as
unavailable") for the entire Phase 1–4 dependency set.

Load-bearing surfaces (a–e, g, i, j, l): **all typed.** Specific confirmations the plan depends on:

- **(l) recursion guard** — `tools: { [name]: boolean }` is typed on both `prompt` and `promptAsync`.
  The engine can disable `bg_*`/`workflow` tools per-prompt without `as any`. This was the one
  load-bearing risk; it is clean.
- **(a/j) parent correlation** — `session.create` accepts a typed `parentID`, and `Session.parentID`
  is present on every payload that carries a `Session` (`session.created`, `session.updated`,
  `session.get`). Decision 4 ("child session IS the durable task" + parent-context persistence) and
  the events.md gotcha "correlate via `Session.parentID`" are both type-backed.
- **(g/j) event-primary completion** — `EventSessionIdle` and the discriminated `Event` union are
  typed; narrowing on `event.type === "session.idle"` is sound. Decision 2 holds.
- **(b) launch path** — `session.create` + `promptAsync` (decision: launch via these two) are both
  typed; `promptAsync` returns `204 void`, so completion MUST come from the event stream, not the
  call return — exactly what decision 2 assumes.

Best-effort / fallback surfaces:

- **(f) `session.status`** — expected best-effort, and it is in fact **typed ✅** (better than the plan
  assumed). Note the shape: it is the *global* `/session/status` map `{ [sessionID]: SessionStatus }`,
  not a per-session call. The poll fallback (decision 2) reads its own session's entry by id.
  `SessionStatus` has no `"completed"`/error terminal — only `idle`/`retry`/`busy` — so it confirms
  idle/busy but is not a completion oracle on its own; pair with output validation as the plan says.
- **(h) `tui.showToast`** — typed ✅, so the documented untyped-toast fallback is unnecessary.

Phase 4 (m): token accounting is fully typed (`input`/`output`/`reasoning`/`cache.{read,write}` +
`cost`). The Epic 4.3 budget spike does **not** need a workaround for missing usage metadata.

## Note on the regenerated reference docs

`references/events.md` and `references/hooks.md` were regenerated from the `1.16.2` source checkout
(exit 0, 32/32 union members resolved). Two observations relevant to the plan:

1. **Stale hand-written gotcha in `events.md`.** The preserved gotcha block (`events.md:330-331`)
   says `session.idle` "has no successor, expect a `session.status`/step-ended successor *later*."
   But `EventSessionStatus` / `session.status` **is already in the 1.16.2 v1 union** (table row,
   `events.md:71`; type `:406-412`). The "later" framing is stale relative to the union it now ships
   beside. This text lives inside the script's `generateEventsDoc` template (hand-written, survives
   regeneration), so the extract script cannot self-correct it — fixing it means editing the script
   template, which is out of scope for this task. Flagged, not changed. Does not affect Phase 1
   design: `session.idle` is still the correct completion boundary (decision 2); `session.status` as
   best-effort poll (f) is unchanged.

2. **No contradiction with plan decisions 1–6.** The regenerated refs reaffirm: `session.idle` as the
   turn-done boundary (decision 2), `Session.parentID` correlation (decisions 1/4), v1 union is what
   the `event` hook receives (decision 5 narrow pin), and the runtime-vs-type note (events.md
   "Runtime vs. this type") is consistent with treating untyped runtime-only events as unavailable
   (decision 3).
