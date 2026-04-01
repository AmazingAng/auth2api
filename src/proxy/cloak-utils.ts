import crypto from "crypto";
import fs from "fs";
import path from "path";

/**
 * Persistent device_id — one per account, same as real Claude Code's
 * getOrCreateUserID() which generates once and saves to global config.
 *
 * Format: randomBytes(32).toString("hex") → 64-char hex string.
 */
const deviceIdCache = new Map<string, string>();

export function getDeviceId(authDir: string, email: string): string {
  if (deviceIdCache.has(email)) return deviceIdCache.get(email)!;

  const suffix = crypto.createHash("sha256").update(email).digest("hex").slice(0, 12);
  const filePath = path.join(authDir, `.device_id_${suffix}`);
  try {
    const stored = fs.readFileSync(filePath, "utf-8").trim();
    if (stored && /^[a-f0-9]{64}$/.test(stored)) {
      deviceIdCache.set(email, stored);
      return stored;
    }
  } catch {}

  const id = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, id, { mode: 0o600 });
  deviceIdCache.set(email, id);
  return id;
}
