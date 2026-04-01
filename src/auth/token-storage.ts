import fs from "fs";
import path from "path";
import { TokenData, TokenStorage } from "./types";

export function tokenToStorage(data: TokenData): TokenStorage {
  return {
    access_token: data.accessToken,
    refresh_token: data.refreshToken,
    last_refresh: new Date().toISOString(),
    email: data.email,
    type: "claude",
    expired: data.expiresAt,
    account_uuid: data.accountUuid,
  };
}

export function storageToToken(storage: TokenStorage): TokenData {
  return {
    accessToken: storage.access_token,
    refreshToken: storage.refresh_token,
    email: storage.email,
    expiresAt: storage.expired,
    accountUuid: storage.account_uuid || "",
  };
}

export function saveToken(authDir: string, data: TokenData): void {
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
  const sanitized = data.email.replace(/[^a-zA-Z0-9@._-]/g, "_").replace(/\.\./g, "_");
  const filename = `claude-${sanitized}.json`;
  const filePath = path.join(authDir, filename);
  fs.writeFileSync(filePath, JSON.stringify(tokenToStorage(data), null, 2), { mode: 0o600 });
}

export function loadAllTokens(authDir: string): TokenData[] {
  if (!fs.existsSync(authDir)) return [];
  const files = fs.readdirSync(authDir).filter((f) => f.startsWith("claude-") && f.endsWith(".json"));
  const tokens: TokenData[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(authDir, file), "utf-8");
      const storage = JSON.parse(raw) as TokenStorage;
      tokens.push(storageToToken(storage));
    } catch {
      console.error(`Failed to load token file: ${file}`);
    }
  }
  return tokens;
}
