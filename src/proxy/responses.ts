import crypto from "crypto";
import { Request, Response as ExpressResponse } from "express";
import { v4 as uuidv4 } from "uuid";
import { extractApiKey } from "../api-key";
import { Config, isDebugLevel } from "../config";
import { AccountFailureKind, AccountManager } from "../accounts/manager";
import { applyCloaking } from "./cloaking";
import { callClaudeAPI } from "./claude-api";
import { resolveModel } from "./translator";
import { sendAccountUnavailable } from "./account-unavailable";

const MAX_RETRIES = 3;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function classifyFailure(status: number): AccountFailureKind {
  if (status === 429) return "rate_limit";
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  return "server";
}

const EFFORT_TO_BUDGET: Record<string, number> = {
  none: 0,
  low: 1024,
  medium: 8192,
  high: 24576,
  xhigh: 32768,
};

// ── OpenAI Responses API request → Claude Messages request ──

function responsesToClaude(body: any): any {
  const model = resolveModel(body.model || "claude-sonnet-4-6");
  const claudeBody: any = {
    model,
    max_tokens: body.max_output_tokens || 8192,
    stream: !!body.stream,
  };

  // reasoning.effort → Claude thinking
  const effort = body.reasoning?.effort;
  if (effort && effort !== "none") {
    const budget = EFFORT_TO_BUDGET[effort];
    if (budget) {
      claudeBody.thinking = { type: "enabled", budget_tokens: budget };
      if (claudeBody.max_tokens <= budget)
        claudeBody.max_tokens = budget + 4096;
    } else {
      claudeBody.thinking = { type: "enabled", budget_tokens: 8192 };
    }
  }

  // instructions → system
  if (body.instructions) {
    claudeBody.system = [{ type: "text", text: body.instructions }];
  }

  // tools: parameters → input_schema
  if (Array.isArray(body.tools)) {
    claudeBody.tools = body.tools.map((t: any) => ({
      name: t.name,
      description: t.description || "",
      input_schema: t.parameters ||
        t.input_schema || { type: "object", properties: {} },
    }));
  }

  if (body.tool_choice) {
    const tc = body.tool_choice;
    if (tc === "auto" || tc?.type === "auto")
      claudeBody.tool_choice = { type: "auto" };
    else if (tc === "required" || tc?.type === "required")
      claudeBody.tool_choice = { type: "any" };
    else if (tc === "none" || tc?.type === "none")
      claudeBody.tool_choice = { type: "none" };
    else if (tc?.type === "function")
      claudeBody.tool_choice = { type: "tool", name: tc.function?.name };
  }

  // input[] → messages[]
  const messages: any[] = [];

  for (const item of body.input || []) {
    const role = item.role;

    // system items in input[] (if instructions not set)
    if (role === "system") {
      if (!claudeBody.system) {
        const text = extractText(item.content);
        if (text) claudeBody.system = [{ type: "text", text }];
      }
      continue;
    }

    if (role === "user" || role === "assistant") {
      if (typeof item.content === "string") {
        messages.push({ role, content: item.content });
      } else if (Array.isArray(item.content)) {
        const content = item.content.flatMap((part: any) =>
          convertResponsesPart(part, role),
        );
        if (content.length) messages.push({ role, content });
      }
    }

    // function_call_output → tool_result
    if (item.type === "function_call_output") {
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: item.call_id,
            content:
              typeof item.output === "string"
                ? item.output
                : JSON.stringify(item.output),
          },
        ],
      });
    }

    // function_call → assistant tool_use
    if (item.type === "function_call") {
      let input: any = {};
      try {
        input = JSON.parse(item.arguments || "{}");
      } catch {
        /* ignore */
      }
      messages.push({
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: item.call_id || item.id,
            name: item.name,
            input,
          },
        ],
      });
    }
  }

  claudeBody.messages = messages;
  return claudeBody;
}

function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p: any) => p.text || "").join("\n");
  }
  return "";
}

function convertResponsesPart(part: any, role: string): any[] {
  if (!part || !part.type) return [];

  switch (part.type) {
    case "input_text":
    case "output_text":
    case "text":
      return [{ type: "text", text: part.text || "" }];

    case "image":
    case "input_image": {
      const url = part.image_url?.url || part.url || "";
      if (url.startsWith("data:")) {
        const match = url.match(/^data:([^;]+);base64,(.+)$/);
        if (match)
          return [
            {
              type: "image",
              source: { type: "base64", media_type: match[1], data: match[2] },
            },
          ];
      }
      if (url) return [{ type: "image", source: { type: "url", url } }];
      return [];
    }

    case "tool_use":
    case "function_call":
      if (role !== "assistant") return [];
      let input: any = {};
      try {
        input = JSON.parse(part.arguments || "{}");
      } catch {
        /* ignore */
      }
      return [
        {
          type: "tool_use",
          id: part.call_id || part.id,
          name: part.name,
          input,
        },
      ];

    case "tool_result":
    case "function_call_output":
      return []; // handled separately in input loop

    default:
      return [];
  }
}

// ── Claude response → OpenAI Responses API format (non-streaming) ──

function claudeToResponses(claudeResp: any, model: string): any {
  const respId = `resp_${uuidv4().replace(/-/g, "")}`;
  const msgId = `msg_${uuidv4().replace(/-/g, "")}`;
  const createdAt = Math.floor(Date.now() / 1000);

  const contentParts: any[] = [];
  const toolCalls: any[] = [];

  for (const block of claudeResp.content || []) {
    if (block.type === "text") {
      contentParts.push({
        type: "output_text",
        text: block.text,
        annotations: [],
      });
    } else if (block.type === "thinking" && block.thinking) {
      contentParts.push({
        type: "reasoning",
        summary: [{ type: "summary_text", text: block.thinking }],
      });
    } else if (block.type === "tool_use") {
      toolCalls.push({
        type: "function_call",
        id: `fc_${block.id}`,
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input || {}),
        status: "completed",
      });
    }
    // redacted_thinking — skip
  }

  const output: any[] = [];
  if (contentParts.length) {
    output.push({
      type: "message",
      id: msgId,
      role: "assistant",
      status: "completed",
      content: contentParts,
    });
  }
  output.push(...toolCalls);

  const stopReason = claudeResp.stop_reason;
  const status = stopReason === "max_tokens" ? "incomplete" : "completed";

  return {
    id: respId,
    object: "response",
    created_at: createdAt,
    status,
    model,
    output,
    usage: {
      input_tokens: claudeResp.usage?.input_tokens || 0,
      output_tokens: claudeResp.usage?.output_tokens || 0,
      total_tokens:
        (claudeResp.usage?.input_tokens || 0) +
        (claudeResp.usage?.output_tokens || 0),
    },
  };
}

// ── Claude SSE → OpenAI Responses API SSE (streaming) ──

interface ResponsesStreamState {
  respId: string;
  msgId: string;
  createdAt: number;
  seq: number;
  inTextBlock: boolean;
  inThinkingBlock: boolean;
  inToolBlock: boolean;
  currentToolId: string;
  currentToolName: string;
  toolIndex: number;
  inputTokens: number;
  outputTokens: number;
  currentText: string;
  currentToolArgs: string;
}

function makeResponsesState(): ResponsesStreamState {
  return {
    respId: `resp_${uuidv4().replace(/-/g, "")}`,
    msgId: `msg_${uuidv4().replace(/-/g, "")}`,
    createdAt: Math.floor(Date.now() / 1000),
    seq: 0,
    inTextBlock: false,
    inThinkingBlock: false,
    inToolBlock: false,
    currentToolId: "",
    currentToolName: "",
    toolIndex: 0,
    inputTokens: 0,
    outputTokens: 0,
    currentText: "",
    currentToolArgs: "",
  };
}

function emitEvent(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function claudeSSEToResponses(
  event: string,
  data: any,
  state: ResponsesStreamState,
  model: string,
): string[] {
  const out: string[] = [];
  const nextSeq = () => ++state.seq;

  if (event === "message_start") {
    state.inputTokens = data.message?.usage?.input_tokens || 0;
    out.push(
      emitEvent("response.created", {
        type: "response.created",
        sequence_number: nextSeq(),
        response: {
          id: state.respId,
          object: "response",
          created_at: state.createdAt,
          status: "in_progress",
          model,
          output: [],
        },
      }),
    );
    out.push(
      emitEvent("response.in_progress", {
        type: "response.in_progress",
        sequence_number: nextSeq(),
        response: {
          id: state.respId,
          object: "response",
          created_at: state.createdAt,
          status: "in_progress",
          model,
          output: [],
        },
      }),
    );
    return out;
  }

  if (event === "content_block_start") {
    const block = data.content_block;
    const idx = data.index;

    if (block?.type === "text") {
      state.inTextBlock = true;
      state.currentText = "";
      out.push(
        emitEvent("response.output_item.added", {
          type: "response.output_item.added",
          sequence_number: nextSeq(),
          output_index: idx,
          item: {
            id: state.msgId,
            type: "message",
            status: "in_progress",
            role: "assistant",
            content: [],
          },
        }),
      );
      out.push(
        emitEvent("response.content_part.added", {
          type: "response.content_part.added",
          sequence_number: nextSeq(),
          item_id: state.msgId,
          output_index: idx,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        }),
      );
    } else if (block?.type === "thinking") {
      state.inThinkingBlock = true;
    } else if (block?.type === "tool_use") {
      state.inToolBlock = true;
      state.currentToolId = block.id;
      state.currentToolName = block.name;
      state.currentToolArgs = "";
      const fcId = `fc_${block.id}`;
      out.push(
        emitEvent("response.output_item.added", {
          type: "response.output_item.added",
          sequence_number: nextSeq(),
          output_index: idx,
          item: {
            id: fcId,
            type: "function_call",
            status: "in_progress",
            call_id: block.id,
            name: block.name,
            arguments: "",
          },
        }),
      );
    }
    // redacted_thinking — skip
    return out;
  }

  if (event === "content_block_delta") {
    const deltaType = data.delta?.type;
    const idx = data.index;

    if (deltaType === "text_delta") {
      state.currentText += data.delta.text;
      out.push(
        emitEvent("response.output_text.delta", {
          type: "response.output_text.delta",
          sequence_number: nextSeq(),
          item_id: state.msgId,
          output_index: idx,
          content_index: 0,
          delta: data.delta.text,
        }),
      );
    } else if (deltaType === "thinking_delta") {
      // thinking delta — skip in responses format (no standard field for this)
    } else if (deltaType === "redacted_thinking_delta") {
      // redacted_thinking — skip
    } else if (deltaType === "input_json_delta") {
      state.currentToolArgs += data.delta.partial_json;
      out.push(
        emitEvent("response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          sequence_number: nextSeq(),
          item_id: `fc_${state.currentToolId}`,
          output_index: idx,
          delta: data.delta.partial_json,
        }),
      );
    }
    return out;
  }

  if (event === "content_block_stop") {
    const idx = data.index;
    if (state.inTextBlock) {
      out.push(
        emitEvent("response.output_text.done", {
          type: "response.output_text.done",
          sequence_number: nextSeq(),
          item_id: state.msgId,
          output_index: idx,
          content_index: 0,
          text: state.currentText,
        }),
      );
      out.push(
        emitEvent("response.content_part.done", {
          type: "response.content_part.done",
          sequence_number: nextSeq(),
          item_id: state.msgId,
          output_index: idx,
          content_index: 0,
          part: {
            type: "output_text",
            text: state.currentText,
            annotations: [],
          },
        }),
      );
      out.push(
        emitEvent("response.output_item.done", {
          type: "response.output_item.done",
          sequence_number: nextSeq(),
          output_index: idx,
          item: {
            id: state.msgId,
            type: "message",
            status: "completed",
            role: "assistant",
            content: [],
          },
        }),
      );
      state.inTextBlock = false;
      state.currentText = "";
    } else if (state.inThinkingBlock) {
      state.inThinkingBlock = false;
    } else if (state.inToolBlock) {
      const fcId = `fc_${state.currentToolId}`;
      out.push(
        emitEvent("response.function_call_arguments.done", {
          type: "response.function_call_arguments.done",
          sequence_number: nextSeq(),
          item_id: fcId,
          output_index: idx,
          arguments: state.currentToolArgs,
        }),
      );
      out.push(
        emitEvent("response.output_item.done", {
          type: "response.output_item.done",
          sequence_number: nextSeq(),
          output_index: idx,
          item: {
            id: fcId,
            type: "function_call",
            status: "completed",
            call_id: state.currentToolId,
            name: state.currentToolName,
            arguments: state.currentToolArgs,
          },
        }),
      );
      state.inToolBlock = false;
      state.currentToolArgs = "";
    }
    return out;
  }

  if (event === "message_delta") {
    state.outputTokens = data.usage?.output_tokens || 0;
  }

  if (event === "message_stop") {
    out.push(
      emitEvent("response.completed", {
        type: "response.completed",
        sequence_number: nextSeq(),
        response: {
          id: state.respId,
          object: "response",
          created_at: state.createdAt,
          status: "completed",
          model,
          output: [],
          usage: {
            input_tokens: state.inputTokens,
            output_tokens: state.outputTokens,
            total_tokens: state.inputTokens + state.outputTokens,
          },
        },
      }),
    );
    out.push(
      `event: response.done\ndata: ${JSON.stringify({ type: "response.done", sequence_number: nextSeq() })}\n\n`,
    );
    return out;
  }

  return out;
}

// ── Express handler ──

export function createResponsesHandler(
  config: Config,
  manager: AccountManager,
) {
  return async (req: Request, res: ExpressResponse): Promise<void> => {
    try {
      const body = req.body;
      if (!body.input && !body.messages) {
        res.status(400).json({ error: { message: "input is required" } });
        return;
      }

      const stream = !!body.stream;
      const model = resolveModel(body.model || "claude-sonnet-4-6");
      const apiKey = extractApiKey(req.headers);
      const apiKeyHash = crypto
        .createHash("sha256")
        .update(apiKey)
        .digest("hex");

      const translatedBody = responsesToClaude(body);

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
              `Responses attempt ${attempt + 1} network failure: ${err.message}`,
            );
          }
          if (attempt < MAX_RETRIES - 1) {
            await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
            continue;
          }
          res
            .status(502)
            .json({ error: { message: "Upstream network error" } });
          return;
        }

        if (upstreamResp.ok) {
          if (stream) {
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

            const state = makeResponsesState();
            const decoder = new TextDecoder();
            let buffer = "";
            let clientDisconnected = false;
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
                buffer = lines.pop() ?? "";

                let currentEvent = "";
                for (const line of lines) {
                  if (line.startsWith("event:")) {
                    currentEvent = line.slice(6).trim();
                  } else if (line.startsWith("data:")) {
                    const raw = line.slice(5).trim();
                    if (!raw || raw === "[DONE]") continue;
                    try {
                      const data = JSON.parse(raw);
                      const chunks = claudeSSEToResponses(
                        currentEvent,
                        data,
                        state,
                        model,
                      );
                      for (const chunk of chunks) {
                        if (!clientDisconnected) res.write(chunk);
                      }
                    } catch {
                      /* ignore parse errors */
                    }
                  }
                }
              }
              if (!clientDisconnected) {
                manager.recordSuccess(account.token.email);
              }
            } catch (err) {
              if (!clientDisconnected) {
                manager.recordFailure(
                  account.token.email,
                  "network",
                  "stream terminated before completion",
                );
              }
              if (!clientDisconnected)
                console.error("Responses stream error:", err);
            } finally {
              if (!clientDisconnected) res.end();
            }
          } else {
            const claudeResp = await upstreamResp.json();
            manager.recordSuccess(account.token.email);
            res.json(claudeToResponses(claudeResp, model));
          }
          return;
        }

        lastStatus = upstreamResp.status;
        lastErrBody = await upstreamResp.text().catch(() => "");
        if (isDebugLevel(config.debug, "errors")) {
          console.error(
            `Responses attempt ${attempt + 1} failed (${lastStatus}): ${lastErrBody}`,
          );
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
        if (!RETRYABLE_STATUSES.has(lastStatus)) break;
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
      console.error("Responses handler error:", err.message);
      res.status(500).json({ error: { message: "Internal server error" } });
    }
  };
}
