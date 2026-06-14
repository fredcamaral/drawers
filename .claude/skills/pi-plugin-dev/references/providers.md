# pi custom model providers

> `pi.registerProvider(name, config)` adds or overrides a model provider — proxies,
> custom endpoints, local model servers, OAuth `/login` flows. `pi.unregisterProvider(name)`
> removes it (restoring any built-in models it shadowed). Config type in `api.md`
> (`ProviderConfig`, `types.ts:1355-1413`). Deep upstream doc:
> `packages/coding-agent/docs/custom-provider.md`.

## When it takes effect

Calls during the **factory** are queued and flushed once the runner binds (before
startup). Calls **after** load (e.g. from a command after a setup flow) take effect
immediately — no `/reload`. To expose freshly-discovered remote models to
`pi --list-models`, prefer an **async factory** (pi awaits it) over deferring the
fetch to `session_start`.

## Two shapes: override vs. define

**Override a built-in** — pass only the fields you change; all existing models are
kept:

```typescript
pi.registerProvider("anthropic", { baseUrl: "https://proxy.example.com" })
pi.registerProvider("openai", { headers: { "X-Org": "$OPENAI_ORG" } })
```

**Define a new provider** — requires `baseUrl`, `api`, and `models` (and an `apiKey`
unless `oauth` is given). Providing `models` **replaces** the provider's model list.

```typescript
pi.registerProvider("my-proxy", {
  name: "My Proxy",                  // display name (e.g. in /login)
  baseUrl: "https://proxy.example.com",
  apiKey: "$PROXY_API_KEY",
  api: "anthropic-messages",
  models: [{
    id: "claude-sonnet-4-20250514",
    name: "Claude 4 Sonnet (proxy)",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },  // $/M tokens
    contextWindow: 200000,
    maxTokens: 16384,
  }],
})
```

### `api` types
`"anthropic-messages"`, `"openai-completions"`, `"openai-responses"`,
`"mistral-conversations"`, `"google-generative-ai"`, `"google-vertex"`,
`"bedrock-converse-stream"`. A custom identifier (e.g. `"my-custom-api"`) **requires a
`streamSimple` implementation** (below).

### `apiKey` interpolation
| Form | Meaning |
|------|---------|
| `$ENV_VAR` / `${ENV_VAR}` | environment variable |
| `!command` (whole value) | run a shell command, use stdout |
| `$$` / `$!` | literal `$` / literal `!` (no interpolation/exec) |
| plain text | literal key |

`headers` values use the same interpolation. `authHeader: true` auto-adds
`Authorization: Bearer <apiKey>`.

### Model definition fields (`ProviderModelConfig`)
`id`, `name`, `reasoning: boolean`, `input: ("text"|"image")[]`,
`cost: { input, output, cacheRead, cacheWrite }`, `contextWindow`, `maxTokens`.
Optional: per-model `api` / `baseUrl` / `headers`, `thinkingLevelMap` (map pi's
`off|minimal|low|medium|high|xhigh` to provider-specific values; `null` hides an
unsupported level), `compat` (provider quirks: reasoning-effort support, tool-result
naming, thinking format, …).

## OAuth `/login`

Supply `oauth` and the provider appears in the `/login` menu. Three required callbacks
(+ optional `modifyModels`):

```typescript
pi.registerProvider("corp-ai", {
  name: "Corporate AI (SSO)",
  baseUrl: "https://ai.corp.com",
  api: "openai-responses",
  models: [ /* … */ ],
  oauth: {
    name: "Corporate AI (SSO)",
    async login(callbacks) {
      // drive the flow via callbacks: onAuth({url}) opens a browser; onDeviceCode({...});
      // onPrompt({message}) asks for a pasted code; onSelect() for interactive choice.
      callbacks.onAuth({ url: authorizeUrl })
      const code = await callbacks.onPrompt({ message: "Paste the code:" })
      const tok = await exchange(code)
      return { refresh: tok.refresh_token, access: tok.access_token, expires: Date.now() + tok.expires_in * 1000 }
    },
    async refreshToken(creds) { return await refresh(creds) },  // auto-called when expired
    getApiKey(creds) { return creds.access },                   // used per request
    // modifyModels(models, creds) { return models }            // optional: subscription/region-aware
  },
})
```

The Anthropic example (`examples/extensions/custom-provider-anthropic/`) does PKCE; the
GitLab Duo example (`custom-provider-gitlab-duo/`) does OAuth + delegates streaming to a
built-in streamer. Credentials persist in pi's auth store (`~/.pi/agent/auth.json`,
OS-keychain-backed where available).

## Custom streaming (`streamSimple`)

For a non-standard API (`api: "my-custom-api"`), implement streaming:

```typescript
streamSimple: (model, context, options) => {
  const stream = new AssistantMessageEventStream()
  ;(async () => {
    stream.push({ type: "start", partial: output })
    // per block: text_start → text_delta* → text_end ; thinking_* ; toolcall_*
    stream.push({ type: "done", reason, message })
    // on failure: stream.push({ type: "error", reason, error })
    stream.end()
  })()
  return stream
}
```

You can also **delegate** to pi's built-in streamers (the GitLab Duo example proxies
the request and reuses the standard streamer).

## Normalizing a provider's context-overflow error

If a provider returns an overflow error pi does not recognize (so it cannot auto-retry
after compaction), rewrite the message in a `message_end` handler:

```typescript
pi.on("message_end", (event) => {
  if (event.message.provider !== "my-provider") return
  if (!/my overflow phrase/i.test(event.message.errorMessage ?? "")) return
  return { message: { ...event.message, errorMessage: `context_length_exceeded: ${event.message.errorMessage}` } }
})
```

## Local-model discovery (async factory)

```typescript
export default async function (pi: ExtensionAPI) {
  const { data } = await (await fetch("http://localhost:1234/v1/models")).json()
  pi.registerProvider("local-openai", {
    baseUrl: "http://localhost:1234/v1",
    apiKey: "$LOCAL_OPENAI_API_KEY",
    api: "openai-completions",
    models: data.map((m) => ({
      id: m.id, name: m.name ?? m.id, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.context_window ?? 128000, maxTokens: m.max_tokens ?? 4096,
    })),
  })
}
```

Because pi awaits the factory, these models are available immediately, including to
`pi --list-models`.
