import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";

export function generateFakeUserID(): string {
  const hex64 = crypto.randomBytes(32).toString("hex");
  return `user_${hex64}_account_${uuidv4()}_session_${uuidv4()}`;
}

const USER_ID_RE = /^user_[a-fA-F0-9]{64}_account_[0-9a-f-]{36}_session_[0-9a-f-]{36}$/;

export function isValidFakeUserID(id: string): boolean {
  return USER_ID_RE.test(id);
}

export function shouldCloak(mode: string, userAgent: string): boolean {
  if (mode === "always") return true;
  if (mode === "never") return false;
  return !userAgent.startsWith("claude-cli");
}

// In-memory cache for user IDs per API key
const userIdCache = new Map<string, string>();

export function getCachedUserID(apiKey: string, useCache: boolean): string {
  if (!useCache) return generateFakeUserID();
  const key = crypto.createHash("sha256").update(apiKey).digest("hex");
  let id = userIdCache.get(key);
  if (!id) {
    id = generateFakeUserID();
    userIdCache.set(key, id);
  }
  return id;
}
