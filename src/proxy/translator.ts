import { v4 as uuidv4 } from "uuid";

// ── Model alias resolution ──

const MODEL_ALIASES: Record<string, string> = {
  "claude-sonnet-4":         "claude-sonnet-4-20250514",
  "claude-opus-4":           "claude-opus-4-20250514",
  "claude-haiku-4":          "claude-haiku-4-20250414",
  "claude-3-5-sonnet":       "claude-3-5-sonnet-20241022",
  "claude-3-5-haiku":        "claude-3-5-haiku-20241022",
  "claude-3-7-sonnet":       "claude-3-7-sonnet-20250219",
};

export function resolveModel(model: string): string {
  return MODEL_ALIASES[model] ?? model;
}

// ── Reasoning effort → Claude thinking config ──

const EFFORT_TO_BUDGET: Record<string, number> = {
  none: 0, low: 1024, medium: 8192, high: 24576, xhigh: 32768,
};

function applyThinking(claudeBody: any, reasoningEffort: string): void {
  if (reasoningEffort === "none") {
    claudeBody.thinking = { type: "disabled" };
    return;
  }
  const budget = EFFORT_TO_BUDGET[reasoningEffort];
  if (budget) {
    claudeBody.thinking = { type: "enabled", budget_tokens: budget };
    // budget must be < max_tokens
    if (claudeBody.max_tokens <= budget) {
      claudeBody.max_tokens = budget + 4096;
    }
  } else {
    // "auto" or unknown → adaptive
    claudeBody.thinking = { type: "enabled", budget_tokens: 8192 };
  }
}

function disableThinkingIfToolChoiceForced(claudeBody: any): void {
  const tcType = claudeBody.tool_choice?.type;
  if (tcType === "any" || tcType === "tool") {
    delete claudeBody.thinking;
  }
}

// ── OpenAI image_url → Claude image ──

function convertContentParts(parts: any[]): any[] {
  return parts.map((part: any) => {
    if (part.type === "image_url" && part.image_url?.url) {
      const url: string = part.image_url.url;
      if (url.startsWith("data:")) {
        // data:image/png;base64,iVBOR...
        const match = url.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          return {
            type: "image",
            source: { type: "base64", media_type: match[1], data: match[2] },
          };
        }
      }
      // Remote URL
      return { type: "image", source: { type: "url", url } };
    }
    return part;
  });
}

// ── OpenAI tool_choice → Claude tool_choice ──

function convertToolChoice(tc: any): any {
  if (tc === "auto") return { type: "auto" };
  if (tc === "required") return { type: "any" };
  if (tc === "none") return { type: "none" };
  if (tc?.type === "function" && tc.function?.name) {
    return { type: "tool", name: tc.function.name };
  }
  return tc;
}

// ── OpenAI tools → Claude tools ──

function convertTools(tools: any[]): any[] {
  return tools.map((t: any) => {
    if (t.type === "function" && t.function) {
      return {
        name: t.function.name,
        description: t.function.description || "",
        input_schema: t.function.parameters || { type: "object", properties: {} },
      };
    }
    return t;
  });
}

// ── OpenAI chat completion request → Claude messages request ──

export function openaiToClaude(body: any): any {
  const claudeBody: any = {
    model: resolveModel(body.model || "claude-sonnet-4-20250514"),
    max_tokens: body.max_tokens || 8192,
    stream: !!body.stream,
  };

  if (body.temperature !== undefined) claudeBody.temperature = body.temperature;
  if (body.top_p !== undefined) claudeBody.top_p = body.top_p;
  if (body.stop) claudeBody.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];

  // Thinking / reasoning
  if (body.reasoning_effort) {
    applyThinking(claudeBody, body.reasoning_effort);
  }

  const messages: any[] = [];
  const systemParts: any[] = [];

  for (const msg of body.messages || []) {
    if (msg.role === "system") {
      const text = typeof msg.content === "string"
        ? msg.content
        : msg.content?.map((c: any) => c.text).join("\n");
      systemParts.push({ type: "text", text });
    } else if (msg.role === "tool") {
      // OpenAI tool result → Claude tool_result
      messages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: msg.tool_call_id,
          content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
        }],
      });
    } else if (msg.role === "assistant" && msg.tool_calls) {
      // Assistant message with tool_calls → Claude assistant with tool_use blocks
      const content: any[] = [];
      if (msg.content) {
        content.push({ type: "text", text: typeof msg.content === "string" ? msg.content : "" });
      }
      for (const tc of msg.tool_calls) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function?.name || "",
          input: tc.function?.arguments ? JSON.parse(tc.function.arguments) : {},
        });
      }
      messages.push({ role: "assistant", content });
    } else {
      // Convert image parts if content is array
      let content = msg.content;
      if (Array.isArray(content)) {
        content = convertContentParts(content);
      }
      messages.push({
        role: msg.role === "user" ? "user" : "assistant",
        content,
      });
    }
  }

  if (systemParts.length) claudeBody.system = systemParts;
  claudeBody.messages = messages;

  // Tools
  if (body.tools) claudeBody.tools = convertTools(body.tools);
  if (body.tool_choice) claudeBody.tool_choice = convertToolChoice(body.tool_choice);

  // Disable thinking when tool_choice forces tool use
  if (claudeBody.thinking && claudeBody.tool_choice) {
    disableThinkingIfToolChoiceForced(claudeBody);
  }

  return claudeBody;
}

// ── Claude response → OpenAI chat completion response (non-streaming) ──

function mapStopReason(reason: string): string {
  if (reason === "end_turn") return "stop";
  if (reason === "max_tokens") return "length";
  if (reason === "tool_use") return "tool_calls";
  return "stop";
}

export function claudeToOpenai(claudeResp: any, model: string): any {
  let textContent = "";
  const toolCalls: any[] = [];
  let reasoning = "";

  if (Array.isArray(claudeResp.content)) {
    for (const block of claudeResp.content) {
      if (block.type === "text") {
        textContent += block.text;
      } else if (block.type === "thinking" && block.thinking) {
        reasoning += (reasoning ? "\n\n" : "") + block.thinking;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {}),
          },
        });
      }
    }
  }

  const message: any = { role: "assistant", content: textContent || null };
  if (toolCalls.length) message.tool_calls = toolCalls;

  return {
    id: `chatcmpl-${uuidv4()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: mapStopReason(claudeResp.stop_reason),
    }],
    usage: {
      prompt_tokens: claudeResp.usage?.input_tokens || 0,
      completion_tokens: claudeResp.usage?.output_tokens || 0,
      total_tokens: (claudeResp.usage?.input_tokens || 0) + (claudeResp.usage?.output_tokens || 0),
    },
  };
}

// ── Streaming state tracker ──

export interface StreamState {
  chatId: string;
  model: string;
  toolCalls: Map<number, { id: string; name: string; args: string }>;
  nextToolIndex: number;
}

export function createStreamState(model: string): StreamState {
  return {
    chatId: `chatcmpl-${uuidv4()}`,
    model,
    toolCalls: new Map(),
    nextToolIndex: 0,
  };
}

function makeChunk(state: StreamState, delta: any, finishReason: string | null, usage?: any): string {
  const chunk: any = {
    id: state.chatId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (usage) chunk.usage = usage;
  return JSON.stringify(chunk);
}

// ── Claude SSE event → OpenAI SSE chunk(s) ──

export function claudeStreamEventToOpenai(
  event: string,
  data: any,
  state: StreamState
): string[] {
  const chunks: string[] = [];

  if (event === "message_start") {
    chunks.push(makeChunk(state, { role: "assistant", content: "" }, null));
    return chunks;
  }

  if (event === "content_block_start") {
    const block = data.content_block;
    if (block?.type === "tool_use") {
      const idx = state.nextToolIndex++;
      state.toolCalls.set(data.index, { id: block.id, name: block.name, args: "" });
      chunks.push(makeChunk(state, {
        tool_calls: [{
          index: idx,
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: "" },
        }],
      }, null));
    }
    // thinking / redacted_thinking block start — no output needed
    return chunks;
  }

  if (event === "content_block_delta") {
    const deltaType = data.delta?.type;

    if (deltaType === "text_delta") {
      chunks.push(makeChunk(state, { content: data.delta.text }, null));
    } else if (deltaType === "thinking_delta") {
      // Emit as reasoning_content for clients that support it
      chunks.push(makeChunk(state, { reasoning_content: data.delta.thinking }, null));
    } else if (deltaType === "redacted_thinking_delta") {
      // Redacted (encrypted) thinking blocks — discard, never forward to clients
    } else if (deltaType === "input_json_delta") {
      const tc = state.toolCalls.get(data.index);
      if (tc) {
        tc.args += data.delta.partial_json;
        // Find the OpenAI tool index
        let tcIdx = 0;
        for (const [blockIdx] of state.toolCalls) {
          if (blockIdx === data.index) break;
          tcIdx++;
        }
        chunks.push(makeChunk(state, {
          tool_calls: [{
            index: tcIdx,
            function: { arguments: data.delta.partial_json },
          }],
        }, null));
      }
    }
    return chunks;
  }

  if (event === "content_block_stop") {
    // No explicit output needed
    return chunks;
  }

  if (event === "message_delta") {
    const finishReason = mapStopReason(data.delta?.stop_reason || "end_turn");
    const usage = data.usage ? {
      prompt_tokens: data.usage.input_tokens || 0,
      completion_tokens: data.usage.output_tokens || 0,
      total_tokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
    } : undefined;
    chunks.push(makeChunk(state, {}, finishReason, usage));
    return chunks;
  }

  if (event === "message_stop") {
    chunks.push("[DONE]");
    return chunks;
  }

  return chunks;
}
