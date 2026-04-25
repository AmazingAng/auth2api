import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { extractApiKey, hashApiKey, timeout } from "../src/utils/common";
import { classifyFailure } from "../src/utils/http";
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
} from "../src/upstream/translator";
import { loadConfig, isDebugLevel, resolveAuthDir } from "../src/config";
import { UsageData } from "../src/accounts/manager";

// ══════════════════════════════════════════════════
// utils/common.ts
// ══════════════════════════════════════════════════

test("extractApiKey extracts Bearer token", () => {
  assert.equal(
    extractApiKey({ authorization: "Bearer sk-test-123" }),
    "sk-test-123",
  );
});

test("extractApiKey extracts x-api-key header", () => {
  assert.equal(extractApiKey({ "x-api-key": "sk-test-456" }), "sk-test-456");
});

test("extractApiKey prefers Bearer over x-api-key", () => {
  assert.equal(
    extractApiKey({
      authorization: "Bearer sk-bearer",
      "x-api-key": "sk-xapi",
    }),
    "sk-bearer",
  );
});

test("extractApiKey returns empty string when no key", () => {
  assert.equal(extractApiKey({}), "");
});

test("extractApiKey handles x-api-key as array", () => {
  assert.equal(extractApiKey({ "x-api-key": ["sk-first", "sk-second"] }), "sk-first");
});

test("hashApiKey returns consistent sha256 hex", () => {
  const hash1 = hashApiKey("test-key");
  const hash2 = hashApiKey("test-key");
  assert.equal(hash1, hash2);
  assert.equal(hash1.length, 64);
  assert.match(hash1, /^[a-f0-9]{64}$/);
});

test("hashApiKey returns different hashes for different keys", () => {
  assert.notEqual(hashApiKey("key-a"), hashApiKey("key-b"));
});

test("timeout resolves after delay", async () => {
  const start = Date.now();
  await timeout(50);
  assert.ok(Date.now() - start >= 45);
});

// ══════════════════════════════════════════════════
// utils/http.ts
// ══════════════════════════════════════════════════

test("classifyFailure maps status codes correctly", () => {
  assert.equal(classifyFailure(429), "rate_limit");
  assert.equal(classifyFailure(401), "auth");
  assert.equal(classifyFailure(403), "forbidden");
  assert.equal(classifyFailure(500), "server");
  assert.equal(classifyFailure(502), "server");
  assert.equal(classifyFailure(503), "server");
  assert.equal(classifyFailure(418), "server");
});

// ══════════════════════════════════════════════════
// config.ts
// ══════════════════════════════════════════════════

test("isDebugLevel returns correct values", () => {
  assert.equal(isDebugLevel("off", "errors"), false);
  assert.equal(isDebugLevel("errors", "errors"), true);
  assert.equal(isDebugLevel("errors", "verbose"), false);
  assert.equal(isDebugLevel("verbose", "errors"), true);
  assert.equal(isDebugLevel("verbose", "verbose"), true);
});

test("resolveAuthDir expands tilde", () => {
  const result = resolveAuthDir("~/.auth2api");
  assert.ok(!result.startsWith("~"));
  assert.ok(result.endsWith(".auth2api"));
});

test("resolveAuthDir resolves relative paths", () => {
  const result = resolveAuthDir("./data");
  assert.ok(path.isAbsolute(result));
});

test("loadConfig uses defaults when file missing", () => {
  const config = loadConfig("/tmp/nonexistent-config-" + Date.now() + ".yaml");
  assert.equal(config.port, 8317);
  assert.equal(config["body-limit"], "200mb");
  assert.equal(config.debug, "off");
  assert.ok(config["api-keys"] instanceof Set);
  assert.ok(config["api-keys"].size > 0); // auto-generated
});

test("loadConfig normalizes debug mode", () => {
  const configPath = path.join(
    os.tmpdir(),
    `auth2api-debug-test-${Date.now()}.yaml`,
  );
  fs.writeFileSync(
    configPath,
    'api-keys:\n  - "sk-test"\ndebug: true\n',
  );
  try {
    const config = loadConfig(configPath);
    assert.equal(config.debug, "errors"); // true → "errors"
  } finally {
    fs.unlinkSync(configPath);
  }
});

// ══════════════════════════════════════════════════
// translator.ts — model resolution
// ══════════════════════════════════════════════════

test("resolveModel maps aliases", () => {
  assert.equal(resolveModel("opus"), "claude-opus-4-7");
  assert.equal(resolveModel("sonnet"), "claude-sonnet-4-6");
  assert.equal(resolveModel("haiku"), "claude-haiku-4-5-20251001");
});

test("resolveModel passes through unknown models", () => {
  assert.equal(resolveModel("gpt-4o"), "gpt-4o");
  assert.equal(resolveModel("claude-sonnet-4-6"), "claude-sonnet-4-6");
  assert.equal(resolveModel("claude-opus-4-7"), "claude-opus-4-7");
  assert.equal(resolveModel("claude-opus-4-6"), "claude-opus-4-6");
});

// ══════════════════════════════════════════════════
// translator.ts — OpenAI Chat → Anthropic
// ══════════════════════════════════════════════════

test("openaiToAnthropic translates basic request", () => {
  const result = openaiToAnthropic({
    model: "sonnet",
    messages: [{ role: "user", content: "hello" }],
    stream: false,
  });
  assert.equal(result.model, "claude-sonnet-4-6");
  assert.equal(result.stream, false);
  assert.equal(result.max_tokens, 8192);
  assert.deepEqual(result.messages, [{ role: "user", content: "hello" }]);
});

test("openaiToAnthropic uses max_completion_tokens over max_tokens", () => {
  const result = openaiToAnthropic({
    model: "sonnet",
    max_tokens: 100,
    max_completion_tokens: 500,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(result.max_tokens, 500);
});

test("openaiToAnthropic translates temperature and top_p", () => {
  const result = openaiToAnthropic({
    model: "sonnet",
    temperature: 0.5,
    top_p: 0.9,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(result.temperature, 0.5);
  assert.equal(result.top_p, 0.9);
});

test("openaiToAnthropic translates stop sequences", () => {
  const result = openaiToAnthropic({
    model: "sonnet",
    stop: ["END", "STOP"],
    messages: [{ role: "user", content: "hi" }],
  });
  assert.deepEqual(result.stop_sequences, ["END", "STOP"]);
});

test("openaiToAnthropic translates single stop string", () => {
  const result = openaiToAnthropic({
    model: "sonnet",
    stop: "END",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.deepEqual(result.stop_sequences, ["END"]);
});

test("openaiToAnthropic translates system messages", () => {
  const result = openaiToAnthropic({
    model: "sonnet",
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "hi" },
    ],
  });
  assert.deepEqual(result.system, [
    { type: "text", text: "You are helpful." },
  ]);
  assert.equal(result.messages.length, 1);
});

test("openaiToAnthropic translates reasoning_effort to thinking", () => {
  const result = openaiToAnthropic({
    model: "sonnet",
    reasoning_effort: "high",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(result.thinking.type, "enabled");
  assert.equal(result.thinking.budget_tokens, 24576);
});

test("openaiToAnthropic translates tools", () => {
  const result = openaiToAnthropic({
    model: "sonnet",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  });
  assert.equal(result.tools[0].name, "get_weather");
  assert.equal(result.tools[0].description, "Get weather");
  assert.ok(result.tools[0].input_schema);
});

test("openaiToAnthropic translates tool_choice", () => {
  const auto = openaiToAnthropic({
    model: "sonnet",
    messages: [{ role: "user", content: "hi" }],
    tool_choice: "auto",
  });
  assert.deepEqual(auto.tool_choice, { type: "auto" });

  const required = openaiToAnthropic({
    model: "sonnet",
    messages: [{ role: "user", content: "hi" }],
    tool_choice: "required",
  });
  assert.deepEqual(required.tool_choice, { type: "any" });
});

test("openaiToAnthropic translates parallel_tool_calls", () => {
  const result = openaiToAnthropic({
    model: "sonnet",
    messages: [{ role: "user", content: "hi" }],
    tool_choice: "auto",
    parallel_tool_calls: false,
  });
  assert.equal(result.tool_choice.disable_parallel_tool_use, true);
});

test("openaiToAnthropic translates response_format json_schema", () => {
  const result = openaiToAnthropic({
    model: "sonnet",
    messages: [{ role: "user", content: "hi" }],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "test",
        schema: { type: "object", properties: { name: { type: "string" } } },
      },
    },
  });
  assert.equal(result.output_config.format.type, "json_schema");
  assert.equal(result.output_config.format.name, "test");
});

test("openaiToAnthropic translates tool role messages", () => {
  const result = openaiToAnthropic({
    model: "sonnet",
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"NYC"}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: '{"temp":72}',
      },
    ],
  });
  // assistant message with tool_use
  assert.equal(result.messages[1].role, "assistant");
  assert.equal(result.messages[1].content[0].type, "tool_use");
  // tool result
  assert.equal(result.messages[2].role, "user");
  assert.equal(result.messages[2].content[0].type, "tool_result");
  assert.equal(result.messages[2].content[0].tool_use_id, "call_1");
});

// ══════════════════════════════════════════════════
// translator.ts — Anthropic → OpenAI Chat
// ══════════════════════════════════════════════════

test("anthropicToOpenai translates basic response", () => {
  const result = anthropicToOpenai(
    {
      content: [{ type: "text", text: "Hello!" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    "claude-sonnet-4-6",
  );
  assert.equal(result.object, "chat.completion");
  assert.equal(result.choices[0].message.content, "Hello!");
  assert.equal(result.choices[0].message.role, "assistant");
  assert.equal(result.choices[0].finish_reason, "stop");
  assert.equal(result.usage.prompt_tokens, 10);
  assert.equal(result.usage.completion_tokens, 5);
  assert.equal(result.usage.total_tokens, 15);
});

test("anthropicToOpenai maps stop reasons correctly", () => {
  const endTurn = anthropicToOpenai(
    { content: [], stop_reason: "end_turn", usage: {} },
    "sonnet",
  );
  assert.equal(endTurn.choices[0].finish_reason, "stop");

  const maxTokens = anthropicToOpenai(
    { content: [], stop_reason: "max_tokens", usage: {} },
    "sonnet",
  );
  assert.equal(maxTokens.choices[0].finish_reason, "length");

  const toolUse = anthropicToOpenai(
    { content: [], stop_reason: "tool_use", usage: {} },
    "sonnet",
  );
  assert.equal(toolUse.choices[0].finish_reason, "tool_calls");
});

test("anthropicToOpenai translates tool_use blocks", () => {
  const result = anthropicToOpenai(
    {
      content: [
        {
          type: "tool_use",
          id: "call_1",
          name: "get_weather",
          input: { city: "NYC" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 20 },
    },
    "sonnet",
  );
  assert.equal(result.choices[0].message.tool_calls.length, 1);
  assert.equal(result.choices[0].message.tool_calls[0].id, "call_1");
  assert.equal(
    result.choices[0].message.tool_calls[0].function.name,
    "get_weather",
  );
  assert.equal(
    result.choices[0].message.tool_calls[0].function.arguments,
    '{"city":"NYC"}',
  );
});

test("anthropicToOpenai includes usage details", () => {
  const result = anthropicToOpenai(
    {
      content: [],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 30,
      },
    },
    "sonnet",
  );
  assert.equal(result.usage.prompt_tokens_details.cached_tokens, 30);
  assert.equal(result.usage.completion_tokens_details.reasoning_tokens, 0);
});

// ══════════════════════════════════════════════════
// translator.ts — Chat SSE streaming
// ══════════════════════════════════════════════════

function parseChatSSE(chunk: string): any {
  const json = chunk.replace(/^data: /, "").trim();
  return JSON.parse(json);
}

test("anthropicSSEToChat handles message_start", () => {
  const state = createStreamState("sonnet", false);
  const chunks = anthropicSSEToChat(
    "message_start",
    { message: { usage: { input_tokens: 10 } } },
    state,
  );
  assert.equal(chunks.length, 1);
  const parsed = parseChatSSE(chunks[0]);
  assert.equal(parsed.choices[0].delta.role, "assistant");
});

test("anthropicSSEToChat handles text_delta", () => {
  const state = createStreamState("sonnet", false);
  const chunks = anthropicSSEToChat(
    "content_block_delta",
    { delta: { type: "text_delta", text: "Hello" } },
    state,
  );
  assert.equal(chunks.length, 1);
  const parsed = parseChatSSE(chunks[0]);
  assert.equal(parsed.choices[0].delta.content, "Hello");
});

test("anthropicSSEToChat handles thinking_delta", () => {
  const state = createStreamState("sonnet", false);
  const chunks = anthropicSSEToChat(
    "content_block_delta",
    { delta: { type: "thinking_delta", thinking: "Let me think..." } },
    state,
  );
  const parsed = parseChatSSE(chunks[0]);
  assert.equal(parsed.choices[0].delta.reasoning_content, "Let me think...");
});

test("anthropicSSEToChat handles message_stop with usage", () => {
  const state = createStreamState("sonnet", true);
  const usage: UsageData = {
    inputTokens: 10,
    outputTokens: 5,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 2,
  };
  const chunks = anthropicSSEToChat("message_stop", {}, state, usage);
  assert.equal(chunks.length, 2); // usage chunk + [DONE]
  const usageChunk = parseChatSSE(chunks[0]);
  assert.deepEqual(usageChunk.choices, []);
  assert.equal(usageChunk.usage.prompt_tokens, 10);
  assert.equal(usageChunk.usage.completion_tokens, 5);
  assert.equal(usageChunk.usage.prompt_tokens_details.cached_tokens, 2);
  assert.equal(chunks[1], "data: [DONE]\n\n");
});

test("anthropicSSEToChat skips usage when includeUsage is false", () => {
  const state = createStreamState("sonnet", false);
  const usage: UsageData = {
    inputTokens: 10,
    outputTokens: 5,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
  const chunks = anthropicSSEToChat("message_stop", {}, state, usage);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], "data: [DONE]\n\n");
});

test("anthropicSSEToChat handles tool_use streaming", () => {
  const state = createStreamState("sonnet", false);

  // tool block start
  const startChunks = anthropicSSEToChat(
    "content_block_start",
    { content_block: { type: "tool_use", id: "call_1", name: "get_weather" }, index: 1 },
    state,
  );
  assert.equal(startChunks.length, 1);
  const startParsed = parseChatSSE(startChunks[0]);
  assert.equal(startParsed.choices[0].delta.tool_calls[0].id, "call_1");
  assert.equal(startParsed.choices[0].delta.tool_calls[0].index, 0);

  // tool delta
  const deltaChunks = anthropicSSEToChat(
    "content_block_delta",
    { delta: { type: "input_json_delta", partial_json: '{"city"' }, index: 1 },
    state,
  );
  assert.equal(deltaChunks.length, 1);
  const deltaParsed = parseChatSSE(deltaChunks[0]);
  assert.equal(
    deltaParsed.choices[0].delta.tool_calls[0].function.arguments,
    '{"city"',
  );
  assert.equal(deltaParsed.choices[0].delta.tool_calls[0].index, 0);
});

test("anthropicSSEToChat returns empty for unknown events", () => {
  const state = createStreamState("sonnet", false);
  assert.deepEqual(anthropicSSEToChat("ping", {}, state), []);
  assert.deepEqual(anthropicSSEToChat("unknown_event", {}, state), []);
});

// ══════════════════════════════════════════════════
// translator.ts — Responses API
// ══════════════════════════════════════════════════

test("responsesToAnthropic translates basic request", () => {
  const result = responsesToAnthropic({
    model: "sonnet",
    input: [{ role: "user", content: "hello" }],
    stream: false,
  });
  assert.equal(result.model, "claude-sonnet-4-6");
  assert.equal(result.stream, false);
  assert.deepEqual(result.messages, [{ role: "user", content: "hello" }]);
});

test("responsesToAnthropic translates temperature and top_p", () => {
  const result = responsesToAnthropic({
    model: "sonnet",
    input: [{ role: "user", content: "hi" }],
    temperature: 0.7,
    top_p: 0.8,
  });
  assert.equal(result.temperature, 0.7);
  assert.equal(result.top_p, 0.8);
});

test("responsesToAnthropic translates instructions to system", () => {
  const result = responsesToAnthropic({
    model: "sonnet",
    instructions: "Be helpful",
    input: [{ role: "user", content: "hi" }],
  });
  assert.deepEqual(result.system, [{ type: "text", text: "Be helpful" }]);
});

test("responsesToAnthropic translates reasoning with summary", () => {
  const result = responsesToAnthropic({
    model: "sonnet",
    input: [{ role: "user", content: "hi" }],
    reasoning: { effort: "high", summary: "concise" },
  });
  assert.equal(result.thinking.type, "enabled");
  assert.equal(result.thinking.budget_tokens, 24576);
  assert.equal(result.thinking.display, "summarized");
});

test("anthropicToResponses translates basic response", () => {
  const result = anthropicToResponses(
    {
      content: [{ type: "text", text: "Hello!" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    "claude-sonnet-4-6",
  );
  assert.equal(result.object, "response");
  assert.equal(result.status, "completed");
  assert.equal(result.output[0].type, "message");
  assert.equal(result.output[0].content[0].type, "output_text");
  assert.equal(result.output[0].content[0].text, "Hello!");
  assert.equal(result.output_text, "Hello!");
  assert.equal(result.usage.input_tokens, 10);
  assert.equal(result.usage.output_tokens, 5);
});

test("anthropicToResponses sets incomplete status on max_tokens", () => {
  const result = anthropicToResponses(
    {
      content: [{ type: "text", text: "partial" }],
      stop_reason: "max_tokens",
      usage: {},
    },
    "sonnet",
  );
  assert.equal(result.status, "incomplete");
});

test("anthropicToResponses includes usage details", () => {
  const result = anthropicToResponses(
    {
      content: [],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 20,
      },
    },
    "sonnet",
  );
  assert.equal(result.usage.input_tokens_details.cached_tokens, 20);
  assert.equal(result.usage.output_tokens_details.reasoning_tokens, 0);
});

// ══════════════════════════════════════════════════
// translator.ts — Responses SSE streaming
// ══════════════════════════════════════════════════

test("anthropicSSEToResponses handles message_start", () => {
  const state = makeResponsesState();
  const usage: UsageData = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
  const events = anthropicSSEToResponses(
    "message_start",
    {},
    state,
    "sonnet",
    usage,
  );
  assert.equal(events.length, 2);
  assert.ok(events[0].includes("response.created"));
  assert.ok(events[1].includes("response.in_progress"));
});

test("anthropicSSEToResponses handles text streaming", () => {
  const state = makeResponsesState();
  const usage: UsageData = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };

  // text block start
  const startEvents = anthropicSSEToResponses(
    "content_block_start",
    { content_block: { type: "text", text: "" }, index: 0 },
    state,
    "sonnet",
    usage,
  );
  assert.ok(startEvents.some((e) => e.includes("response.output_item.added")));
  assert.ok(
    startEvents.some((e) => e.includes("response.content_part.added")),
  );

  // text delta
  const deltaEvents = anthropicSSEToResponses(
    "content_block_delta",
    { delta: { type: "text_delta", text: "Hello" }, index: 0 },
    state,
    "sonnet",
    usage,
  );
  assert.ok(
    deltaEvents.some((e) => e.includes("response.output_text.delta")),
  );
  assert.ok(deltaEvents.some((e) => e.includes('"Hello"')));

  // text block stop
  const stopEvents = anthropicSSEToResponses(
    "content_block_stop",
    { index: 0 },
    state,
    "sonnet",
    usage,
  );
  assert.ok(stopEvents.some((e) => e.includes("response.output_text.done")));
  assert.ok(
    stopEvents.some((e) => e.includes("response.output_item.done")),
  );
});

test("anthropicSSEToResponses handles message_stop with usage", () => {
  const state = makeResponsesState();
  const usage: UsageData = {
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 10,
  };
  const events = anthropicSSEToResponses(
    "message_stop",
    {},
    state,
    "sonnet",
    usage,
  );
  assert.ok(events.some((e) => e.includes("response.completed")));
  assert.ok(events.some((e) => e.includes("response.done")));
  assert.ok(events.some((e) => e.includes('"input_tokens":100')));
});

test("anthropicSSEToResponses returns empty for unknown events", () => {
  const state = makeResponsesState();
  const usage: UsageData = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
  assert.deepEqual(
    anthropicSSEToResponses("ping", {}, state, "sonnet", usage),
    [],
  );
});
