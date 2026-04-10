import crypto from "crypto";
import { Request } from "express";
import type { Config } from "../config";
import { AvailableAccount } from "../accounts/manager";
import { extractApiKey, hashApiKey } from "../utils/common";
import {
  getSessionID,
  DEFAULT_CLI_VERSION,
  DEFAULT_ENTRYPOINT,
} from "./anthropic-api";

/**
 * Fingerprint algorithm — exact replica of Claude Code's utils/fingerprint.ts
 *
 * Algorithm: SHA256(SALT + msg[4] + msg[7] + msg[20] + version).slice(0, 3)
 * The salt and char indices must match the backend validator exactly.
 */
const FINGERPRINT_SALT = "59cf53e54c78";

function extractFirstUserMessageText(messages: any[]): string {
  if (!Array.isArray(messages)) return "";
  const first = messages.find((m: any) => m.role === "user");
  if (!first) return "";
  if (typeof first.content === "string") return first.content;
  if (Array.isArray(first.content)) {
    const textBlock = first.content.find((b: any) => b.type === "text");
    if (textBlock) return textBlock.text || "";
  }
  return "";
}

function computeFingerprint(messageText: string, version: string): string {
  const indices = [4, 7, 20];
  const chars = indices.map((i) => messageText[i] || "0").join("");
  const input = `${FINGERPRINT_SALT}${chars}${version}`;
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 3);
}

function generateBillingHeader(
  messages: any[],
  version: string,
  entrypoint: string,
  workload?: string,
): string {
  const msgText = extractFirstUserMessageText(messages);
  const fp = computeFingerprint(msgText, version);

  // cc_workload: optional workload tag (e.g., for cron-initiated requests)
  const workloadPair = workload ? ` cc_workload=${workload};` : "";

  return `x-anthropic-billing-header: cc_version=${version}.${fp}; cc_entrypoint=${entrypoint};${workloadPair}`;
}

/**
 * Build metadata.user_id — JSON-stringified object matching real Claude Code.
 *
 * - device_id: fixed per auth2api instance (one "installation")
 * - account_uuid: fixed per OAuth account
 * - session_id: varies per API key (each downstream user = separate CLI session)
 */
function buildUserId(
  deviceId: string,
  accountUuid: string,
  sessionId: string,
): string {
  return JSON.stringify({
    device_id: deviceId,
    account_uuid: accountUuid,
    session_id: sessionId,
  });
}

/** Checks if system block is a billing header */
function isBillingHeaderBlock(block: any): boolean {
  return (
    typeof block.text === "string" &&
    block.text.includes("x-anthropic-billing-header")
  );
}

/** Checks if system block is the CLI prefix */
function isPrefixBlock(block: any): boolean {
  return (
    typeof block.text === "string" && block.text.includes("You are Claude Code")
  );
}

/**
 * Apply Claude Code cloaking to the request body.
 *
 * Supports two modes:
 * 1. OpenAI-compatible clients: Injects billing header, prefix, and metadata
 * 2. Claude Code CLI clients: Detects existing prefix/billing header, avoids duplication
 *
 * Always injects metadata.user_id (since external clients don't have the auth2api device_id).
 */
export interface CloakingOptions {
  body?: any;
  request: Request;
  account: AvailableAccount;
  config: Config;
}

/**
 * Remove thinking blocks with empty `thinking` field from message history.
 *
 * When Claude Code compacts context or restores a session, it may preserve
 * the thinking block skeleton but clear the content, resulting in
 * `{ type: "thinking", thinking: "", signature: "" }`. The Anthropic API
 * rejects these with HTTP 400 "each thinking block must contain thinking".
 */
function sanitizeMessages(messages: any[]): any[] {
  if (!Array.isArray(messages)) return messages;
  return messages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg;
    const filtered = msg.content.filter((block: any) => {
      if (block.type === "thinking") {
        return typeof block.thinking === "string" && block.thinking.length > 0;
      }
      return true;
    });
    return { ...msg, content: filtered };
  });
}

export function applyCloaking(options: CloakingOptions): any {
  const { request, account, config } = options;
  const body = structuredClone(options.body ?? request.body);
  const cloaking = config.cloaking;

  // Strip empty thinking blocks before forwarding to upstream API
  if (Array.isArray(body.messages)) {
    body.messages = sanitizeMessages(body.messages);
  }
  const cliVersion = cloaking["cli-version"] || DEFAULT_CLI_VERSION;
  const entrypoint = cloaking.entrypoint || DEFAULT_ENTRYPOINT;

  // --- System prompt injection ---
  // Ensures billing header and CLI prefix are present in the system blocks.
  // Claude Code CLI clients may already include these; if so, keep the originals.
  // For OpenAI-compatible clients we generate them from scratch.

  const existingSystem = body.system || [];
  const remaining: any[] = Array.isArray(existingSystem)
    ? [...existingSystem]
    : [{ type: "text", text: existingSystem }];

  // Extract existing billing header and prefix if present, removing them from remaining
  const billingIdx = remaining.findIndex(isBillingHeaderBlock);
  const billingBlock =
    billingIdx >= 0
      ? remaining.splice(billingIdx, 1)[0]
      : {
          type: "text",
          text: generateBillingHeader(
            body.messages || [],
            cliVersion,
            entrypoint,
          ),
        };

  const prefixIdx = remaining.findIndex(isPrefixBlock);
  const prefixBlock =
    prefixIdx >= 0
      ? remaining.splice(prefixIdx, 1)[0]
      : {
          type: "text",
          text: "You are Claude Code, Anthropic's official CLI for Claude.",
          cache_control: { type: "ephemeral" },
        };

  // Reassemble: billing header (pos 0), prefix (pos 1), then the rest
  body.system = [billingBlock, prefixBlock, ...remaining];

  // --- Metadata injection ---
  // metadata.user_id identifies the device, account, and session to the upstream API.
  // Claude Code CLI clients may pass a session ID header; otherwise we derive one
  // from the downstream API key so each user gets a stable, rotating session.

  const apiKeyHash = hashApiKey(extractApiKey(request.headers));

  let sessionID = request.headers["x-claude-code-session-id"];
  sessionID =
    typeof sessionID === "string" ? sessionID : getSessionID(apiKeyHash);

  if (!body.metadata) body.metadata = {};

  body.metadata.user_id = buildUserId(
    account.deviceId,
    account.accountUuid,
    sessionID,
  );

  return body;
}
