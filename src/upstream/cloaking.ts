import crypto from "crypto";
import { CloakingConfig } from "../config";
import {
  getSessionId,
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
export function applyCloaking(
  body: any,
  deviceId: string,
  accountUuid: string,
  apiKeyHash: string,
  cloaking: CloakingConfig,
  overrideSessionId?: string,
): any {
  const cliVersion = cloaking["cli-version"] || DEFAULT_CLI_VERSION;
  const entrypoint = cloaking.entrypoint || DEFAULT_ENTRYPOINT;

  // Normalize existing system to array
  const existingSystem = body.system || [];
  const systemArray: any[] = Array.isArray(existingSystem)
    ? [...existingSystem]
    : [{ type: "text", text: existingSystem }];

  // Detect if client already sent Claude Code-style system prompt
  const hasBillingHeader = systemArray.some(isBillingHeaderBlock);
  const hasPrefix = systemArray.some(isPrefixBlock);

  // Build system blocks in correct order
  const systemBlocks: any[] = [];
  const PREFIX_TEXT =
    "You are Claude Code, Anthropic's official CLI for Claude.";

  // 1. Billing header (position 0)
  if (hasBillingHeader) {
    // Keep client's billing header (Claude Code CLI mode)
    const existingBilling = systemArray.find(isBillingHeaderBlock)!;
    systemBlocks.push(existingBilling);
  } else {
    // Generate our own (OpenAI client mode)
    const billingHeader = generateBillingHeader(
      body.messages || [],
      cliVersion,
      entrypoint,
    );
    systemBlocks.push({ type: "text", text: billingHeader });
  }

  // 2. Prefix block (position 1)
  if (hasPrefix) {
    // Keep client's prefix (Claude Code CLI mode)
    const existingPrefix = systemArray.find(isPrefixBlock)!;
    systemBlocks.push(existingPrefix);
  } else {
    systemBlocks.push({
      type: "text",
      text: PREFIX_TEXT,
    });
  }

  for (const block of systemArray) {
    // Skip billing header and prefix blocks (already handled above)
    if (isBillingHeaderBlock(block) || isPrefixBlock(block)) {
      continue;
    }

    systemBlocks.push(block);
  }

  body.system = systemBlocks;

  // 4. metadata.user_id — always set since external clients don't have auth2api's device_id
  if (!body.metadata) body.metadata = {};
  body.metadata.user_id = buildUserId(
    deviceId,
    accountUuid,
    overrideSessionId || getSessionId(apiKeyHash),
  );

  return body;
}
