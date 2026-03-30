import test from "node:test";
import assert from "node:assert/strict";

import { collectCodexResponseFromSse } from "../src/providers/codex-sse";

function makeResponse(chunks: string[], contentType?: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: contentType ? { "Content-Type": contentType } : undefined,
  });
}

test("collectCodexResponseFromSse parses SSE even when content-type is omitted", async () => {
  const response = await collectCodexResponseFromSse(makeResponse([
    "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_123\",\"object\":\"response\",\"status\":\"in_progress\",\"model\":\"gpt-5.4\"}}\n\n",
    "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\n",
    "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_123\",\"object\":\"response\",\"status\":\"completed\",\"model\":\"gpt-5.4\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n",
  ]));

  assert.equal(response.id, "resp_123");
  assert.equal(response.output[0].content[0].text, "ok");
  assert.equal(response.usage.total_tokens, 2);
});
