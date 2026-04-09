import { Response as ExpressResponse } from "express";
import { timeout } from "./common";
import {
  AccountFailureKind,
  AccountManager,
  AccountResult,
  AvailableAccount,
} from "../accounts/manager";
import { Config, isDebugLevel } from "../config";

export const MAX_RETRIES = 3;
export const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export function classifyFailure(status: number): AccountFailureKind {
  if (status === 429) return "rate_limit";
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  return "server";
}

const FAILURE_RESPONSES: Record<
  AccountFailureKind,
  { status: number; message: string }
> = {
  rate_limit: {
    status: 429,
    message: "Rate limited on the configured account",
  },
  auth: {
    status: 503,
    message: "Configured account requires re-authentication",
  },
  forbidden: { status: 503, message: "Configured account is forbidden" },
  server: { status: 503, message: "Upstream server temporarily unavailable" },
  network: { status: 503, message: "Upstream network temporarily unavailable" },
};

export function accountUnavailable(
  resp: ExpressResponse,
  result: Extract<AccountResult, { account: null }>,
): void {
  const { failureKind, retryAfterMs } = result;

  if (!failureKind) {
    resp.status(503).json({ error: { message: "No available account" } });
    return;
  }

  const { status, message } = FAILURE_RESPONSES[failureKind];
  if (retryAfterMs && retryAfterMs > 0) {
    resp.setHeader(
      "Retry-After",
      Math.max(1, Math.ceil(retryAfterMs / 1000)).toString(),
    );
  }
  resp.status(status).json({ error: { message } });
}

export interface ProxyOptions {
  upstream: (account: AvailableAccount) => Promise<Response>;
  success: (upstream: Response, account: AvailableAccount) => Promise<void>;
  maxRetries?: number;
}

export async function proxyWithRetry(
  tag: string,
  resp: ExpressResponse,
  config: Config,
  manager: AccountManager,
  options: ProxyOptions,
): Promise<void> {
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  let lastStatus = 500;
  let lastErrBody = "";
  const refreshedAccounts = new Set<string>();

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const result = manager.getNextAccount();
    if (!result.account) {
      return accountUnavailable(resp, result);
    }
    const account = result.account;
    manager.recordAttempt(account.token.email);

    let upstream: Response;
    try {
      upstream = await options.upstream(account);
    } catch (err: any) {
      manager.recordFailure(account.token.email, "network", err.message);
      if (isDebugLevel(config.debug, "errors")) {
        console.error(
          `${tag} attempt ${attempt + 1} network failure: ${err.message}`,
        );
      }
      if (attempt < maxRetries - 1) {
        await timeout((attempt + 1) * 1000);
        continue;
      }
      resp.status(502).json({ error: { message: "Upstream network error" } });
      return;
    }

    if (upstream.ok) {
      await options.success(upstream, account);
      return;
    }

    lastStatus = upstream.status;
    try {
      lastErrBody = await upstream.text();
      if (isDebugLevel(config.debug, "errors")) {
        console.error(
          `${tag} attempt ${attempt + 1} failed (${lastStatus}): ${lastErrBody}`,
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
      manager.recordFailure(account.token.email, classifyFailure(lastStatus));
    }

    if (!RETRYABLE_STATUSES.has(lastStatus)) break;
    if (attempt < maxRetries - 1) {
      await timeout((attempt + 1) * 1000);
    }
  }

  try {
    const parsed = lastErrBody ? JSON.parse(lastErrBody) : null;
    if (parsed && typeof parsed === "object") {
      resp.status(lastStatus).json(parsed);
    } else {
      resp
        .status(lastStatus)
        .json({ error: { message: "Upstream request failed" } });
    }
  } catch {
    resp
      .status(lastStatus)
      .json({ error: { message: "Upstream request failed" } });
  }
}
