import crypto from "crypto";

export function hashApiKey(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

export function extractApiKey(headers: {
  authorization?: string;
  "x-api-key"?: string | string[];
}): string {
  const auth = headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    return auth.slice(7);
  }

  const xApiKey = headers["x-api-key"];
  if (typeof xApiKey === "string") {
    return xApiKey;
  }
  if (Array.isArray(xApiKey) && xApiKey.length > 0) {
    return xApiKey[0];
  }

  return "";
}
