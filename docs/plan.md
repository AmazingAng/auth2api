# Rate Limit Utilization 提取、调度、预警与透传

## 背景

Claude API 每次响应头中返回丰富的 rate limit 信息（如 `anthropic-ratelimit-unified-5h-utilization`），但 auth2api 当前完全忽略了这些头。本方案将这些信息提取、存储、用于调度决策，并透传给下游客户端。

## 数据流

```
Claude API
  │ Response Headers
  ▼
proxyWithRetry()                    ← 中枢：提取 + 存储 + 注入
  │
  ├─→ extractRateLimitHeaders()     → RateLimitInfo
  │     │
  │     ├─→ manager.recordRateLimit()  → 存储 + 预警日志
  │     │
  │     └─→ buildDownstreamHeaders()   → x-auth2api-* headers
  │           │
  │           ├─→ success 回调（handler 注入响应头）
  │           │     ├─ 非流式：resp.setHeader() → resp.json()
  │           │     └─ 流式：resp.setHeader() → handleStreamingResponse()
  │           │
  │           └─→ 最终失败：proxyWithRetry 直接注入响应头
  │
  └─→ /admin/accounts              → rateLimit + anonymousId
```

## 一、数据结构 — `src/accounts/manager.ts`

### 1.1 新增 `RateLimitInfo` 接口

```ts
export interface RateLimitInfo {
  unifiedStatus: string;          // "allowed" | "throttled"
  fiveHourUtilization: number;    // 0.0 ~ 1.0
  fiveHourStatus: string;
  fiveHourReset: number;          // unix timestamp
  sevenDayUtilization: number;
  sevenDayStatus: string;
  sevenDayReset: number;
  overageUtilization: number;
  overageStatus: string;
  representativeClaim: string;    // "five_hour" | "seven_day"
  updatedAt: string;              // ISO 8601
}
```

### 1.2 `AccountState` 新增字段

```ts
rateLimit: RateLimitInfo | null   // 初始 null
```

### 1.3 `AccountSnapshot` 新增字段

```ts
rateLimit: RateLimitInfo | null
anonymousId: string               // "account-1", "account-2", ...
```

> `anonymousId` 基于 email 的 SHA-256 前 8 位 hex 生成，增删账号不影响已有 ID 的稳定性。

## 二、提取与构建函数 — `src/upstream/ratelimit.ts`（新建）

独立文件，避免在 `anthropic-api.ts` 里混入下游逻辑。

### 2.1 `extractRateLimitHeaders(resp: Response): RateLimitInfo | null`

从 `Response.headers` 中读取 `anthropic-ratelimit-unified-*` 系列头，解析为 `RateLimitInfo`。如果 `anthropic-ratelimit-unified-status` 不存在则返回 `null`。

### 2.2 `buildDownstreamRateLimitHeaders(upstream: Response, anonymousId: string): Record<string, string>`

直接透传上游所有 `anthropic-ratelimit-` 开头的 headers（原名不变），额外附加 auth2api 自有 header：

- 遍历 upstream response headers，将所有 `anthropic-ratelimit-` 前缀的 header 原样放入结果（前缀匹配，不硬编码白名单）
- 附加 `x-auth2api-account: <anonymousId>`

透传的 headers 包括但不限于：

**Unified 系列**（用于 utilization 调度）：
- `anthropic-ratelimit-unified-status`
- `anthropic-ratelimit-unified-5h-utilization`
- `anthropic-ratelimit-unified-5h-status`
- `anthropic-ratelimit-unified-5h-reset`
- `anthropic-ratelimit-unified-7d-utilization`
- `anthropic-ratelimit-unified-7d-status`
- `anthropic-ratelimit-unified-7d-reset`
- `anthropic-ratelimit-unified-overage-utilization`
- `anthropic-ratelimit-unified-overage-status`
- `anthropic-ratelimit-unified-representative-claim`
- `anthropic-ratelimit-unified-reset`

**非 Unified 系列**（auth2api-router 的 `header_filter.lua` 依赖）：
- `anthropic-ratelimit-requests-remaining`
- `anthropic-ratelimit-requests-limit`
- `anthropic-ratelimit-tokens-remaining`
- `anthropic-ratelimit-tokens-limit`
- 以及 Anthropic 未来可能新增的其他 `anthropic-ratelimit-*` headers

> 使用前缀匹配而非显式白名单，确保 Anthropic 新增 header 时无需改代码。

### 2.3 `getEffectiveUtilization(rl: RateLimitInfo | null): number`

```ts
export function getEffectiveUtilization(rl: RateLimitInfo | null): number {
  if (!rl) return 0;
  return Math.max(rl.fiveHourUtilization, rl.sevenDayUtilization);
}
```

> 取 `Math.max` 而非只看 `representativeClaim`，避免某一维度压力被忽略（如 5h=0.3 但 7d=0.95 时仅看 5h 会误判为空闲）。`representativeClaim` 仅用于预警日志中的描述。

## 三、AccountManager 改动 — `src/accounts/manager.ts`

### 3.1 `getAnonymousId(email: string): string`

基于 email 的稳定 hash，取 SHA-256 前 8 位 hex，返回 `account-<hash>`（如 `account-a3f1b2c4`）。不依赖数组索引，增删账号不影响已有 ID。

### 3.2 `recordRateLimit(email: string, info: RateLimitInfo): void`

- 更新 `AccountState.rateLimit`
- 预警逻辑（基于 `getEffectiveUtilization` 返回值）：
  - `>= 0.8` → `console.warn` 黄色预警
  - `>= 0.95` → `console.error` 红色预警
  - `unifiedStatus === "throttled"` → `console.error` 告警

### 3.3 `getNextAccount()` 调度改造

现有逻辑：sticky 粘性 + round-robin + cooldown 退避。

新逻辑（**cooldown 优先级不变，utilization 仅影响选择偏好**）：

1. **Sticky 检查**：当前 sticky 账号可用（不在 cooldown 中）且 `getEffectiveUtilization() < 0.8` → 继续使用
2. **Sticky 失效**（过期 / cooldown / utilization >= 0.8）→ 在所有不在 cooldown 的账号中选 utilization 最低的
3. **无 rateLimit 数据**（刚启动）→ 退回现有 round-robin 逻辑
4. **所有可用账号都 >= 0.8** → 选 utilization 最低的（仍然得发）
5. **所有账号都在 cooldown** → 保持现有 fallback 逻辑不变（找最可恢复的）

关键原则：**cooldown > utilization**。一个账号即使 utilization 很低，如果在 cooldown 中也必须跳过。

### 3.4 `getSnapshots()` 扩展

输出中增加 `rateLimit` 和 `anonymousId` 字段。

## 四、核心改动 — `src/utils/http.ts`

`proxyWithRetry()` 是所有请求的中枢，rate limit 提取和存储集中在此处。

### 4.1 `ProxyOptions` 接口扩展

```ts
export interface ProxyOptions {
  upstream: (account: AvailableAccount) => Promise<Response>;
  success: (
    upstream: Response,
    account: AvailableAccount,
    rateLimitHeaders: Record<string, string>,  // 新增
  ) => Promise<void>;
  maxRetries?: number;
}
```

`success` 回调新增第三个参数 `rateLimitHeaders`，handler 负责在 `resp.json()` 或 `handleStreamingResponse()` 之前调用 `resp.setHeader()` 注入。

### 4.2 `proxyWithRetry()` 内部改动

```ts
// 在拿到 upstream Response 后、判断 upstream.ok 之前：
const rlInfo = extractRateLimitHeaders(upstream);
if (rlInfo) {
  manager.recordRateLimit(account.token.email, rlInfo);
}
const anonymousId = manager.getAnonymousId(account.token.email);
const rlHeaders = buildDownstreamRateLimitHeaders(upstream, anonymousId);

if (upstream.ok) {
  await options.success(upstream, account, rlHeaders);  // 传给 handler
  return;
}

// ... 现有失败处理逻辑 ...

// 最终失败时也注入 rlHeaders：
for (const [k, v] of Object.entries(rlHeaders)) {
  resp.setHeader(k, v);
}
resp.status(lastStatus).json(...);
```

注意三种场景的处理：

| 场景 | 提取 | recordRateLimit | 透传 |
|---|---|---|---|
| 成功（`upstream.ok`） | ✅ | ✅ | ✅ 由 handler 在 success 回调中注入 |
| 失败但重试 | ✅ | ✅ | ❌ 下游还没收到响应，不需要透传 |
| 最终失败（循环结束） | ✅ 用最后一次的 | ✅ | ✅ 由 proxyWithRetry 直接注入 |
| 网络异常（fetch 抛错） | ❌ 无 Response 对象 | ❌ | ❌ |

## 五、Handler 改动

两个 handler 文件的改动模式相同：在 `success` 回调中接收 `rateLimitHeaders` 并注入。

### 5.1 `src/handlers/anthropic.ts`

**`createMessagesHandler`**：
```ts
success: async (upstream, account, rateLimitHeaders) => {
  for (const [k, v] of Object.entries(rateLimitHeaders)) {
    resp.setHeader(k, v);
  }
  if (stream) {
    // setHeader 在 flushHeaders 之前，headers 会被一起发出
    const result = await handleStreamingResponse(upstream, resp);
    // ...
  } else {
    const anthropicResp = await upstream.json();
    // ...
    resp.json(anthropicResp);
  }
}
```

**`createCountTokensHandler`**：同上（仅非流式）。

### 5.2 `src/handlers/openai.ts`

**`createChatCompletionsHandler`** 和 **`createResponsesHandler`**：同上模式。

> 关键：`resp.setHeader()` 必须在 `resp.json()` 和 `handleStreamingResponse()` 之前调用。`handleStreamingResponse()` 内部调用 `resp.flushHeaders()` 时会把之前设置的所有 headers 一起发出，无需修改 `streaming.ts`。

## 六、改动文件清单

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `src/accounts/manager.ts` | 修改 | 新增 `RateLimitInfo` 类型、`AccountState.rateLimit` 字段、`recordRateLimit()`、`getAnonymousId()`、调度逻辑改造、`getSnapshots()` 扩展 |
| `src/upstream/ratelimit.ts` | **新建** | `extractRateLimitHeaders()` + `buildDownstreamRateLimitHeaders()` + `getEffectiveUtilization()` |
| `src/utils/http.ts` | 修改 | `ProxyOptions.success` 签名扩展、`proxyWithRetry()` 内提取/存储/注入 rate limit |
| `src/handlers/anthropic.ts` | 修改 | success 回调适配新签名，注入下游 headers |
| `src/handlers/openai.ts` | 修改 | 同上 |

不新增依赖，不需要配置变更。

## 七、与 auth2api-router 的兼容性

auth2api-router（OpenResty 网关层）通过两条路径获取 rate limit 数据：

### 7.1 响应头透传（`header_filter.lua`）

Router 的 `header_filter.lua` 从上游响应中读取以下 headers，存入 `backend_state` 共享内存：

| Header | Router 存储键 | 用途 |
|---|---|---|
| `anthropic-ratelimit-unified-5h-utilization` | `util_5h:<idx>` | 路由决策：>= 0.95 排除 backend |
| `anthropic-ratelimit-unified-7d-utilization` | `util_7d:<idx>` | backend_score 计算 |
| `anthropic-ratelimit-requests-remaining` | `req_remaining:<idx>` | 路由决策：<= 0 排除 backend |
| `anthropic-ratelimit-tokens-remaining` | `tok_remaining:<idx>` | admin 展示 |
| `anthropic-ratelimit-requests-limit` | `req_limit:<idx>` | admin 展示 |
| `anthropic-ratelimit-tokens-limit` | `tok_limit:<idx>` | admin 展示 |
| `anthropic-ratelimit-unified-reset` | `util_reset:<idx>` | admin 展示 |

本方案通过前缀匹配透传所有 `anthropic-ratelimit-*` headers，完全覆盖 router 需求。

### 7.2 健康检查轮询（`health_ext.lua`）

Router 定时轮询 auth2api 的 `/admin/accounts` 端点，当前读取 `accounts[].available` 判断是否所有账号都在 cooldown。本方案在 snapshot 中新增 `rateLimit` 和 `anonymousId` 字段，向后兼容（仅新增字段），router 可后续利用 per-account 的 rateLimit 做更精细的判断。

### 7.3 多账号轮转下的 utilization 闪烁

auth2api 一个实例可能有多个账号。每次请求可能使用不同账号，返回该账号对应的 utilization。Router 以 backend 粒度存储，会看到值在不同账号之间跳动。

缓解措施：
- auth2api 内部的 utilization-aware 调度（第三节）会优先使用低 utilization 的账号，使大部分响应返回的 utilization 趋于一致
- `x-auth2api-account` header 已透传，router 未来可据此做 per-account 追踪

## 八、其他注意事项

1. **Nginx header 透传**：当前 `nginx.conf` 未配置 `proxy_hide_header`，默认透传所有上游 headers。`x-auth2api-account` 作为非标准 header 也会自动透传，无需额外配置。
2. **CORS**：当前仅 CLI 使用，暂不需要。如有浏览器客户端需在 `server.ts` 添加 `Access-Control-Expose-Headers`。
3. **测试**：`extractRateLimitHeaders` 应有单元测试覆盖正常解析、缺失 header、部分缺失等场景。
