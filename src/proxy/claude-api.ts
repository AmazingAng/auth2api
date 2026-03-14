const BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_BETA =
  "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05";

function getStainlessArch(): string {
  const arch = process.arch;
  if (arch === "arm64") return "arm64";
  if (arch === "x64") return "x64";
  return "x86";
}

function getStainlessOs(): string {
  const platform = process.platform;
  if (platform === "darwin") return "MacOS";
  if (platform === "win32") return "Windows";
  if (platform === "freebsd") return "FreeBSD";
  return "Linux";
}

function buildHeaders(accessToken: string, stream: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    "Anthropic-Version": "2023-06-01",
    "Anthropic-Beta": ANTHROPIC_BETA,
    "Anthropic-Dangerous-Direct-Browser-Access": "true",
    "X-App": "cli",
    "User-Agent": "claude-cli/2.1.63 (external, cli)",
    Connection: "keep-alive",
    "X-Stainless-Runtime": "node",
    "X-Stainless-Lang": "js",
    "X-Stainless-Runtime-Version": "v24.3.0",
    "X-Stainless-Package-Version": "0.74.0",
    "X-Stainless-Arch": getStainlessArch(),
    "X-Stainless-Os": getStainlessOs(),
    "X-Stainless-Timeout": "600",
    "X-Stainless-Retry-Count": "0",
  };

  if (stream) {
    headers["Accept"] = "text/event-stream";
    headers["Accept-Encoding"] = "identity";
  } else {
    headers["Accept"] = "application/json";
    headers["Accept-Encoding"] = "gzip, deflate, br, zstd";
  }

  return headers;
}

export async function callClaudeAPI(
  accessToken: string,
  body: any,
  stream: boolean
): Promise<Response> {
  const url = `${BASE_URL}/v1/messages?beta=true`;
  const headers = buildHeaders(accessToken, stream);

  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
}

export async function callClaudeCountTokens(
  accessToken: string,
  body: any
): Promise<Response> {
  const url = `${BASE_URL}/v1/messages/count_tokens?beta=true`;
  const headers = buildHeaders(accessToken, false);

  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
}
