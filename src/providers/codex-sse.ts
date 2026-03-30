function mergeResponseSnapshot(current: any, nextValue: any): any {
  if (!nextValue || typeof nextValue !== "object" || Array.isArray(nextValue)) {
    return current;
  }

  return {
    ...current,
    ...nextValue,
    usage: nextValue.usage || current?.usage,
    output: nextValue.output || current?.output,
    content: nextValue.content || current?.content,
  };
}

function buildOutputFromText(outputText: string, status: string): any[] {
  if (!outputText) {
    return [];
  }

  return [{
    type: "message",
    role: "assistant",
    status,
    content: [
      {
        type: "output_text",
        text: outputText,
        annotations: [],
      },
    ],
  }];
}

export async function collectCodexResponseFromSse(upstreamResp: Response): Promise<any> {
  const contentType = upstreamResp.headers.get("content-type") || "";
  if (/application\/json/i.test(contentType)) {
    return upstreamResp.json();
  }

  const reader = upstreamResp.body?.getReader();
  if (!reader) {
    throw new Error("Codex upstream response body is unavailable");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";
  let response: any = {};
  let outputText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const rawLine of lines) {
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
      if (!dataStr || dataStr === "[DONE]") {
        continue;
      }

      let data: any;
      try {
        data = JSON.parse(dataStr);
      } catch {
        continue;
      }

      if (currentEvent === "response.created") {
        response = mergeResponseSnapshot(response, data?.response || data);
        continue;
      }

      if (currentEvent === "response.output_text.delta") {
        if (typeof data?.delta === "string") {
          outputText += data.delta;
        }
        continue;
      }

      if (currentEvent === "response.completed") {
        response = mergeResponseSnapshot(response, data?.response || data);
      }
    }
  }

  if (!response.output && !response.content) {
    response.output = buildOutputFromText(outputText, response.status || "completed");
  }

  return response;
}
