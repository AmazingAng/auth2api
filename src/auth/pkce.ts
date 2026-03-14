import crypto from "crypto";
import { PKCECodes } from "./types";

function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generatePKCECodes(): PKCECodes {
  const verifierBytes = crypto.randomBytes(96);
  const codeVerifier = base64url(verifierBytes);
  const challengeHash = crypto.createHash("sha256").update(codeVerifier).digest();
  const codeChallenge = base64url(challengeHash);
  return { codeVerifier, codeChallenge };
}
