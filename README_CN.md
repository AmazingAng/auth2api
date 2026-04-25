# auth2api

[English](./README.md)

一个轻量级的 Claude OAuth 转 API 代理，适合 Claude Code 和 OpenAI 兼容客户端。

auth2api 的定位很克制，也很明确：

- 一个或多个 Claude OAuth 账号
- 一个本地或自托管代理
- 一个目标：把 Claude OAuth 登录态变成可调用的 API

它并不试图做成多 provider 网关，也不是大型路由平台。如果你想要的是一个体积小、容易理解、方便自己改的代理，auth2api 就是为这个场景准备的。

## 功能特性

- **轻量优先** — 代码量小、依赖和运行逻辑都尽量简单
- **Claude OAuth 转 API** — 把 Claude OAuth 登录账号作为 API 代理账号使用
- **多账号支持** — 支持加载多个 OAuth token，具备粘性路由、自动故障转移和逐账号用量统计
- **OpenAI 兼容 API** — 支持 `/v1/chat/completions`、`/v1/responses`、`/v1/models`
- **Claude 原生透传** — 支持 `/v1/messages` 与 `/v1/messages/count_tokens`
- **适配 Claude Code** — 兼容 `Authorization: Bearer` 和 `x-api-key`
- **覆盖核心能力** — 支持流式、工具调用、图片与 reasoning，而不引入大型框架
- **结构化 JSON 输出** — 支持 `response_format`（Chat API）和 `text.format`（Responses API）的结构化输出
- **健康管理** — 内置逐账号的 cooldown、重试、token 刷新和 `/admin/accounts` 状态查看
- **默认安全设置** — timing-safe API key 校验、每 IP 限流、仅允许 localhost 浏览器 CORS

## 运行要求

- Node.js 20+
- 一个 Claude 账号（推荐 Claude Max）

## 安装

```bash
git clone https://github.com/AmazingAng/auth2api
cd auth2api
npm install
npm run build
```

## 登录

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

可以多次执行 `--login` 来添加更多账号，每个账号的 token 会作为独立文件存储在 auth 目录中。

## 启动服务

```bash
node dist/index.js
```

默认监听地址为 `http://127.0.0.1:8317`。首次启动时，如果 `config.yaml` 中没有配置 API key，会自动生成并写入该文件。

## 配置

复制 `config.example.yaml` 为 `config.yaml`，然后按需修改：

```yaml
host: ""          # 绑定地址，空字符串表示 127.0.0.1
port: 8317

auth-dir: "~/.auth2api"   # OAuth token 存储目录

api-keys:
  - "your-api-key-here"   # 客户端使用这个 key 访问代理

body-limit: "200mb"       # 最大 JSON 请求体大小，适合大上下文场景

timeouts:
  messages-ms: 120000         # 非流式 /v1/messages 超时
  stream-messages-ms: 600000  # 流式 /v1/messages 超时（10 分钟，适合 Claude Code 长任务）
  count-tokens-ms: 30000      # /v1/messages/count_tokens 超时

# 请求指纹 — 控制 auth2api 如何模拟 Claude Code CLI
cloaking:
  cli-version: "2.1.88"   # 模拟的 CLI 版本号
  entrypoint: "cli"        # 计费归属入口（cli、mcp、sdk 等）

debug: "off"            # off | errors | verbose
```

`debug` 支持三级日志：
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

### 支持的模型

| 模型 ID | 说明 |
|--------|------|
| `claude-opus-4-7` | Claude Opus 4.7 |
| `claude-opus-4-6` | Claude Opus 4.6 |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 |
| `claude-haiku-4-5-20251001` | Claude Haiku 4.5 |
| `claude-haiku-4-5` | Claude Haiku 4.5 的别名 |

auth2api 额外支持以下便捷别名：

- `opus` -> `claude-opus-4-7`
- `sonnet` -> `claude-sonnet-4-6`
- `haiku` -> `claude-haiku-4-5-20251001`

### 接口列表

| Endpoint | 说明 |
|----------|------|
| `POST /v1/chat/completions` | OpenAI 兼容聊天接口 |
| `POST /v1/responses` | OpenAI Responses API 兼容接口 |
| `POST /v1/messages` | Claude 原生消息透传 |
| `POST /v1/messages/count_tokens` | Claude token 计数 |
| `GET /v1/models` | 列出可用模型 |
| `GET /admin/accounts` | 查看账号健康状态（需要 API key） |
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

## 与 Claude Code 配合使用

将 `ANTHROPIC_BASE_URL` 指向 auth2api：

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8317 \
ANTHROPIC_API_KEY=<your-api-key> \
claude
```

Claude Code 使用的是原生 `/v1/messages` 接口，auth2api 会直接透传。`Authorization: Bearer` 与 `x-api-key` 两种认证头都支持。

## 多账号

auth2api 支持多个 Claude OAuth 账号，每个账号的 token 作为独立文件存储在 auth 目录中。

- 每执行一次 `--login` 可以添加一个账号的 token
- 请求使用粘性选择策略 — 同一个账号会被持续使用，直到触发 cooldown
- 当遇到限流或故障时，auth2api 会自动切换到下一个可用账号
- 逐账号追踪 token 用量（输入、输出、缓存），并定期输出日志
- 通过 `/admin/accounts` 可查看所有账号的状态

## 管理状态

通过 `/admin/accounts` 查看所有账号状态：

```bash
curl http://127.0.0.1:8317/admin/accounts \
  -H "Authorization: Bearer <your-api-key>"
```

返回内容包含逐账号的可用状态、cooldown 截止时间、失败计数、最近刷新时间、token 用量和请求统计。

## 测试

仓库内置了测试套件，使用 mocked upstream response，不会调用真实 Claude 服务：

```bash
npm run test:smoke
```

## 致谢

- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
- [sub2api](https://github.com/Wei-Shaw/sub2api)

## License

MIT
