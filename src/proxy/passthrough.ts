import { Request, Response as ExpressResponse } from "express";
import { extractApiKey } from "../api-key";
import { Config } from "../config";
import { AccountFailureKind, AccountManager } from "../accounts/manager";
import { applyCloaking } from "./cloaking";
import { callClaudeAPI, callClaudeCountTokens } from "./claude-api";

const MAX_RETRIES = 3;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function classifyFailure(status: number): AccountFailureKind {
  if (status === 429) return "rate_limit";
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  return "server";
}

// POST /v1/messages — Claude native format passthrough
export function createMessagesHandler(config: Config, manager: AccountManager) {
  return async (req: Request, res: ExpressResponse): Promise<void> => {
    try {
      const body = req.body;
      if (!body.messages) {
        res.status(400).json({ error: { type: "invalid_request_error", message: "messages is required" } });
        return;
      }

      const stream = !!body.stream;
      const userAgent = req.headers["user-agent"] || "";
      const apiKey = extractApiKey(req.headers);

      // Apply cloaking (system prompt injection, user ID, etc.)
      const claudeBody = applyCloaking({ ...body }, config.cloaking, userAgent, apiKey);

      let lastStatus = 500;
      const refreshedAccounts = new Set<string>();
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const account = manager.getNextAccount();
        if (!account) {
          const availability = manager.getAvailability();
          if (availability.state === "cooldown") {
            res.status(429).json({ error: { type: "api_error", message: "Rate limited on the configured account" } });
          } else {
            res.status(503).json({ error: { type: "api_error", message: "No available account" } });
          }
          return;
        }

        manager.recordAttempt(account.email);

        let upstreamResp: globalThis.Response;
        try {
          upstreamResp = await callClaudeAPI(account.accessToken, claudeBody, stream);
        } catch (err: any) {
          manager.recordFailure(account.email, "network", err.message);
          if (config.debug) console.error(`Messages attempt ${attempt + 1} network failure: ${err.message}`);
          if (attempt < MAX_RETRIES - 1) {
            await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
            continue;
          }
          res.status(502).json({ error: { type: "api_error", message: "Upstream network error" } });
          return;
        }

        if (upstreamResp.ok) {
          if (stream) {
            // Pipe SSE directly — no translation needed
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            res.setHeader("X-Accel-Buffering", "no");
            res.flushHeaders();

            const reader = upstreamResp.body?.getReader();
            if (!reader) { res.end(); return; }

            let clientDisconnected = false;
            res.on("close", () => {
              clientDisconnected = true;
              reader.cancel().catch(() => {});
            });

            try {
              while (!clientDisconnected) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(Buffer.from(value));
              }
              if (!clientDisconnected) {
                manager.recordSuccess(account.email);
              }
            } catch (err) {
              if (!clientDisconnected) {
                manager.recordFailure(account.email, "network", "stream terminated before completion");
              }
              if (!clientDisconnected) console.error("Stream pipe error:", err);
            } finally {
              if (!clientDisconnected) res.end();
            }
          } else {
            // Forward JSON response directly
            const data = await upstreamResp.json();
            manager.recordSuccess(account.email);
            res.json(data);
          }
          return;
        }

        lastStatus = upstreamResp.status;
        try {
          const errText = await upstreamResp.text();
          if (config.debug) console.error(`Messages attempt ${attempt + 1} failed (${lastStatus}): ${errText}`);
        } catch { /* ignore */ }

        if (lastStatus === 401) {
          const refreshed = await manager.refreshAccount(account.email);
          if (refreshed && !refreshedAccounts.has(account.email)) {
            refreshedAccounts.add(account.email);
            attempt--;
            continue;
          }
        } else {
          manager.recordFailure(account.email, classifyFailure(lastStatus));
        }
        if (!RETRYABLE_STATUSES.has(lastStatus)) break;
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
        }
      }

      const clientMsg = lastStatus === 429 ? "Rate limited on the configured account" : "Upstream request failed";
      res.status(lastStatus).json({ error: { type: "api_error", message: clientMsg } });
    } catch (err: any) {
      console.error("Messages handler error:", err.message);
      res.status(500).json({ error: { type: "api_error", message: "Internal server error" } });
    }
  };
}

// POST /v1/messages/count_tokens — passthrough
export function createCountTokensHandler(config: Config, manager: AccountManager) {
  return async (req: Request, res: ExpressResponse): Promise<void> => {
    try {
      let lastStatus = 500;
      const refreshedAccounts = new Set<string>();
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const account = manager.getNextAccount();
        if (!account) {
          const availability = manager.getAvailability();
          if (availability.state === "cooldown") {
            res.status(429).json({ error: { type: "api_error", message: "Rate limited on the configured account" } });
          } else {
            res.status(503).json({ error: { type: "api_error", message: "No available account" } });
          }
          return;
        }

        manager.recordAttempt(account.email);

        let upstreamResp: globalThis.Response;
        try {
          upstreamResp = await callClaudeCountTokens(account.accessToken, req.body);
        } catch (err: any) {
          manager.recordFailure(account.email, "network", err.message);
          if (config.debug) console.error(`Count tokens attempt ${attempt + 1} network failure: ${err.message}`);
          if (attempt < MAX_RETRIES - 1) {
            await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
            continue;
          }
          res.status(502).json({ error: { type: "api_error", message: "Upstream network error" } });
          return;
        }

        if (upstreamResp.ok) {
          manager.recordSuccess(account.email);
          const data = await upstreamResp.json();
          res.json(data);
          return;
        }

        lastStatus = upstreamResp.status;
        if (lastStatus === 401) {
          const refreshed = await manager.refreshAccount(account.email);
          if (refreshed && !refreshedAccounts.has(account.email)) {
            refreshedAccounts.add(account.email);
            attempt--;
            continue;
          }
        } else {
          manager.recordFailure(account.email, classifyFailure(lastStatus));
        }

        if (!RETRYABLE_STATUSES.has(lastStatus)) break;
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
        }
      }

      res.status(lastStatus).json({ error: { type: "api_error", message: "Token counting failed" } });
    } catch (err: any) {
      console.error("Count tokens error:", err.message);
      res.status(500).json({ error: { type: "api_error", message: "Internal server error" } });
    }
  };
}
