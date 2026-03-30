const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

function buildHeaders(accessToken: string, stream: boolean): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
}

export async function callCodexResponses(accessToken: string, body: unknown, stream = false): Promise<Response> {
  return fetch(CODEX_RESPONSES_URL, {
    method: "POST",
    headers: buildHeaders(accessToken, stream),
    body: JSON.stringify(body),
  });
}
