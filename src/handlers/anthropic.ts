import { Request, Response as ExpressResponse } from "express";
import { Config, isDebugLevel } from "../config";
import { AccountManager, extractUsage } from "../accounts/manager";
import { proxyWithRetry } from "../utils/http";
import { applyCloaking } from "../upstream/cloaking";
import {
  callAnthropicMessages,
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

      await proxyWithRetry("Messages", resp, config, manager, {
        upstream: (account) => {
          const anthropicBody = applyCloaking({
            request: req,
            account,
            config,
          });
          return callAnthropicMessages({
            body: anthropicBody,
            request: req,
            account,
            config,
          });
        },
        success: async (upstream, account) => {
          if (stream) {
            const result = await handleStreamingResponse(upstream, resp);
            if (result.completed) {
              manager.recordSuccess(account.token.email, result.usage);
            } else if (!result.clientDisconnected) {
              manager.recordFailure(
                account.token.email,
                "network",
                "stream terminated before completion",
              );
            }
          } else {
            const anthropicResp = await upstream.json();
            manager.recordSuccess(
              account.token.email,
              extractUsage(anthropicResp),
            );
            resp.json(anthropicResp);
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
      await proxyWithRetry("CountTokens", resp, config, manager, {
        upstream: (account) =>
          callAnthropicCountTokens({ request: req, account, config }),
        success: async (upstream, account) => {
          manager.recordSuccess(account.token.email);
          const data = await upstream.json();
          resp.json(data);
        },
      });
    } catch (err: any) {
      console.error("Count tokens error:", err.message);
      resp.status(500).json({ error: { message: "Internal server error" } });
    }
  };
}
