import { Request, Response as ExpressResponse } from "express";
import { extractApiKey, hashApiKey } from "../utils/common";
import { Config, isDebugLevel } from "../config";
import { AccountManager, extractUsage } from "../accounts/manager";
import { proxyWithRetry } from "../utils/http";
import {
  resolveModel,
  openaiToAnthropic,
  anthropicToOpenai,
  createStreamState,
  anthropicSSEToChat,
  responsesToAnthropic,
  anthropicToResponses,
  makeResponsesState,
  anthropicSSEToResponses,
} from "../upstream/translator";
import { applyCloaking } from "../upstream/cloaking";
import { callAnthropicAPI } from "../upstream/anthropic-api";
import { handleStreamingResponse } from "../upstream/streaming";

// POST /v1/chat/completions — OpenAI Chat Completions format
export function createChatCompletionsHandler(
  config: Config,
  manager: AccountManager,
) {
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

      const stream = !!body.stream;
      const model = resolveModel(body.model || "claude-sonnet-4-6");
      const apiKeyHash = hashApiKey(extractApiKey(req.headers));
      const translatedBody = openaiToAnthropic(body);

      if (isDebugLevel(config.debug, "verbose")) {
        console.log(
          "[DEBUG] Translated OpenAI->Anthropic body (before cloaking):",
        );
        console.log(JSON.stringify(translatedBody, null, 2));
      }

      await proxyWithRetry(resp, config, manager, {
        logPrefix: "ChatCompletions",
        upstream: (account) => {
          const anthropicBody = applyCloaking(
            translatedBody,
            account.deviceId,
            account.accountUuid,
            apiKeyHash,
            config.cloaking,
          );
          return callAnthropicAPI(
            account.token.accessToken,
            anthropicBody,
            stream,
            config.timeouts,
            config.cloaking,
            apiKeyHash,
          );
        },
        success: async (upstreamResp, account) => {
          if (stream) {
            const includeUsage = body.stream_options?.include_usage !== false;
            const state = createStreamState(model, includeUsage);
            const streamResp = await handleStreamingResponse(
              upstreamResp,
              resp,
              {
                onEvent: (event, data, usage) =>
                  anthropicSSEToChat(event, data, state, usage).map(
                    (c) => `data: ${c}\n\n`,
                  ),
              },
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
            const anthropicResp = await upstreamResp.json();
            manager.recordSuccess(
              account.token.email,
              extractUsage(anthropicResp),
            );
            resp.json(anthropicToOpenai(anthropicResp, model));
          }
        },
      });
    } catch (err: any) {
      console.error("Handler error:", err.message);
      resp.status(500).json({ error: { message: "Internal server error" } });
    }
  };
}

// POST /v1/responses — OpenAI Responses API format
export function createResponsesHandler(
  config: Config,
  manager: AccountManager,
) {
  return async (req: Request, resp: ExpressResponse): Promise<void> => {
    try {
      const body = req.body;
      if (!body.input && !body.messages) {
        resp.status(400).json({ error: { message: "input is required" } });
        return;
      }

      const stream = !!body.stream;
      const model = resolveModel(body.model || "claude-sonnet-4-6");
      const apiKeyHash = hashApiKey(extractApiKey(req.headers));
      const translatedBody = responsesToAnthropic(body);

      await proxyWithRetry(resp, config, manager, {
        logPrefix: "Responses",
        upstream: (account) => {
          const anthropicBody = applyCloaking(
            translatedBody,
            account.deviceId,
            account.accountUuid,
            apiKeyHash,
            config.cloaking,
          );
          return callAnthropicAPI(
            account.token.accessToken,
            anthropicBody,
            stream,
            config.timeouts,
            config.cloaking,
            apiKeyHash,
          );
        },
        success: async (upstreamResp, account) => {
          if (stream) {
            const state = makeResponsesState();
            const streamResp = await handleStreamingResponse(
              upstreamResp,
              resp,
              {
                onEvent: (event, data, usage) =>
                  anthropicSSEToResponses(event, data, state, model, usage),
              },
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
            const anthropicResp = await upstreamResp.json();
            manager.recordSuccess(
              account.token.email,
              extractUsage(anthropicResp),
            );
            resp.json(anthropicToResponses(anthropicResp, model));
          }
        },
      });
    } catch (err: any) {
      console.error("Responses handler error:", err.message);
      resp.status(500).json({ error: { message: "Internal server error" } });
    }
  };
}
