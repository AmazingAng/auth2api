import crypto from "crypto";
import express from "express";
import { Config, isDebugLevel } from "./config";
import { AccountManager } from "./accounts/manager";
import { extractApiKey } from "./api-key";
import { ClaudeProvider } from "./providers/claude";
import { CodexProvider } from "./providers/codex";
import { resolveProviderFromModel } from "./providers/router";

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
  const codexProvider = new CodexProvider(config);
  const routeByModel =
    (
      claudeHandler: express.RequestHandler,
      codexHandler: express.RequestHandler
    ): express.RequestHandler =>
    (req, res, next) => {
      const model = req.body?.model;
      const provider = resolveProviderFromModel(model);

      if (provider === "codex") {
        if (!codexProvider.supportsModel(model)) {
          res.status(400).json({ error: { message: `Unsupported model: ${String(model)}` } });
          return;
        }
        codexHandler(req, res, next);
        return;
      }

      if (provider === "claude") {
        claudeHandler(req, res, next);
        return;
      }

      if (claudeProvider.supportsModel(model)) {
        claudeHandler(req, res, next);
        return;
      }

      if (codexProvider.supportsModel(model)) {
        codexHandler(req, res, next);
        return;
      }

      res.status(400).json({ error: { message: `Unsupported model: ${String(model)}` } });
      return;
    };

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
  app.post(
    "/v1/chat/completions",
    routeByModel(claudeProvider.handleChatCompletions(), codexProvider.handleChatCompletions())
  );
  app.post(
    "/v1/responses",
    routeByModel(claudeProvider.handleResponses(), codexProvider.handleResponses())
  );

  // Routes — Claude native passthrough
  app.post("/v1/messages/count_tokens", claudeProvider.handleCountTokens());
  app.post("/v1/messages", claudeProvider.handleMessages());

  app.get("/v1/models", (_req, res) => {
    const models = [...claudeProvider.listModels(), ...codexProvider.listModels()];
    res.json({
      object: "list",
      data: models.map((model) => ({
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
    const claudeStatus = claudeProvider.getStatus();
    const codexStatus = codexProvider.getStatus();
    res.json({
      accounts: manager.getSnapshots(),
      account_count: manager.accountCount,
      claude: claudeStatus,
      codex: codexStatus,
      generated_at: new Date().toISOString(),
    });
  });

  return app;
}
