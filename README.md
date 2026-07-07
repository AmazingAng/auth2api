# auth2api

[中文](./README_CN.md)

A lightweight OAuth-to-API proxy that turns your Claude (Anthropic), ChatGPT (OpenAI Codex), and experimental local Cursor login into usable API endpoints for Claude Code and OpenAI-compatible clients.

auth2api is intentionally small and focused:

- bring your own Claude / ChatGPT / Cursor login (one or more accounts per provider)
- one local or self-hosted proxy
- automatic per-provider routing by model name

It is not trying to be a large multi-provider gateway. If you want a compact, understandable proxy that is easy to run and modify, auth2api is built for that use case.

## Features

- **Lightweight by design** — small codebase, minimal moving parts
- **Multiple providers, one proxy** — Claude OAuth, OpenAI Codex (ChatGPT) OAuth, and an experimental Cursor local-login provider coexist; per-provider account pools, cooldown, refresh, and stats
- **Multi-account support** — load multiple OAuth tokens per provider with sticky routing, automatic failover, and per-account usage tracking
- **OpenAI-compatible API** — supports `/v1/chat/completions`, `/v1/responses`, `/v1/images/generations`, `/v1/images/edits`, and `/v1/models`
- **Claude native passthrough** — supports `/v1/messages` and `/v1/messages/count_tokens`
- **Claude Code friendly** — works with both `Authorization: Bearer` and `x-api-key`
- **Streaming, tools, images, and reasoning** — covers the main usage patterns without a large framework
- **Structured JSON output** — supports `response_format` (Chat API) and `text.format` (Responses API) for structured outputs
- **Per-account health handling** — cooldown, retry, token refresh (with concurrency lock), and `/admin/accounts` snapshot
- **Basic safety defaults** — timing-safe API key validation, per-IP rate limiting, localhost-only browser CORS

## Requirements

- Node.js 20+
- A Claude account (Claude Max subscription recommended)

## Installation

```bash
git clone https://github.com/AmazingAng/auth2api
cd auth2api
npm install
npm run build
```

## Login

auth2api supports these upstream providers:

- `anthropic` — Claude OAuth (default). Used for `claude-*` models.
- `codex` — OpenAI's "Sign in with ChatGPT" OAuth, talking to the official codex backend at `https://chatgpt.com/backend-api/codex/responses`. Used for `gpt-5*` (incl. `gpt-5-codex`), `o\d*`, and `codex-*` models. Requires a **ChatGPT Plus or Pro** subscription — Free accounts authenticate but the first call fails with `model not supported`.
- `cursor` — experimental Cursor account, authorized either through a browser deep-link PKCE flow (default) or by importing the local Cursor desktop login. **Routing**: in multi-provider setups Cursor only serves models with an explicit `cursor-*` or `cr/*` prefix. In **Cursor-exclusive mode** (only Cursor is logged in, no `anthropic`/`codex` accounts), every request — including bare `claude-*` or `gpt-*` model names — is auto-routed through Cursor so off-the-shelf Claude Code / OpenAI clients work without a prefix.

Pick the provider with `--provider=`. Default is `anthropic`.

### Auto mode (requires local browser)

```bash
# Claude (default)
node dist/index.js --login

# Codex (ChatGPT Plus/Pro)
node dist/index.js --login --provider=codex

# Cursor (experimental; opens a browser to authorize your Cursor account)
node dist/index.js --login --provider=cursor

# Cursor — fall back to importing the local Cursor desktop login instead of using the browser
node dist/index.js --login --provider=cursor --cursor-import-local
node dist/index.js --login --provider=cursor --cursor-storage=/path/to/state.vscdb
```

Anthropic and Codex open a browser URL. After authorizing, the callback is handled automatically. The Anthropic flow uses port `54545`; the Codex flow uses port `1455` — make sure neither is blocked by your firewall. Cursor uses a different "deep-link" PKCE flow: it prints a `https://cursor.com/loginDeepControl?...` URL, you click "Yes, Log In" in your browser, and `auth2api` polls `api2.cursor.sh/auth/poll` until the token is issued — no callback port required. Pass `--cursor-import-local` (or `--cursor-storage=...`) if you'd rather pull the existing token out of your Cursor desktop install.

### Manual mode (for remote servers)

```bash
node dist/index.js --login --manual
node dist/index.js --login --provider=codex --manual
```

Open the printed URL in your browser. After authorizing, your browser will redirect to a `localhost` URL that fails to load — copy the full URL from the address bar and paste it back into the terminal.

You can run `--login` multiple times to add additional accounts (per provider). auth2api stores tokens side-by-side in `auth-dir` (`claude-<email>.json`, `codex-<email>.json`, and `cursor-<email>.json`) and routes inbound requests to the matching pool by model name. Logging in to only one provider is fine — the others simply have no advertised models.

> **Note on Codex:** The codex provider relays your ChatGPT Plus/Pro subscription quota. OpenAI's ToS does not officially permit relaying ChatGPT sessions through third-party tools — use this for your own personal local consumption only.

> **Note on Cursor:** The cursor provider is a research-only integration built from non-public, reverse-engineered Cursor APIs (`api2.cursor.sh` over HTTP/2, Connect-RPC + protobuf). It may break when Cursor changes client versions, may violate Cursor's terms, and should be used only for local personal experiments.

## Starting the server

```bash
node dist/index.js
```

The server starts on `http://127.0.0.1:8317` by default. On first run, an API key is auto-generated and saved to `config.yaml`.

## Configuration

Copy `config.example.yaml` to `config.yaml` and edit as needed:

```yaml
host: "" # bind address, empty = 127.0.0.1
port: 8317

auth-dir: "~/.auth2api" # where OAuth tokens are stored

api-keys:
  - "your-api-key-here" # clients use this to authenticate

body-limit: "200mb" # maximum JSON request body size, useful for large-context usage

timeouts:
  messages-ms: 120000 # non-stream /v1/messages timeout
  stream-messages-ms: 600000 # stream /v1/messages timeout (10 min, suitable for Claude Code)
  count-tokens-ms: 30000 # /v1/messages/count_tokens timeout

# Request fingerprinting — controls how auth2api mimics Claude Code CLI
cloaking:
  cli-version: "2.1.88" # CLI version to impersonate
  entrypoint: "cli" # billing attribution entrypoint (cli, mcp, sdk, etc.)

debug: "off" # off | errors | verbose
```

`debug` supports three levels:

- `off`: no extra logs
- `errors`: log upstream/network failures and upstream error bodies
- `verbose`: include `errors` logs plus per-request method, path, status, and duration

Cursor's reverse-engineered headers can be overridden if the upstream version gate changes. `agent-base-url` is the legacy alias for the chat host; both keys point at the same backend now (`api2.cursor.sh`).

```yaml
cloaking:
  cursor:
    client-version: "2.3.41"
    client-type: "ide"
    agent-base-url: "https://api2.cursor.sh"
    api-base-url: "https://api2.cursor.sh"
```

## Usage

Use any OpenAI-compatible client pointed at `http://127.0.0.1:8317`:

```bash
curl http://127.0.0.1:8317/v1/chat/completions \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 1024
  }'
```

### Available models

`GET /v1/models` lists only models for providers you've actually logged in to. The codex list is **fetched live** from `chatgpt.com/backend-api/codex/models` (cached 5 minutes, ETag-aware) so it always matches what your account can actually serve. Cursor models are fetched from Cursor's internal AvailableModels endpoint when possible, with a small fallback list. The current ChatGPT-account-supported set at the time of writing:

| Model ID                                             | Provider  | Description                                        |
| ---------------------------------------------------- | --------- | -------------------------------------------------- |
| `claude-opus-4-7`                                    | anthropic | Claude Opus 4.7                                    |
| `claude-opus-4-6`                                    | anthropic | Claude Opus 4.6                                    |
| `claude-sonnet-4-6`                                  | anthropic | Claude Sonnet 4.6                                  |
| `claude-haiku-4-5-20251001`                          | anthropic | Claude Haiku 4.5                                   |
| `claude-haiku-4-5`                                   | anthropic | Alias for Claude Haiku 4.5                         |
| `gpt-5.5`                                            | codex     | GPT-5.5 (reasoning model)                          |
| `gpt-5.4`                                            | codex     | GPT-5.4                                            |
| `gpt-5.4-mini`                                       | codex     | GPT-5.4 Mini                                       |
| `gpt-5.3-codex`                                      | codex     | GPT-5.3 (Codex variant)                            |
| `gpt-5.2`                                            | codex     | GPT-5.2                                            |
| `cursor-claude-opus-4-7-medium`                      | cursor    | Claude Opus 4.7 routed through Cursor              |
| `cursor-claude-sonnet-4-7-medium`                    | cursor    | Claude Sonnet 4.7 routed through Cursor            |
| `cursor-default`                                     | cursor    | Cursor "Auto" model                                |
| `cursor-premium` / `cursor-fast` / `cursor-composer` | cursor    | Fallback ids when AvailableModels can't be reached |

Short convenience aliases accepted by auth2api:

- `opus` -> `claude-opus-4-7`
- `sonnet` -> `claude-sonnet-4-6`
- `haiku` -> `claude-haiku-4-5-20251001`

Routing: requests are dispatched to the matching pool by model name. `claude-*` and the bare aliases (`opus`/`sonnet`/`haiku`) hit your Claude account; `gpt-5*`, `o\d` (`o3`, `o4-mini`, …), and `codex-*` hit your Codex account; `cursor-*` and `cr/*` hit your Cursor account. Other model families (`gpt-3.5-*`, `gpt-4*`, …) are not served by either backend and route to anthropic by default. If you haven't logged into the matching provider, the request returns `503 no_account_for_provider` with the exact `--login` command to fix it.

#### "Cursor exclusive" mode (zero-config Claude Code / OpenAI clients)

When **only Cursor has a logged-in account** (anthropic and codex are both empty), every model name routes to Cursor automatically — `cursor-` prefix becomes optional. This is what makes a Cursor-only auth2api a drop-in replacement for the Anthropic API or the OpenAI API:

| Client behaviour                                           | What auth2api does                                                                 |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `POST /v1/messages` `{"model":"claude-sonnet-4-5"}`        | routes through Cursor and re-encodes the upstream stream as Anthropic Messages SSE |
| `POST /v1/messages` `{"model":"opus"}`                     | maps `opus` → `claude-opus-4-7-medium` on Cursor, returns Anthropic Messages SSE   |
| `POST /v1/responses` `{"model":"gpt-5.5"}`                 | maps to `gpt-5.5-medium` on Cursor, returns OpenAI Responses SSE                   |
| `POST /v1/chat/completions` `{"model":"claude-haiku-4-5"}` | maps to `claude-4.5-haiku` on Cursor                                               |

A small built-in alias table covers the names Anthropic / OpenAI SDKs and Claude Code use by default (`claude-sonnet-4-5`, `claude-opus-4-7`, `opus`, `sonnet`, `haiku`, `gpt-5.5`, `o3`, …) and translates them to Cursor's internal SKUs (`claude-4.5-sonnet`, `claude-opus-4-7-medium`, `gpt-5.5-medium`, …). Set `CURSOR_MODEL_ALIASES="my-name=claude-opus-4-7-max,foo=composer-2"` to extend the table without forking. Anything not in the table is passed through verbatim, so you can still hit Cursor's full SKU catalogue (e.g. `claude-opus-4-7-thinking-max`).

When **more than one provider has accounts**, the historical routing table above applies — explicit prefixes (`cursor-`, `cr/`) still force Cursor, but `claude-*` goes to your Anthropic OAuth account.

##### Anthropic SSE for Claude Code on Cursor

`POST /v1/messages` against a Cursor-served model emits the Anthropic Messages SSE format (`message_start` → `content_block_start`/`content_block_delta` → `message_delta` → `message_stop`). Reasoning bytes from thinking-enabled models are routed to a `thinking` content block before the final `text` block, matching Claude Code's expectations. Streaming is forced on (Cursor only supports streaming), so non-streaming `/v1/messages` requests still get an SSE response when the upstream is Cursor.

### Endpoint × provider support matrix

| Endpoint                         | anthropic | codex                                                               | cursor                                                             |
| -------------------------------- | --------- | ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `POST /v1/chat/completions`      | ✅        | ✅ (Chat ↔ Responses translator — reasoning as `reasoning_content`) | ✅ (`chat.completion.chunk` SSE; reasoning as `reasoning_content`) |
| `POST /v1/responses`             | ✅        | ✅ (passthrough)                                                    | ✅                                                                 |
| `POST /v1/images/generations`    | ❌        | ✅ (Codex Responses `image_generation` tool)                        | ❌                                                                 |
| `POST /v1/images/edits`          | ❌        | ✅ (Codex Responses `image_generation` tool with input images)      | ❌                                                                 |
| `POST /v1/messages`              | ✅        | ✅ (Anthropic ↔ Responses translator — see below)                   | ✅ (Anthropic Messages SSE — see below)                            |
| `POST /v1/messages/count_tokens` | ✅        | ❌ (501)                                                            | ❌ (501)                                                           |

For Cursor all three OpenAI-compatible endpoints are wired natively: `req.path` selects the wire format the cursor provider emits (`openai-chat-completions`, `openai-responses`, or `anthropic-messages`). Non-streaming `/v1/chat/completions` aggregates the upstream stream into a single `chat.completion` JSON response.

For Codex (ChatGPT-account backend) the same coverage is achieved through a dedicated Chat ↔ Responses ↔ Anthropic translator pair (`src/upstream/responses-translator.ts`): incoming Chat or Anthropic requests are translated to OpenAI Responses upstream, the streaming Responses SSE response is translated back to the original wire format, and non-streaming requests aggregate the SSE locally before responding. Tool calls, system prompts (lifted into `instructions`), `reasoning_effort`/`thinking`, multi-turn conversations and `response_format` `json_schema` are all supported. Codex-specific incompatibilities (`max_output_tokens`, `parallel_tool_calls`) are stripped automatically in the codex handler — you don't have to think about them.

Codex image routes (`/v1/images/generations`, `/v1/images/edits`) do not call the public OpenAI Images API and do not require a separate OpenAI API key. They route through the ChatGPT-account Codex Responses backend with the hosted `image_generation` tool (`gpt-image-2`) and return OpenAI-compatible `{ data: [{ b64_json }] }` responses. Codex may silently coerce `size` / `quality` to backend defaults, so exact dimensions are best-effort on this OAuth-backed path.

#### Codex `/v1/responses` body requirements

The ChatGPT codex backend rejects requests that don't include `stream: true`, `store: false`, and `instructions`, and 400s on a couple of public Responses fields (`max_output_tokens`, `parallel_tool_calls`). auth2api applies the same sanitize-and-force-stream pattern to all three codex endpoints (`/v1/chat/completions`, `/v1/messages`, `/v1/responses`):

- `store: false` and `instructions: ""` are auto-filled when the client omits them.
- `max_output_tokens` and `parallel_tool_calls` are stripped — the backend caps tokens by your ChatGPT plan instead.
- The upstream call is **always** made with `stream: true` regardless of the client's `stream` value. If the client asked for `stream: false`, auth2api drains the upstream SSE locally and returns a single JSON body in the requested wire format (Responses, Chat Completions, or Anthropic Messages) — including stitching `response.output_item.done` items into `output` because codex's `response.completed.response.output` is always `[]`.

Off-the-shelf OpenAI Responses / Chat / Claude Code clients all just work without knowing about codex's quirks.

#### Cursor `/v1/responses` limitations

Cursor's chat protocol is reverse-engineered: requests go to `api2.cursor.sh/aiserver.v1.ChatService/StreamUnifiedChatWithTools` over HTTP/2 + `application/connect+proto`, and the response is decoded back into OpenAI Responses SSE deltas. Stream is forced on (Cursor only supports streaming). Tool calls, images, repository context, edit actions, and Cursor's richer agent protocol are intentionally not translated yet — only single-turn streaming text is supported.

The decoder routes Cursor's chain-of-thought (`reasoning`) bytes to `response.reasoning_summary_text.delta` events instead of leaking them into the main `response.output_text.delta` stream. For Composer/Kimi-style models that stream the entire response (CoT + answer) through a single reasoning channel, the decoder splits on the first `</think>` marker so the final answer still surfaces as plain `output_text`.

### Endpoints

| Endpoint                         | Description                                                           |
| -------------------------------- | --------------------------------------------------------------------- |
| `POST /v1/chat/completions`      | OpenAI-compatible chat                                                |
| `POST /v1/responses`             | OpenAI Responses API compatibility                                    |
| `POST /v1/images/generations`    | OpenAI-compatible image generation via Codex OAuth                    |
| `POST /v1/images/edits`          | OpenAI-compatible image edit/reference generation via Codex OAuth     |
| `POST /v1/messages`              | Claude native passthrough                                             |
| `POST /v1/messages/count_tokens` | Claude token counting                                                 |
| `GET /v1/models`                 | List available models                                                 |
| `GET /admin/accounts`            | Account health/status (API key required)                              |
| `GET /admin/stats`               | Per-client / per-account / per-API call statistics (API key required) |
| `POST /admin/reload`             | Reload tokens from disk (API key required)                            |
| `GET /health`                    | Health check                                                          |

## Docker

```bash
# Build
docker build -t auth2api .

# Run (mount your config and token directory)
docker run -d \
  -p 8317:8317 \
  -v ~/.auth2api:/data \
  -v ./config.yaml:/config/config.yaml \
  auth2api
```

Or with docker-compose:

```bash
docker-compose up -d
```

## Use with Claude Code

Set `ANTHROPIC_BASE_URL` to point Claude Code at auth2api:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8317 \
ANTHROPIC_API_KEY=<your-api-key> \
claude
```

Claude Code uses the native `/v1/messages` endpoint which auth2api passes through directly. Both `Authorization: Bearer` and `x-api-key` authentication headers are supported.

## Multi-account

auth2api supports multiple Claude OAuth accounts. Each account is stored as a separate token file in the auth directory.

- Run `--login` once per account to add tokens
- Requests are routed using sticky selection — the same account is reused until it hits a cooldown
- On rate limit or failure, auth2api automatically fails over to the next available account
- Per-account token usage (input, output, cache) is tracked and logged periodically
- Use `/admin/accounts` to inspect all account states

## Admin status

Use `/admin/accounts` with your configured API key to inspect the current account states:

```bash
curl http://127.0.0.1:8317/admin/accounts \
  -H "Authorization: Bearer <your-api-key>"
```

Response shape (one entry per logged-in provider):

```json
{
  "providers": {
    "anthropic": { "accounts": [...], "account_count": 1 },
    "codex":     { "accounts": [...], "account_count": 1 }
  },
  "generated_at": "2026-04-26T..."
}
```

Each account snapshot carries availability, cooldown, failure counters, last refresh time, request statistics, and per-account token usage including `totalReasoningOutputTokens` (reasoning models like `gpt-5.5` consume hidden reasoning tokens that aren't part of the visible output). Codex accounts also carry `planType` (e.g. `"plus"` / `"pro"` / `"free"`) extracted from the OAuth `id_token`. If a refresh token was permanently invalidated (`refresh_token_reused`/`expired`/`invalidated`), the account enters a 24-hour terminal cooldown with `lastError` set to a message pointing at `--login --provider=<provider>` for re-authorization.

### Re-authenticating without restart

Running `--login` while the server is up writes a new token file and **automatically notifies the running server** (via `POST /admin/reload`) so the new token takes effect immediately — no restart needed. This is especially important for the codex provider: OpenAI rotates the refresh token on every refresh, so leaving the server running with a stale refresh token while you re-auth would otherwise put the account into a `refresh_token_reused` terminal cooldown.

You can also trigger a reload manually (e.g. on Windows, in containers, or after a `kill -USR1` workflow) by posting to the endpoint:

```bash
curl -X POST http://127.0.0.1:8317/admin/reload \
  -H "Authorization: Bearer <your-api-key>"
```

Response shape:

```json
{
  "reloaded": {
    "anthropic": { "added": [], "updated": ["alice@…"], "unchanged": [] },
    "codex": { "added": [], "updated": [], "unchanged": ["bob@…"] }
  },
  "generated_at": "2026-04-26T..."
}
```

Reload semantics are **upsert only**: new token files on disk are added to the in-memory pool, existing accounts whose `access_token` changed are updated (and any cooldown / `lastError` is cleared, but request/usage stats are preserved), and accounts that no longer exist on disk are kept in memory until the next restart (so historical stats aren't dropped if a token file is accidentally removed).

### Call statistics: `/admin/stats`

Every request that passes API-key auth is appended as a single line to `<auth-dir>/stats.jsonl` and added to an in-memory aggregate. On startup the aggregate is rebuilt by replaying the JSONL, so the snapshot survives restarts.

`GET /admin/stats` returns three independent aggregate views plus a global `totals`:

- `byClient[apiKeyHash]` — keyed by `sha256(api-key)`; tracks requests, success / failure counts, the five token counters, total latency, and the last seen IP / User-Agent.
- `byAccount["<provider>:<email>"]` — keyed by upstream OAuth account.
- `byApi["<endpoint>|<model>|<provider>"]` — keyed by endpoint × model × provider.

```bash
curl http://127.0.0.1:8317/admin/stats \
  -H "Authorization: Bearer <your-api-key>"
```

```json
{
  "byClient": {
    "8f2a1d3c4e5f8f2a1d3c4e5f8f2a1d3c4e5f8f2a1d3c4e5f8f2a1d3c4e5f6789": {
      "apiKeyShort": "8f2a1d3c4e5f",
      "requests": 142, "successes": 140, "failures": 2,
      "totalInputTokens": 12345, "totalOutputTokens": 6789,
      "totalCacheReadInputTokens": 0, "totalLatencyMs": 286430,
      "lastIp": "127.0.0.1", "lastUa": "claude-cli/2.1.88",
      "firstSeenAt": "2026-05-09T08:00:00Z",
      "lastSeenAt":  "2026-05-09T12:00:00Z"
    }
  },
  "byAccount": {
    "anthropic:alice@example.com": { "provider": "anthropic", "email": "alice@example.com", "requests": 100, ... }
  },
  "byApi": {
    "POST /v1/chat/completions|claude-sonnet-4-6|anthropic": { "endpoint": "POST /v1/chat/completions", "model": "claude-sonnet-4-6", "provider": "anthropic", "requests": 80, ... }
  },
  "totals": { "requests": 142, "successes": 140, "failures": 2, ... },
  "generated_at": "2026-05-09T12:00:00Z"
}
```

The JSONL grows append-only; if it gets too large just stop the server and delete `stats.jsonl` to reset (the aggregate is flushed on shutdown). To disable stats entirely:

```yaml
stats:
  enabled: false
```

Failure modes of the auto-notify (printed by `--login`):

- `Notified running auth2api server to reload tokens.` — success, server picked up the new token.
- `(no auth2api server detected at <host>:<port> — token saved, will be loaded next start)` — connection refused / timeout. Common case when no server is running; not an error.
- `auth2api server is running but rejected the reload (HTTP 401/403). The api-keys in config.yaml may differ from the running server's; restart the server to pick up the new key set.` — actionable: either edit your config back to match, or restart so the server picks up the new key set.

## Tests

A test suite is included using mocked upstream responses (no real Claude service calls):

```bash
npm run test:smoke
```

## Inspired by

- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
- [sub2api](https://github.com/Wei-Shaw/sub2api)

## License

MIT
