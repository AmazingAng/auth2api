import express from "express";
import { Config, isDebugLevel } from "./config";
import { ProviderRegistry } from "./providers/registry";
import { extractApiKey, hashApiKey } from "./utils/common";
import {
  createChatCompletionsHandler,
  createResponsesCompactHandler,
  createResponsesHandler,
} from "./handlers/openai";
import {
  createImageEditsHandler,
  createImageGenerationsHandler,
} from "./handlers/images";
import {
  createMessagesHandler,
  createCountTokensHandler,
} from "./handlers/anthropic";
import { StatsRecorder } from "./stats/recorder";

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
  registry: ProviderRegistry,
  statsRecorder?: StatsRecorder,
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
    // Seed res.locals.stats so the stats-finish middleware can record this
    // request even if the downstream handler aborts before filling in the
    // upstream account / model / usage fields.
    if (statsRecorder) {
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const ua = (req.headers["user-agent"] as string) || "";
      res.locals.stats = {
        apiKeyHash: hashApiKey(key),
        ip,
        ua,
        endpoint: `${req.method} ${req.baseUrl}${req.path}`,
        startedAt: Date.now(),
        model: null,
        provider: null,
        accountEmail: null,
        usage: null,
        failureKind: null,
      };
    }
    next();
  };

  // Record one stats event per request that made it past auth. `finish`
  // covers normal responses; `close` covers client disconnects before the
  // response completed. A guard prevents the normal finish->close sequence
  // from double-counting.
  const statsFinishMiddleware: express.RequestHandler = (req, res, next) => {
    if (!statsRecorder) return next();
    let recorded = false;
    const recordStats = (override?: {
      status: "success" | "failure";
      statusCode: number;
      failureKind: string | null;
    }) => {
      if (recorded) return;
      recorded = true;
      const ctx = res.locals.stats as
        | {
            apiKeyHash: string;
            ip: string;
            ua: string;
            endpoint: string;
            startedAt: number;
            model: string | null;
            provider: string | null;
            accountEmail: string | null;
            usage: any;
            failureKind: string | null;
          }
        | undefined;
      if (!ctx) return;
      const status: "success" | "failure" =
        override?.status ??
        (res.statusCode >= 200 && res.statusCode < 300 ? "success" : "failure");
      statsRecorder.record({
        apiKeyHash: ctx.apiKeyHash,
        ip: ctx.ip,
        ua: ctx.ua,
        endpoint: ctx.endpoint,
        model: ctx.model,
        provider: ctx.provider as any,
        accountEmail: ctx.accountEmail,
        status,
        failureKind: override?.failureKind ?? ctx.failureKind,
        statusCode: override?.statusCode ?? res.statusCode,
        latencyMs: Date.now() - ctx.startedAt,
        usage: ctx.usage,
      });
    };
    res.on("finish", () => recordStats());
    res.on("close", () => {
      if (!res.writableEnded) {
        recordStats({
          status: "failure",
          statusCode: 499,
          failureKind: "client_disconnect",
        });
      }
    });
    next();
  };

  // Health check (no account count to avoid info leak)
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/admin", requireApiKey);
  app.use("/admin", statsFinishMiddleware);

  // GET /admin/stats — three-axis aggregated call statistics.
  //   byClient — keyed by sha256(api-key); show short hex prefix to operator
  //   byAccount — keyed by `${provider}:${email}` (upstream OAuth account)
  //   byApi — keyed by `${endpoint}|${model}|${provider}`
  app.get("/admin/stats", (_req, res) => {
    if (!statsRecorder) {
      res.json({ enabled: false });
      return;
    }
    res.json({
      ...statsRecorder.getSnapshot(),
      generated_at: new Date().toISOString(),
    });
  });

  app.get("/admin/accounts", (_req, res) => {
    const providers: Record<
      string,
      { accounts: unknown[]; account_count: number }
    > = {};
    for (const p of registry.all()) {
      providers[p.id] = {
        accounts: p.manager.getSnapshots(),
        account_count: p.manager.accountCount,
      };
    }
    res.json({
      providers,
      generated_at: new Date().toISOString(),
    });
  });

  // POST /admin/reload — re-reads token files from auth-dir and reconciles
  // each provider's in-memory state. Called automatically by `--login` after
  // a successful re-auth (see notifyServerReload in src/index.ts), and
  // available for manual use via curl. See AccountManager.reload() for
  // upsert semantics.
  app.post("/admin/reload", async (_req, res) => {
    const reloaded: Record<string, unknown> = {};
    for (const p of registry.all()) {
      try {
        reloaded[p.id] = await p.manager.reload();
      } catch (err: any) {
        reloaded[p.id] = { error: err?.message || String(err) };
      }
    }
    res.json({
      reloaded,
      generated_at: new Date().toISOString(),
    });
  });

  app.use(["/v1", "/codex", "/backend-api/codex"], requireApiKey);
  app.use(["/v1", "/codex", "/backend-api/codex"], statsFinishMiddleware);
  app.get("/v1/models", async (_req, res) => {
    const created = Math.floor(Date.now() / 1000);
    const providers = registry.withAccounts();
    const lists = await Promise.all(providers.map((p) => p.listModels()));
    const data = lists.flatMap((models) =>
      models.map((m) => ({
        id: m.id,
        object: "model",
        created,
        owned_by: m.owned_by,
      })),
    );
    res.json({ object: "list", data });
  });

  // Routes — OpenAI compatible
  app.post(
    "/v1/chat/completions",
    createChatCompletionsHandler(config, registry),
  );
  app.post("/v1/responses", createResponsesHandler(config, registry));
  app.post(
    "/v1/responses/compact",
    createResponsesCompactHandler(config, registry),
  );
  app.post(
    "/codex/responses/compact",
    createResponsesCompactHandler(config, registry),
  );
  app.post(
    "/backend-api/codex/responses/compact",
    createResponsesCompactHandler(config, registry),
  );
  app.post(
    "/v1/images/generations",
    createImageGenerationsHandler(config, registry),
  );
  app.post(
    "/v1/images/edits",
    express.raw({ type: "multipart/form-data", limit: config["body-limit"] }),
    createImageEditsHandler(config, registry),
  );

  // Routes — Anthropic native passthrough
  app.post("/v1/messages", createMessagesHandler(config, registry));
  app.post(
    "/v1/messages/count_tokens",
    createCountTokensHandler(config, registry),
  );

  return app;
}
