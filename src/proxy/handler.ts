import crypto from "crypto";
import { Request, Response as ExpressResponse } from "express";
import { extractApiKey } from "../api-key";
import { Config, isDebugLevel } from "../config";
import { AccountFailureKind, AccountManager } from "../accounts/manager";
import { openaiToClaude, claudeToOpenai, resolveModel } from "./translator";
import { applyCloaking } from "./cloaking";
import { callClaudeAPI } from "./claude-api";
import { handleStreamingResponse } from "./streaming";
import { sendAccountUnavailable } from "./account-unavailable";

const MAX_RETRIES = 3;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function classifyFailure(status: number): AccountFailureKind {
  if (status === 429) return "rate_limit";
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  return "server";
}

export function createChatCompletionsHandler(
  config: Config,
  manager: AccountManager,
) {
  return async (req: Request, res: ExpressResponse): Promise<void> => {
    try {
      const body = req.body;
      if (
        !body.messages ||
        !Array.isArray(body.messages) ||
        body.messages.length === 0
      ) {
        res.status(400).json({
          error: {
            message: "messages is required and must be a non-empty array",
          },
        });
        return;
      }

      const stream = !!body.stream;
      const model = resolveModel(body.model || "claude-sonnet-4-6");
      const apiKey = extractApiKey(req.headers);
      const apiKeyHash = crypto
        .createHash("sha256")
        .update(apiKey)
        .digest("hex");

      // Translate OpenAI -> Claude
      const translatedBody = openaiToClaude(body);

      // Debug: log translated body before cloaking
      if (isDebugLevel(config.debug, "verbose")) {
        console.log(
          "[DEBUG] Translated OpenAI->Claude body (before cloaking):",
        );
        console.log(JSON.stringify(translatedBody, null, 2));
      }

      // Retry with account switching on retryable errors
      let lastStatus = 500;
      let lastErrBody = "";
      const refreshedAccounts = new Set<string>();
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const accountResult = manager.getNextAccount();
        const { account } = accountResult;
        if (!account) {
          sendAccountUnavailable(res, accountResult);
          return;
        }

        manager.recordAttempt(account.token.email);

        // Apply per-account cloaking (clone body so each attempt is fresh)
        const claudeBody = applyCloaking(
          structuredClone(translatedBody),
          account.deviceId,
          account.accountUuid,
          apiKeyHash,
          config.cloaking,
        );

        // Debug: log final body after cloaking
        if (isDebugLevel(config.debug, "verbose")) {
          console.log("[DEBUG] Final body after cloaking:");
          console.log(JSON.stringify(claudeBody, null, 2));
        }

        let upstreamResp: globalThis.Response;
        try {
          upstreamResp = await callClaudeAPI(
            account.token.accessToken,
            claudeBody,
            stream,
            config.timeouts,
            config.cloaking,
            apiKeyHash,
          );
        } catch (err: any) {
          manager.recordFailure(account.token.email, "network", err.message);
          if (isDebugLevel(config.debug, "errors")) {
            console.error(
              `Attempt ${attempt + 1} network failure: ${err.message}`,
            );
          }
          if (attempt < MAX_RETRIES - 1) {
            await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
            continue;
          }
          res.status(502).json({
            error: { message: "Upstream network error" },
          });
          return;
        }

        if (upstreamResp.ok) {
          if (stream) {
            const streamResult = await handleStreamingResponse(
              upstreamResp,
              res,
              model,
            );
            if (streamResult.completed) {
              manager.recordSuccess(account.token.email);
            } else if (!streamResult.clientDisconnected) {
              manager.recordFailure(
                account.token.email,
                "network",
                "stream terminated before completion",
              );
            }
          } else {
            const claudeResp = await upstreamResp.json();
            const openaiResp = claudeToOpenai(claudeResp, model);
            manager.recordSuccess(account.token.email);
            res.json(openaiResp);
          }
          return;
        }

        lastStatus = upstreamResp.status;
        try {
          lastErrBody = await upstreamResp.text();
          if (isDebugLevel(config.debug, "errors")) {
            console.error(
              `Attempt ${attempt + 1} failed (${lastStatus}): ${lastErrBody}`,
            );
          }
        } catch {
          /* ignore */
        }

        if (lastStatus === 401) {
          const refreshed = await manager.refreshAccount(account.token.email);
          if (refreshed && !refreshedAccounts.has(account.token.email)) {
            refreshedAccounts.add(account.token.email);
            attempt--;
            continue;
          }
        } else {
          manager.recordFailure(
            account.token.email,
            classifyFailure(lastStatus),
          );
        }

        // Don't retry on client errors (400, 401, 403) except rate limits
        if (!RETRYABLE_STATUSES.has(lastStatus)) break;

        // Brief delay before retry
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
        }
      }

      try {
        const parsed = lastErrBody ? JSON.parse(lastErrBody) : null;
        if (parsed && typeof parsed === "object") {
          res.status(lastStatus).json(parsed);
        } else {
          res
            .status(lastStatus)
            .json({ error: { message: "Upstream request failed" } });
        }
      } catch {
        res
          .status(lastStatus)
          .json({ error: { message: "Upstream request failed" } });
      }
    } catch (err: any) {
      console.error("Handler error:", err.message);
      res.status(500).json({ error: { message: "Internal server error" } });
    }
  };
}
