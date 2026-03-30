# Codex Dual-Provider Design

## Goal

将 `auth2api` 从“单 Claude OAuth 账号代理”扩展为“单实例、单端口、双 provider 代理”，同时向本机脚本暴露：

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `GET /v1/models`

其中：

- `claude-*` 模型走现有 Claude OAuth 链路
- `gpt-*`、`o*`、`codex-*` 模型走本机 `~/.codex/auth.json` 对应的 Codex OAuth 链路

## Non-Goals

- 不新增 Codex 登录流程
- 不优先兼容所有第三方 SDK 的边角行为
- 不默认把服务暴露到局域网，仍保持 `127.0.0.1`
- 不把 Claude 与 Codex 的上游协议强行统一成同一套内部格式

## Chosen Approach

采用 “单 HTTP 层 + provider 抽象 + 按模型自动路由” 的结构。

保留现有服务入口和大部分 Claude 逻辑，但把具体上游调用封装到 provider 层。HTTP 层只关心两件事：

1. 当前请求属于哪个 provider
2. 该 provider 如何处理 `chat/completions`、`responses`、`models`、`status`

Codex 侧使用 `responses` 作为内部主语义，因为它更接近 Codex 上游形态。`chat/completions` 只是兼容层，先转换成 provider 内部请求，再复用同一条 Codex 主链。

## High-Level Architecture

### 1. HTTP Layer

现有 [src/server.ts](/Users/wy/auth2api/.worktrees/feature-codex-dual-provider/src/server.ts) 继续保留：

- API key 鉴权
- 限流
- CORS
- 路由注册

但不再直接把路由绑死到 Claude handler，而是注入一个 `ProviderRouter`。

### 2. Provider Layer

新增 provider 抽象：

- `ClaudeProvider`
- `CodexProvider`
- `ProviderRouter`

统一接口建议包含：

- `supportsModel(model: string): boolean`
- `listModels(): ProviderModel[]`
- `getStatus(): ProviderStatus`
- `handleChatCompletions(req, res): Promise<void>`
- `handleResponses(req, res): Promise<void>`

Claude provider 主要是对现有代码做封装，不改变其上游行为。

Codex provider 负责：

- 读取 `~/.codex/auth.json`
- 将外部请求转换为 Codex 上游请求
- 调用 Codex 上游
- 将结果映射回 OpenAI 风格接口

### 3. Auth / Session Layer

Claude 继续使用现有 [src/accounts/manager.ts](/Users/wy/auth2api/.worktrees/feature-codex-dual-provider/src/accounts/manager.ts)。

Codex 新增 `CodexAuthStore` / `CodexSessionManager`：

- 只读 `~/.codex/auth.json`
- 读取字段：
  - `auth_mode`
  - `tokens.access_token`
  - `tokens.refresh_token`
  - `tokens.account_id`
  - `last_refresh`
- 以文件 `mtime` 作为热重载依据
- 不自行做 OAuth login
- 第一版不主动实现 refresh 流程，只在请求前取最新文件内容

## Request Flow

### Chat Completions

1. 客户端请求 `/v1/chat/completions`
2. `server.ts` 完成 API key 校验
3. `ProviderRouter` 根据 `model` 选择 Claude 或 Codex
4. Claude:
   - 走现有 `openai -> claude messages -> claude response -> openai` 链路
5. Codex:
   - `chat/completions` 请求先转换为 Codex 内部 canonical request
   - 复用 Codex `responses` 主链
   - 输出 OpenAI chat completion 格式

### Responses

1. 客户端请求 `/v1/responses`
2. `ProviderRouter` 根据 `model` 选择 provider
3. Claude:
   - 继续走现有 [src/proxy/responses.ts](/Users/wy/auth2api/.worktrees/feature-codex-dual-provider/src/proxy/responses.ts) 思路
4. Codex:
   - 直接按 `responses` 语义构造上游请求
   - 普通响应和流式响应分别映射回 OpenAI Responses API 格式

### Models

`/v1/models` 改为 provider 聚合：

- Claude 模型：保留现有列表
- Codex 模型：第一版使用配置或静态白名单
- 对外返回两者并集

### Admin

`/admin/accounts` 升级为 provider 视角状态：

- `claude`: 当前账户、冷却、刷新、统计
- `codex`: `auth.json` 是否存在、最后加载时间、最近错误、是否可用

## Codex-Specific Design

### Upstream

根据当前本机信息，Codex 上游目标应抽象为：

- `https://chatgpt.com/backend-api/codex/responses`

该地址与头部要求可能变化，因此应集中在单独模块，例如：

- `src/providers/codex/upstream.ts`

避免在 HTTP 层、转换层和状态层散落硬编码。

### Token Handling

Codex provider 的第一版策略：

1. 启动时读取 `~/.codex/auth.json`
2. 每次请求前检查文件 `mtime`
3. 若文件变化则重新加载
4. 若上游返回 `401`
   - 强制重读一次 `auth.json`
   - 仅重试一次
5. 仍失败则把 provider 状态标记为 `unavailable`

这保证了用户重新执行 `codex login` 后，代理可自动恢复，而不用重启进程。

### Streaming

Codex 流式返回格式与 Claude SSE 可能不同，因此必须单独实现：

- `Codex responses stream -> OpenAI responses SSE`
- `Codex responses stream -> OpenAI chat completion SSE`

不要复用 Claude 的 `claudeStreamEventToOpenai(...)`。

## Config Changes

建议在 [src/config.ts](/Users/wy/auth2api/.worktrees/feature-codex-dual-provider/src/config.ts) 中新增：

```yaml
codex:
  enabled: true
  auth-file: "~/.codex/auth.json"
  models:
    - "gpt-5.4"
    - "gpt-5.4-mini"
    - "codex-mini-latest"
```

说明：

- `enabled` 控制是否启用 Codex provider
- `auth-file` 允许未来从非默认位置读取
- `models` 先走白名单，避免动态探测带来的不确定性

## Error Handling

### Claude

保持现有行为：

- 网络错误重试
- 429/5xx 冷却
- 401 refresh token 后重试

### Codex

第一版错误处理策略：

- `auth.json` 缺失或字段不完整：provider 不可用，但 Claude 正常工作
- 401：重载 auth 文件并重试一次
- 429：返回明确的 rate limit 错误
- 5xx / 网络错误：短重试后返回 upstream error

关键原则：

- Claude provider 故障不影响 Codex provider
- Codex provider 故障不影响 Claude provider

## Testing Strategy

### Unit

- model 路由
- `auth.json` 解析
- chat -> codex canonical request 转换
- responses -> codex canonical request 转换
- codex response -> openai response/chat 映射

### Integration

- mock Codex 上游普通响应
- mock Codex 上游流式响应
- 验证 `/v1/models` 聚合
- 验证 `/admin/accounts` provider 状态

### Regression

- 保证现有 Claude smoke tests 全部通过
- 追加 Codex smoke case，不破坏已有行为

## Implementation Order

1. 引入 provider 抽象与模型路由
2. 把现有 Claude 逻辑封装成 Claude provider
3. 接入 Codex auth store 与 provider status
4. 先实现 Codex `/v1/responses`
5. 再实现 Codex `/v1/chat/completions`
6. 最后补 `/v1/models`、`/admin/accounts`、测试与文档
