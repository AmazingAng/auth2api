import { Request, Response as ExpressResponse } from "express";
import { extractApiKey, hashApiKey } from "../utils/common";
import { Config, isDebugLevel } from "../config";
import { AccountManager, extractUsage } from "../accounts/manager";
import { proxyWithRetry } from "../utils/http";
import { applyCloaking } from "../upstream/cloaking";
import {
  callAnthropicAPI,
  callAnthropicCountTokens,
} from "../upstream/anthropic-api";
import { handleStreamingResponse } from "../upstream/streaming";

// POST /v1/messages — Anthropic native format passthrough
export function createMessagesHandler(config: Config, manager: AccountManager) {
  return async (req: Request, resp: ExpressResponse): Promise<void> => {
    try {
      const body = req.body;
      if (
        !body.messages ||
        !Array.isArray(body.messages) ||
        body.messages.length === 0
      ) {
        resp.status(400).json({
          error: {
            message: "messages is required and must be a non-empty array",
          },
        });
        return;
      }

      if (isDebugLevel(config.debug, "verbose")) {
        console.log("[DEBUG] Incoming /v1/messages body:");
        console.log(JSON.stringify(body, null, 2));
      }

      const stream = !!body.stream;
      const apiKeyHash = hashApiKey(extractApiKey(req.headers));

      // When request comes from claude-cli, pass through anthropic-* and session headers
      const userAgent = req.headers["user-agent"] || "";
      let passthroughHeaders: Record<string, string> | undefined;
      let overrideSessionId: string | undefined;
      if (
        typeof userAgent === "string" &&
        userAgent.toLowerCase().startsWith("claude-cli")
      ) {
        passthroughHeaders = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if (key.startsWith("anthropic") && typeof value === "string") {
            passthroughHeaders[key] = value;
          }
        }
        const sessionId = req.headers["x-claude-code-session-id"];
        if (typeof sessionId === "string") {
          passthroughHeaders["X-Claude-Code-Session-Id"] = sessionId;
          overrideSessionId = sessionId;
        }
      }

      await proxyWithRetry(resp, config, manager, {
        logPrefix: "Messages",
        upstream: (account) => {
          const anthropicBody = applyCloaking(
            body,
            account.deviceId,
            account.accountUuid,
            apiKeyHash,
            config.cloaking,
            overrideSessionId,
          );
          return callAnthropicAPI(
            account.token.accessToken,
            anthropicBody,
            stream,
            config.timeouts,
            config.cloaking,
            apiKeyHash,
            passthroughHeaders,
          );
        },
        success: async (upstreamResp, account) => {
          if (stream) {
            const streamResp = await handleStreamingResponse(
              upstreamResp,
              resp,
            );
            if (streamResp.completed) {
              manager.recordSuccess(account.token.email, streamResp.usage);
            } else if (!streamResp.clientDisconnected) {
              manager.recordFailure(
                account.token.email,
                "network",
                "stream terminated before completion",
              );
            }
          } else {
            const data = await upstreamResp.json();
            manager.recordSuccess(account.token.email, extractUsage(data));
            resp.json(data);
          }
        },
      });
    } catch (err: any) {
      console.error("Messages handler error:", err.message);
      resp.status(500).json({ error: { message: "Internal server error" } });
    }
  };
}

// POST /v1/messages/count_tokens — passthrough
export function createCountTokensHandler(
  config: Config,
  manager: AccountManager,
) {
  return async (req: Request, resp: ExpressResponse): Promise<void> => {
    try {
      const apiKeyHash = hashApiKey(extractApiKey(req.headers));

      await proxyWithRetry(resp, config, manager, {
        logPrefix: "CountTokens",
        upstream: (account) =>
          callAnthropicCountTokens(
            account.token.accessToken,
            req.body,
            config.timeouts,
            config.cloaking,
            apiKeyHash,
          ),
        success: async (upstreamResp, account) => {
          manager.recordSuccess(account.token.email);
          const data = await upstreamResp.json();
          resp.json(data);
        },
      });
    } catch (err: any) {
      console.error("Count tokens error:", err.message);
      resp.status(500).json({ error: { message: "Internal server error" } });
    }
  };
}
