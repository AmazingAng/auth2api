import { Request, Response as ExpressResponse } from "express";
import { extractApiKey } from "../api-key";
import { Config } from "../config";
import { AccountFailureKind, AccountManager } from "../accounts/manager";
import { openaiToClaude, claudeToOpenai, resolveModel } from "./translator";
import { applyCloaking } from "./cloaking";
import { callClaudeAPI } from "./claude-api";
import { handleStreamingResponse } from "./streaming";

const MAX_RETRIES = 3;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function classifyFailure(status: number): AccountFailureKind {
  if (status === 429) return "rate_limit";
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  return "server";
}

export function createChatCompletionsHandler(config: Config, manager: AccountManager) {
  return async (req: Request, res: ExpressResponse): Promise<void> => {
    try {
      const body = req.body;
      if (!body.messages || !Array.isArray(body.messages)) {
        res.status(400).json({ error: { message: "messages is required" } });
        return;
      }

      const stream = !!body.stream;
      const model = resolveModel(body.model || "claude-sonnet-4-20250514");
      const userAgent = req.headers["user-agent"] || "";
      const apiKey = extractApiKey(req.headers);

      // Translate OpenAI -> Claude
      let claudeBody = openaiToClaude(body);
      claudeBody = applyCloaking(claudeBody, config.cloaking, userAgent, apiKey);

      // Retry with account switching on retryable errors
      let lastStatus = 500;
      const refreshedAccounts = new Set<string>();
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const account = manager.getNextAccount();
        if (!account) {
          const availability = manager.getAvailability();
          if (availability.state === "cooldown") {
            res.status(429).json({
              error: {
                message: "Rate limited on the configured account",
                type: "upstream_error",
              },
            });
          } else {
            res.status(503).json({ error: { message: "No available account" } });
          }
          return;
        }

        manager.recordAttempt(account.email);

        let upstreamResp: globalThis.Response;
        try {
          upstreamResp = await callClaudeAPI(account.accessToken, claudeBody, stream);
        } catch (err: any) {
          manager.recordFailure(account.email, "network", err.message);
          if (config.debug) console.error(`Attempt ${attempt + 1} network failure: ${err.message}`);
          if (attempt < MAX_RETRIES - 1) {
            await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
            continue;
          }
          res.status(502).json({ error: { message: "Upstream network error", type: "upstream_error" } });
          return;
        }

        if (upstreamResp.ok) {
          if (stream) {
            const streamResult = await handleStreamingResponse(upstreamResp, res, model);
            if (streamResult.completed) {
              manager.recordSuccess(account.email);
            } else if (!streamResult.clientDisconnected) {
              manager.recordFailure(account.email, "network", "stream terminated before completion");
            }
          } else {
            const claudeResp = await upstreamResp.json();
            const openaiResp = claudeToOpenai(claudeResp, model);
            manager.recordSuccess(account.email);
            res.json(openaiResp);
          }
          return;
        }

        lastStatus = upstreamResp.status;
        try {
          const errText = await upstreamResp.text();
          if (config.debug) console.error(`Attempt ${attempt + 1} failed (${lastStatus}): ${errText}`);
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

        // Don't retry on client errors (400, 401, 403) except rate limits
        if (!RETRYABLE_STATUSES.has(lastStatus)) break;

        // Brief delay before retry
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
        }
      }

      const clientMsg = lastStatus === 429 ? "Rate limited on the configured account"
        : lastStatus === 401 ? "Authentication error"
        : "Upstream request failed";
      res.status(lastStatus).json({ error: { message: clientMsg, type: "upstream_error" } });
    } catch (err: any) {
      console.error("Handler error:", err.message);
      res.status(500).json({ error: { message: "Internal server error" } });
    }
  };
}
