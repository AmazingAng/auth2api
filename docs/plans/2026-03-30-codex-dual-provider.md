# Codex Dual-Provider Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend `auth2api` into a single-instance, single-port proxy that serves both Claude OAuth and Codex OAuth models via `/v1/chat/completions`, `/v1/responses`, and `/v1/models`.

**Architecture:** Introduce a provider abstraction and route requests by model name. Keep Claude on the existing proxy path, add a dedicated Codex provider that reads `~/.codex/auth.json`, and aggregate provider status/models at the server layer.

**Tech Stack:** TypeScript, Node.js, Express, local JSON auth files, mocked upstream HTTP in `node:test` + `tsx`

### Task 1: Add provider abstraction and model router

**Files:**
- Create: `src/providers/types.ts`
- Create: `src/providers/router.ts`
- Test: `tests/provider-router.test.ts`

**Step 1: Write the failing test**

Create `tests/provider-router.test.ts` covering:
- `claude-sonnet-4-6` routes to `claude`
- `gpt-5.4` routes to `codex`
- `codex-mini-latest` routes to `codex`
- unknown model returns `null` or throws a controlled routing error

**Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/provider-router.test.ts`
Expected: FAIL because router/types do not exist

**Step 3: Write minimal implementation**

Add:
- provider type definitions in `src/providers/types.ts`
- model-prefix based router in `src/providers/router.ts`

**Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/provider-router.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/types.ts src/providers/router.ts tests/provider-router.test.ts
git commit -m "feat: add provider model router"
```

### Task 2: Extract current Claude logic behind a Claude provider

**Files:**
- Create: `src/providers/claude.ts`
- Modify: `src/server.ts`
- Modify: `src/proxy/handler.ts`
- Modify: `src/proxy/responses.ts`
- Modify: `src/proxy/passthrough.ts`
- Test: `tests/smoke.test.ts`

**Step 1: Write the failing test**

Add a smoke-level assertion that `/v1/chat/completions` still works after routing through a provider object rather than direct handler imports.

**Step 2: Run test to verify it fails**

Run: `npm run test:smoke`
Expected: FAIL after temporary server wiring change or missing provider contract

**Step 3: Write minimal implementation**

Create `ClaudeProvider` as a thin wrapper around existing handler constructors and expose:
- `supportsModel`
- `listModels`
- `getStatus`
- `handleChatCompletions`
- `handleResponses`
- `handleMessages`
- `handleCountTokens`

Update `src/server.ts` to use this provider for Claude routes.

**Step 4: Run test to verify it passes**

Run: `npm run test:smoke`
Expected: PASS with all existing Claude smoke cases unchanged

**Step 5: Commit**

```bash
git add src/providers/claude.ts src/server.ts src/proxy/handler.ts src/proxy/responses.ts src/proxy/passthrough.ts tests/smoke.test.ts
git commit -m "refactor: wrap claude flow in provider abstraction"
```

### Task 3: Add Codex config and auth-file loader

**Files:**
- Modify: `src/config.ts`
- Create: `src/providers/codex-auth.ts`
- Test: `tests/codex-auth.test.ts`

**Step 1: Write the failing test**

Create `tests/codex-auth.test.ts` covering:
- parses `~/.codex/auth.json`-shaped data
- rejects missing `tokens.access_token`
- reloads when file mtime changes

**Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/codex-auth.test.ts`
Expected: FAIL because config/auth loader does not exist

**Step 3: Write minimal implementation**

Add `codex` config section:
- `enabled`
- `auth-file`
- `models`

Implement `CodexAuthStore` that:
- resolves auth path
- loads/parses JSON
- caches by mtime
- exposes `getAccessToken()` and status metadata

**Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/codex-auth.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/config.ts src/providers/codex-auth.ts tests/codex-auth.test.ts
git commit -m "feat: add codex auth file loader"
```

### Task 4: Implement Codex provider status and model listing

**Files:**
- Create: `src/providers/codex.ts`
- Modify: `src/server.ts`
- Test: `tests/codex-provider-status.test.ts`

**Step 1: Write the failing test**

Create `tests/codex-provider-status.test.ts` covering:
- configured Codex models appear in provider model list
- missing auth file marks provider unavailable
- `/v1/models` returns Claude + Codex model union
- `/admin/accounts` includes both `claude` and `codex` sections

**Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/codex-provider-status.test.ts`
Expected: FAIL because Codex provider and server aggregation do not exist

**Step 3: Write minimal implementation**

Implement:
- `CodexProvider.listModels()`
- `CodexProvider.getStatus()`
- server-side model aggregation
- provider-aware admin payload

Keep request handling stubbed or not-yet-implemented if needed, but return controlled errors.

**Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/codex-provider-status.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/codex.ts src/server.ts tests/codex-provider-status.test.ts
git commit -m "feat: expose codex status and model listing"
```

### Task 5: Implement Codex upstream client for `/v1/responses`

**Files:**
- Create: `src/providers/codex-upstream.ts`
- Create: `src/providers/codex-responses.ts`
- Modify: `src/providers/codex.ts`
- Test: `tests/codex-responses.test.ts`

**Step 1: Write the failing test**

Create `tests/codex-responses.test.ts` covering:
- `/v1/responses` with `gpt-5.4` routes to Codex upstream
- bearer token comes from mocked `auth.json`
- non-streaming response maps back to OpenAI Responses API format

**Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/codex-responses.test.ts`
Expected: FAIL because Codex request/response bridge is missing

**Step 3: Write minimal implementation**

Implement:
- upstream request helper targeting Codex responses endpoint
- minimal request translation from external Responses API to Codex upstream body
- minimal non-streaming response mapping back to OpenAI Responses object

**Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/codex-responses.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/codex-upstream.ts src/providers/codex-responses.ts src/providers/codex.ts tests/codex-responses.test.ts
git commit -m "feat: add codex responses provider path"
```

### Task 6: Add Codex streaming support for `/v1/responses`

**Files:**
- Modify: `src/providers/codex-upstream.ts`
- Modify: `src/providers/codex-responses.ts`
- Test: `tests/codex-responses-stream.test.ts`

**Step 1: Write the failing test**

Create `tests/codex-responses-stream.test.ts` covering:
- streamed upstream events are emitted as OpenAI Responses SSE
- stream closes cleanly with final done event

**Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/codex-responses-stream.test.ts`
Expected: FAIL because streaming bridge is missing

**Step 3: Write minimal implementation**

Add Codex-specific SSE parsing and event mapping. Do not reuse Claude streaming translator.

**Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/codex-responses-stream.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/codex-upstream.ts src/providers/codex-responses.ts tests/codex-responses-stream.test.ts
git commit -m "feat: add codex responses streaming bridge"
```

### Task 7: Add `/v1/chat/completions` compatibility for Codex

**Files:**
- Create: `src/providers/codex-chat.ts`
- Modify: `src/providers/codex.ts`
- Test: `tests/codex-chat.test.ts`

**Step 1: Write the failing test**

Create `tests/codex-chat.test.ts` covering:
- chat request with `gpt-5.4` routes to Codex provider
- messages are converted into Codex canonical request
- non-streaming response maps back to OpenAI chat completion

**Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/codex-chat.test.ts`
Expected: FAIL because chat compatibility layer is missing

**Step 3: Write minimal implementation**

Implement chat-to-canonical translation and canonical-to-chat response mapping using the existing Codex responses path internally.

**Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/codex-chat.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/codex-chat.ts src/providers/codex.ts tests/codex-chat.test.ts
git commit -m "feat: add codex chat completions compatibility"
```

### Task 8: Add Codex streaming support for `/v1/chat/completions`

**Files:**
- Modify: `src/providers/codex-chat.ts`
- Test: `tests/codex-chat-stream.test.ts`

**Step 1: Write the failing test**

Create `tests/codex-chat-stream.test.ts` covering:
- streamed Codex upstream events map to OpenAI chat completion SSE chunks
- final chunk ends with `[DONE]`

**Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/codex-chat-stream.test.ts`
Expected: FAIL because streaming chunk translation is missing

**Step 3: Write minimal implementation**

Implement Codex-specific streaming adapter for chat completions, reusing canonical Codex response stream where practical.

**Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/codex-chat-stream.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/codex-chat.ts tests/codex-chat-stream.test.ts
git commit -m "feat: add codex chat streaming compatibility"
```

### Task 9: Wire provider routing into the HTTP server

**Files:**
- Modify: `src/server.ts`
- Modify: `src/index.ts`
- Test: `tests/smoke.test.ts`

**Step 1: Write the failing test**

Extend `tests/smoke.test.ts` with cases showing:
- `claude-*` requests still route to Claude
- `gpt-*` requests route to Codex
- missing Codex auth file only affects Codex models

**Step 2: Run test to verify it fails**

Run: `npm run test:smoke`
Expected: FAIL because final server routing is incomplete

**Step 3: Write minimal implementation**

Finish server composition:
- instantiate Claude and Codex providers
- route `chat/completions` and `responses` by model
- keep `/v1/messages` and `/v1/messages/count_tokens` Claude-only

**Step 4: Run test to verify it passes**

Run: `npm run test:smoke`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server.ts src/index.ts tests/smoke.test.ts
git commit -m "feat: route http requests across claude and codex providers"
```

### Task 10: Final verification and docs

**Files:**
- Modify: `README.md`
- Modify: `README_CN.md`
- Test: `tests/smoke.test.ts`

**Step 1: Update docs**

Document:
- Codex auth source is `~/.codex/auth.json`
- dual-provider model routing
- Claude-only native endpoints
- new config keys

**Step 2: Run full verification**

Run:
- `npm run test:smoke`
- `npx tsc --noEmit`

Expected:
- all tests PASS
- TypeScript compile PASS

**Step 3: Review final diff**

Run: `git diff --stat main...HEAD`
Expected: only provider/config/server/docs/test changes relevant to this feature

**Step 4: Commit**

```bash
git add README.md README_CN.md
git commit -m "docs: describe dual claude and codex providers"
```
