import { v4 as uuidv4 } from "uuid";
import { UsageData } from "../accounts/manager";

function compactUuid(): string {
  return uuidv4().replace(/-/g, "");
}

function formatChatUsage(
  inputTokens: number,
  outputTokens: number,
  cachedTokens: number,
): any {
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    prompt_tokens_details: { cached_tokens: cachedTokens },
    completion_tokens_details: { reasoning_tokens: 0 },
  };
}

function formatResponsesUsage(
  inputTokens: number,
  outputTokens: number,
  cachedTokens: number,
): any {
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    input_tokens_details: { cached_tokens: cachedTokens },
    output_tokens_details: { reasoning_tokens: 0 },
  };
}

// ── Model alias resolution ──

const MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
  "claude-opus-4-6": "claude-opus-4-6",
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
};

export function resolveModel(model: string): string {
  return MODEL_ALIASES[model] ?? model;
}

// ── Shared: reasoning effort → Anthropic thinking ──

const EFFORT_TO_BUDGET: Record<string, number> = {
  none: 0,
  low: 1024,
  medium: 8192,
  high: 24576,
  xhigh: 32768,
};

function applyThinking(
  anthropicBody: any,
  effort: string,
  summary?: string,
): void {
  if (effort === "none") {
    anthropicBody.thinking = { type: "disabled" };
    return;
  }
  const budget = EFFORT_TO_BUDGET[effort];
  if (budget) {
    anthropicBody.thinking = { type: "enabled", budget_tokens: budget };
    if (anthropicBody.max_tokens <= budget) {
      anthropicBody.max_tokens = budget + 4096;
    }
  } else {
    anthropicBody.thinking = { type: "enabled", budget_tokens: 8192 };
  }
  if (summary && summary !== "auto") {
    anthropicBody.thinking.display = "summarized";
  }
}

function disableThinkingIfToolChoiceForced(anthropicBody: any): void {
  const tcType = anthropicBody.tool_choice?.type;
  if (tcType === "any" || tcType === "tool") {
    delete anthropicBody.thinking;
  }
}

// ── Shared: image conversion ──

function convertImage(url: string): any {
  if (url.startsWith("data:")) {
    const match = url.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      return {
        type: "image",
        source: { type: "base64", media_type: match[1], data: match[2] },
      };
    }
  }
  return { type: "image", source: { type: "url", url } };
}

// ── Shared: tool_choice conversion ──

function convertToolChoice(tc: any): any {
  if (tc === "auto" || tc?.type === "auto") return { type: "auto" };
  if (tc === "required" || tc?.type === "required") return { type: "any" };
  if (tc === "none" || tc?.type === "none") return { type: "none" };
  if (tc?.type === "function" && tc.function?.name) {
    return { type: "tool", name: tc.function.name };
  }
  return tc;
}

// ══════════════════════════════════════════════════════════════════
// OpenAI Chat Completions ↔ Anthropic Messages
// ══════════════════════════════════════════════════════════════════

// ── OpenAI image_url → Anthropic image ──

function convertContentParts(parts: any[]): any[] {
  return parts.map((part: any) => {
    if (part.type === "image_url" && part.image_url?.url) {
      return convertImage(part.image_url.url);
    }
    return part;
  });
}

// ── OpenAI tools → Anthropic tools ──

function convertChatTools(tools: any[]): any[] {
  return tools.map((t: any) => {
    if (t.type === "function" && t.function) {
      return {
        name: t.function.name,
        description: t.function.description || "",
        input_schema: t.function.parameters || {
          type: "object",
          properties: {},
        },
      };
    }
    return t;
  });
}

// ── OpenAI chat completion request → Anthropic messages request ──

export function openaiToAnthropic(body: any): any {
  const anthropicBody: any = {
    model: resolveModel(body.model || "claude-sonnet-4-6"),
    max_tokens: body.max_completion_tokens || body.max_tokens || 8192,
    stream: !!body.stream,
  };

  if (body.temperature !== undefined)
    anthropicBody.temperature = body.temperature;
  if (body.top_p !== undefined) anthropicBody.top_p = body.top_p;
  if (body.stop)
    anthropicBody.stop_sequences = Array.isArray(body.stop)
      ? body.stop
      : [body.stop];

  // Thinking / reasoning
  if (body.reasoning_effort) {
    applyThinking(anthropicBody, body.reasoning_effort);
  }

  // response_format → output_config
  if (body.response_format) {
    const fmt = body.response_format;
    if (fmt.type === "json_schema" && fmt.json_schema) {
      anthropicBody.output_config = {
        format: {
          type: "json_schema",
          schema: fmt.json_schema.schema,
          name: fmt.json_schema.name,
        },
      };
    }
  }

  const messages: any[] = [];
  const systemParts: any[] = [];

  for (const msg of body.messages || []) {
    if (msg.role === "system") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : msg.content?.map((c: any) => c.text).join("\n");
      systemParts.push({ type: "text", text });
    } else if (msg.role === "tool") {
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.tool_call_id,
            content:
              typeof msg.content === "string"
                ? msg.content
                : JSON.stringify(msg.content),
          },
        ],
      });
    } else if (msg.role === "assistant" && msg.tool_calls) {
      const content: any[] = [];
      if (msg.content) {
        content.push({
          type: "text",
          text: typeof msg.content === "string" ? msg.content : "",
        });
      }
      for (const tc of msg.tool_calls) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function?.name || "",
          input: tc.function?.arguments
            ? JSON.parse(tc.function.arguments)
            : {},
        });
      }
      messages.push({ role: "assistant", content });
    } else {
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

  if (systemParts.length) anthropicBody.system = systemParts;
  anthropicBody.messages = messages;

  if (body.tools) anthropicBody.tools = convertChatTools(body.tools);
  if (body.tool_choice)
    anthropicBody.tool_choice = convertToolChoice(body.tool_choice);

  // parallel_tool_calls
  if (body.parallel_tool_calls === false && anthropicBody.tool_choice) {
    anthropicBody.tool_choice.disable_parallel_tool_use = true;
  }

  if (anthropicBody.thinking && anthropicBody.tool_choice) {
    disableThinkingIfToolChoiceForced(anthropicBody);
  }

  return anthropicBody;
}

// ── Anthropic response → OpenAI chat completion (non-streaming) ──

function mapStopReason(reason: string): string {
  if (reason === "end_turn") return "stop";
  if (reason === "max_tokens") return "length";
  if (reason === "tool_use") return "tool_calls";
  return "stop";
}

export function anthropicToOpenai(anthropicResp: any, model: string): any {
  let textContent = "";
  const toolCalls: any[] = [];

  if (Array.isArray(anthropicResp.content)) {
    for (const block of anthropicResp.content) {
      if (block.type === "text") {
        textContent += block.text;
      } else if (block.type === "thinking" && block.thinking) {
        // thinking blocks not exposed in chat completions response
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

  const inputTokens = anthropicResp.usage?.input_tokens || 0;
  const outputTokens = anthropicResp.usage?.output_tokens || 0;

  return {
    id: `chatcmpl-${uuidv4()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapStopReason(anthropicResp.stop_reason),
      },
    ],
    usage: formatChatUsage(
      inputTokens,
      outputTokens,
      anthropicResp.usage?.cache_read_input_tokens || 0,
    ),
  };
}

// ── Streaming: Chat Completions ──

export interface StreamState {
  chatId: string;
  model: string;
  toolCalls: Map<
    number,
    { id: string; name: string; args: string; openaiIndex: number }
  >;
  nextToolIndex: number;
  includeUsage: boolean;
}

export function createStreamState(
  model: string,
  includeUsage: boolean,
): StreamState {
  return {
    chatId: `chatcmpl-${uuidv4()}`,
    model,
    toolCalls: new Map(),
    nextToolIndex: 0,
    includeUsage,
  };
}

function makeChunk(
  state: StreamState,
  delta: any,
  finishReason: string | null,
): string {
  return JSON.stringify({
    id: state.chatId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

type ChatSSEHandler = (
  data: any,
  state: StreamState,
  usage?: UsageData,
) => string[];

const chatSSEHandlers: Record<string, ChatSSEHandler> = {
  message_start: (_data, state) => [
    makeChunk(state, { role: "assistant", content: "" }, null),
  ],

  content_block_start: (data, state) => {
    const block = data.content_block;
    if (block?.type !== "tool_use") return [];
    const idx = state.nextToolIndex++;
    state.toolCalls.set(data.index, {
      id: block.id,
      name: block.name,
      args: "",
      openaiIndex: idx,
    });
    return [
      makeChunk(
        state,
        {
          tool_calls: [
            {
              index: idx,
              id: block.id,
              type: "function",
              function: { name: block.name, arguments: "" },
            },
          ],
        },
        null,
      ),
    ];
  },

  content_block_delta: (data, state) => {
    const deltaType = data.delta?.type;
    if (deltaType === "text_delta") {
      return [makeChunk(state, { content: data.delta.text }, null)];
    }
    if (deltaType === "thinking_delta") {
      return [
        makeChunk(state, { reasoning_content: data.delta.thinking }, null),
      ];
    }
    if (deltaType === "input_json_delta") {
      const tc = state.toolCalls.get(data.index);
      if (!tc) return [];
      tc.args += data.delta.partial_json;
      return [
        makeChunk(
          state,
          {
            tool_calls: [
              {
                index: tc.openaiIndex,
                function: { arguments: data.delta.partial_json },
              },
            ],
          },
          null,
        ),
      ];
    }
    return [];
  },

  message_delta: (data, state) => [
    makeChunk(state, {}, mapStopReason(data.delta?.stop_reason || "end_turn")),
  ],

  message_stop: (_data, state, usage) => {
    const chunks: string[] = [];
    if (state.includeUsage && usage) {
      chunks.push(
        JSON.stringify({
          id: state.chatId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: state.model,
          choices: [],
          usage: formatChatUsage(
            usage.inputTokens,
            usage.outputTokens,
            usage.cacheReadInputTokens,
          ),
        }),
      );
    }
    chunks.push("[DONE]");
    return chunks;
  },
};

export function anthropicSSEToChat(
  event: string,
  data: any,
  state: StreamState,
  usage?: UsageData,
): string[] {
  const handler = chatSSEHandlers[event];
  return handler ? handler(data, state, usage) : [];
}

// ══════════════════════════════════════════════════════════════════
// OpenAI Responses API ↔ Anthropic Messages
// ══════════════════════════════════════════════════════════════════

// ── Responses API content part → Anthropic content block ──

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
      if (!url) return [];
      return [convertImage(url)];
    }

    case "tool_use":
    case "function_call": {
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
    }

    case "tool_result":
    case "function_call_output":
      return []; // handled separately in input loop

    default:
      return [];
  }
}

// ── OpenAI Responses API request → Anthropic messages request ──

export function responsesToAnthropic(body: any): any {
  const model = resolveModel(body.model || "claude-sonnet-4-6");
  const anthropicBody: any = {
    model,
    max_tokens: body.max_output_tokens || 8192,
    stream: !!body.stream,
  };

  if (body.temperature !== undefined)
    anthropicBody.temperature = body.temperature;
  if (body.top_p !== undefined) anthropicBody.top_p = body.top_p;

  // reasoning.effort → Anthropic thinking
  const effort = body.reasoning?.effort;
  const summary = body.reasoning?.summary;
  if (effort && effort !== "none") {
    applyThinking(anthropicBody, effort, summary);
  }

  // text.format → output_config
  if (body.text?.format) {
    const fmt = body.text.format;
    if (fmt.type === "json_schema" && fmt.schema) {
      anthropicBody.output_config = {
        format: {
          type: "json_schema",
          schema: fmt.schema,
          name: fmt.name,
        },
      };
    }
  }

  // instructions → system
  if (body.instructions) {
    anthropicBody.system = [{ type: "text", text: body.instructions }];
  }

  // tools
  if (Array.isArray(body.tools)) {
    anthropicBody.tools = body.tools.map((t: any) => ({
      name: t.name,
      description: t.description || "",
      input_schema: t.parameters ||
        t.input_schema || { type: "object", properties: {} },
    }));
  }

  if (body.tool_choice) {
    anthropicBody.tool_choice = convertToolChoice(body.tool_choice);
  }

  // parallel_tool_calls
  if (body.parallel_tool_calls === false && anthropicBody.tool_choice) {
    anthropicBody.tool_choice.disable_parallel_tool_use = true;
  }

  if (anthropicBody.thinking && anthropicBody.tool_choice) {
    disableThinkingIfToolChoiceForced(anthropicBody);
  }

  // input[] → messages[]
  const messages: any[] = [];

  for (const item of body.input || []) {
    const role = item.role;

    if (role === "system") {
      if (!anthropicBody.system) {
        const text = extractText(item.content);
        if (text) anthropicBody.system = [{ type: "text", text }];
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

  anthropicBody.messages = messages;
  return anthropicBody;
}

// ── Anthropic response → OpenAI Responses API (non-streaming) ──

export function anthropicToResponses(anthropicResp: any, model: string): any {
  const respId = `resp_${compactUuid()}`;
  const msgId = `msg_${compactUuid()}`;
  const createdAt = Math.floor(Date.now() / 1000);

  const contentParts: any[] = [];
  const toolCalls: any[] = [];

  for (const block of anthropicResp.content || []) {
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

  const outputText = contentParts
    .filter((p) => p.type === "output_text")
    .map((p) => p.text)
    .join("");

  const stopReason = anthropicResp.stop_reason;
  const status = stopReason === "max_tokens" ? "incomplete" : "completed";
  const inputTokens = anthropicResp.usage?.input_tokens || 0;
  const outputTokens = anthropicResp.usage?.output_tokens || 0;

  return {
    id: respId,
    object: "response",
    created_at: createdAt,
    status,
    model,
    output,
    output_text: outputText || null,
    usage: formatResponsesUsage(
      inputTokens,
      outputTokens,
      anthropicResp.usage?.cache_read_input_tokens || 0,
    ),
  };
}

// ── Streaming: Responses API ──

export interface ResponsesStreamState {
  respId: string;
  msgId: string;
  createdAt: number;
  seq: number;
  inTextBlock: boolean;
  inThinkingBlock: boolean;
  inToolBlock: boolean;
  currentToolId: string;
  currentToolName: string;
  currentText: string;
  currentToolArgs: string;
  currentThinkingText: string;
  currentReasoningId: string;
}

export function makeResponsesState(): ResponsesStreamState {
  return {
    respId: `resp_${compactUuid()}`,
    msgId: `msg_${compactUuid()}`,
    createdAt: Math.floor(Date.now() / 1000),
    seq: 0,
    inTextBlock: false,
    inThinkingBlock: false,
    inToolBlock: false,
    currentToolId: "",
    currentToolName: "",
    currentText: "",
    currentToolArgs: "",
    currentThinkingText: "",
    currentReasoningId: "",
  };
}

function formatSSE(data: { type: string; [key: string]: any }): string {
  return `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
}

type ResponsesSSEHandler = (
  data: any,
  state: ResponsesStreamState,
  model: string,
  usage: UsageData,
) => string[];

const responsesSSEHandlers: Record<string, ResponsesSSEHandler> = {
  message_start: (_data, state, model) => {
    const nextSeq = () => ++state.seq;
    const response = {
      id: state.respId,
      object: "response",
      created_at: state.createdAt,
      status: "in_progress",
      model,
      output: [],
    };
    return [
      formatSSE({
        type: "response.created",
        sequence_number: nextSeq(),
        response,
      }),
      formatSSE({
        type: "response.in_progress",
        sequence_number: nextSeq(),
        response: { ...response },
      }),
    ];
  },

  content_block_start: (data, state) => {
    const nextSeq = () => ++state.seq;
    const block = data.content_block;
    const idx = data.index;

    if (block?.type === "text") {
      state.inTextBlock = true;
      state.currentText = "";
      return [
        formatSSE({
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
        formatSSE({
          type: "response.content_part.added",
          sequence_number: nextSeq(),
          item_id: state.msgId,
          output_index: idx,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        }),
      ];
    }

    if (block?.type === "thinking") {
      state.inThinkingBlock = true;
      state.currentThinkingText = "";
      state.currentReasoningId = `rs_${compactUuid()}`;
      return [
        formatSSE({
          type: "response.output_item.added",
          sequence_number: nextSeq(),
          output_index: idx,
          item: {
            id: state.currentReasoningId,
            type: "reasoning",
            status: "in_progress",
            summary: [],
          },
        }),
        formatSSE({
          type: "response.reasoning_summary_part.added",
          sequence_number: nextSeq(),
          item_id: state.currentReasoningId,
          output_index: idx,
          summary_index: 0,
          part: { type: "summary_text", text: "" },
        }),
      ];
    }

    if (block?.type === "tool_use") {
      state.inToolBlock = true;
      state.currentToolId = block.id;
      state.currentToolName = block.name;
      state.currentToolArgs = "";
      return [
        formatSSE({
          type: "response.output_item.added",
          sequence_number: nextSeq(),
          output_index: idx,
          item: {
            id: `fc_${block.id}`,
            type: "function_call",
            status: "in_progress",
            call_id: block.id,
            name: block.name,
            arguments: "",
          },
        }),
      ];
    }

    return [];
  },

  content_block_delta: (data, state) => {
    const nextSeq = () => ++state.seq;
    const deltaType = data.delta?.type;
    const idx = data.index;

    if (deltaType === "text_delta") {
      state.currentText += data.delta.text;
      return [
        formatSSE({
          type: "response.output_text.delta",
          sequence_number: nextSeq(),
          item_id: state.msgId,
          output_index: idx,
          content_index: 0,
          delta: data.delta.text,
        }),
      ];
    }

    if (deltaType === "thinking_delta") {
      state.currentThinkingText += data.delta.thinking;
      return [
        formatSSE({
          type: "response.reasoning_summary_text.delta",
          sequence_number: nextSeq(),
          item_id: state.currentReasoningId,
          output_index: idx,
          summary_index: 0,
          delta: data.delta.thinking,
        }),
      ];
    }

    if (deltaType === "input_json_delta") {
      state.currentToolArgs += data.delta.partial_json;
      return [
        formatSSE({
          type: "response.function_call_arguments.delta",
          sequence_number: nextSeq(),
          item_id: `fc_${state.currentToolId}`,
          output_index: idx,
          delta: data.delta.partial_json,
        }),
      ];
    }

    return [];
  },

  content_block_stop: (data, state) => {
    const nextSeq = () => ++state.seq;
    const idx = data.index;
    const out: string[] = [];

    if (state.inTextBlock) {
      out.push(
        formatSSE({
          type: "response.output_text.done",
          sequence_number: nextSeq(),
          item_id: state.msgId,
          output_index: idx,
          content_index: 0,
          text: state.currentText,
        }),
        formatSSE({
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
        formatSSE({
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
      out.push(
        formatSSE({
          type: "response.reasoning_summary_text.done",
          sequence_number: nextSeq(),
          item_id: state.currentReasoningId,
          output_index: idx,
          summary_index: 0,
          text: state.currentThinkingText,
        }),
        formatSSE({
          type: "response.reasoning_summary_part.done",
          sequence_number: nextSeq(),
          item_id: state.currentReasoningId,
          output_index: idx,
          summary_index: 0,
          part: { type: "summary_text", text: state.currentThinkingText },
        }),
        formatSSE({
          type: "response.output_item.done",
          sequence_number: nextSeq(),
          output_index: idx,
          item: {
            id: state.currentReasoningId,
            type: "reasoning",
            status: "completed",
            summary: [
              { type: "summary_text", text: state.currentThinkingText },
            ],
          },
        }),
      );
      state.inThinkingBlock = false;
      state.currentThinkingText = "";
    } else if (state.inToolBlock) {
      const fcId = `fc_${state.currentToolId}`;
      out.push(
        formatSSE({
          type: "response.function_call_arguments.done",
          sequence_number: nextSeq(),
          item_id: fcId,
          output_index: idx,
          arguments: state.currentToolArgs,
        }),
        formatSSE({
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
  },

  message_stop: (_data, state, model, usage) => {
    const nextSeq = () => ++state.seq;
    return [
      formatSSE({
        type: "response.completed",
        sequence_number: nextSeq(),
        response: {
          id: state.respId,
          object: "response",
          created_at: state.createdAt,
          status: "completed",
          model,
          output: [],
          usage: formatResponsesUsage(
            usage.inputTokens,
            usage.outputTokens,
            usage.cacheReadInputTokens,
          ),
        },
      }),
      formatSSE({ type: "response.done", sequence_number: nextSeq() }),
    ];
  },
};

export function anthropicSSEToResponses(
  event: string,
  data: any,
  state: ResponsesStreamState,
  model: string,
  usage: UsageData,
): string[] {
  const handler = responsesSSEHandlers[event];
  return handler ? handler(data, state, model, usage) : [];
}
