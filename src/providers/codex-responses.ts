import express from "express";
import { v4 as uuidv4 } from "uuid";
import { CodexAuthError, CodexAuthStore } from "./codex-auth";
import { normalizeCodexRequestBody } from "./codex-request";
import { collectCodexResponseFromSse } from "./codex-sse";
import { callCodexResponses } from "./codex-upstream";

function normalizeOutput(upstream: any): any[] {
  if (Array.isArray(upstream?.output)) {
    return upstream.output;
  }
  if (Array.isArray(upstream?.content)) {
    return [{
      type: "message",
      id: `msg_${uuidv4().replace(/-/g, "")}`,
      role: "assistant",
      status: "completed",
      content: upstream.content,
    }];
  }
  return [];
}

function normalizeUsage(upstream: any): {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
} {
  const inputTokens = upstream?.usage?.input_tokens || 0;
  const outputTokens = upstream?.usage?.output_tokens || 0;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: upstream?.usage?.total_tokens || inputTokens + outputTokens,
  };
}

function normalizeResponse(upstream: any, model: string): any {
  return {
    id: upstream?.id || `resp_${uuidv4().replace(/-/g, "")}`,
    object: upstream?.object || "response",
    created_at: upstream?.created_at || Math.floor(Date.now() / 1000),
    status: upstream?.status || "completed",
    model: upstream?.model || model,
    output: normalizeOutput(upstream),
    usage: normalizeUsage(upstream),
  };
}

function authErrorResponse(message: string): { status: number; body: { error: { message: string } } } {
  return {
    status: 503,
    body: { error: { message } },
  };
}

async function streamCodexResponses(upstreamResp: Response, res: express.Response): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const reader = upstreamResp.body?.getReader();
  if (!reader) {
    res.end();
    return;
  }

  const decoder = new TextDecoder();
  let clientDisconnected = false;
  res.on("close", () => {
    clientDisconnected = true;
    reader.cancel().catch(() => {});
  });

  try {
    while (!clientDisconnected) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!clientDisconnected && value) {
        res.write(decoder.decode(value, { stream: true }));
      }
    }
  } finally {
    if (!clientDisconnected) {
      res.end();
    }
  }
}

export function createCodexResponsesHandler(authStore: CodexAuthStore): express.RequestHandler {
  return async (req, res): Promise<void> => {
    try {
      const body = normalizeCodexRequestBody(req.body || {});
      const clientStream = !!body.stream;
      const upstreamBody = {
        ...body,
        stream: true,
      };

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

      const upstreamResp = await callCodexResponses(snapshot.accessToken, upstreamBody, true);
      if (!upstreamResp.ok) {
        const text = await upstreamResp.text().catch(() => "");
        res.status(upstreamResp.status).json({
          error: { message: text || "Codex upstream request failed" },
        });
        return;
      }

      if (clientStream) {
        await streamCodexResponses(upstreamResp, res);
        return;
      }

      const upstreamJson = await collectCodexResponseFromSse(upstreamResp);
      res.json(normalizeResponse(upstreamJson, body.model || upstreamJson?.model || "gpt-5.4"));
    } catch (error: any) {
      res.status(500).json({ error: { message: error?.message || "Internal server error" } });
    }
  };
}
