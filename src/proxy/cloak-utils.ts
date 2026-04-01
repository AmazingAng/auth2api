import crypto from "crypto";
import fs from "fs";
import path from "path";

/**
 * Persistent device_id — one per auth2api instance, same as real Claude Code's
 * getOrCreateUserID() which generates once and saves to global config.
 *
 * Format: randomBytes(32).toString("hex") → 64-char hex string.
 */
let cachedDeviceId: string | null = null;

export function getDeviceId(authDir: string): string {
  if (cachedDeviceId) return cachedDeviceId;

  const filePath = path.join(authDir, ".device_id");
  try {
    cachedDeviceId = fs.readFileSync(filePath, "utf-8").trim();
    if (cachedDeviceId && /^[a-f0-9]{64}$/.test(cachedDeviceId)) {
      return cachedDeviceId;
    }
  } catch {}

  cachedDeviceId = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, cachedDeviceId, { mode: 0o600 });
  return cachedDeviceId;
}
