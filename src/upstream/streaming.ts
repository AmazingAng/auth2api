import { Response as ExpressResponse } from "express";
import { UsageData } from "../accounts/manager";

export type SSEEventHandler = (
  event: string,
  data: any,
  usage: UsageData,
) => string[];

export interface StreamOptions {
  onEvent: SSEEventHandler;
  rawPassthrough?: boolean;
  finalChunk?: string;
}

export interface StreamResult {
  completed: boolean;
  clientDisconnected: boolean;
  usage: UsageData;
}

function extractUsageFromSSE(event: string, data: any, usage: UsageData): void {
  if (event === "message_start") {
    const u = data.message?.usage;
    usage.inputTokens = u?.input_tokens || 0;
    usage.cacheCreationInputTokens = u?.cache_creation_input_tokens || 0;
    usage.cacheReadInputTokens = u?.cache_read_input_tokens || 0;
  } else if (event === "message_delta") {
    usage.outputTokens = data.usage?.output_tokens || 0;
  }
}

export async function handleStreamingResponse(
  upstreamResp: Response,
  res: ExpressResponse,
  options: StreamOptions,
): Promise<StreamResult> {
  const usage: UsageData = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const reader = upstreamResp.body?.getReader();
  if (!reader) {
    if (options.finalChunk) res.write(options.finalChunk);
    res.end();
    return { completed: true, clientDisconnected: false, usage };
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";
  let clientDisconnected = false;
  let completed = false;

  res.on("close", () => {
    clientDisconnected = true;
    reader.cancel().catch(() => {});
  });

  try {
    while (!clientDisconnected) {
      const { done, value } = await reader.read();
      if (done) break;

      if (options.rawPassthrough) {
        res.write(Buffer.from(value));
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (clientDisconnected) break;
        if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          const raw = line.slice(5).trim();
          if (!raw || raw === "[DONE]") continue;
          try {
            const data = JSON.parse(raw);
            extractUsageFromSSE(currentEvent, data, usage);
            if (!options.rawPassthrough) {
              const chunks = options.onEvent(currentEvent, data, usage);
              for (const c of chunks) {
                if (!clientDisconnected) res.write(c);
              }
            }
          } catch {
            /* ignore parse errors */
          }
        }
      }
    }
    completed = true;
  } catch (err) {
    if (!clientDisconnected) console.error("Stream error:", err);
  } finally {
    if (!clientDisconnected) {
      if (options.finalChunk) res.write(options.finalChunk);
      res.end();
    }
  }

  return { completed, clientDisconnected, usage };
}
