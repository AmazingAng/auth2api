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
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

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
    codex: {
      enabled: true,
      "auth-file": path.join(authDir, "codex-auth.json"),
      models: ["gpt-5.4", "o3", "codex-mini-latest"],
    },
  };
}

function makeConfigWithCodex(authDir: string, codex: Config["codex"]): Config {
  return {
    ...makeConfig(authDir),
    codex,
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

function writeCodexAuth(authDir: string): void {
  fs.writeFileSync(
    path.join(authDir, "codex-auth.json"),
    JSON.stringify({
      auth_mode: "oauth",
      last_refresh: new Date().toISOString(),
      tokens: {
        access_token: "codex-access-token",
        refresh_token: "codex-refresh-token",
        account_id: "acct_codex",
      },
    })
  );
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
  assert.equal(modelsResp.body.data.some((model: { id: string }) => model.id === "claude-sonnet-4-6"), true);

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

test("routes OpenAI responses requests to Codex based on model", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    assert.equal(url, CODEX_RESPONSES_URL);
    assert.equal(init?.method, "POST");
    assert.equal(init?.headers && (init.headers as Record<string, string>).Authorization, "Bearer codex-access-token");

    const parsedBody = JSON.parse(String(init?.body || "{}"));
    assert.equal(parsedBody.model, "gpt-5.4");
    assert.equal(parsedBody.input[0].content, "hello codex");

    return new Response(
      JSON.stringify({
        id: "resp_codex",
        object: "response",
        model: "gpt-5.4",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "hello from codex" }],
          },
        ],
        usage: { input_tokens: 7, output_tokens: 4, total_tokens: 11 },
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
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      input: [{ role: "user", content: "hello codex" }],
      stream: false,
    },
  });

  assert.equal(resp.status, 200);
  assert.equal(resp.body.object, "response");
  assert.equal(resp.body.model, "gpt-5.4");
  assert.equal(resp.body.output[0].content[0].text, "hello from codex");
  assert.equal(resp.body.usage.total_tokens, 11);
});

test("routes OpenAI chat completions requests to Codex based on model", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    assert.equal(url, CODEX_RESPONSES_URL);
    assert.equal(init?.method, "POST");
    assert.equal(init?.headers && (init.headers as Record<string, string>).Authorization, "Bearer codex-access-token");

    const parsedBody = JSON.parse(String(init?.body || "{}"));
    assert.equal(parsedBody.model, "gpt-5.4");
    assert.equal(parsedBody.input[0].content, "hello from codex chat");

    return new Response(
      JSON.stringify({
        id: "resp_codex_chat",
        object: "response",
        model: "gpt-5.4",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "hello from codex chat" }],
          },
        ],
        usage: { input_tokens: 6, output_tokens: 5, total_tokens: 11 },
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
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello from codex chat" }],
      stream: false,
    },
  });

  assert.equal(resp.status, 200);
  assert.equal(resp.body.object, "chat.completion");
  assert.equal(resp.body.model, "gpt-5.4");
  assert.equal(resp.body.choices[0].message.content, "hello from codex chat");
  assert.equal(resp.body.usage.total_tokens, 11);
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

test("missing Codex auth only breaks Codex models and still allows Claude models", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async (input, init) => {
    const url = String(input);
    assert.equal(url, "https://api.anthropic.com/v1/messages?beta=true");
    assert.equal(init?.headers && (init.headers as Record<string, string>).Authorization, "Bearer access-token");

    return new Response(
      JSON.stringify({
        id: "msg_claude_ok",
        content: [{ type: "text", text: "claude still works" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 3 },
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

  const codexResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hi codex" }],
      stream: false,
    },
  });

  assert.equal(codexResp.status, 503);
  assert.match(codexResp.body.error.message, /Codex auth file not found/);

  const claudeResp = await requestJson({
    server,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi claude" }],
      stream: false,
    },
  });

  assert.equal(claudeResp.status, 200);
  assert.equal(claudeResp.body.choices[0].message.content, "claude still works");
});

test("disabled Codex provider rejects Codex models without falling back to Claude", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async () => {
    throw new Error("Upstream should not be called when Codex provider is disabled");
  });
  const server = await startApp(
    makeConfigWithCodex(authDir, {
      enabled: false,
      "auth-file": path.join(authDir, "codex-auth.json"),
      models: ["gpt-5.4"],
    }),
    manager
  );

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
      model: "gpt-5.4",
      messages: [{ role: "user", content: "disabled codex" }],
      stream: false,
    },
  });

  assert.equal(resp.status, 400);
  assert.equal(resp.body.error.message, "Unsupported model: gpt-5.4");
});

test("Codex models not listed in config are rejected", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  writeCodexAuth(authDir);
  const manager = makeManager(authDir, [makeToken()]);
  const restoreFetch = withMockedFetch(async () => {
    throw new Error("Upstream should not be called for disallowed Codex models");
  });
  const server = await startApp(
    makeConfigWithCodex(authDir, {
      enabled: true,
      "auth-file": path.join(authDir, "codex-auth.json"),
      models: ["gpt-5.4"],
    }),
    manager
  );

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
      model: "o3",
      input: [{ role: "user", content: "not configured" }],
      stream: false,
    },
  });

  assert.equal(resp.status, 400);
  assert.equal(resp.body.error.message, "Unsupported model: o3");
});

test("rejects loading multiple accounts in single-account mode", (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-smoke-"));
  t.after(() => {
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  saveToken(authDir, makeToken({ email: "first@example.com" }));
  saveToken(authDir, makeToken({ email: "second@example.com", accessToken: "second-access" }));

  const manager = new AccountManager(authDir);
  assert.throws(
    () => manager.load(),
    /Single-account mode only supports one token/
  );
});
