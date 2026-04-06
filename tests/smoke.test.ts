import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { AddressInfo } from "node:net";
import { createServer as createHttpServer } from "node:http";

import { AccountManager } from "../src/accounts/manager";
import { Config } from "../src/config";
import { createServer } from "../src/server";
import { saveToken } from "../src/auth/token-storage";
import { TokenData } from "../src/auth/types";

const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";

function makeConfig(authDir: string): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    "auth-dir": authDir,
    "api-keys": ["test-key"],
    "body-limit": "200mb",
    cloaking: {
      mode: "never",
      "strict-mode": false,
      "sensitive-words": [],
      "cache-user-id": false,
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
    ...overrides,
  };
}

function makeManager(authDir: string, tokens: TokenData[]): AccountManager {
  for (const token of tokens) {
    saveToken(authDir, token);
  }
  const manager = new AccountManager(authDir);
  manager.load();
  return manager;
}

async function startApp(config: Config, manager: AccountManager): Promise<http.Server> {
  const app = createServer(config, manager);
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
}): Promise<{ status: number; body: any }> {
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
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload).toString() } : {}),
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
          });
        });
      }
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
  mock: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
): () => void {
  const originalFetch = global.fetch;
  global.fetch = mock as typeof fetch;
  return () => {
    global.fetch = originalFetch;
  };
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

  const adminResp = await requestJson({
    server,
    method: "GET",
    path: "/admin/accounts",
    headers: { "x-api-key": "test-key" },
  });

  assert.equal(adminResp.status, 200);
  assert.equal(adminResp.body.account_count, 1);
  assert.equal(adminResp.body.accounts[0].email, "test@example.com");
});

test("proxies a non-stream chat completion through Claude OAuth token", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    assert.equal(url, "https://api.anthropic.com/v1/messages?beta=true");
    assert.equal(init?.method, "POST");
    assert.equal(init?.headers && (init.headers as Record<string, string>).Authorization, "Bearer access-token");

    return new Response(
      JSON.stringify({
        id: "msg_1",
        content: [{ type: "text", text: "hello from claude" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 12, output_tokens: 5 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
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
      const authHeader = (init?.headers as Record<string, string>).Authorization;
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
          { status: 200, headers: { "Content-Type": "application/json" } }
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
        { status: 200, headers: { "Content-Type": "application/json" } }
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
  assert.equal(adminResp.body.accounts[0].lastRefreshAt !== null, true);
  assert.equal(adminResp.body.accounts[0].totalSuccesses, 1);
});

test("returns rate limited when the configured account is cooled down", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [makeToken()]);
  manager.recordFailure("test@example.com", "rate_limit", "forced for smoke test");
  const restoreFetch = withMockedFetch(async () => {
    throw new Error("Upstream should not be called while the configured account is cooled down");
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
  assert.equal(resp.body.error.message, "Rate limited on the configured account");
});

test("loads multiple accounts successfully", (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  t.after(() => {
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  saveToken(authDir, makeToken({ email: "first@example.com", accessToken: "first-access" }));
  saveToken(authDir, makeToken({ email: "second@example.com", accessToken: "second-access" }));

  const manager = new AccountManager(authDir);
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
  assert.ok(first);
  assert.ok(first.account);
  assert.equal(first.account.token.email, "a@example.com");

  const second = manager.getNextAccount();
  assert.ok(second);
  assert.ok(second.account);
  assert.equal(second.account.token.email, "a@example.com");

  const third = manager.getNextAccount();
  assert.ok(third);
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

test("returns a null account result when all accounts are cooled down", (t) => {
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
  assert.equal(result.account, null);
  assert.equal(result.total, 2);
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
  assert.equal(resp.body.account_count, 2);
  const emails = resp.body.accounts.map((a: any) => a.email).sort();
  assert.deepEqual(emails, ["a@example.com", "b@example.com"]);
});

test("multi-account proxies requests using the sticky account until failover", async (t) => {
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
      { status: 200, headers: { "Content-Type": "application/json" } }
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
    body: { model: "claude-sonnet-4", messages: [{ role: "user", content: "1" }], stream: false },
  });

  // Second request
  await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: { model: "claude-sonnet-4", messages: [{ role: "user", content: "2" }], stream: false },
  });

  // Third request (wraps around)
  await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: { model: "claude-sonnet-4", messages: [{ role: "user", content: "3" }], stream: false },
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
      { status: 200, headers: { "Content-Type": "application/json" } }
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
    body: { model: "claude-sonnet-4", messages: [{ role: "user", content: "hi" }], stream: false },
  });

  assert.equal(resp.status, 200);
  assert.equal(resp.body.choices[0].message.content, "from b");
  // First attempt used token-a (got 429), retry used token-b (success)
  assert.equal(usedTokens[0], "token-a");
  assert.ok(usedTokens.includes("token-b"));
});
