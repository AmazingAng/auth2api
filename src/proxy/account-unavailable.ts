import { Response as ExpressResponse } from "express";
import { AccountResult } from "../accounts/manager";

function assertNever(value: never): never {
  throw new Error(`Unexpected unavailable reason: ${String(value)}`);
}

export function sendAccountUnavailable(
  res: ExpressResponse,
  accountResult: Extract<AccountResult, { account: null }>,
): void {
  if (accountResult.total === 0) {
    res.status(503).json({ error: { message: "No available account" } });
    return;
  }

  const { unavailableReason } = accountResult;
  switch (unavailableReason) {
    case "none":
      res.status(503).json({ error: { message: "No available account" } });
      return;
    case "rate_limit":
      if (accountResult.retryAfterMs && accountResult.retryAfterMs > 0) {
        res.setHeader(
          "Retry-After",
          Math.max(1, Math.ceil(accountResult.retryAfterMs / 1000)).toString(),
        );
      }
      res
        .status(429)
        .json({ error: { message: "Rate limited on the configured account" } });
      return;
    case "auth":
      res.status(503).json({
        error: { message: "Configured account requires re-authentication" },
      });
      return;
    case "forbidden":
      res.status(503).json({
        error: { message: "Configured account is forbidden" },
      });
      return;
    case "server":
      res.status(503).json({
        error: { message: "Upstream server temporarily unavailable" },
      });
      return;
    case "network":
      res.status(503).json({
        error: { message: "Upstream network temporarily unavailable" },
      });
      return;
  }

  const exhaustiveCheck: never = unavailableReason;
  return assertNever(exhaustiveCheck);
}
