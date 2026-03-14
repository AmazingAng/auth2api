# auth2api

A lightweight proxy that converts Claude OAuth tokens into an OpenAI-compatible API, allowing you to use Claude models with any OpenAI-compatible client or directly with Claude Code.

## Features

- **OpenAI-compatible API** — drop-in replacement for OpenAI clients (`/v1/chat/completions`, `/v1/models`)
- **Claude native passthrough** — direct `/v1/messages` and `/v1/messages/count_tokens` endpoints
- **Streaming support** — SSE streaming for both OpenAI and Claude native formats
- **Thinking/reasoning** — maps `reasoning_effort` to Claude's extended thinking
- **Tool calls** — full support for function calling, streaming and non-streaming
- **Image support** — passes image_url content to Claude's vision API
- **Single-account mode** — one Claude OAuth account with cooldown, refresh, and health tracking
- **Auto token refresh** — refreshes OAuth tokens before expiry
- **Claude Code compatible** — accepts both `Authorization: Bearer` and `x-api-key` headers
- **Security** — timing-safe API key validation, rate limiting (60 req/min per IP), localhost-only CORS

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

### Auto mode (requires local browser)

```bash
node dist/index.js --login
```

Opens a browser URL. After authorizing, the callback is handled automatically.

### Manual mode (for remote servers)

```bash
node dist/index.js --login --manual
```

Open the printed URL in your browser. After authorizing, your browser will redirect to a `localhost` URL that fails to load — copy the full URL from the address bar and paste it back into the terminal.

## Starting the server

```bash
node dist/index.js
```

The server starts on `http://127.0.0.1:8317` by default. On first run, an API key is auto-generated and saved to `config.yaml`.

## Configuration

Copy `config.example.yaml` to `config.yaml` and edit as needed:

```yaml
host: ""          # bind address, empty = 127.0.0.1
port: 8317

auth-dir: "~/.auth2api"   # where OAuth tokens are stored

api-keys:
  - "your-api-key-here"   # clients use this to authenticate

cloaking:
  mode: "auto"            # auto | always | never
  strict-mode: false
  sensitive-words: []
  cache-user-id: false

debug: false
```

## Usage

Use any OpenAI-compatible client pointed at `http://127.0.0.1:8317`:

```bash
curl http://127.0.0.1:8317/v1/chat/completions \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 1024
  }'
```

### Available models

| Model ID | Description |
|----------|-------------|
| `claude-sonnet-4-20250514` | Claude Sonnet 4 |
| `claude-opus-4-20250514` | Claude Opus 4 |
| `claude-haiku-4-20250414` | Claude Haiku 4 |
| `claude-3-5-sonnet-20241022` | Claude 3.5 Sonnet |

### Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /v1/chat/completions` | OpenAI-compatible chat |
| `POST /v1/messages` | Claude native passthrough |
| `POST /v1/messages/count_tokens` | Claude token counting |
| `GET /v1/models` | List available models |
| `GET /health` | Health check |

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

## Single-account mode

This proxy now supports exactly one Claude OAuth account at a time. Running `--login` again refreshes the stored token for the same account. If a different account is already stored, auth2api will ask you to remove the existing token first.

## License

MIT
