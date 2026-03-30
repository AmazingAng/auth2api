import express from "express";
import { v4 as uuidv4 } from "uuid";
import { CodexAuthError, CodexAuthStore } from "./codex-auth";
import { normalizeCodexRequestBody } from "./codex-request";
import { collectCodexResponseFromSse } from "./codex-sse";
import { callCodexResponses } from "./codex-upstream";

function authErrorResponse(message: string): { status: number; body: { error: { message: string } } } {
  return {
    status: 503,
    body: { error: { message } },
  };
}

function normalizeMessageContent(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part: any) => {
        if (part?.type === "text" || part?.type === "input_text" || part?.type === "output_text") {
          return typeof part.text === "string" ? part.text : "";
        }
        return "";
      })
      .join("");
    return text || null;
  }

  return null;
}

function normalizeOutputText(upstream: any): string {
  if (Array.isArray(upstream?.output)) {
    for (const item of upstream.output) {
      if (item?.role !== "assistant" && item?.type !== "message") {
        continue;
      }
      const text = normalizeMessageContent(item?.content);
      if (text) {
        return text;
      }
    }
  }

  if (typeof upstream?.content === "string") {
    return upstream.content;
  }

  if (Array.isArray(upstream?.content)) {
    const text = normalizeMessageContent(upstream.content);
    if (text) {
      return text;
    }
  }

  return "";
}

function normalizeUsage(upstream: any): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  const promptTokens = upstream?.usage?.input_tokens || 0;
  const completionTokens = upstream?.usage?.output_tokens || 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: upstream?.usage?.total_tokens || promptTokens + completionTokens,
  };
}

function emitChatChunk(
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
): string {
  const chunk: any = {
    id: `chatcmpl-${uuidv4()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  };

  if (usage) {
    chunk.usage = usage;
  }

  return JSON.stringify(chunk);
}

function writeSseData(res: express.Response, data: string): void {
  res.write(`data: ${data}\n\n`);
}

function mapFinishReason(status: any): string {
  if (status === "incomplete") {
    return "length";
  }
  return "stop";
}

function normalizeResponse(upstream: any, model: string): any {
  const completionText = normalizeOutputText(upstream);
  return {
    id: `chatcmpl-${uuidv4()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: upstream?.model || model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: completionText,
        },
        finish_reason: upstream?.status === "incomplete" ? "length" : "stop",
      },
    ],
    usage: normalizeUsage(upstream),
  };
}

function canonicalizeChatRequest(body: any, stream: boolean): any {
  const input = Array.isArray(body?.messages)
    ? body.messages.map((message: any) => ({
        role: message.role,
        content: message.content,
      }))
    : [];

  return normalizeCodexRequestBody({
    model: body?.model || "gpt-5.4",
    input,
    stream,
  });
}

async function streamCodexChatResponses(upstreamResp: Response, res: express.Response, model: string): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const reader = upstreamResp.body?.getReader();
  if (!reader) {
    writeSseData(res, "[DONE]");
    res.end();
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";
  let sentRoleChunk = false;
  let sentFinalChunk = false;
  let sentDone = false;
  let clientDisconnected = false;
  let pendingUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
  let pendingFinishReason: string | null = null;

  res.on("close", () => {
    clientDisconnected = true;
    reader.cancel().catch(() => {});
  });

  try {
    while (!clientDisconnected) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const rawLine of lines) {
        if (clientDisconnected) break;

        const line = rawLine.trimEnd();
        if (!line) {
          currentEvent = "";
          continue;
        }

        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
          continue;
        }

        if (!line.startsWith("data:")) {
          continue;
        }

        const dataStr = line.slice(5).trimStart();
        if (dataStr === "[DONE]") {
          continue;
        }

        let data: any;
        try {
          data = JSON.parse(dataStr);
        } catch {
          continue;
        }

        if (currentEvent === "response.created") {
          if (!sentRoleChunk) {
            writeSseData(res, emitChatChunk(model, { role: "assistant" }));
            sentRoleChunk = true;
          }
          continue;
        }

        if (currentEvent === "response.output_text.delta") {
          if (!sentRoleChunk) {
            writeSseData(res, emitChatChunk(model, { role: "assistant" }));
            sentRoleChunk = true;
          }
          const delta = typeof data?.delta === "string" ? data.delta : "";
          if (delta) {
            writeSseData(res, emitChatChunk(model, { content: delta }));
          }
          continue;
        }

        if (currentEvent === "response.completed") {
          const upstreamResponse = data?.response || data;
          const usage = upstreamResponse?.usage || data?.usage;
          pendingUsage = usage
            ? {
                prompt_tokens: usage.input_tokens || 0,
                completion_tokens: usage.output_tokens || 0,
                total_tokens: usage.total_tokens || (usage.input_tokens || 0) + (usage.output_tokens || 0),
              }
            : pendingUsage;
          pendingFinishReason = mapFinishReason(upstreamResponse?.status || data?.status);
          if (!sentFinalChunk) {
            writeSseData(
              res,
              emitChatChunk(model, {}, pendingFinishReason || "stop", pendingUsage)
            );
            sentFinalChunk = true;
          }
          continue;
        }

        if (currentEvent === "response.done") {
          if (!sentDone) {
            writeSseData(res, "[DONE]");
            sentDone = true;
          }
          continue;
        }
      }
    }
  } finally {
    if (!clientDisconnected) {
      if (!sentFinalChunk) {
        writeSseData(res, emitChatChunk(model, {}, pendingFinishReason || "stop", pendingUsage));
      }
      if (!sentDone) {
        writeSseData(res, "[DONE]");
      }
      res.end();
    }
  }
}

export function createCodexChatCompletionsHandler(authStore: CodexAuthStore): express.RequestHandler {
  return async (req, res): Promise<void> => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.messages)) {
        res.status(400).json({ error: { message: "messages is required" } });
        return;
      }

      let snapshot;
      try {
        snapshot = authStore.load();
      } catch (error) {
        if (error instanceof CodexAuthError) {
          const authError = authErrorResponse(error.message);
          res.status(authError.status).json(authError.body);
          return;
        }
        throw error;
      }

      const stream = !!body.stream;
      const canonicalRequest = canonicalizeChatRequest(body, stream);
      const upstreamRequest = {
        ...canonicalRequest,
        stream: true,
      };
      const upstreamResp = await callCodexResponses(snapshot.accessToken, upstreamRequest, true);
      if (!upstreamResp.ok) {
        const text = await upstreamResp.text().catch(() => "");
        res.status(upstreamResp.status).json({
          error: { message: text || "Codex upstream request failed" },
        });
        return;
      }

      if (stream) {
        await streamCodexChatResponses(upstreamResp, res, canonicalRequest.model);
        return;
      }

      const upstreamJson = await collectCodexResponseFromSse(upstreamResp);
      res.json(normalizeResponse(upstreamJson, canonicalRequest.model));
    } catch (error: any) {
      res.status(500).json({ error: { message: error?.message || "Internal server error" } });
    }
  };
}
