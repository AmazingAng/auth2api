import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { AddressInfo } from "node:net";
import { createServer as createHttpServer } from "node:http";

import express from "express";
import { Config } from "../src/config";
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
      models: ["gpt-5.4"],
    },
    debug: "off",
  };
}

function writeAuth(filePath: string, accessToken: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      auth_mode: "oauth",
      tokens: {
        access_token: accessToken,
        refresh_token: "refresh-token",
        account_id: "acct_123",
      },
      last_refresh: "2026-03-30T00:00:00.000Z",
    }, null, 2)
  );
}

async function startApp(handler: express.RequestHandler): Promise<http.Server> {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.post("/v1/chat/completions", handler);
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

function makeStreamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

test("Codex chat completions sends bearer token upstream and canonicalizes chat messages", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-chat-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  writeAuth(authFile, "codex-access-token");
  const provider = new CodexProvider(makeConfig(authDir, authFile));
  const calls: Array<{ url: string; auth?: string; accept?: string; body: any }> = [];

  const restoreFetch = global.fetch;
  global.fetch = (async (input, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({
      url: String(input),
      auth: headers?.Authorization,
      accept: headers?.Accept,
      body,
    });

    return makeStreamResponse([
      "event: response.created\ndata: {\"type\":\"response.created\",\"sequence_number\":1}\n\n",
      "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"sequence_number\":2,\"delta\":\"hello from codex\"}\n\n",
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":3,\"response\":{\"status\":\"completed\",\"model\":\"gpt-5.4\",\"usage\":{\"input_tokens\":12,\"output_tokens\":8,\"total_tokens\":20}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":4}\n\n",
    ]);
  }) as typeof fetch;

  const server = await startApp(provider.handleChatCompletions());

  t.after(async () => {
    global.fetch = restoreFetch;
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
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    },
  });

  assert.equal(calls[0]?.url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(calls[0]?.auth, "Bearer codex-access-token");
  assert.equal(calls[0]?.accept, "text/event-stream");
  assert.deepEqual(calls[0]?.body, {
    model: "gpt-5.4",
    instructions: "",
    store: false,
    input: [{ role: "user", content: "hello" }],
    stream: true,
  });
  assert.equal(resp.status, 200);
  assert.equal(resp.body.object, "chat.completion");
  assert.equal(resp.body.model, "gpt-5.4");
  assert.equal(resp.body.choices[0].message.role, "assistant");
  assert.equal(resp.body.choices[0].message.content, "hello from codex");
  assert.equal(resp.body.usage.total_tokens, 20);
});

test("Codex chat completions converts system messages to developer role", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-chat-system-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  writeAuth(authFile, "codex-access-token");
  const provider = new CodexProvider(makeConfig(authDir, authFile));
  const calls: Array<{ body: any }> = [];

  const restoreFetch = global.fetch;
  global.fetch = (async (_input, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ body });

    return makeStreamResponse([
      "event: response.created\ndata: {\"type\":\"response.created\",\"sequence_number\":1}\n\n",
      "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":2,\"response\":{\"status\":\"completed\",\"model\":\"gpt-5.4\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":3}\n\n",
    ]);
  }) as typeof fetch;

  const server = await startApp(provider.handleChatCompletions());

  t.after(async () => {
    global.fetch = restoreFetch;
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
      messages: [
        { role: "system", content: "be precise" },
        { role: "user", content: "hello" },
      ],
      stream: false,
    },
  });

  assert.equal(resp.status, 200);
  assert.equal(calls[0]?.body.instructions, "");
  assert.equal(calls[0]?.body.store, false);
  assert.equal(calls[0]?.body.stream, true);
  assert.equal(calls[0]?.body.input[0].role, "developer");
  assert.equal(calls[0]?.body.input[1].role, "user");
});

test("Codex chat completions returns controlled error when auth file is missing", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-chat-missing-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  const provider = new CodexProvider(makeConfig(authDir, authFile));

  const restoreFetch = global.fetch;
  global.fetch = (async () => {
    throw new Error("Upstream should not be called when auth is missing");
  }) as typeof fetch;

  const server = await startApp(provider.handleChatCompletions());

  t.after(async () => {
    global.fetch = restoreFetch;
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
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    },
  });

  assert.equal(resp.status, 503);
  assert.match(String(resp.body.error.message), /auth/i);
});

test("Codex chat completions returns controlled error when auth file is malformed", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-chat-malformed-"));
  const authFile = path.join(authDir, ".codex", "auth.json");
  fs.mkdirSync(path.dirname(authFile), { recursive: true });
  fs.writeFileSync(
    authFile,
    JSON.stringify({
      auth_mode: "oauth",
      tokens: {
        refresh_token: "refresh-token",
        account_id: "acct_123",
      },
    }, null, 2)
  );

  const provider = new CodexProvider(makeConfig(authDir, authFile));
  const server = await startApp(provider.handleChatCompletions());

  t.after(async () => {
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
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    },
  });

  assert.equal(resp.status, 503);
  assert.match(String(resp.body.error.message), /access_token/i);
});
