/**
 * Translators between OpenAI Responses API and the two other public
 * formats auth2api exposes (OpenAI Chat Completions and Anthropic
 * Messages). These exist so providers whose upstream is the OpenAI
 * Responses API natively (currently codex) can serve `/v1/chat/completions`
 * and `/v1/messages` requests without going through anthropic as an
 * intermediate hop.
 *
 * The translators are deliberately "good enough for common cases":
 * text content, single/multi-turn messages, system/instructions,
 * temperature/top_p/max_tokens, response_format, basic tool calls,
 * reasoning_effort/thinking. Esoteric Responses-only fields (state via
 * previous_response_id, vector stores, hosted file inputs, etc.) are
 * intentionally not translated — they have no Chat or Messages analog.
 */
import { v4 as uuidv4 } from "uuid";
import { readSseEvents } from "./streaming";

function compactUuid(): string {
  return uuidv4().replace(/-/g, "");
}

/**
 * Drained pieces of a codex Responses-format SSE stream.
 *
 * `completedResponse` is the entire `data.response` object from the
 * `response.completed` event when present. NOTE: codex's
 * ChatGPT-account backend differs from the public OpenAI Responses API
 * in one crucial way — `response.completed.response.output` is
 * **always an empty array**. The actual output items (message,
 * reasoning, function_call) are emitted as separate
 * `response.output_item.done` events during the stream. So
 * `outputItems` collects those payloads and the `/v1/responses`
 * non-stream path stitches them back into `completedResponse.output`.
 *
 * `textOut`/`reasoningOut`/`toolCalls` are kept for the chat
 * completions / messages translation paths, which build their own
 * faux Responses payload from the deltas (they don't need the full
 * output items, just the aggregated text/reasoning/tool args).
 */
export interface DrainedCodexResponses {
  textOut: string;
  reasoningOut: string;
  toolCalls: Map<string, { id: string; name: string; args: string }>;
  outputItems: any[];
  completedResponse: any | null;
  upstreamError: string | null;
  status: string;
  usage: any | null;
}

/**
 * Walk a codex Responses-format SSE stream and collect everything the
 * non-streaming aggregation paths need. Centralised here so the
 * `readSseEvents` flush invariants (decoder flush, leftover line
 * consumption) are applied uniformly to chat completions, messages and
 * the responses passthrough — previously each handler had its own
 * hand-rolled drain loop and they could each silently drop a final
 * un-terminated `data:` line containing `response.completed`.
 */
export async function drainCodexResponsesSse(
  upstream: Response,
): Promise<DrainedCodexResponses> {
  const toolCalls = new Map<string, { id: string; name: string; args: string }>();
  // codex `function_call_arguments.delta` events reference the parent
  // item by `item_id` (the internal `fc_…` id), not by `call_id` (the
  // public `call_…` id we key `toolCalls` by). Track the mapping
  // separately so subsequent argument deltas can find their slot
  // without polluting `toolCalls.values()` with duplicates.
  const itemIdToCallId = new Map<string, string>();
  const outputItems: any[] = [];
  let textOut = "";
  let reasoningOut = "";
  let completedResponse: any = null;
  let upstreamError: string | null = null;
  let status = "completed";
  let usage: any = null;

  for await (const { event, data } of readSseEvents(upstream)) {
    if (!data) continue;
    switch (event) {
      case "response.output_text.delta":
        if (typeof data.delta === "string") textOut += data.delta;
        break;
      case "response.reasoning_summary_text.delta":
        if (typeof data.delta === "string") reasoningOut += data.delta;
        break;
      case "response.output_item.added": {
        const item = data.item;
        if (item?.type === "function_call" && item.call_id) {
          // The toolCalls map is keyed by the public `call_id` so
          // `Array.from(toolCalls.values())` yields each tool call
          // exactly once. Codex's `function_call_arguments.delta`
          // events reference the item by `item_id` (= `item.id`,
          // an internal `fc_…`) rather than `call_id`, so we keep
          // a separate `itemIdToCallId` map for those lookups —
          // dual-keying the value map would emit duplicates.
          const tc = { id: item.call_id, name: item.name, args: "" };
          toolCalls.set(item.call_id, tc);
          if (item.id && item.id !== item.call_id) {
            itemIdToCallId.set(item.id, item.call_id);
          }
        }
        break;
      }
      case "response.output_item.done": {
        // The complete output item — codex emits one of these for
        // every message/reasoning/function_call once it finishes
        // streaming. We keep them in arrival order so the
        // `/v1/responses` non-stream path can populate the
        // `output` array on the final response (which codex itself
        // leaves empty in `response.completed`).
        if (data.item) outputItems.push(data.item);
        break;
      }
      case "response.function_call_arguments.delta": {
        const ref = data.item_id || data.call_id;
        const callId =
          ref && toolCalls.has(ref)
            ? ref
            : ref
              ? itemIdToCallId.get(ref)
              : undefined;
        const tc = callId ? toolCalls.get(callId) : null;
        if (tc && typeof data.delta === "string") tc.args += data.delta;
        break;
      }
      case "response.completed":
        completedResponse = data.response || null;
        usage = data.response?.usage ?? usage;
        status = data.response?.status || status;
        break;
      case "response.failed":
        upstreamError = data.response?.error?.message || "Upstream error";
        break;
    }
  }

  return {
    textOut,
    reasoningOut,
    toolCalls,
    outputItems,
    completedResponse,
    upstreamError,
    status,
    usage,
  };
}

function effortFromBudget(budgetTokens: number): "low" | "medium" | "high" {
  if (budgetTokens <= 4096) return "low";
  if (budgetTokens <= 16384) return "medium";
  return "high";
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => {
      if (typeof part === "string") return part;
      if (part?.type === "text") return part.text || "";
      if (part?.type === "output_text") return part.text || "";
      return "";
    })
    .join("");
}

// ─────────────────────────────────────────────────────────────────────
// 1. OpenAI Chat Completions request → OpenAI Responses request
// ─────────────────────────────────────────────────────────────────────

export function chatToResponsesRequest(body: any): any {
  const out: any = {
    model: body.model,
    stream: !!body.stream,
  };

  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  if (maxTokens !== undefined) out.max_output_tokens = maxTokens;
  if (body.user) out.user = body.user;

  if (body.reasoning_effort) {
    out.reasoning = { effort: body.reasoning_effort };
  }

  if (body.response_format) {
    const fmt = body.response_format;
    if (fmt.type === "json_object") {
      out.text = { format: { type: "json_object" } };
    } else if (fmt.type === "json_schema" && fmt.json_schema) {
      out.text = {
        format: {
          type: "json_schema",
          name: fmt.json_schema.name,
          schema: fmt.json_schema.schema,
          strict: fmt.json_schema.strict,
        },
      };
    }
  }

  // tools: Chat shape `{type:"function", function:{name, description, parameters}}`
  // becomes Responses shape `{type:"function", name, description, parameters}`.
  if (Array.isArray(body.tools)) {
    out.tools = body.tools
      .filter((t: any) => t?.type === "function" && t.function)
      .map((t: any) => ({
        type: "function",
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      }));
  }
  if (body.tool_choice) out.tool_choice = body.tool_choice;
  if (body.parallel_tool_calls === false) out.parallel_tool_calls = false;

  // messages → input + (optionally) instructions.
  // System messages are concatenated and lifted into `instructions`.
  // tool messages become `function_call_output` items, assistant tool_calls
  // become `function_call` items.
  const inputItems: any[] = [];
  const systemTexts: string[] = [];

  for (const msg of body.messages || []) {
    const role = msg.role;
    if (role === "system" || role === "developer") {
      const t = extractText(msg.content);
      if (t) systemTexts.push(t);
      continue;
    }

    if (role === "tool") {
      inputItems.push({
        type: "function_call_output",
        call_id: msg.tool_call_id,
        output:
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content),
      });
      continue;
    }

    if (role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      const text = extractText(msg.content);
      if (text) {
        inputItems.push({
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      }
      for (const tc of msg.tool_calls) {
        inputItems.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.function?.name || "",
          arguments: tc.function?.arguments || "{}",
        });
      }
      continue;
    }

    // Plain user / assistant / function (legacy) message.
    if (typeof msg.content === "string") {
      inputItems.push({ role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      const parts = msg.content
        .map((part: any) => {
          if (typeof part === "string") return { type: "input_text", text: part };
          if (part?.type === "text") {
            return {
              type: role === "assistant" ? "output_text" : "input_text",
              text: part.text,
            };
          }
          if (part?.type === "image_url" && part.image_url?.url) {
            return { type: "input_image", image_url: part.image_url.url };
          }
          if (part?.type === "input_text" || part?.type === "output_text") {
            return part;
          }
          return null;
        })
        .filter(Boolean);
      if (parts.length) inputItems.push({ role, content: parts });
    }
  }

  if (systemTexts.length) {
    out.instructions = systemTexts.join("\n\n");
  }
  out.input = inputItems;
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// 2. Anthropic Messages request → OpenAI Responses request
// ─────────────────────────────────────────────────────────────────────

export function anthropicToResponsesRequest(body: any): any {
  const out: any = {
    model: body.model,
    stream: !!body.stream,
  };

  if (body.max_tokens !== undefined) out.max_output_tokens = body.max_tokens;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  // NOTE: Do not forward `metadata.user_id` as `user`. The ChatGPT Codex
  // backend (the only consumer of this translator) rejects requests that
  // include `user` with HTTP 400 `{"detail":"Unsupported parameter: user"}`.

  // Anthropic `system` can be a string or [{type:"text", text}] array.
  if (body.system) {
    if (typeof body.system === "string") {
      out.instructions = body.system;
    } else if (Array.isArray(body.system)) {
      out.instructions = body.system
        .map((p: any) => (typeof p === "string" ? p : p?.text || ""))
        .join("\n\n");
    }
  }

  // thinking → reasoning.effort
  if (body.thinking?.type === "enabled") {
    const budget = body.thinking.budget_tokens || 12000;
    out.reasoning = { effort: effortFromBudget(budget) };
  }

  // tools (Anthropic) → tools (Responses)
  if (Array.isArray(body.tools)) {
    out.tools = body.tools.map((t: any) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.input_schema || { type: "object", properties: {} },
    }));
  }
  if (body.tool_choice) {
    if (body.tool_choice.type === "auto") out.tool_choice = "auto";
    else if (body.tool_choice.type === "any") out.tool_choice = "required";
    else if (body.tool_choice.type === "tool" && body.tool_choice.name) {
      out.tool_choice = {
        type: "function",
        function: { name: body.tool_choice.name },
      };
    }
  }

  // messages[] → input[]
  // Anthropic messages can carry text / image / tool_use / tool_result blocks.
  const inputItems: any[] = [];
  for (const msg of body.messages || []) {
    const role = msg.role;
    if (typeof msg.content === "string") {
      inputItems.push({ role, content: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content)) continue;

    const textParts: any[] = [];
    for (const block of msg.content) {
      if (block?.type === "text") {
        textParts.push({
          type: role === "assistant" ? "output_text" : "input_text",
          text: block.text || "",
        });
      } else if (block?.type === "image" && block.source?.data) {
        const mime = block.source.media_type || "image/png";
        const data = block.source.data;
        textParts.push({
          type: "input_image",
          image_url: data.startsWith("data:")
            ? data
            : `data:${mime};base64,${data}`,
        });
      } else if (block?.type === "tool_use") {
        // Flush any preceding text first to keep ordering.
        if (textParts.length) {
          inputItems.push({ role, content: [...textParts] });
          textParts.length = 0;
        }
        inputItems.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input || {}),
        });
      } else if (block?.type === "tool_result") {
        if (textParts.length) {
          inputItems.push({ role, content: [...textParts] });
          textParts.length = 0;
        }
        const content = block.content;
        const out =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content
                  .map((c: any) =>
                    c?.type === "text" ? c.text : JSON.stringify(c),
                  )
                  .join("")
              : JSON.stringify(content || "");
        inputItems.push({
          type: "function_call_output",
          call_id: block.tool_use_id,
          output: out,
        });
      }
    }
    if (textParts.length) inputItems.push({ role, content: textParts });
  }
  out.input = inputItems;
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// 3. Responses non-streaming response → OpenAI Chat Completions
// ─────────────────────────────────────────────────────────────────────

export function responsesToChatCompletion(resp: any, model: string): any {
  let textOut = "";
  let reasoningOut = "";
  const toolCalls: any[] = [];

  for (const item of resp?.output || []) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c?.type === "output_text" && c.text) textOut += c.text;
      }
    } else if (item.type === "reasoning" && Array.isArray(item.summary)) {
      for (const s of item.summary) {
        if (s?.type === "summary_text" && s.text) reasoningOut += s.text;
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id || item.id || `call_${compactUuid().slice(0, 24)}`,
        type: "function",
        function: {
          name: item.name,
          arguments: item.arguments || "{}",
        },
      });
    }
  }

  const message: any = {
    role: "assistant",
    content: textOut || (toolCalls.length ? null : ""),
  };
  if (reasoningOut) message.reasoning_content = reasoningOut;
  if (toolCalls.length) message.tool_calls = toolCalls;

  let finishReason: string = "stop";
  if (toolCalls.length) finishReason = "tool_calls";
  else if (resp?.status === "incomplete") finishReason = "length";

  return {
    id: `chatcmpl-${compactUuid().slice(0, 24)}`,
    object: "chat.completion",
    created: resp?.created_at || Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: `fp_${compactUuid().slice(0, 12)}`,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: resp?.usage?.input_tokens || 0,
      completion_tokens: resp?.usage?.output_tokens || 0,
      total_tokens:
        (resp?.usage?.input_tokens || 0) + (resp?.usage?.output_tokens || 0),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// 4. Responses non-streaming response → Anthropic Messages
// ─────────────────────────────────────────────────────────────────────

export function responsesToAnthropicMessage(resp: any, model: string): any {
  const content: any[] = [];

  for (const item of resp?.output || []) {
    if (item.type === "reasoning" && Array.isArray(item.summary)) {
      const t = item.summary
        .map((s: any) => (s?.type === "summary_text" ? s.text : ""))
        .join("");
      if (t) content.push({ type: "thinking", thinking: t });
    } else if (item.type === "message" && Array.isArray(item.content)) {
      const t = item.content
        .map((c: any) => (c?.type === "output_text" ? c.text : ""))
        .join("");
      if (t) content.push({ type: "text", text: t });
    } else if (item.type === "function_call") {
      let input: any = {};
      try {
        input = JSON.parse(item.arguments || "{}");
      } catch {
        /* ignore */
      }
      content.push({
        type: "tool_use",
        id: item.call_id || item.id,
        name: item.name,
        input,
      });
    }
  }

  let stopReason = "end_turn";
  if (resp?.status === "incomplete") stopReason = "max_tokens";
  else if (content.some((b) => b.type === "tool_use")) stopReason = "tool_use";

  return {
    id: `msg_${compactUuid()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: resp?.usage?.input_tokens || 0,
      output_tokens: resp?.usage?.output_tokens || 0,
      cache_creation_input_tokens:
        resp?.usage?.input_tokens_details?.cached_tokens || 0,
      cache_read_input_tokens:
        resp?.usage?.input_tokens_details?.cached_tokens || 0,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// 5. Responses SSE → OpenAI Chat Completions SSE
// ─────────────────────────────────────────────────────────────────────

export interface ResponsesToChatState {
  id: string;
  created: number;
  fingerprint: string;
  model: string;
  rolePrimerSent: boolean;
  // Maps the public `call_…` id to a chat tool_call index slot.
  toolCallIndices: Map<string, number>;
  // Sidecar mapping from codex's internal `fc_…` (sent on
  // `function_call_arguments.delta` events as `item_id`) to the
  // public `call_…`. Lets argument deltas resolve their slot
  // without polluting `toolCallIndices` with duplicates.
  itemIdToCallId: Map<string, string>;
  nextToolIndex: number;
  finishReason: string;
}

export function makeResponsesToChatState(model: string): ResponsesToChatState {
  return {
    id: `chatcmpl-${compactUuid().slice(0, 24)}`,
    created: Math.floor(Date.now() / 1000),
    fingerprint: `fp_${compactUuid().slice(0, 12)}`,
    model,
    rolePrimerSent: false,
    toolCallIndices: new Map(),
    itemIdToCallId: new Map(),
    nextToolIndex: 0,
    finishReason: "stop",
  };
}

function buildChatChunk(
  state: ResponsesToChatState,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): string {
  const payload = {
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    system_fingerprint: state.fingerprint,
    choices: [
      { index: 0, delta, finish_reason: finishReason, logprobs: null },
    ],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function ensureRolePrimer(state: ResponsesToChatState): string[] {
  if (state.rolePrimerSent) return [];
  state.rolePrimerSent = true;
  return [buildChatChunk(state, { role: "assistant", content: "" })];
}

export function responsesSSEToChat(
  event: string,
  data: any,
  state: ResponsesToChatState,
): string[] {
  switch (event) {
    case "response.output_text.delta":
      if (typeof data?.delta === "string" && data.delta) {
        return [
          ...ensureRolePrimer(state),
          buildChatChunk(state, { content: data.delta }),
        ];
      }
      return [];

    case "response.reasoning_summary_text.delta":
      if (typeof data?.delta === "string" && data.delta) {
        return [
          ...ensureRolePrimer(state),
          buildChatChunk(state, { reasoning_content: data.delta }),
        ];
      }
      return [];

    case "response.output_item.added": {
      const item = data?.item;
      if (item?.type === "function_call" && item.call_id) {
        if (!state.toolCallIndices.has(item.call_id)) {
          const idx = state.nextToolIndex++;
          // Codex's `output_item.added` carries both `item.id`
          // (e.g. `fc_…`) and `item.call_id` (e.g. `call_…`).
          // Subsequent `function_call_arguments.delta` events
          // reference the item via `item_id` (= `item.id`), NOT
          // `item.call_id`. Keep the chat slot map keyed only by
          // `call_id` and use `itemIdToCallId` for the
          // delta-event lookup so any future iteration over
          // `toolCallIndices` doesn't see duplicates.
          state.toolCallIndices.set(item.call_id, idx);
          if (item.id && item.id !== item.call_id) {
            state.itemIdToCallId.set(item.id, item.call_id);
          }
          state.finishReason = "tool_calls";
          return [
            ...ensureRolePrimer(state),
            buildChatChunk(state, {
              tool_calls: [
                {
                  index: idx,
                  id: item.call_id,
                  type: "function",
                  function: { name: item.name, arguments: "" },
                },
              ],
            }),
          ];
        }
      }
      return [];
    }

    case "response.function_call_arguments.delta": {
      const ref = data?.item_id || data?.call_id;
      const callId = ref
        ? state.toolCallIndices.has(ref)
          ? ref
          : state.itemIdToCallId.get(ref)
        : undefined;
      const idx = callId ? state.toolCallIndices.get(callId) : undefined;
      if (idx === undefined || typeof data?.delta !== "string") return [];
      return [
        buildChatChunk(state, {
          tool_calls: [
            {
              index: idx,
              function: { arguments: data.delta },
            },
          ],
        }),
      ];
    }

    case "response.completed": {
      const status = data?.response?.status;
      if (status === "incomplete" && state.finishReason === "stop") {
        state.finishReason = "length";
      }
      return [
        ...ensureRolePrimer(state),
        buildChatChunk(state, {}, state.finishReason),
        "data: [DONE]\n\n",
      ];
    }

    case "response.failed": {
      const msg = data?.response?.error?.message || "Upstream error";
      return [
        `data: ${JSON.stringify({
          error: { message: msg, type: "upstream_error" },
        })}\n\n`,
        "data: [DONE]\n\n",
      ];
    }

    default:
      return [];
  }
}

// ─────────────────────────────────────────────────────────────────────
// 6. Responses SSE → Anthropic Messages SSE
// ─────────────────────────────────────────────────────────────────────

export interface ResponsesToAnthropicState {
  messageId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  // Block tracking — Anthropic requires sequential indices and explicit
  // start/stop bracketing per block.
  thinkingOpen: boolean;
  thinkingIndex: number;
  textOpen: boolean;
  textIndex: number;
  toolBlocks: Map<string, { index: number; name: string; argsBuf: string }>;
  // Maps codex's internal `fc_…` item id (used in
  // `function_call_arguments.delta` events) to the public `call_…`
  // id we key `toolBlocks` by. Kept separate so iterating
  // `toolBlocks.values()` to emit `content_block_stop` doesn't see
  // duplicate entries.
  itemIdToCallId: Map<string, string>;
  nextBlockIndex: number;
  messageStartSent: boolean;
  stopReason: string;
}

export function makeResponsesToAnthropicState(
  model: string,
): ResponsesToAnthropicState {
  return {
    messageId: `msg_${compactUuid()}`,
    model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    thinkingOpen: false,
    thinkingIndex: -1,
    textOpen: false,
    textIndex: -1,
    toolBlocks: new Map(),
    itemIdToCallId: new Map(),
    nextBlockIndex: 0,
    messageStartSent: false,
    stopReason: "end_turn",
  };
}

function sseEvent(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function ensureMessageStart(state: ResponsesToAnthropicState): string[] {
  if (state.messageStartSent) return [];
  state.messageStartSent = true;
  return [
    sseEvent("message_start", {
      type: "message_start",
      message: {
        id: state.messageId,
        type: "message",
        role: "assistant",
        content: [],
        model: state.model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }),
  ];
}

function closeOpenBlocks(state: ResponsesToAnthropicState): string[] {
  const out: string[] = [];
  if (state.thinkingOpen) {
    out.push(
      sseEvent("content_block_stop", {
        type: "content_block_stop",
        index: state.thinkingIndex,
      }),
    );
    state.thinkingOpen = false;
  }
  if (state.textOpen) {
    out.push(
      sseEvent("content_block_stop", {
        type: "content_block_stop",
        index: state.textIndex,
      }),
    );
    state.textOpen = false;
  }
  for (const tool of state.toolBlocks.values()) {
    out.push(
      sseEvent("content_block_stop", {
        type: "content_block_stop",
        index: tool.index,
      }),
    );
  }
  state.toolBlocks.clear();
  return out;
}

export function responsesSSEToAnthropic(
  event: string,
  data: any,
  state: ResponsesToAnthropicState,
): string[] {
  switch (event) {
    case "response.created":
    case "response.in_progress":
      return ensureMessageStart(state);

    case "response.reasoning_summary_text.delta": {
      const delta = data?.delta;
      if (typeof delta !== "string" || !delta) return [];
      const out = ensureMessageStart(state);
      // Anthropic doesn't allow interleaving — once text starts we drop
      // further reasoning rather than emit a malformed stream.
      if (state.textOpen) return out;
      if (!state.thinkingOpen) {
        state.thinkingIndex = state.nextBlockIndex++;
        state.thinkingOpen = true;
        out.push(
          sseEvent("content_block_start", {
            type: "content_block_start",
            index: state.thinkingIndex,
            content_block: { type: "thinking", thinking: "" },
          }),
        );
      }
      out.push(
        sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: state.thinkingIndex,
          delta: { type: "thinking_delta", thinking: delta },
        }),
      );
      return out;
    }

    case "response.output_text.delta": {
      const delta = data?.delta;
      if (typeof delta !== "string" || !delta) return [];
      const out = ensureMessageStart(state);
      if (state.thinkingOpen) {
        out.push(
          sseEvent("content_block_stop", {
            type: "content_block_stop",
            index: state.thinkingIndex,
          }),
        );
        state.thinkingOpen = false;
      }
      if (!state.textOpen) {
        state.textIndex = state.nextBlockIndex++;
        state.textOpen = true;
        out.push(
          sseEvent("content_block_start", {
            type: "content_block_start",
            index: state.textIndex,
            content_block: { type: "text", text: "" },
          }),
        );
      }
      out.push(
        sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: state.textIndex,
          delta: { type: "text_delta", text: delta },
        }),
      );
      return out;
    }

    case "response.output_item.added": {
      const item = data?.item;
      if (item?.type === "function_call" && item.call_id) {
        const out = ensureMessageStart(state);
        // Tool blocks come after text/reasoning per Anthropic convention.
        if (state.thinkingOpen) {
          out.push(
            sseEvent("content_block_stop", {
              type: "content_block_stop",
              index: state.thinkingIndex,
            }),
          );
          state.thinkingOpen = false;
        }
        if (state.textOpen) {
          out.push(
            sseEvent("content_block_stop", {
              type: "content_block_stop",
              index: state.textIndex,
            }),
          );
          state.textOpen = false;
        }
        if (!state.toolBlocks.has(item.call_id)) {
          const idx = state.nextBlockIndex++;
          // toolBlocks is keyed by the public `call_id` only so the
          // close-blocks iteration emits one `content_block_stop`
          // per tool. The internal `fc_…` id used by subsequent
          // `function_call_arguments.delta` events is recorded in
          // a sidecar map (`itemIdToCallId`) so the delta lookup
          // can resolve back to the same block.
          const block = { index: idx, name: item.name, argsBuf: "" };
          state.toolBlocks.set(item.call_id, block);
          if (item.id && item.id !== item.call_id) {
            state.itemIdToCallId.set(item.id, item.call_id);
          }
          state.stopReason = "tool_use";
          out.push(
            sseEvent("content_block_start", {
              type: "content_block_start",
              index: idx,
              content_block: {
                type: "tool_use",
                id: item.call_id,
                name: item.name,
                input: {},
              },
            }),
          );
        }
        return out;
      }
      return [];
    }

    case "response.function_call_arguments.delta": {
      const ref = data?.item_id || data?.call_id;
      if (!ref) return [];
      const callId = state.toolBlocks.has(ref)
        ? ref
        : state.itemIdToCallId.get(ref);
      const tool = callId ? state.toolBlocks.get(callId) : undefined;
      if (!tool || typeof data?.delta !== "string") return [];
      tool.argsBuf += data.delta;
      return [
        sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: tool.index,
          delta: { type: "input_json_delta", partial_json: data.delta },
        }),
      ];
    }

    case "response.completed": {
      const r = data?.response;
      if (r?.usage) {
        state.inputTokens = r.usage.input_tokens || 0;
        state.outputTokens = r.usage.output_tokens || 0;
      }
      if (r?.status === "incomplete" && state.stopReason === "end_turn") {
        state.stopReason = "max_tokens";
      }
      const out = ensureMessageStart(state);
      out.push(...closeOpenBlocks(state));
      out.push(
        sseEvent("message_delta", {
          type: "message_delta",
          delta: { stop_reason: state.stopReason, stop_sequence: null },
          usage: { output_tokens: state.outputTokens },
        }),
      );
      out.push(sseEvent("message_stop", { type: "message_stop" }));
      return out;
    }

    case "response.failed": {
      const msg = data?.response?.error?.message || "Upstream error";
      const out = ensureMessageStart(state);
      out.push(...closeOpenBlocks(state));
      out.push(
        sseEvent("error", {
          type: "error",
          error: { type: "upstream_error", message: msg },
        }),
      );
      return out;
    }

    default:
      return [];
  }
}
