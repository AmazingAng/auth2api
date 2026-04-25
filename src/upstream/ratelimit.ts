export interface RateLimitInfo {
  unifiedStatus: string;
  fiveHourUtilization: number;
  fiveHourStatus: string;
  fiveHourReset: number;
  sevenDayUtilization: number;
  sevenDayStatus: string;
  sevenDayReset: number;
  overageUtilization: number;
  overageStatus: string;
  representativeClaim: string;
  updatedAt: string;
}

const HEADER_PREFIX = "anthropic-ratelimit-";

export function extractRateLimitHeaders(
  resp: Response,
): RateLimitInfo | null {
  const status = resp.headers.get(
    "anthropic-ratelimit-unified-status",
  );
  if (!status) return null;

  return {
    unifiedStatus: status,
    fiveHourUtilization: parseFloat(
      resp.headers.get("anthropic-ratelimit-unified-5h-utilization") || "0",
    ),
    fiveHourStatus:
      resp.headers.get("anthropic-ratelimit-unified-5h-status") || "",
    fiveHourReset: parseFloat(
      resp.headers.get("anthropic-ratelimit-unified-5h-reset") || "0",
    ),
    sevenDayUtilization: parseFloat(
      resp.headers.get("anthropic-ratelimit-unified-7d-utilization") || "0",
    ),
    sevenDayStatus:
      resp.headers.get("anthropic-ratelimit-unified-7d-status") || "",
    sevenDayReset: parseFloat(
      resp.headers.get("anthropic-ratelimit-unified-7d-reset") || "0",
    ),
    overageUtilization: parseFloat(
      resp.headers.get(
        "anthropic-ratelimit-unified-overage-utilization",
      ) || "0",
    ),
    overageStatus:
      resp.headers.get("anthropic-ratelimit-unified-overage-status") || "",
    representativeClaim:
      resp.headers.get(
        "anthropic-ratelimit-unified-representative-claim",
      ) || "five_hour",
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Collect all anthropic-ratelimit-* headers from upstream via prefix match,
 * plus an x-auth2api-account header identifying the account used.
 */
export function buildDownstreamRateLimitHeaders(
  upstream: Response,
  anonymousId: string,
): Record<string, string> {
  const result: Record<string, string> = {};

  upstream.headers.forEach((value, key) => {
    if (key.startsWith(HEADER_PREFIX)) {
      result[key] = value;
    }
  });

  result["x-auth2api-account"] = anonymousId;
  return result;
}

const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Returns the effective utilization for scheduling decisions.
 * If the cached data is older than STALE_THRESHOLD_MS, returns 0 so the
 * account is treated as "unknown" and participates in round-robin, giving
 * it a chance to receive a fresh response and update its utilization.
 */
export function getEffectiveUtilization(
  rl: RateLimitInfo | null,
): number {
  if (!rl) return 0;
  const ageMs = Date.now() - new Date(rl.updatedAt).getTime();
  if (ageMs > STALE_THRESHOLD_MS) return 0;
  return Math.max(rl.fiveHourUtilization, rl.sevenDayUtilization);
}
