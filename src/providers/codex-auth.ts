import fs from "fs";
import path from "path";

export interface CodexAuthSnapshot {
  available: boolean;
  authMode: string;
  accessToken: string;
  refreshToken: string;
  accountId: string;
  lastRefresh: string | null;
  path: string;
  mtimeMs: number;
}

export class CodexAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexAuthError";
  }
}

function resolveAuthFile(filePath: string): string {
  if (filePath.startsWith("~")) {
    return path.join(process.env.HOME || "/root", filePath.slice(1));
  }
  return path.resolve(filePath);
}

export class CodexAuthStore {
  private readonly authFilePath: string;
  private cachedMtimeMs: number | null = null;
  private cachedSnapshot: CodexAuthSnapshot | null = null;

  constructor(authFilePath: string) {
    this.authFilePath = resolveAuthFile(authFilePath);
  }

  load(): CodexAuthSnapshot {
    if (!fs.existsSync(this.authFilePath)) {
      throw new CodexAuthError(`Codex auth file not found: ${this.authFilePath}`);
    }

    const stat = fs.statSync(this.authFilePath);
    if (this.cachedSnapshot && this.cachedMtimeMs === stat.mtimeMs) {
      return this.cachedSnapshot;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(fs.readFileSync(this.authFilePath, "utf-8"));
    } catch (err: any) {
      throw new CodexAuthError(`Failed to parse Codex auth file ${this.authFilePath}: ${err.message}`);
    }

    const accessToken = parsed?.tokens?.access_token;
    if (!accessToken) {
      throw new CodexAuthError("Codex auth file missing tokens.access_token");
    }

    const snapshot: CodexAuthSnapshot = {
      available: true,
      authMode: parsed?.auth_mode || "unknown",
      accessToken,
      refreshToken: parsed?.tokens?.refresh_token || "",
      accountId: parsed?.tokens?.account_id || "",
      lastRefresh: typeof parsed?.last_refresh === "string" ? parsed.last_refresh : null,
      path: this.authFilePath,
      mtimeMs: stat.mtimeMs,
    };

    this.cachedMtimeMs = stat.mtimeMs;
    this.cachedSnapshot = snapshot;
    return snapshot;
  }
}
