# auth2api

[English](./README.md)

一个轻量级的双 provider API 代理，适合 Claude Code 和 OpenAI 兼容客户端。

auth2api 的定位很克制，也很明确：

- 最多一个 Claude OAuth 账号
- 一个直接复用 `~/.codex/auth.json` 的本地 Codex 登录态
- 一个本地或自托管代理
- 一个目标：把本地 Claude/Codex 登录态变成可调用的 API

它依然不打算做成多账号池，也不是大型路由平台。如果你想要的是一个体积小、容易理解、方便自己改的代理，auth2api 就是为这个场景准备的。

## 功能特性

- **轻量优先**：代码量小、单账号架构、依赖和运行逻辑都尽量简单
- **Claude + Codex**：一个进程同时服务 Claude OAuth 和本地 Codex 登录态
- **OpenAI 兼容 API**：支持 `/v1/chat/completions`、`/v1/responses`、`/v1/models`
- **按模型自动路由**：`claude-*` 走 Claude，`gpt-*` / `o*` / `codex-*` 走 Codex
- **Claude 原生透传**：支持 `/v1/messages` 与 `/v1/messages/count_tokens`
- **适配 Claude Code**：兼容 `Authorization: Bearer` 和 `x-api-key`
- **覆盖核心能力**：支持流式、工具调用、图片与 reasoning，而不引入大型框架
- **Provider 级状态查看**：`/admin/accounts` 同时暴露 Claude 和 Codex 的可用状态
- **默认安全设置**：timing-safe API key 校验、每 IP 限流、仅允许 localhost 浏览器 CORS

## 运行要求

- Node.js 20+
- 如果要用 Claude 模型，需要一个 Claude 账号（推荐 Claude Max）
- 如果要用 Codex 模型，需要本机已有 Codex 登录态（`~/.codex/auth.json`）

## 安装

```bash
git clone https://github.com/AmazingAng/auth2api
cd auth2api
npm install
npm run build
```

## 快速开始

1. 复制 `config.example.yaml` 为 `config.yaml`。
2. 在 `api-keys` 里至少配置一个 API key。
3. 选择一个或两个 provider：
   - 只用 Codex：确保本机已经有 `~/.codex/auth.json`，然后配置 `codex.models`。
   - 使用 Claude：先执行一次 `node dist/index.js --login`。
4. 执行 `node dist/index.js` 启动服务。

如果你一开始只启用了 Codex，那么像 `/v1/messages` 这类 Claude 原生接口在完成 Claude 登录前仍然不可用。

## 登录

Claude 模型仍然使用 auth2api 内置的 OAuth 登录流程。Codex 模型没有单独的登录流程，auth2api 直接复用本机 `~/.codex/auth.json`。

### 自动模式（需要本地浏览器）

```bash
node dist/index.js --login
```

程序会输出一个浏览器 URL。完成授权后，回调会自动处理。

### 手动模式（适合远程服务器）

```bash
node dist/index.js --login --manual
```

在浏览器中打开输出的链接。授权完成后，浏览器会跳转到一个 `localhost` 地址，这个页面可能无法打开；请把地址栏中的完整 URL 复制回终端。

## 启动服务

```bash
node dist/index.js
```

默认监听地址为 `http://127.0.0.1:8317`。首次启动时，如果 `config.yaml` 中没有配置 API key，会自动生成并写入该文件。

只要任一 provider 可用，进程就可以启动：

- Claude 可用：先执行 `node dist/index.js --login`
- Codex 可用：本机已有 `~/.codex/auth.json`

如果 Claude token 不存在，且 Codex 配置或认证也不可用，auth2api 会在启动时直接退出，而不是带着错误配置继续提供服务。

如果上游因为限流导致当前账号进入 cooldown，auth2api 会返回 `429 Rate limited on the configured account`，而不是通用的 `503`。

## 配置

复制 `config.example.yaml` 为 `config.yaml`，然后按需修改：

```yaml
host: ""          # 绑定地址，空字符串表示 127.0.0.1
port: 8317

auth-dir: "~/.auth2api"   # Claude OAuth token 存储目录

api-keys:
  - "your-api-key-here"   # 客户端使用这个 key 访问代理

body-limit: "200mb"       # 最大 JSON 请求体大小，适合大上下文场景

cloaking:
  mode: "auto"            # auto | always | never
  strict-mode: false
  sensitive-words: []
  cache-user-id: false

debug: "off"            # off | errors | verbose
```

如果你要跑较长的 Claude Code 任务，也可以单独配置上游超时：

```yaml
timeouts:
  messages-ms: 120000
  stream-messages-ms: 600000
  count-tokens-ms: 30000

codex:
  enabled: true
  auth-file: "~/.codex/auth.json"
  models:
    - "gpt-5.4"
    - "o3"
    - "codex-mini-latest"
```

默认情况下，流式上游请求会允许持续 10 分钟后才会被 auth2api 主动中断。

默认请求体大小限制现在是 `200mb`，比之前固定的 `20mb` 更适合 Claude Code 的大上下文使用场景。

`/v1/models` 里的 Codex 模型来自 `codex.models` 配置；Claude 模型则是内置列表。

几个关键语义：

- `codex.enabled: false` 会彻底关闭 Codex 路由。
- `codex.models` 既决定 `/v1/models` 的输出，也决定运行时允许访问的 Codex 模型白名单。
- 如果请求的是 `gpt-*`、`o*`、`codex-*`，但模型不在 `codex.models` 里，会直接返回 `400 Unsupported model`。

`debug` 现在支持三级日志：
- `off`：不输出额外调试日志
- `errors`：记录上游/网络失败信息和上游错误响应正文
- `verbose`：在 `errors` 基础上，再输出每个请求的方法、路径、状态码和耗时

## 使用方法

将任意 OpenAI 兼容客户端指向 `http://127.0.0.1:8317`：

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

`/v1/chat/completions` 和 `/v1/responses` 会按 `model` 自动分流：

- `claude-*` -> Claude provider
- `gpt-*`、`o*`、`codex-*` -> Codex provider

不支持或未被允许的模型会返回 `400 Unsupported model`。

Codex 请求示例：

```bash
curl http://127.0.0.1:8317/v1/chat/completions \
  -H "Authorization: Bearer <your-api-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4",
    "messages": [{"role": "user", "content": "Summarize this repo."}],
    "stream": false
  }'
```

### 支持的模型

auth2api 内置的 Claude 模型：

| 模型 ID | 说明 |
|--------|------|
| `claude-opus-4-6` | Claude Opus 4.6 |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 |
| `claude-haiku-4-5-20251001` | Claude Haiku 4.5 |
| `claude-haiku-4-5` | Claude Haiku 4.5 的别名 |

auth2api 额外支持以下便捷别名：

- `opus` -> `claude-opus-4-6`
- `sonnet` -> `claude-sonnet-4-6`
- `haiku` -> `claude-haiku-4-5-20251001`

Codex 模型通过 `config.yaml` 里的 `codex.models` 显式配置；只有列在其中的模型才会由 `/v1/models` 返回并在运行时被接受。

### 接口列表

| Endpoint | 说明 |
|----------|------|
| `POST /v1/chat/completions` | OpenAI 兼容聊天接口，按模型自动路由 |
| `POST /v1/responses` | OpenAI Responses API 兼容接口，按模型自动路由 |
| `POST /v1/messages` | Claude 原生消息透传，仅 Claude |
| `POST /v1/messages/count_tokens` | Claude token 计数，仅 Claude |
| `GET /v1/models` | 列出可用模型 |
| `GET /admin/accounts` | 查看 Claude + Codex provider 状态（需要 API key） |
| `GET /health` | 健康检查 |

## Docker

```bash
# 构建
docker build -t auth2api .

# 运行（挂载配置文件与 token 目录）
docker run -d \
  -p 8317:8317 \
  -v ~/.auth2api:/data \
  -v ./config.yaml:/config/config.yaml \
  auth2api
```

或者使用 docker-compose：

```bash
docker-compose up -d
```

容器使用注意：

- 如果你希望 Claude 登录态持久化，建议在 `config.yaml` 里把 `auth-dir` 设成 `"/data"`。
- 如果你要在 Docker 里使用 Codex，需要把宿主机的 auth 文件挂载到容器内与 `codex.auth-file` 一致的路径，例如 `-v ~/.codex/auth.json:/root/.codex/auth.json:ro`。
- 如果你改了容器内路径，记得同步修改 `codex.auth-file`。

## 与 Claude Code 配合使用

将 `ANTHROPIC_BASE_URL` 指向 auth2api：

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8317 \
ANTHROPIC_API_KEY=<your-api-key> \
claude
```

Claude Code 使用的是原生 `/v1/messages` 接口，auth2api 会直接透传。`Authorization: Bearer` 与 `x-api-key` 两种认证头都支持。

## 单账号模式

Claude token 存储仍然保持单账号模式：

- 再次执行 `--login` 时，如果还是同一个账号，会更新已保存的 token
- 如果本地已保存的是另一个账号，auth2api 会拒绝覆盖，并要求你先删除旧 token
- 如果 token 目录中存在多个 token 文件，auth2api 会直接报错并退出，直到你清理多余文件

Codex 认证是独立的：auth2api 只读取本机 `~/.codex/auth.json`，不负责 Codex 登录管理。

## 管理状态

你可以通过 `/admin/accounts` 查看当前账号状态：

```bash
curl http://127.0.0.1:8317/admin/accounts \
  -H "Authorization: Bearer <your-api-key>"
```

返回内容包含旧版 Claude 账号快照，以及拆开的 `claude`、`codex` provider 状态，便于分别判断哪一侧不可用。

常用字段：

- `claude.available`：当前 Claude 账号是否可用
- `codex.available`：Codex 认证和模型配置是否可用
- `codex.details.error`：Codex 当前不可用的具体原因，例如认证文件缺失或模型配置为空

## Smoke 测试

仓库内置了一套最小自动化 smoke test，并使用 mocked upstream response，因此不会调用真实 Claude 或 Codex 服务：

```bash
npm run test:smoke
```

## 致谢

- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
- [sub2api](https://github.com/Wei-Shaw/sub2api)

## License

MIT
