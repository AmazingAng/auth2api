import crypto from "crypto";
import { Request, Response as ExpressResponse } from "express";
import { extractApiKey } from "../api-key";
import { Config, isDebugLevel } from "../config";
import { AccountFailureKind, AccountManager } from "../accounts/manager";
import { applyCloaking } from "./cloaking";
import { callClaudeAPI, callClaudeCountTokens } from "./claude-api";
import { sendAccountUnavailable } from "./account-unavailable";

const MAX_RETRIES = 3;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function classifyFailure(status: number): AccountFailureKind {
  if (status === 429) return "rate_limit";
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  return "server";
}

// POST /v1/messages — Claude native format passthrough
export function createMessagesHandler(config: Config, manager: AccountManager) {
  return async (req: Request, res: ExpressResponse): Promise<void> => {
    try {
      const body = req.body;
      if (
        !body.messages ||
        !Array.isArray(body.messages) ||
        body.messages.length === 0
      ) {
        res.status(400).json({
          error: {
            message: "messages is required and must be a non-empty array",
          },
        });
        return;
      }

      // Debug: log incoming request body
      if (isDebugLevel(config.debug, "verbose")) {
        console.log("[DEBUG] Incoming /v1/messages body:");
        console.log(JSON.stringify(body, null, 2));
      }

      const stream = !!body.stream;
      const apiKey = extractApiKey(req.headers);
      const apiKeyHash = crypto
        .createHash("sha256")
        .update(apiKey)
        .digest("hex");

      // When request comes from claude-cli, pass through anthropic-* and session headers
      const userAgent = req.headers["user-agent"] || "";
      let passthroughHeaders: Record<string, string> | undefined;
      let overrideSessionId: string | undefined;
      if (userAgent.startsWith("claude-cli")) {
        passthroughHeaders = { "User-Agent": userAgent };
        for (const [key, value] of Object.entries(req.headers)) {
          if (key.startsWith("anthropic") && typeof value === "string") {
            passthroughHeaders[key] = value;
          }
        }
        const sessionId = req.headers["x-claude-code-session-id"];
        if (typeof sessionId === "string") {
          passthroughHeaders["X-Claude-Code-Session-Id"] = sessionId;
          overrideSessionId = sessionId;
        }
      }

      let lastStatus = 500;
      let lastErrBody = "";
      const refreshedAccounts = new Set<string>();
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const accountResult = manager.getNextAccount();
        const { account } = accountResult;
        if (!account) {
          sendAccountUnavailable(res, accountResult);
          return;
        }

        manager.recordAttempt(account.token.email);

        // Apply per-account cloaking (clone body so each attempt is fresh)
        const claudeBody = applyCloaking(
          structuredClone(body),
          account.deviceId,
          account.accountUuid,
          apiKeyHash,
          config.cloaking,
          overrideSessionId,
        );

        // Debug: log final request body after cloaking
        if (isDebugLevel(config.debug, "verbose")) {
          console.log("[DEBUG] Final /v1/messages body after cloaking:");
          console.log(JSON.stringify(claudeBody, null, 2));
        }

        let upstreamResp: globalThis.Response;
        try {
          upstreamResp = await callClaudeAPI(
            account.token.accessToken,
            claudeBody,
            stream,
            config.timeouts,
            config.cloaking,
            apiKeyHash,
            passthroughHeaders,
          );
        } catch (err: any) {
          manager.recordFailure(account.token.email, "network", err.message);
          if (isDebugLevel(config.debug, "errors")) {
            console.error(
              `Messages attempt ${attempt + 1} network failure: ${err.message}`,
            );
          }
          if (attempt < MAX_RETRIES - 1) {
            await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
            continue;
          }
          res.status(502).json({
            error: { message: "Upstream network error" },
          });
          return;
        }

        if (upstreamResp.ok) {
          if (stream) {
            // Pipe SSE directly — no translation needed
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            res.setHeader("X-Accel-Buffering", "no");
            res.flushHeaders();

            const reader = upstreamResp.body?.getReader();
            if (!reader) {
              res.end();
              return;
            }

            let clientDisconnected = false;
            res.on("close", () => {
              clientDisconnected = true;
              reader.cancel().catch(() => {});
            });

            try {
              while (!clientDisconnected) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(Buffer.from(value));
              }
              if (!clientDisconnected) {
                manager.recordSuccess(account.token.email);
              }
            } catch (err) {
              if (!clientDisconnected) {
                manager.recordFailure(
                  account.token.email,
                  "network",
                  "stream terminated before completion",
                );
              }
              if (!clientDisconnected) console.error("Stream pipe error:", err);
            } finally {
              if (!clientDisconnected) res.end();
            }
          } else {
            // Forward JSON response directly
            const data = await upstreamResp.json();
            manager.recordSuccess(account.token.email);
            res.json(data);
          }
          return;
        }

        lastStatus = upstreamResp.status;
        try {
          lastErrBody = await upstreamResp.text();
          if (isDebugLevel(config.debug, "errors")) {
            console.error(
              `Messages attempt ${attempt + 1} failed (${lastStatus}): ${lastErrBody}`,
            );
          }
        } catch {
          /* ignore */
        }

        if (lastStatus === 401) {
          const refreshed = await manager.refreshAccount(account.token.email);
          if (refreshed && !refreshedAccounts.has(account.token.email)) {
            refreshedAccounts.add(account.token.email);
            attempt--;
            continue;
          }
        } else {
          manager.recordFailure(
            account.token.email,
            classifyFailure(lastStatus),
          );
        }
        if (!RETRYABLE_STATUSES.has(lastStatus)) break;
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
        }
      }

      try {
        const parsed = lastErrBody ? JSON.parse(lastErrBody) : null;
        if (parsed && typeof parsed === "object") {
          res.status(lastStatus).json(parsed);
        } else {
          res
            .status(lastStatus)
            .json({ error: { message: "Upstream request failed" } });
        }
      } catch {
        res
          .status(lastStatus)
          .json({ error: { message: "Upstream request failed" } });
      }
    } catch (err: any) {
      console.error("Messages handler error:", err.message);
      res.status(500).json({
        error: { message: "Internal server error" },
      });
    }
  };
}

// POST /v1/messages/count_tokens — passthrough
export function createCountTokensHandler(
  config: Config,
  manager: AccountManager,
) {
  return async (req: Request, res: ExpressResponse): Promise<void> => {
    try {
      const apiKey = extractApiKey(req.headers);
      const apiKeyHash = crypto
        .createHash("sha256")
        .update(apiKey)
        .digest("hex");

      let lastStatus = 500;
      let lastErrBody = "";
      const refreshedAccounts = new Set<string>();
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const accountResult = manager.getNextAccount();
        const { account } = accountResult;
        if (!account) {
          sendAccountUnavailable(res, accountResult);
          return;
        }

        manager.recordAttempt(account.token.email);

        let upstreamResp: globalThis.Response;
        try {
          upstreamResp = await callClaudeCountTokens(
            account.token.accessToken,
            req.body,
            config.timeouts,
            config.cloaking,
            apiKeyHash,
          );
        } catch (err: any) {
          manager.recordFailure(account.token.email, "network", err.message);
          if (isDebugLevel(config.debug, "errors")) {
            console.error(
              `Count tokens attempt ${attempt + 1} network failure: ${err.message}`,
            );
          }
          if (attempt < MAX_RETRIES - 1) {
            await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
            continue;
          }
          res.status(502).json({
            error: { message: "Upstream network error" },
          });
          return;
        }

        if (upstreamResp.ok) {
          manager.recordSuccess(account.token.email);
          const data = await upstreamResp.json();
          res.json(data);
          return;
        }

        lastStatus = upstreamResp.status;
        lastErrBody = await upstreamResp.text().catch(() => "");
        if (lastStatus === 401) {
          const refreshed = await manager.refreshAccount(account.token.email);
          if (refreshed && !refreshedAccounts.has(account.token.email)) {
            refreshedAccounts.add(account.token.email);
            attempt--;
            continue;
          }
        } else {
          manager.recordFailure(
            account.token.email,
            classifyFailure(lastStatus),
          );
        }

        if (!RETRYABLE_STATUSES.has(lastStatus)) break;
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
        }
      }

      try {
        const parsed = lastErrBody ? JSON.parse(lastErrBody) : null;
        if (parsed && typeof parsed === "object") {
          res.status(lastStatus).json(parsed);
        } else {
          res
            .status(lastStatus)
            .json({ error: { message: "Upstream request failed" } });
        }
      } catch {
        res
          .status(lastStatus)
          .json({ error: { message: "Upstream request failed" } });
      }
    } catch (err: any) {
      console.error("Count tokens error:", err.message);
      res.status(500).json({
        error: { message: "Internal server error" },
      });
    }
  };
}
