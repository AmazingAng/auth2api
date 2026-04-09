import express from "express";
import { Config, isDebugLevel } from "./config";
import { AccountManager } from "./accounts/manager";
import { extractApiKey } from "./utils/common";
import {
  createChatCompletionsHandler,
  createResponsesHandler,
} from "./handlers/openai";
import {
  createMessagesHandler,
  createCountTokensHandler,
} from "./handlers/anthropic";

const SUPPORTED_MODELS = [
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "claude-haiku-4-5",
  "opus",
  "sonnet",
  "haiku",
] as const;

// Simple in-memory rate limiter per IP
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 60;

function rateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

// Cleanup stale entries every 5 minutes
const cleanupTimer = setInterval(
  () => {
    const now = Date.now();
    for (const [ip, entry] of rateLimitMap) {
      if (now > entry.resetAt) rateLimitMap.delete(ip);
    }
  },
  5 * 60 * 1000,
);
cleanupTimer.unref();

export function createServer(
  config: Config,
  manager: AccountManager,
): express.Application {
  const app = express();

  app.use(express.json({ limit: config["body-limit"] }));

  if (isDebugLevel(config.debug, "verbose")) {
    app.use((req, res, next) => {
      const startedAt = Date.now();
      console.error(`[debug] ${req.method} ${req.originalUrl} started`);
      res.on("finish", () => {
        console.error(
          `[debug] ${req.method} ${req.originalUrl} -> ${res.statusCode} in ${Date.now() - startedAt}ms`,
        );
      });
      next();
    });
  }

  // CORS - restrict to localhost origins only
  const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
  app.use((_req, res, next) => {
    const origin = _req.headers.origin;
    if (origin && LOCALHOST_RE.test(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, x-api-key",
    );
    if (_req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Rate limiting middleware
  app.use("/v1", (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    if (!rateLimit(ip)) {
      res.status(429).json({ error: { message: "Too many requests" } });
      return;
    }
    next();
  });

  // API key auth middleware — accepts both OpenAI style (Authorization: Bearer)
  // and Anthropic style (x-api-key), so Claude Code and OpenAI clients both work
  const requireApiKey: express.RequestHandler = (req, res, next) => {
    const key = extractApiKey(req.headers);
    if (!key) {
      res.status(401).json({ error: { message: "Missing API key" } });
      return;
    }
    const valid = config["api-keys"].has(key);
    if (!valid) {
      res.status(403).json({ error: { message: "Invalid API key" } });
      return;
    }
    next();
  };

  // Health check (no account count to avoid info leak)
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/admin", requireApiKey);
  app.get("/admin/accounts", (_req, res) => {
    res.json({
      accounts: manager.getSnapshots(),
      account_count: manager.accountCount,
      generated_at: new Date().toISOString(),
    });
  });

  app.use("/v1", requireApiKey);
  app.get("/v1/models", (_req, res) => {
    res.json({
      object: "list",
      data: SUPPORTED_MODELS.map((id) => ({
        id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "anthropic",
      })),
    });
  });

  // Routes — OpenAI compatible
  app.post(
    "/v1/chat/completions",
    createChatCompletionsHandler(config, manager),
  );
  app.post("/v1/responses", createResponsesHandler(config, manager));

  // Routes — Anthropic native passthrough
  app.post("/v1/messages", createMessagesHandler(config, manager));
  app.post(
    "/v1/messages/count_tokens",
    createCountTokensHandler(config, manager),
  );

  return app;
}
