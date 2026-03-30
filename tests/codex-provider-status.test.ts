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
import { CodexProvider } from "../src/providers/codex";

function makeConfig(authDir: string, codexAuthFile: string): Config {
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
    codex: {
      enabled: true,
      "auth-file": codexAuthFile,
      models: ["gpt-5.4", "codex-mini-latest"],
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

function serverAddress(server: http.Server): AddressInfo {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Server is not listening on a TCP port");
  }
  return address;
}

async function requestJson(options: {
  server: http.Server;
  method: string;
  path: string;
  headers?: Record<string, string>;
}): Promise<{ status: number; body: any }> {
  const address = serverAddress(options.server);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: address.port,
        method: options.method,
        path: options.path,
        headers: options.headers || {},
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
    req.end();
  });
}

test("CodexProvider lists configured models", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-provider-"));
  const config = makeConfig(tmpDir, path.join(tmpDir, ".codex", "auth.json"));
  const provider = new CodexProvider(config);

  assert.deepEqual(
    provider.listModels().map((model) => model.id),
    ["gpt-5.4", "codex-mini-latest"]
  );
});

test("CodexProvider reports unavailable when auth.json is missing", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-provider-"));
  const config = makeConfig(tmpDir, path.join(tmpDir, ".codex", "auth.json"));
  const provider = new CodexProvider(config);

  const status = provider.getStatus();

  assert.equal(status.name, "codex");
  assert.equal(status.available, false);
});

test("CodexProvider supports only configured models when enabled", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-provider-"));
  const config = makeConfig(tmpDir, path.join(tmpDir, ".codex", "auth.json"));
  const provider = new CodexProvider(config);

  assert.equal(provider.supportsModel("gpt-5.4"), true);
  assert.equal(provider.supportsModel("o3"), false);
});

test("CodexProvider rejects all models when disabled", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-provider-"));
  const config = {
    ...makeConfig(tmpDir, path.join(tmpDir, ".codex", "auth.json")),
    codex: {
      enabled: false,
      "auth-file": path.join(tmpDir, ".codex", "auth.json"),
      models: ["gpt-5.4"],
    },
  };
  const provider = new CodexProvider(config);

  assert.equal(provider.supportsModel("gpt-5.4"), false);
  assert.deepEqual(provider.listModels(), []);
  assert.equal(provider.getStatus().available, false);
});

test("server exposes Claude and Codex models and provider status", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-server-"));
  const config = makeConfig(authDir, path.join(authDir, ".codex", "auth.json"));
  const manager = makeManager(authDir, [makeToken()]);
  const server = await startApp(config, manager);

  t.after(async () => {
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const modelsResp = await requestJson({
    server,
    method: "GET",
    path: "/v1/models",
    headers: { Authorization: "Bearer test-key" },
  });

  assert.equal(modelsResp.status, 200);
  assert.ok(modelsResp.body.data.some((model: any) => model.id === "claude-sonnet-4-6"));
  assert.ok(modelsResp.body.data.some((model: any) => model.id === "gpt-5.4"));

  const adminResp = await requestJson({
    server,
    method: "GET",
    path: "/admin/accounts",
    headers: { Authorization: "Bearer test-key" },
  });

  assert.equal(adminResp.status, 200);
  assert.equal(adminResp.body.claude.name, "claude");
  assert.equal(adminResp.body.codex.name, "codex");
  assert.equal(adminResp.body.codex.available, false);
});
