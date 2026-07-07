import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { AddressInfo } from "node:net";
import { createServer as createHttpServer } from "node:http";

import { AccountManager } from "../src/accounts/manager";
import { Config, loadConfig } from "../src/config";
import { createServer } from "../src/server";
import { saveToken } from "../src/auth/token-storage";
import { TokenData } from "../src/auth/types";
import { buildRegistry, ProviderRegistry } from "../src/providers/registry";
import { refreshTokensWithRetry } from "../src/auth/oauth";

const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";

function makeConfig(authDir: string): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    "auth-dir": authDir,
    "api-keys": new Set(["test-key"]),
    "body-limit": "200mb",
    cloaking: {
      "cli-version": "2.1.88",
      entrypoint: "cli",
    },
    timeouts: {
      "messages-ms": 120000,
      "stream-messages-ms": 600000,
      "count-tokens-ms": 30000,
    },
    debug: "off",
  };
}

function makeToken(overrides: Partial<TokenData> = {}): TokenData {
  return {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    email: "test@example.com",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    accountUuid: "test-uuid",
    provider: "anthropic",
    ...overrides,
  };
}

function makeManager(authDir: string, tokens: TokenData[]): AccountManager {
  for (const token of tokens) {
    saveToken(authDir, token);
  }
  const manager = new AccountManager(authDir, {
    provider: "anthropic",
    refresh: refreshTokensWithRetry,
  });
  manager.load();
  return manager;
}

function makeRegistry(
  authDir: string,
  manager: AccountManager,
): ProviderRegistry {
  // Build the real registry, then swap the anthropic manager for the test one
  // so the existing tests can introspect/control it.
  const registry = buildRegistry(authDir);
  const anthropic = registry.get("anthropic");
  // Replace the manager with the pre-populated test instance.
  (anthropic as { manager: AccountManager }).manager = manager;
  return registry;
}

async function startApp(
  config: Config,
  manager: AccountManager,
): Promise<http.Server> {
  const registry = makeRegistry(config["auth-dir"], manager);
  const app = createServer(config, registry);
  const server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

async function startAppWithLoadedRegistry(
  config: Config,
): Promise<http.Server> {
  const registry = buildRegistry(config["auth-dir"]);
  for (const provider of registry.all()) provider.manager.load();
  const app = createServer(config, registry);
  const server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

async function stopApp(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function requestJson(options: {
  server: http.Server;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  const address = serverAddress(options.server);
  const payload = options.body ? JSON.stringify(options.body) : undefined;

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: address.port,
        method: options.method,
        path: options.path,
        headers: {
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload).toString(),
              }
            : {}),
          ...(options.headers || {}),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode || 0,
            body: data ? JSON.parse(data) : null,
            headers: res.headers,
          });
        });
      },
    );

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function requestText(options: {
  server: http.Server;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<{
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  const address = serverAddress(options.server);
  const payload = options.body ? JSON.stringify(options.body) : undefined;

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: address.port,
        method: options.method,
        path: options.path,
        headers: {
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload).toString(),
              }
            : {}),
          ...(options.headers || {}),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode || 0,
            body: data,
            headers: res.headers,
          });
        });
      },
    );

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function serverAddress(server: http.Server): AddressInfo {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Server is not listening on a TCP port");
  }
  return address;
}

function withMockedFetch(
  mock: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
): () => void {
  const originalFetch = global.fetch;
  global.fetch = mock as typeof fetch;
  return () => {
    global.fetch = originalFetch;
  };
}

function encodeVarintBuf(value: number): Buffer {
  const out: number[] = [];
  let n = value >>> 0;
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
}

function encodeBytesField(field: number, payload: Buffer): Buffer {
  const tag = encodeVarintBuf((field << 3) | 2);
  const len = encodeVarintBuf(payload.length);
  return Buffer.concat([tag, len, payload]);
}

function connectProtoTextFrame(text: string): Uint8Array {
  const inner = encodeBytesField(1, Buffer.from(text, "utf8"));
  const outer = encodeBytesField(2, inner);
  const frame = Buffer.alloc(5 + outer.length);
  frame[0] = 0;
  frame.writeUInt32BE(outer.length, 1);
  outer.copy(frame, 5);
  return frame;
}

test("accepts x-api-key auth and serves models/admin state", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [makeToken()]);
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const modelsResp = await requestJson({
    server,
    method: "GET",
    path: "/v1/models",
    headers: { "x-api-key": "test-key" },
  });

  assert.equal(modelsResp.status, 200);
  assert.ok(Array.isArray(modelsResp.body.data));
  assert.ok(modelsResp.body.data.length > 0);
  const modelIds = new Set(modelsResp.body.data.map((m: any) => m.id));
  assert.ok(modelIds.has("claude-sonnet-5"));
  assert.ok(modelIds.has("claude-fable-5"));
  assert.ok(modelIds.has("claude-mythos-preview"));

  const adminResp = await requestJson({
    server,
    method: "GET",
    path: "/admin/accounts",
    headers: { "x-api-key": "test-key" },
  });

  assert.equal(adminResp.status, 200);
  assert.equal(adminResp.body.providers.anthropic.account_count, 1);
  assert.equal(
    adminResp.body.providers.anthropic.accounts[0].email,
    "test@example.com",
  );
  assert.equal(adminResp.body.providers.codex.account_count, 0);
});

test("proxies a non-stream chat completion through Claude OAuth token", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    assert.equal(url, "https://api.anthropic.com/v1/messages?beta=true");
    assert.equal(init?.method, "POST");
    assert.equal(
      init?.headers && (init.headers as Record<string, string>).Authorization,
      "Bearer access-token",
    );

    return new Response(
      JSON.stringify({
        id: "msg_1",
        content: [{ type: "text", text: "hello from claude" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 12, output_tokens: 5 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    },
  });

  assert.equal(resp.status, 200);
  assert.equal(resp.body.object, "chat.completion");
  assert.equal(resp.body.choices[0].message.content, "hello from claude");
  assert.equal(resp.body.usage.total_tokens, 17);
});

test("refreshes the OAuth token after an upstream 401 and retries successfully", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [makeToken()]);
  const calls: string[] = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    calls.push(url);

    if (url === "https://api.anthropic.com/v1/messages?beta=true") {
      const authHeader = (init?.headers as Record<string, string>)
        .Authorization;
      if (authHeader === "Bearer access-token") {
        return new Response("unauthorized", { status: 401 });
      }
      if (authHeader === "Bearer refreshed-access-token") {
        return new Response(
          JSON.stringify({
            id: "msg_after_refresh",
            content: [{ type: "text", text: "refreshed ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 3, output_tokens: 2 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    if (url === TOKEN_URL) {
      return new Response(
        JSON.stringify({
          access_token: "refreshed-access-token",
          refresh_token: "refreshed-refresh-token",
          expires_in: 3600,
          account: { email_address: "test@example.com" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    throw new Error(`Unexpected fetch to ${url}`);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "refresh me" }],
      stream: false,
    },
  });

  assert.equal(resp.status, 200);
  assert.equal(resp.body.choices[0].message.content, "refreshed ok");
  assert.deepEqual(calls, [
    "https://api.anthropic.com/v1/messages?beta=true",
    TOKEN_URL,
    "https://api.anthropic.com/v1/messages?beta=true",
  ]);

  const adminResp = await requestJson({
    server,
    method: "GET",
    path: "/admin/accounts",
    headers: { Authorization: "Bearer test-key" },
  });

  assert.equal(adminResp.status, 200);
  const anthAccounts = adminResp.body.providers.anthropic.accounts;
  assert.equal(anthAccounts[0].lastRefreshAt !== null, true);
  assert.equal(anthAccounts[0].totalSuccesses, 1);
});

test("does not double-refresh when the second request also 401s (refresh-token-rotation safety)", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [makeToken()]);
  const calls: string[] = [];
  let refreshCalls = 0;
  const restoreFetch = withMockedFetch(async (input) => {
    const url = String(input);
    calls.push(url);
    // Upstream is broken — every call returns 401 regardless of token.
    if (url === "https://api.anthropic.com/v1/messages?beta=true") {
      return new Response("unauthorized", { status: 401 });
    }
    if (url === TOKEN_URL) {
      refreshCalls++;
      return new Response(
        JSON.stringify({
          access_token: `refreshed-${refreshCalls}`,
          refresh_token: `rotated-${refreshCalls}`,
          expires_in: 3600,
          account: { email_address: "test@example.com" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "fail me" }],
      stream: false,
    },
  });

  // Final response should be the upstream 401 we couldn't recover from.
  assert.equal(resp.status, 401);
  // Critical: refresh is called exactly ONCE, not on every 401. Otherwise we
  // would burn rotated refresh tokens and could trigger a refresh_token_reused
  // failure on the next legitimate refresh.
  assert.equal(
    refreshCalls,
    1,
    `expected one refresh, saw ${refreshCalls}; calls: ${JSON.stringify(calls)}`,
  );
});

test("returns rate limited when the configured account is cooled down", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [makeToken()]);
  manager.recordFailure(
    "test@example.com",
    "rate_limit",
    "forced for smoke test",
  );
  const restoreFetch = withMockedFetch(async () => {
    throw new Error(
      "Upstream should not be called while the configured account is cooled down",
    );
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hello" }],
    },
  });

  assert.equal(resp.status, 429);
  assert.equal(
    resp.body.error.message,
    "Rate limited on the configured account",
  );
  assert.equal(typeof resp.headers["retry-after"], "string");
});

test("returns 503 when account requires re-authentication", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [makeToken()]);
  manager.recordFailure("test@example.com", "auth", "forced");
  const restoreFetch = withMockedFetch(async () => {
    throw new Error("should not be called");
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
    },
  });

  assert.equal(resp.status, 503);
  assert.equal(
    resp.body.error.message,
    "Configured account requires re-authentication",
  );
});

test("returns 503 when account is forbidden", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [makeToken()]);
  manager.recordFailure("test@example.com", "forbidden", "forced");
  const restoreFetch = withMockedFetch(async () => {
    throw new Error("should not be called");
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
    },
  });

  assert.equal(resp.status, 503);
  assert.equal(resp.body.error.message, "Configured account is forbidden");
});

test("returns 503 when upstream server is unavailable", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [makeToken()]);
  manager.recordFailure("test@example.com", "server", "forced");
  const restoreFetch = withMockedFetch(async () => {
    throw new Error("should not be called");
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
    },
  });

  assert.equal(resp.status, 503);
  assert.equal(
    resp.body.error.message,
    "Upstream server temporarily unavailable",
  );
});

test("returns 503 when upstream network is unavailable", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [makeToken()]);
  manager.recordFailure("test@example.com", "network", "forced");
  const restoreFetch = withMockedFetch(async () => {
    throw new Error("should not be called");
  });
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
    },
  });

  assert.equal(resp.status, 503);
  assert.equal(
    resp.body.error.message,
    "Upstream network temporarily unavailable",
  );
});

test("loads multiple accounts successfully", (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  t.after(() => {
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  saveToken(
    authDir,
    makeToken({ email: "first@example.com", accessToken: "first-access" }),
  );
  saveToken(
    authDir,
    makeToken({ email: "second@example.com", accessToken: "second-access" }),
  );

  const manager = new AccountManager(authDir, {
    provider: "anthropic",
    refresh: refreshTokensWithRetry,
  });
  manager.load();
  assert.equal(manager.accountCount, 2);
});

test("sticky selection keeps using the same available account", (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  t.after(() => {
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const manager = makeManager(authDir, [
    makeToken({ email: "a@example.com", accessToken: "token-a" }),
    makeToken({ email: "b@example.com", accessToken: "token-b" }),
    makeToken({ email: "c@example.com", accessToken: "token-c" }),
  ]);

  const first = manager.getNextAccount();
  assert.ok(first.account);
  assert.equal(first.account.token.email, "a@example.com");

  const second = manager.getNextAccount();
  assert.ok(second.account);
  assert.equal(second.account.token.email, "a@example.com");

  const third = manager.getNextAccount();
  assert.ok(third.account);
  assert.equal(third.account.token.email, "a@example.com");
});

test("sticky selection switches when the current account is cooled down", (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  t.after(() => {
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const manager = makeManager(authDir, [
    makeToken({ email: "a@example.com", accessToken: "token-a" }),
    makeToken({ email: "b@example.com", accessToken: "token-b" }),
    makeToken({ email: "c@example.com", accessToken: "token-c" }),
  ]);

  const first = manager.getNextAccount();
  assert.ok(first.account);
  assert.equal(first.account.token.email, "a@example.com");

  manager.recordFailure("a@example.com", "rate_limit", "test");

  const second = manager.getNextAccount();
  assert.ok(second.account);
  assert.equal(second.account.token.email, "b@example.com");

  const third = manager.getNextAccount();
  assert.ok(third.account);
  assert.equal(third.account.token.email, "b@example.com");
});

test("returns failure info when all accounts are cooled down", (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  t.after(() => {
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const manager = makeManager(authDir, [
    makeToken({ email: "a@example.com", accessToken: "token-a" }),
    makeToken({ email: "b@example.com", accessToken: "token-b" }),
  ]);

  manager.recordFailure("a@example.com", "rate_limit", "test");
  manager.recordFailure("b@example.com", "rate_limit", "test");

  const result = manager.getNextAccount();
  if (result.account !== null) {
    assert.fail("Expected null account");
  }
  assert.equal(result.failureKind, "rate_limit");
  assert.ok((result.retryAfterMs ?? 0) > 0);
});

test("prefers recoverable failure over terminal when all accounts down", (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  t.after(() => {
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const manager = makeManager(authDir, [
    makeToken({ email: "a@example.com", accessToken: "token-a" }),
    makeToken({ email: "b@example.com", accessToken: "token-b" }),
  ]);

  manager.recordFailure("a@example.com", "auth", "test");
  manager.recordFailure("b@example.com", "rate_limit", "test");

  const result = manager.getNextAccount();
  if (result.account !== null) {
    assert.fail("Expected null account");
  }
  assert.equal(result.failureKind, "rate_limit");
  assert.ok((result.retryAfterMs ?? 0) > 0);
});

test("multi-account admin endpoint shows all accounts", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [
    makeToken({ email: "a@example.com", accessToken: "token-a" }),
    makeToken({ email: "b@example.com", accessToken: "token-b" }),
  ]);
  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "GET",
    path: "/admin/accounts",
    headers: { "x-api-key": "test-key" },
  });

  assert.equal(resp.status, 200);
  assert.equal(resp.body.providers.anthropic.account_count, 2);
  const emails = resp.body.providers.anthropic.accounts
    .map((a: any) => a.email)
    .sort();
  assert.deepEqual(emails, ["a@example.com", "b@example.com"]);
});

test("multi-account proxies requests using sticky account until failover", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [
    makeToken({ email: "a@example.com", accessToken: "token-a" }),
    makeToken({ email: "b@example.com", accessToken: "token-b" }),
  ]);

  const usedTokens: string[] = [];
  const restoreFetch = withMockedFetch(async (_input, init) => {
    const authHeader = (init?.headers as Record<string, string>).Authorization;
    usedTokens.push(authHeader.replace("Bearer ", ""));

    return new Response(
      JSON.stringify({
        id: "msg_1",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });

  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  // First request
  await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "1" }],
      stream: false,
    },
  });

  // Second request
  await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "2" }],
      stream: false,
    },
  });

  // Third request (wraps around)
  await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "3" }],
      stream: false,
    },
  });

  assert.deepEqual(usedTokens, ["token-a", "token-a", "token-a"]);
});

test("multi-account falls back to next account on rate limit", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [
    makeToken({ email: "a@example.com", accessToken: "token-a" }),
    makeToken({ email: "b@example.com", accessToken: "token-b" }),
  ]);

  const usedTokens: string[] = [];
  const restoreFetch = withMockedFetch(async (_input, init) => {
    const authHeader = (init?.headers as Record<string, string>).Authorization;
    const token = authHeader.replace("Bearer ", "");
    usedTokens.push(token);

    if (token === "token-a") {
      return new Response("rate limited", { status: 429 });
    }
    return new Response(
      JSON.stringify({
        id: "msg_1",
        content: [{ type: "text", text: "from b" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });

  const server = await startApp(makeConfig(authDir), manager);

  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    },
  });

  assert.equal(resp.status, 200);
  assert.equal(resp.body.choices[0].message.content, "from b");
  // First attempt used token-a (got 429), retry used token-b (success)
  assert.equal(usedTokens[0], "token-a");
  assert.ok(usedTokens.includes("token-b"));
});

// ── loadConfig: YAML api-keys array → Set ──

test("loadConfig converts YAML api-keys array to Set", () => {
  const configPath = path.join(os.tmpdir(), `auth2api-test-${Date.now()}.yaml`);
  fs.writeFileSync(
    configPath,
    [
      'host: "127.0.0.1"',
      "port: 9999",
      'auth-dir: "~/.auth2api"',
      "api-keys:",
      '  - "sk-key-one"',
      '  - "sk-key-two"',
      '  - "sk-key-three"',
      'body-limit: "100mb"',
      'debug: "off"',
    ].join("\n"),
  );

  try {
    const config = loadConfig(configPath);
    assert.ok(config["api-keys"] instanceof Set);
    assert.equal(config["api-keys"].size, 3);
    assert.ok(config["api-keys"].has("sk-key-one"));
    assert.ok(config["api-keys"].has("sk-key-two"));
    assert.ok(config["api-keys"].has("sk-key-three"));
    assert.ok(!config["api-keys"].has("sk-missing"));
  } finally {
    fs.unlinkSync(configPath);
  }
});

test("POST /admin/reload reloads token from disk; subsequent request uses new bearer", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  // Existing in-memory token = "old-access". Disk will be rewritten to "new-access" mid-test.
  const manager = makeManager(authDir, [
    makeToken({ accessToken: "old-access" }),
  ]);

  const calls: { url: string; auth: string }[] = [];
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    const auth =
      (init?.headers as Record<string, string> | undefined)?.Authorization ||
      "";
    calls.push({ url, auth });
    if (url.startsWith("https://api.anthropic.com/v1/messages")) {
      // Backend only accepts the new token.
      if (auth === "Bearer new-access") {
        return new Response(
          JSON.stringify({
            id: "msg_ok",
            content: [{ type: "text", text: "hello after reload" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("unauthorized", { status: 401 });
    }
    if (url === TOKEN_URL) {
      // If the manager tries to refresh while we're racing, return a fresh
      // unrelated token so the test isolates the reload path.
      return new Response(
        JSON.stringify({
          access_token: "refresh-noise",
          refresh_token: "rt",
          expires_in: 3600,
          account: { email_address: "test@example.com" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });

  const server = await startApp(makeConfig(authDir), manager);
  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  // Simulate `--login` writing a new token to disk while server is up.
  saveToken(authDir, makeToken({ accessToken: "new-access" }));

  // Trigger reload via the new endpoint.
  const reloadResp = await requestJson({
    server,
    method: "POST",
    path: "/admin/reload",
    headers: { Authorization: "Bearer test-key" },
  });
  assert.equal(reloadResp.status, 200);
  assert.deepEqual(reloadResp.body.reloaded.anthropic.updated, [
    "test@example.com",
  ]);
  assert.deepEqual(reloadResp.body.reloaded.anthropic.added, []);

  // Subsequent request should use the new bearer.
  const chatResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    },
  });
  assert.equal(chatResp.status, 200);
  assert.equal(chatResp.body.choices[0].message.content, "hello after reload");
  // Final upstream call must have used the new bearer (no refresh-and-retry).
  const upstream = calls.filter((c) =>
    c.url.startsWith("https://api.anthropic.com/v1/messages"),
  );
  assert.equal(upstream.at(-1)?.auth, "Bearer new-access");
});

test("POST /admin/reload requires the API key", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [makeToken()]);
  const server = await startApp(makeConfig(authDir), manager);
  t.after(async () => {
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });
  const noAuth = await requestJson({
    server,
    method: "POST",
    path: "/admin/reload",
  });
  assert.equal(noAuth.status, 401);
  const wrongAuth = await requestJson({
    server,
    method: "POST",
    path: "/admin/reload",
    headers: { Authorization: "Bearer wrong" },
  });
  assert.equal(wrongAuth.status, 403);
});

test("count_tokens with empty body returns upstream client error, not network error", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async (input, init) => {
    assert.equal(
      String(input),
      "https://api.anthropic.com/v1/messages/count_tokens?beta=true",
    );
    assert.equal(init?.body, "{}");
    return new Response(
      JSON.stringify({
        error: {
          message: "messages is required",
          type: "invalid_request_error",
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  });
  const server = await startApp(makeConfig(authDir), manager);
  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/messages/count_tokens",
    headers: { Authorization: "Bearer test-key" },
  });

  assert.equal(resp.status, 400);
  assert.equal(resp.body.error.message, "messages is required");
});

test("claude-cli anthropic-beta passthrough deduplicates oauth beta", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async (_input, init) => {
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers["anthropic-beta"], "oauth-2025-04-20,custom-beta");
    return new Response(
      JSON.stringify({
        id: "msg_1",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  const server = await startApp(makeConfig(authDir), manager);
  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/messages",
    headers: {
      Authorization: "Bearer test-key",
      "User-Agent": "claude-cli/2.1.88",
      "anthropic-beta": "oauth-2025-04-20,custom-beta,custom-beta",
    },
    body: {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
    },
  });

  assert.equal(resp.status, 200);
});

test("anthropic compact beta is inferred from context_management", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [makeToken()]);
  let seenMessagesHeader = "";
  let seenCountTokensHeader = "";
  const restoreFetch = withMockedFetch(async (input, init) => {
    const headers = init?.headers as Record<string, string>;
    const url = String(input);
    if (url.endsWith("/v1/messages?beta=true")) {
      seenMessagesHeader = headers["anthropic-beta"];
      return new Response(
        JSON.stringify({
          id: "msg_1",
          content: [
            { type: "compaction", content: "summary" },
            { type: "text", text: "ok" },
          ],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            iterations: [{ type: "compaction", input_tokens: 1 }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    assert.equal(
      url,
      "https://api.anthropic.com/v1/messages/count_tokens?beta=true",
    );
    seenCountTokensHeader = headers["anthropic-beta"];
    return new Response(JSON.stringify({ input_tokens: 42 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const server = await startApp(makeConfig(authDir), manager);
  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const compactBody = {
    model: "claude-sonnet-4-6",
    max_tokens: 50,
    messages: [{ role: "user", content: "hi" }],
    context_management: {
      edits: [{ type: "compact_20260112" }],
    },
  };

  const msgResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/messages",
    headers: { Authorization: "Bearer test-key" },
    body: compactBody,
  });
  assert.equal(msgResp.status, 200);
  assert.match(seenMessagesHeader, /compact-2026-01-12/);

  const countResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/messages/count_tokens",
    headers: { Authorization: "Bearer test-key" },
    body: compactBody,
  });
  assert.equal(countResp.status, 200);
  assert.match(seenCountTokensHeader, /compact-2026-01-12/);
});

test("codex responses upstream errors are normalized to OpenAI error shape", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  saveToken(
    authDir,
    makeToken({
      accessToken: "codex-access",
      email: "codex@example.com",
      accountUuid: "chatgpt-account-id",
      provider: "codex",
    }),
  );
  const restoreFetch = withMockedFetch(async (input) => {
    assert.equal(
      String(input),
      "https://chatgpt.com/backend-api/codex/responses",
    );
    return new Response(JSON.stringify({ detail: "bad codex request" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  });
  const server = await startAppWithLoadedRegistry(makeConfig(authDir));
  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.3-codex",
      input: [{ role: "user", content: "hi" }],
    },
  });

  assert.equal(resp.status, 400);
  assert.deepEqual(resp.body, {
    error: { message: "bad codex request", type: "upstream_error" },
  });
});

test("cursor responses proxy converts minimal Connect-RPC stream to Responses SSE", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  saveToken(
    authDir,
    makeToken({
      accessToken: "cursor-access",
      refreshToken: "cursor-refresh",
      email: "cursor@example.com",
      accountUuid: "cursor-machine",
      provider: "cursor",
      cursorServiceMachineId: "cursor-machine",
      cursorClientVersion: "cli-test",
      cursorConfigVersion: "config-test",
    }),
  );

  const { __setCursorTransport } = await import("../src/upstream/cursor-api");
  __setCursorTransport(async (url, headers, body) => {
    assert.equal(
      url,
      "https://api2.cursor.sh/aiserver.v1.ChatService/StreamUnifiedChatWithTools",
    );
    assert.equal(headers.Authorization, "Bearer cursor-access");
    assert.equal(headers["Content-Type"], "application/connect+proto");
    assert.equal(headers["Connect-Protocol-Version"], "1");
    assert.ok(body instanceof Buffer && body.length > 5);
    return {
      status: 200,
      headers: { "content-type": "application/connect+proto" },
      body: Buffer.from(connectProtoTextFrame("hello from cursor")),
    };
  });
  const server = await startAppWithLoadedRegistry(makeConfig(authDir));

  t.after(async () => {
    __setCursorTransport(null);
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const response = await requestText({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: {
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    },
    body: {
      model: "cursor-premium",
      input: "hi",
      stream: true,
    },
  });

  assert.equal(response.status, 200);
  assert.match(response.body, /event: response\.output_text\.delta/);
  assert.match(response.body, /hello from cursor/);
  assert.match(response.body, /event: response\.completed/);
});

test("cursor SSE forwards deltas as soon as upstream HTTP/2 chunks arrive (no whole-buffer wait)", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  saveToken(
    authDir,
    makeToken({
      accessToken: "cursor-access",
      refreshToken: "cursor-refresh",
      email: "stream@cursor.com",
      accountUuid: "cursor-machine",
      provider: "cursor",
      cursorServiceMachineId: "cursor-machine",
      cursorClientVersion: "cli-test",
      cursorConfigVersion: "config-test",
    }),
  );

  const { __setCursorTransport } = await import("../src/upstream/cursor-api");
  // Build a streaming body that emits one Connect frame per chunk, with a
  // gap between chunks. If callCursorResponses still buffered the whole
  // upstream response, the second/third frames would only arrive together
  // at the end and the deltaArrivalTimes timestamps would be tightly
  // clustered. With a real stream they should be roughly `chunkGapMs`
  // apart.
  const chunkGapMs = 60;
  const frames = [
    Buffer.from(connectProtoTextFrame("first ")),
    Buffer.from(connectProtoTextFrame("second ")),
    Buffer.from(connectProtoTextFrame("third")),
  ];
  __setCursorTransport(async () => {
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (i >= frames.length) {
          controller.close();
          return;
        }
        if (i > 0) await new Promise((r) => setTimeout(r, chunkGapMs));
        controller.enqueue(new Uint8Array(frames[i++]));
      },
    });
    return {
      status: 200,
      headers: { "content-type": "application/connect+proto" },
      body: stream,
    };
  });
  const server = await startAppWithLoadedRegistry(makeConfig(authDir));
  t.after(async () => {
    __setCursorTransport(null);
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const arrivals: number[] = [];
  await new Promise<void>((resolve, reject) => {
    const address = serverAddress(server);
    const payload = JSON.stringify({
      model: "cursor-default",
      input: "hi",
      stream: true,
    });
    const req = http.request(
      {
        host: "127.0.0.1",
        port: address.port,
        method: "POST",
        path: "/v1/responses",
        headers: {
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload).toString(),
        },
      },
      (res) => {
        const start = Date.now();
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (/response\.output_text\.delta/.test(chunk)) {
            arrivals.push(Date.now() - start);
          }
        });
        res.on("end", () => resolve());
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });

  assert.ok(
    arrivals.length >= 3,
    `expected at least 3 streaming output_text deltas, got ${arrivals.length}`,
  );
  // Spread between first and last delta arrival should be at least roughly
  // one inter-chunk gap. With a safety margin for CI jitter we require
  // half the upstream gap × 2 (= one full gap).
  const spread = arrivals[arrivals.length - 1] - arrivals[0];
  assert.ok(
    spread >= chunkGapMs,
    `output_text.delta events arrived in ${spread}ms across ${arrivals.length} frames ` +
      `(expected at least ${chunkGapMs}ms spread). The HTTP/2 transport ` +
      `may have buffered the entire upstream response.`,
  );
});

test("cursor /v1/messages emits Anthropic Messages SSE for bare model names in cursor-only mode", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  saveToken(
    authDir,
    makeToken({
      accessToken: "cursor-access",
      refreshToken: "cursor-refresh",
      email: "cursor-only@example.com",
      accountUuid: "cursor-machine",
      provider: "cursor",
      cursorServiceMachineId: "cursor-machine",
      cursorClientVersion: "cli-test",
      cursorConfigVersion: "config-test",
    }),
  );

  const { __setCursorTransport } = await import("../src/upstream/cursor-api");
  __setCursorTransport(async (_url, _headers, _body) => ({
    status: 200,
    headers: { "content-type": "application/connect+proto" },
    body: Buffer.from(connectProtoTextFrame("hello from cursor")),
  }));
  const server = await startAppWithLoadedRegistry(makeConfig(authDir));
  t.after(async () => {
    __setCursorTransport(null);
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const response = await requestText({
    server,
    method: "POST",
    path: "/v1/messages",
    headers: {
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    },
    body: {
      // Bare Anthropic-style name — no `cursor-` prefix.
      model: "claude-sonnet-4-5",
      max_tokens: 50,
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    },
  });

  assert.equal(response.status, 200);
  assert.match(response.body, /event: message_start/);
  assert.match(response.body, /"model":"claude-sonnet-4-5"/);
  assert.match(response.body, /"type":"text_delta"/);
  assert.match(response.body, /hello from cursor/);
  assert.match(response.body, /event: message_stop/);
});

test("cursor /v1/chat/completions streaming emits OpenAI Chat SSE for bare model names", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  saveToken(
    authDir,
    makeToken({
      accessToken: "cursor-access",
      refreshToken: "cursor-refresh",
      email: "cursor-chat@example.com",
      accountUuid: "cursor-machine",
      provider: "cursor",
      cursorServiceMachineId: "cursor-machine",
      cursorClientVersion: "cli-test",
      cursorConfigVersion: "config-test",
    }),
  );

  const { __setCursorTransport } = await import("../src/upstream/cursor-api");
  __setCursorTransport(async () => ({
    status: 200,
    headers: { "content-type": "application/connect+proto" },
    body: Buffer.from(connectProtoTextFrame("hi from cursor chat")),
  }));
  const server = await startAppWithLoadedRegistry(makeConfig(authDir));
  t.after(async () => {
    __setCursorTransport(null);
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const response = await requestText({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: {
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    },
    body: {
      // Bare OpenAI-style name — no `cursor-` prefix; cursor-only mode
      // routes it to cursor and the OpenAI Chat SSE generator emits
      // chat.completion.chunk frames.
      model: "gpt-4o",
      messages: [{ role: "user", content: "say hi" }],
      stream: true,
    },
  });

  assert.equal(response.status, 200);
  assert.match(response.body, /"object":"chat\.completion\.chunk"/);
  // Role primer chunk must come first so OpenAI SDKs that look for the
  // initial role marker accept the stream.
  assert.match(response.body, /"role":"assistant"/);
  // Content delta must appear and carry our text.
  assert.match(response.body, /"content":"hi from cursor chat"/);
  // Stream must end with finish_reason and the [DONE] sentinel.
  assert.match(response.body, /"finish_reason":"stop"/);
  assert.match(response.body, /data: \[DONE\]/);
});

test("cursor /v1/chat/completions non-streaming aggregates SSE into chat.completion JSON", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  saveToken(
    authDir,
    makeToken({
      accessToken: "cursor-access",
      refreshToken: "cursor-refresh",
      email: "cursor-chat-nonstream@example.com",
      accountUuid: "cursor-machine",
      provider: "cursor",
      cursorServiceMachineId: "cursor-machine",
      cursorClientVersion: "cli-test",
      cursorConfigVersion: "config-test",
    }),
  );

  const { __setCursorTransport } = await import("../src/upstream/cursor-api");
  // Two text frames so we exercise aggregation.
  __setCursorTransport(async () => ({
    status: 200,
    headers: { "content-type": "application/connect+proto" },
    body: Buffer.concat([
      Buffer.from(connectProtoTextFrame("foo")),
      Buffer.from(connectProtoTextFrame(" bar")),
    ]),
  }));
  const server = await startAppWithLoadedRegistry(makeConfig(authDir));
  t.after(async () => {
    __setCursorTransport(null);
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const response = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: {
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    },
    body: {
      model: "gpt-4o",
      messages: [{ role: "user", content: "two parts please" }],
      // Explicitly non-streaming — provider streams internally and the
      // handler aggregates into a single chat.completion JSON.
      stream: false,
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.object, "chat.completion");
  assert.equal(response.body.model, "gpt-4o");
  assert.equal(response.body.choices[0].message.role, "assistant");
  assert.equal(response.body.choices[0].message.content, "foo bar");
  assert.equal(response.body.choices[0].finish_reason, "stop");
});

// Helper: build a Responses-API SSE body that the codex backend would send
// back. Used to drive smoke tests for the codex chat-completions /
// messages translator handlers.
function codexResponsesSseBody(textParts: string[]): string {
  const ev = (event: string, data: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  let out = ev("response.created", {
    type: "response.created",
    response: { id: "resp_x", status: "in_progress" },
  });
  for (const t of textParts) {
    out += ev("response.output_text.delta", {
      type: "response.output_text.delta",
      delta: t,
    });
  }
  out += ev("response.completed", {
    type: "response.completed",
    response: {
      id: "resp_x",
      status: "completed",
      usage: { input_tokens: 3, output_tokens: 4 },
    },
  });
  return out;
}

test("codex /v1/chat/completions translates Chat → Responses upstream and SSE → Chat back", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  saveToken(
    authDir,
    makeToken({
      accessToken: "codex-access",
      email: "codex-chat@example.com",
      accountUuid: "chatgpt-account-id",
      provider: "codex",
    }),
  );

  let receivedUpstreamBody: any = null;
  const restoreFetch = withMockedFetch(async (input, init) => {
    assert.equal(
      String(input),
      "https://chatgpt.com/backend-api/codex/responses",
    );
    receivedUpstreamBody = JSON.parse(String(init?.body || "{}"));
    return new Response(codexResponsesSseBody(["foo", " bar"]), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  const server = await startAppWithLoadedRegistry(makeConfig(authDir));
  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  // Streaming.
  const streamResp = await requestText({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.5",
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "say hi" },
      ],
      stream: true,
    },
  });
  assert.equal(streamResp.status, 200);
  // Translated upstream body must be Responses-shaped: input array (not
  // messages), instructions lifted from system, stream:true forced on.
  assert.ok(Array.isArray(receivedUpstreamBody.input));
  assert.equal(receivedUpstreamBody.instructions, "Be terse.");
  assert.equal(receivedUpstreamBody.stream, true);
  // Codex-strip: max_output_tokens must NOT be sent.
  assert.equal(receivedUpstreamBody.max_output_tokens, undefined);
  // Output is Chat Completions SSE.
  assert.match(streamResp.body, /"object":"chat\.completion\.chunk"/);
  assert.match(streamResp.body, /"role":"assistant"/);
  assert.match(streamResp.body, /"content":"foo"/);
  assert.match(streamResp.body, /"content":" bar"/);
  assert.match(streamResp.body, /"finish_reason":"stop"/);
  assert.match(streamResp.body, /data: \[DONE\]/);

  // Non-streaming aggregates the same upstream stream into JSON.
  const jsonResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.5",
      messages: [{ role: "user", content: "say hi" }],
      stream: false,
    },
  });
  assert.equal(jsonResp.status, 200);
  assert.equal(jsonResp.body.object, "chat.completion");
  assert.equal(jsonResp.body.choices[0].message.content, "foo bar");
  assert.equal(jsonResp.body.choices[0].finish_reason, "stop");
});

test("codex /v1/messages translates Anthropic → Responses upstream and SSE → Anthropic back", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  saveToken(
    authDir,
    makeToken({
      accessToken: "codex-access",
      email: "codex-msg@example.com",
      accountUuid: "chatgpt-account-id",
      provider: "codex",
    }),
  );

  let receivedUpstreamBody: any = null;
  const restoreFetch = withMockedFetch(async (input, init) => {
    assert.equal(
      String(input),
      "https://chatgpt.com/backend-api/codex/responses",
    );
    receivedUpstreamBody = JSON.parse(String(init?.body || "{}"));
    return new Response(codexResponsesSseBody(["ack"]), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  const server = await startAppWithLoadedRegistry(makeConfig(authDir));
  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  // Streaming.
  const streamResp = await requestText({
    server,
    method: "POST",
    path: "/v1/messages",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.5",
      max_tokens: 50,
      system: "You are helpful.",
      messages: [{ role: "user", content: "Reply: ack" }],
      stream: true,
    },
  });
  assert.equal(streamResp.status, 200);
  // Upstream body checks.
  assert.equal(receivedUpstreamBody.instructions, "You are helpful.");
  assert.ok(Array.isArray(receivedUpstreamBody.input));
  assert.equal(receivedUpstreamBody.stream, true);
  // max_output_tokens stripped (anthropic max_tokens must not pass through).
  assert.equal(receivedUpstreamBody.max_output_tokens, undefined);
  // Output is Anthropic Messages SSE.
  assert.match(streamResp.body, /event: message_start/);
  assert.match(streamResp.body, /"model":"gpt-5.5"/);
  assert.match(streamResp.body, /"type":"text_delta","text":"ack"/);
  assert.match(streamResp.body, /event: message_stop/);

  // Non-streaming.
  const jsonResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/messages",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.5",
      max_tokens: 50,
      messages: [{ role: "user", content: "say hi" }],
    },
  });
  assert.equal(jsonResp.status, 200);
  assert.equal(jsonResp.body.role, "assistant");
  assert.equal(jsonResp.body.type, "message");
  assert.equal(jsonResp.body.content[0].type, "text");
  assert.equal(jsonResp.body.content[0].text, "ack");
  assert.equal(jsonResp.body.stop_reason, "end_turn");
});

test("codex /v1/responses sanitises body, forces upstream stream:true, and aggregates non-stream", async (t) => {
  // Regression cover for the "Codex Responses passthrough still violates new
  // streaming contract" review: client may send public-Responses fields like
  // max_output_tokens/parallel_tool_calls or stream:false, but the codex
  // backend rejects all of those. The handler must strip them, force the
  // upstream to stream, and aggregate locally if the client wanted JSON.
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  saveToken(
    authDir,
    makeToken({
      accessToken: "codex-access",
      email: "codex-resp@example.com",
      accountUuid: "chatgpt-account-id",
      provider: "codex",
    }),
  );

  let receivedUpstreamBody: any = null;
  const restoreFetch = withMockedFetch(async (input, init) => {
    assert.equal(
      String(input),
      "https://chatgpt.com/backend-api/codex/responses",
    );
    receivedUpstreamBody = JSON.parse(String(init?.body || "{}"));
    return new Response(codexResponsesSseBody(["pong"]), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  const server = await startAppWithLoadedRegistry(makeConfig(authDir));
  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  // Client sends stream:false plus the two fields codex-backend rejects.
  // We expect:
  //   - upstream body was sanitised (no max_output_tokens / parallel_tool_calls)
  //   - upstream body has stream:true (forced by the handler)
  //   - response is a single Responses JSON, not SSE
  const jsonResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.5",
      input: [
        { role: "user", content: [{ type: "input_text", text: "ping" }] },
      ],
      max_output_tokens: 64,
      parallel_tool_calls: false,
      stream: false,
    },
  });
  assert.equal(jsonResp.status, 200);
  assert.equal(receivedUpstreamBody.stream, true);
  assert.equal(receivedUpstreamBody.max_output_tokens, undefined);
  assert.equal(receivedUpstreamBody.parallel_tool_calls, undefined);
  // The handler emits the completed response verbatim — id/status/usage all
  // come straight from the upstream's response.completed event.
  assert.equal(jsonResp.body.id, "resp_x");
  assert.equal(jsonResp.body.status, "completed");
  assert.deepEqual(jsonResp.body.usage, { input_tokens: 3, output_tokens: 4 });

  // And streaming clients still get the SSE forwarded as-is.
  const streamResp = await requestText({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.5",
      input: [
        { role: "user", content: [{ type: "input_text", text: "ping" }] },
      ],
      max_output_tokens: 64,
      stream: true,
    },
  });
  assert.equal(streamResp.status, 200);
  // Sanitisation applies to the streaming path too.
  assert.equal(receivedUpstreamBody.max_output_tokens, undefined);
  assert.equal(receivedUpstreamBody.stream, true);
  assert.match(streamResp.body, /event: response\.output_text\.delta/);
  assert.match(streamResp.body, /"delta":"pong"/);
  assert.match(streamResp.body, /event: response\.completed/);
});

test("codex responses compact proxies standalone compaction endpoint", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  saveToken(
    authDir,
    makeToken({
      accessToken: "codex-access",
      email: "codex-compact@example.com",
      accountUuid: "chatgpt-account-id",
      provider: "codex",
    }),
  );

  const seenPaths: string[] = [];
  let receivedUpstreamBody: any = null;
  const compactPayload = {
    id: "resp_compact_x",
    object: "response.compaction",
    created_at: 1764967971,
    output: [
      {
        id: "cmp_001",
        type: "compaction",
        encrypted_content: "opaque",
      },
    ],
    usage: {
      input_tokens: 11,
      input_tokens_details: { cached_tokens: 3 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 2 },
      total_tokens: 16,
    },
  };
  const restoreFetch = withMockedFetch(async (input, init) => {
    const headers = init?.headers as Record<string, string>;
    assert.equal(
      String(input),
      "https://chatgpt.com/backend-api/codex/responses/compact",
    );
    assert.equal(headers.Accept, "application/json");
    assert.equal(headers.session_id, "compact-seed");
    assert.equal(headers.conversation_id, "compact-seed");
    receivedUpstreamBody = JSON.parse(String(init?.body || "{}"));
    return new Response(JSON.stringify(compactPayload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const server = await startAppWithLoadedRegistry(makeConfig(authDir));
  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  for (const pathName of [
    "/v1/responses/compact",
    "/backend-api/codex/responses/compact",
  ]) {
    seenPaths.push(pathName);
    const resp = await requestJson({
      server,
      method: "POST",
      path: pathName,
      headers: { Authorization: "Bearer test-key" },
      body: {
        model: "gpt-5.5",
        input: [
          { role: "user", content: [{ type: "input_text", text: "ping" }] },
        ],
        instructions: "compact this",
        stream: true,
        store: true,
        prompt_cache_key: "compact-seed",
        client_metadata: { source: "codex" },
      },
    });

    assert.equal(resp.status, 200);
    assert.equal(resp.body.object, "response.compaction");
    assert.equal(resp.body.output[0].type, "compaction");
    assert.equal(receivedUpstreamBody.instructions, "compact this");
    assert.equal(receivedUpstreamBody.stream, undefined);
    assert.equal(receivedUpstreamBody.store, undefined);
    assert.equal(receivedUpstreamBody.prompt_cache_key, undefined);
    assert.equal(receivedUpstreamBody.client_metadata, undefined);
  }

  assert.deepEqual(seenPaths, [
    "/v1/responses/compact",
    "/backend-api/codex/responses/compact",
  ]);
});

test("codex /v1/chat/completions non-stream still captures final SSE event when upstream omits trailing newline", async (t) => {
  // Regression cover for the "SSE drain drops final buffered line" review:
  // the previous hand-rolled drain loops would skip the very last `data:`
  // line if it lacked a trailing \n. We now use the shared readSseEvents
  // helper which flushes the leftover buffer on stream close.
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  saveToken(
    authDir,
    makeToken({
      accessToken: "codex-access",
      email: "codex-drain@example.com",
      accountUuid: "chatgpt-account-id",
      provider: "codex",
    }),
  );

  // Build an SSE body whose final event has NO trailing \n\n.
  const ev = (event: string, data: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const sseNoTrailingNewline =
    ev("response.created", {
      response: { id: "resp_x", status: "in_progress" },
    }) +
    ev("response.output_text.delta", { delta: "answer" }) +
    `event: response.completed\ndata: ${JSON.stringify({
      response: {
        id: "resp_x",
        status: "completed",
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    })}`; // ← deliberately no trailing newline

  const restoreFetch = withMockedFetch(async () => {
    return new Response(sseNoTrailingNewline, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  const server = await startAppWithLoadedRegistry(makeConfig(authDir));
  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const jsonResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.5",
      messages: [{ role: "user", content: "q" }],
      stream: false,
    },
  });
  assert.equal(jsonResp.status, 200);
  // The final delta survives the drain.
  assert.equal(jsonResp.body.choices[0].message.content, "answer");
  // And the response.completed-derived finish_reason makes it through.
  assert.equal(jsonResp.body.choices[0].finish_reason, "stop");
});

test("codex /v1/responses non-stream splices streamed output_item.done into completed.output (real codex wire shape)", async (t) => {
  // Real codex backend ships output items (message / reasoning /
  // function_call) in dedicated `response.output_item.done` events
  // during the stream, and then sends a final `response.completed`
  // whose `response.output` is **always `[]`** (it differs from the
  // public OpenAI Responses API in that respect). The handler must
  // reconstruct the final response by splicing the streamed items
  // into the empty array so non-stream clients actually get the
  // generated content.
  //
  // Without the splice, our `/v1/responses` non-stream path would
  // hand back `output: []` plus correct usage — clients would see a
  // successful 200 with no content. The unit tests cover the drain
  // helper end of this contract; this smoke locks the handler-level
  // splice behaviour so a future refactor can't silently regress
  // the wire-format reconstruction.
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  saveToken(
    authDir,
    makeToken({
      accessToken: "codex-access",
      email: "codex-splice@example.com",
      accountUuid: "chatgpt-account-id",
      provider: "codex",
    }),
  );

  // Faithful slice of a real codex stream: a reasoning item, a
  // message item, and a function_call item — each delivered as a
  // separate `response.output_item.done` event — followed by a
  // `response.completed` whose `output` is intentionally empty.
  const ev = (event: string, data: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const reasoningItem = {
    id: "rs_1",
    type: "reasoning",
    summary: [{ type: "summary_text", text: "thinking briefly" }],
  };
  const messageItem = {
    id: "msg_1",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: "PONG", annotations: [] }],
  };
  const functionCallItem = {
    id: "fc_1",
    type: "function_call",
    status: "completed",
    call_id: "call_xyz",
    name: "get_weather",
    arguments: '{"city":"Tokyo"}',
  };

  const sseBody =
    ev("response.created", {
      response: { id: "resp_splice", status: "in_progress" },
    }) +
    ev("response.output_item.done", { item: reasoningItem }) +
    ev("response.output_item.done", { item: messageItem }) +
    ev("response.output_item.done", { item: functionCallItem }) +
    ev("response.completed", {
      response: {
        id: "resp_splice",
        object: "response",
        status: "completed",
        model: "gpt-5.5",
        output: [], // ← codex's actual wire behaviour
        usage: { input_tokens: 17, output_tokens: 9 },
      },
    });

  const restoreFetch = withMockedFetch(async () => {
    return new Response(sseBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  const server = await startAppWithLoadedRegistry(makeConfig(authDir));
  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const jsonResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.5",
      input: [
        { role: "user", content: [{ type: "input_text", text: "ping" }] },
      ],
      stream: false,
    },
  });

  assert.equal(jsonResp.status, 200);
  assert.equal(jsonResp.body.id, "resp_splice");
  assert.equal(jsonResp.body.status, "completed");
  // The handler-level splice: completed.response.output was [] but
  // we should have stitched the three streamed items in order.
  assert.ok(Array.isArray(jsonResp.body.output), "output must be an array");
  assert.equal(
    jsonResp.body.output.length,
    3,
    `expected 3 output items spliced from output_item.done events, got ${jsonResp.body.output.length}`,
  );
  assert.equal(jsonResp.body.output[0].type, "reasoning");
  assert.equal(jsonResp.body.output[0].summary[0].text, "thinking briefly");
  assert.equal(jsonResp.body.output[1].type, "message");
  assert.equal(jsonResp.body.output[1].content[0].text, "PONG");
  assert.equal(jsonResp.body.output[2].type, "function_call");
  assert.equal(jsonResp.body.output[2].call_id, "call_xyz");
  assert.equal(jsonResp.body.output[2].arguments, '{"city":"Tokyo"}');
  // Usage from completed.response is preserved.
  assert.deepEqual(jsonResp.body.usage, {
    input_tokens: 17,
    output_tokens: 9,
  });
});

test("codex /v1/responses non-stream prefers upstream-populated output over streamed items (defensive)", async (t) => {
  // The handler's splice is conditional: if a future codex backend
  // ever starts populating `response.completed.response.output`
  // itself (matching the public Responses contract), we should
  // honour that array instead of double-emitting items we also
  // captured from the stream. This test pins that precedence so
  // we don't accidentally regress to "always overwrite with
  // streamed items" if someone simplifies the splice logic.
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  saveToken(
    authDir,
    makeToken({
      accessToken: "codex-access",
      email: "codex-splice2@example.com",
      accountUuid: "chatgpt-account-id",
      provider: "codex",
    }),
  );

  const ev = (event: string, data: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const streamedItem = {
    id: "msg_streamed",
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "FROM_STREAM" }],
  };
  const completedItem = {
    id: "msg_completed",
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "FROM_COMPLETED" }],
  };
  const sseBody =
    ev("response.output_item.done", { item: streamedItem }) +
    ev("response.completed", {
      response: {
        id: "resp_x",
        status: "completed",
        output: [completedItem],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });

  const restoreFetch = withMockedFetch(async () => {
    return new Response(sseBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  const server = await startAppWithLoadedRegistry(makeConfig(authDir));
  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const jsonResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.5",
      input: [
        { role: "user", content: [{ type: "input_text", text: "ping" }] },
      ],
      stream: false,
    },
  });

  assert.equal(jsonResp.status, 200);
  // When upstream supplies output already, it wins.
  assert.equal(jsonResp.body.output.length, 1);
  assert.equal(jsonResp.body.output[0].id, "msg_completed");
  assert.equal(jsonResp.body.output[0].content[0].text, "FROM_COMPLETED");
});

test("codex /v1/images/generations routes through image_generation tool", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  saveToken(
    authDir,
    makeToken({
      accessToken: "codex-access",
      email: "codex-image-gen@example.com",
      accountUuid: "chatgpt-account-id",
      provider: "codex",
    }),
  );

  let receivedUpstreamBody: any = null;
  const ev = (event: string, data: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const imageItem = {
    id: "ig_1",
    type: "image_generation_call",
    status: "completed",
    result: Buffer.from("fake-png").toString("base64"),
    revised_prompt: "A clean dashboard hero",
  };
  const sseBody =
    ev("response.output_item.done", { item: imageItem }) +
    ev("response.completed", {
      response: {
        id: "resp_img",
        status: "completed",
        output: [],
        usage: { input_tokens: 9, output_tokens: 2 },
      },
    });

  const restoreFetch = withMockedFetch(async (input, init) => {
    assert.equal(
      String(input),
      "https://chatgpt.com/backend-api/codex/responses",
    );
    receivedUpstreamBody = JSON.parse(String(init?.body || "{}"));
    return new Response(sseBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  const server = await startAppWithLoadedRegistry(makeConfig(authDir));
  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/images/generations",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-image-2",
      codex_model: "gpt-5.5",
      prompt: "Generate a clean dashboard hero",
      size: "1024x1024",
      quality: "high",
      response_format: "b64_json",
    },
  });

  assert.equal(resp.status, 200);
  assert.equal(
    resp.body.data[0].b64_json,
    Buffer.from("fake-png").toString("base64"),
  );
  assert.equal(resp.body.data[0].revised_prompt, "A clean dashboard hero");
  assert.equal(receivedUpstreamBody.model, "gpt-5.5");
  assert.equal(receivedUpstreamBody.store, false);
  assert.equal(receivedUpstreamBody.stream, true);
  assert.equal(receivedUpstreamBody.tools[0].type, "image_generation");
  assert.equal(receivedUpstreamBody.tools[0].action, "generate");
  assert.equal(receivedUpstreamBody.tools[0].model, "gpt-image-2");
  assert.equal(receivedUpstreamBody.tools[0].size, "1024x1024");
  assert.equal(receivedUpstreamBody.tools[0].quality, "high");
  assert.deepEqual(receivedUpstreamBody.tool_choice, {
    type: "image_generation",
  });
  assert.equal(receivedUpstreamBody.input[0].content[0].type, "input_text");
  assert.equal(
    receivedUpstreamBody.input[0].content[0].text,
    "Generate a clean dashboard hero",
  );
});

test("codex /v1/images/edits forwards input images", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  saveToken(
    authDir,
    makeToken({
      accessToken: "codex-access",
      email: "codex-image-edit@example.com",
      accountUuid: "chatgpt-account-id",
      provider: "codex",
    }),
  );

  let receivedUpstreamBody: any = null;
  const ev = (event: string, data: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const imageItem = {
    id: "ig_edit",
    type: "image_generation_call",
    status: "completed",
    result: Buffer.from("edited-png").toString("base64"),
  };
  const sseBody =
    ev("response.output_item.done", { item: imageItem }) +
    ev("response.completed", {
      response: {
        id: "resp_edit",
        status: "completed",
        output: [],
        usage: { input_tokens: 12, output_tokens: 3 },
      },
    });

  const restoreFetch = withMockedFetch(async (_input, init) => {
    receivedUpstreamBody = JSON.parse(String(init?.body || "{}"));
    return new Response(sseBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  const server = await startAppWithLoadedRegistry(makeConfig(authDir));
  t.after(async () => {
    restoreFetch();
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestJson({
    server,
    method: "POST",
    path: "/v1/images/edits",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-image-2",
      prompt: "Make the background white",
      image_url: "https://example.com/source.png",
    },
  });

  assert.equal(resp.status, 200);
  assert.equal(
    resp.body.data[0].b64_json,
    Buffer.from("edited-png").toString("base64"),
  );
  assert.equal(receivedUpstreamBody.tools[0].action, "edit");
  assert.equal(
    receivedUpstreamBody.input[0].content[0].text,
    "Make the background white",
  );
  assert.equal(receivedUpstreamBody.input[0].content[1].type, "input_image");
  assert.equal(
    receivedUpstreamBody.input[0].content[1].image_url,
    "https://example.com/source.png",
  );
});
