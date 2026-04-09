import { Request, Response as ExpressResponse } from "express";
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
import { callAnthropicMessages } from "../upstream/anthropic-api";
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
      const structured =
        body.response_format?.type === "json_object" ||
        body.response_format?.type === "json_schema";
      const translatedBody = openaiToAnthropic(body);

      if (isDebugLevel(config.debug, "verbose")) {
        console.log(
          "[DEBUG] Translated OpenAI->Anthropic body (before cloaking):",
        );
        console.log(JSON.stringify(translatedBody, null, 2));
      }

      await proxyWithRetry("ChatCompletions", resp, config, manager, {
        upstream: (account) => {
          const anthropicBody = applyCloaking({
            body: translatedBody,
            request: req,
            account,
            config,
          });
          return callAnthropicMessages({
            body: anthropicBody,
            request: req,
            account,
            config,
            structured,
          });
        },
        success: async (upstream, account) => {
          if (stream) {
            const includeUsage = body.stream_options?.include_usage !== false;
            const state = createStreamState(model, includeUsage);
            const result = await handleStreamingResponse(upstream, resp, {
              onEvent: (event, data, usage) =>
                anthropicSSEToChat(event, data, state, usage).map(
                  (c) => `data: ${c}\n\n`,
                ),
            });
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
      const structured =
        body.text?.format?.type === "json_object" ||
        body.text?.format?.type === "json_schema";
      const translatedBody = responsesToAnthropic(body);

      await proxyWithRetry("Responses", resp, config, manager, {
        upstream: (account) => {
          const anthropicBody = applyCloaking({
            body: translatedBody,
            request: req,
            account,
            config,
          });
          return callAnthropicMessages({
            body: anthropicBody,
            request: req,
            account,
            config,
            structured,
          });
        },
        success: async (upstream, account) => {
          if (stream) {
            const state = makeResponsesState();
            const streamResp = await handleStreamingResponse(upstream, resp, {
              onEvent: (event, data, usage) =>
                anthropicSSEToResponses(event, data, state, model, usage),
            });
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
            const anthropicResp = await upstream.json();
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
