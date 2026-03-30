import crypto from "crypto";
import express from "express";
import { Config, isDebugLevel } from "./config";
import { AccountManager } from "./accounts/manager";
import { extractApiKey } from "./api-key";
import { ClaudeProvider } from "./providers/claude";

// Timing-safe API key comparison
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Compare dummy against itself to consume constant time
    const dummy = Buffer.alloc(bufB.length);
    crypto.timingSafeEqual(dummy, dummy);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

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
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
}, 5 * 60 * 1000);
cleanupTimer.unref();

export function createServer(config: Config, manager: AccountManager): express.Application {
  const app = express();
  const claudeProvider = new ClaudeProvider(config, manager);

  app.use(express.json({ limit: config["body-limit"] }));

  if (isDebugLevel(config.debug, "verbose")) {
    app.use((req, res, next) => {
      const startedAt = Date.now();
      console.error(`[debug] ${req.method} ${req.originalUrl} started`);
      res.on("finish", () => {
        console.error(
          `[debug] ${req.method} ${req.originalUrl} -> ${res.statusCode} in ${Date.now() - startedAt}ms`
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
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key");
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
    const valid = config["api-keys"].some((k) => safeCompare(key, k));
    if (!valid) {
      res.status(403).json({ error: { message: "Invalid API key" } });
      return;
    }
    next();
  };

  app.use("/v1", requireApiKey);
  app.use("/admin", requireApiKey);

  // Routes — OpenAI compatible
  app.post("/v1/chat/completions", claudeProvider.handleChatCompletions());
  app.post("/v1/responses", claudeProvider.handleResponses());

  // Routes — Claude native passthrough
  app.post("/v1/messages/count_tokens", claudeProvider.handleCountTokens());
  app.post("/v1/messages", claudeProvider.handleMessages());

  app.get("/v1/models", (_req, res) => {
    res.json({
      object: "list",
      data: claudeProvider.listModels().map((model) => ({
        id: model.id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: model.ownedBy,
      })),
    });
  });

  // Health check (no account count to avoid info leak)
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/admin/accounts", (_req, res) => {
    res.json({
      accounts: manager.getSnapshots(),
      account_count: manager.accountCount,
      generated_at: new Date().toISOString(),
    });
  });

  return app;
}
