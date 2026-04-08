import { Response as ExpressResponse } from "express";
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
  res: ExpressResponse,
  result: Extract<AccountResult, { account: null }>,
): void {
  const { failureKind, retryAfterMs } = result;

  if (!failureKind) {
    res.status(503).json({ error: { message: "No available account" } });
    return;
  }

  const { status, message } = FAILURE_RESPONSES[failureKind];
  if (retryAfterMs && retryAfterMs > 0) {
    res.setHeader(
      "Retry-After",
      Math.max(1, Math.ceil(retryAfterMs / 1000)).toString(),
    );
  }
  res.status(status).json({ error: { message } });
}

function forwardErrorResponse(
  res: ExpressResponse,
  status: number,
  body: string,
): void {
  try {
    const parsed = body ? JSON.parse(body) : null;
    if (parsed && typeof parsed === "object") {
      res.status(status).json(parsed);
    } else {
      res
        .status(status)
        .json({ error: { message: "Upstream request failed" } });
    }
  } catch {
    res.status(status).json({ error: { message: "Upstream request failed" } });
  }
}

export interface ProxyCallbacks {
  callUpstream: (account: AvailableAccount) => Promise<Response>;
  handleSuccess: (
    upstreamResp: Response,
    account: AvailableAccount,
  ) => Promise<void>;
  logPrefix: string;
}

export async function proxyWithRetry(
  res: ExpressResponse,
  config: Config,
  manager: AccountManager,
  callbacks: ProxyCallbacks,
): Promise<void> {
  let lastStatus = 500;
  let lastErrBody = "";
  const refreshedAccounts = new Set<string>();

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const result = manager.getNextAccount();
    if (!result.account) {
      return accountUnavailable(res, result);
    }
    const account = result.account;
    manager.recordAttempt(account.token.email);

    let upstreamResp: Response;
    try {
      upstreamResp = await callbacks.callUpstream(account);
    } catch (err: any) {
      manager.recordFailure(account.token.email, "network", err.message);
      if (isDebugLevel(config.debug, "errors")) {
        console.error(
          `${callbacks.logPrefix} attempt ${attempt + 1} network failure: ${err.message}`,
        );
      }
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
        continue;
      }
      res.status(502).json({ error: { message: "Upstream network error" } });
      return;
    }

    if (upstreamResp.ok) {
      await callbacks.handleSuccess(upstreamResp, account);
      return;
    }

    lastStatus = upstreamResp.status;
    try {
      lastErrBody = await upstreamResp.text();
      if (isDebugLevel(config.debug, "errors")) {
        console.error(
          `${callbacks.logPrefix} attempt ${attempt + 1} failed (${lastStatus}): ${lastErrBody}`,
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
    if (attempt < MAX_RETRIES - 1) {
      await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
    }
  }

  forwardErrorResponse(res, lastStatus, lastErrBody);
}
