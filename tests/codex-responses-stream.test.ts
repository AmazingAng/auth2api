import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { AddressInfo } from "node:net";
import { createServer as createHttpServer } from "node:http";

import express from "express";
import { CodexProvider } from "../src/providers/codex";
import { Config } from "../src/config";

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
  app.post("/v1/responses", handler);
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

async function requestRaw(options: {
  server: http.Server;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
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
            headers: res.headers,
            body: data,
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

test("Codex responses handler streams upstream SSE events through to the client", async (t) => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-codex-responses-stream-"));
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
      "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"sequence_number\":2,\"delta\":\"hello\"}\n\n",
      "event: response.done\ndata: {\"type\":\"response.done\",\"sequence_number\":3}\n\n",
    ]);
  }) as typeof fetch;

  const server = await startApp(provider.handleResponses());

  t.after(async () => {
    global.fetch = restoreFetch;
    await stopApp(server);
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  const resp = await requestRaw({
    server,
    method: "POST",
    path: "/v1/responses",
    headers: { Authorization: "Bearer test-key" },
    body: {
      model: "gpt-5.4",
      stream: true,
      input: [{ role: "user", content: "hello" }],
    },
  });

  assert.equal(calls[0]?.url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(calls[0]?.auth, "Bearer codex-access-token");
  assert.equal(calls[0]?.accept, "text/event-stream");
  assert.equal(calls[0]?.body.stream, true);
  assert.equal(resp.status, 200);
  assert.match(String(resp.headers["content-type"]), /text\/event-stream/);
  assert.match(resp.body, /event: response.created/);
  assert.match(resp.body, /"delta":"hello"/);
  assert.match(resp.body, /event: response.done/);
});
