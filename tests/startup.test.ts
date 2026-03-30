import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AccountManager } from "../src/accounts/manager";
import { Config } from "../src/config";
import { canStartServer } from "../src/startup";
import { saveToken } from "../src/auth/token-storage";
import { TokenData } from "../src/auth/types";

function makeConfig(authDir: string): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    "auth-dir": authDir,
    "api-keys": ["test-key"],
    "body-limit": "200mb",
    cloaking: {
      mode: "never",
      "strict-mode": false,
      "sensitive-words": [],
      "cache-user-id": false,
    },
    timeouts: {
      "messages-ms": 120000,
      "stream-messages-ms": 600000,
      "count-tokens-ms": 30000,
    },
    debug: "off",
    codex: {
      enabled: true,
      "auth-file": path.join(authDir, "codex-auth.json"),
      models: ["gpt-5.4"],
    },
  };
}

function writeClaudeToken(authDir: string): void {
  const token: TokenData = {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    email: "test@example.com",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
  saveToken(authDir, token);
}

function writeCodexAuth(authDir: string): void {
  fs.writeFileSync(
    path.join(authDir, "codex-auth.json"),
    JSON.stringify({
      auth_mode: "oauth",
      last_refresh: new Date().toISOString(),
      tokens: {
        access_token: "codex-access-token",
        refresh_token: "codex-refresh-token",
        account_id: "acct_codex",
      },
    })
  );
}

function loadManager(authDir: string): AccountManager {
  const manager = new AccountManager(authDir);
  manager.load();
  return manager;
}

test("allows startup when Claude is missing but Codex auth is available", () => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-startup-"));

  try {
    writeCodexAuth(authDir);
    const manager = loadManager(authDir);

    assert.equal(canStartServer(makeConfig(authDir), manager), true);
  } finally {
    fs.rmSync(authDir, { recursive: true, force: true });
  }
});

test("rejects startup when neither Claude nor Codex auth is available", () => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-startup-"));

  try {
    const manager = loadManager(authDir);

    assert.equal(canStartServer(makeConfig(authDir), manager), false);
  } finally {
    fs.rmSync(authDir, { recursive: true, force: true });
  }
});

test("allows startup when Claude auth is available even if Codex auth is missing", () => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-startup-"));

  try {
    writeClaudeToken(authDir);
    const manager = loadManager(authDir);

    assert.equal(canStartServer(makeConfig(authDir), manager), true);
  } finally {
    fs.rmSync(authDir, { recursive: true, force: true });
  }
});

test("rejects startup when Codex auth exists but no Codex models are configured", () => {
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-startup-"));

  try {
    writeCodexAuth(authDir);
    const manager = loadManager(authDir);
    const config = makeConfig(authDir);
    config.codex.models = [];

    assert.equal(canStartServer(config, manager), false);
  } finally {
    fs.rmSync(authDir, { recursive: true, force: true });
  }
});
