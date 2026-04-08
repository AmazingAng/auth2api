import { TokenData } from "../auth/types";
import { refreshTokensWithRetry } from "../auth/oauth";
import { saveToken, loadAllTokens } from "../auth/token-storage";
import { getDeviceId } from "../utils/cloak-utils";

const REFRESH_LEAD_MS = 4 * 60 * 60 * 1000; // 4 hours before expiry
const REFRESH_CHECK_INTERVAL_MS = 60 * 1000; // check every 60s

export type AccountFailureKind =
  | "rate_limit"
  | "auth"
  | "forbidden"
  | "server"
  | "network";

const FAILURE_BACKOFF: Record<
  AccountFailureKind,
  { baseMs: number; maxMs: number }
> = {
  rate_limit: { baseMs: 60 * 1000, maxMs: 15 * 60 * 1000 },
  auth: { baseMs: 10 * 60 * 1000, maxMs: 60 * 60 * 1000 },
  forbidden: { baseMs: 10 * 60 * 1000, maxMs: 60 * 60 * 1000 },
  server: { baseMs: 5 * 1000, maxMs: 5 * 60 * 1000 },
  network: { baseMs: 5 * 1000, maxMs: 5 * 60 * 1000 },
};

export interface UsageData {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export function extractUsage(resp: any): UsageData {
  return {
    inputTokens: resp.usage?.input_tokens || 0,
    outputTokens: resp.usage?.output_tokens || 0,
    cacheCreationInputTokens: resp.usage?.cache_creation_input_tokens || 0,
    cacheReadInputTokens: resp.usage?.cache_read_input_tokens || 0,
  };
}

interface AccountState {
  token: TokenData;
  cooldownUntil: number;
  failureCount: number;
  lastFailureKind: AccountFailureKind | null;
  lastError: string | null;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  lastRefreshAt: string | null;
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationInputTokens: number;
  totalCacheReadInputTokens: number;
  refreshing: boolean;
  refreshPromise: Promise<boolean> | null;
}

export interface AccountSnapshot {
  email: string;
  available: boolean;
  cooldownUntil: number;
  failureCount: number;
  lastError: string | null;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  lastRefreshAt: string | null;
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationInputTokens: number;
  totalCacheReadInputTokens: number;
  expiresAt: string;
  refreshing: boolean;
}

export interface AvailableAccount {
  token: TokenData;
  deviceId: string;
  accountUuid: string;
}

export type AccountResult =
  | { account: AvailableAccount }
  | {
      account: null;
      failureKind: AccountFailureKind | null;
      retryAfterMs: number | null;
    };

const STICKY_MIN_MS = 20 * 60 * 1000; // 20 minutes
const STICKY_MAX_MS = 60 * 60 * 1000; // 60 minutes

function randomStickyDuration(): number {
  return STICKY_MIN_MS + Math.random() * (STICKY_MAX_MS - STICKY_MIN_MS);
}

// Lower = more recoverable, preferred when all accounts are unavailable
const FAILURE_PRIORITY: Record<AccountFailureKind, number> = {
  rate_limit: 0,
  server: 1,
  network: 2,
  forbidden: 3,
  auth: 4,
};

function buildAvailableAccount(
  authDir: string,
  email: string,
  token: TokenData,
): AvailableAccount {
  return {
    token,
    deviceId: getDeviceId(authDir, email),
    accountUuid: token.accountUuid,
  };
}

export class AccountManager {
  private accounts: Map<string, AccountState> = new Map();
  private accountOrder: string[] = []; // emails in insertion order for round-robin
  private lastUsedIndex: number = -1;
  private stickyUntil: number = 0; // timestamp until which current account is sticky
  private authDir: string;
  private refreshTimer: NodeJS.Timeout | null = null;
  private statsTimer: NodeJS.Timeout | null = null;
  private refreshing = false;

  constructor(authDir: string) {
    this.authDir = authDir;
  }

  load(): void {
    const tokens = loadAllTokens(this.authDir);
    for (const token of tokens) {
      this.accounts.set(token.email, this.createAccountState(token));
      this.accountOrder.push(token.email);
    }
    console.log(`Loaded ${this.accounts.size} account(s)`);
  }

  addAccount(token: TokenData): void {
    const existing = this.accounts.get(token.email);
    if (existing) {
      existing.token = token;
      existing.cooldownUntil = 0;
      existing.failureCount = 0;
      existing.lastFailureKind = null;
      existing.lastError = null;
      existing.lastFailureAt = null;
      existing.lastSuccessAt = new Date().toISOString();
      existing.lastRefreshAt = new Date().toISOString();
    } else {
      const state = this.createAccountState(token);
      state.lastSuccessAt = new Date().toISOString();
      state.lastRefreshAt = new Date().toISOString();
      this.accounts.set(token.email, state);
      this.accountOrder.push(token.email);
    }

    saveToken(this.authDir, token);
  }

  /**
   * Sticky account selection. Keeps using the same account for STICKY_DURATION_MS
   * before rotating to the next one. Rotates early only when the current account
   * enters cooldown (e.g. rate-limited).
   */
  getNextAccount(): AccountResult {
    const count = this.accountOrder.length;
    if (count === 0) {
      return { account: null, failureKind: null, retryAfterMs: null };
    }

    const now = Date.now();

    // Try to keep using the current sticky account
    if (this.lastUsedIndex >= 0 && now < this.stickyUntil) {
      const email = this.accountOrder[this.lastUsedIndex];
      const acct = this.accounts.get(email)!;
      if (acct.cooldownUntil <= now) {
        return {
          account: buildAvailableAccount(this.authDir, email, acct.token),
        };
      }
    }

    // Pick the next available account
    const startIdx = this.lastUsedIndex >= 0 ? this.lastUsedIndex + 1 : 0;
    for (let i = 0; i < count; i++) {
      const idx = (startIdx + i) % count;
      const email = this.accountOrder[idx];
      const acct = this.accounts.get(email)!;
      if (acct.cooldownUntil <= now) {
        this.lastUsedIndex = idx;
        this.stickyUntil = now + randomStickyDuration();
        return {
          account: buildAvailableAccount(this.authDir, email, acct.token),
        };
      }
    }

    // All accounts in cooldown — find the most recoverable one
    const firstAcct = this.accounts.get(this.accountOrder[0])!;
    let bestKind: AccountFailureKind = firstAcct.lastFailureKind ?? "network";
    let bestRemainingMs = Math.max(0, firstAcct.cooldownUntil - now);
    for (const email of this.accountOrder.slice(1)) {
      const acct = this.accounts.get(email)!;
      const kind = acct.lastFailureKind ?? "network";
      const remainingMs = Math.max(0, acct.cooldownUntil - now);
      if (
        FAILURE_PRIORITY[kind] < FAILURE_PRIORITY[bestKind] ||
        (FAILURE_PRIORITY[kind] === FAILURE_PRIORITY[bestKind] &&
          remainingMs < bestRemainingMs)
      ) {
        bestKind = kind;
        bestRemainingMs = remainingMs;
      }
    }

    const isRecoverable = bestKind !== "auth" && bestKind !== "forbidden";
    return {
      account: null,
      failureKind: bestKind,
      retryAfterMs: isRecoverable ? bestRemainingMs : null,
    };
  }

  recordAttempt(email: string): void {
    const acct = this.accounts.get(email);
    if (acct) {
      acct.totalRequests++;
    }
  }

  recordSuccess(email: string, usage?: UsageData): void {
    const acct = this.accounts.get(email);
    if (!acct) return;

    acct.cooldownUntil = 0;
    acct.failureCount = 0;
    acct.lastFailureKind = null;
    acct.lastError = null;
    acct.lastFailureAt = null;
    acct.lastSuccessAt = new Date().toISOString();
    acct.totalSuccesses++;

    if (usage) {
      acct.totalInputTokens += usage.inputTokens;
      acct.totalOutputTokens += usage.outputTokens;
      acct.totalCacheCreationInputTokens += usage.cacheCreationInputTokens;
      acct.totalCacheReadInputTokens += usage.cacheReadInputTokens;
    }
  }

  recordFailure(
    email: string,
    kind: AccountFailureKind,
    detail?: string,
  ): void {
    const acct = this.accounts.get(email);
    if (!acct) return;

    acct.failureCount++;
    acct.totalFailures++;
    acct.lastFailureKind = kind;
    acct.lastFailureAt = new Date().toISOString();
    acct.lastError = detail ? `${kind}: ${detail}` : kind;

    const { baseMs, maxMs } = FAILURE_BACKOFF[kind];
    const cooldownMs = Math.min(
      baseMs * 2 ** Math.max(0, acct.failureCount - 1),
      maxMs,
    );
    acct.cooldownUntil = Date.now() + cooldownMs;
    console.log(
      `Account ${email} cooled down for ${Math.round(cooldownMs / 1000)}s (${kind})`,
    );
  }

  async refreshAccount(email: string): Promise<boolean> {
    const acct = this.accounts.get(email);
    if (!acct) return false;
    if (acct.refreshPromise) {
      return acct.refreshPromise;
    }

    acct.refreshPromise = this.performRefresh(acct);
    return acct.refreshPromise;
  }

  getSnapshots(): AccountSnapshot[] {
    const now = Date.now();
    const snapshots: AccountSnapshot[] = [];
    for (const acct of this.accounts.values()) {
      snapshots.push({
        email: acct.token.email,
        available: acct.cooldownUntil <= now,
        cooldownUntil: acct.cooldownUntil,
        failureCount: acct.failureCount,
        lastError: acct.lastError,
        lastFailureAt: acct.lastFailureAt,
        lastSuccessAt: acct.lastSuccessAt,
        lastRefreshAt: acct.lastRefreshAt,
        totalRequests: acct.totalRequests,
        totalSuccesses: acct.totalSuccesses,
        totalFailures: acct.totalFailures,
        totalInputTokens: acct.totalInputTokens,
        totalOutputTokens: acct.totalOutputTokens,
        totalCacheCreationInputTokens: acct.totalCacheCreationInputTokens,
        totalCacheReadInputTokens: acct.totalCacheReadInputTokens,
        expiresAt: acct.token.expiresAt,
        refreshing: acct.refreshing,
      });
    }
    return snapshots;
  }

  startAutoRefresh(): void {
    const timer = setInterval(
      () =>
        this.refreshAll().catch((err) =>
          console.error("Refresh cycle failed:", err.message),
        ),
      REFRESH_CHECK_INTERVAL_MS,
    );
    timer.unref();
    this.refreshTimer = timer;
    this.refreshAll().catch((err) =>
      console.error("Initial refresh failed:", err.message),
    );
  }

  stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  startStatsLogger(): void {
    const timer = setInterval(() => this.logStats(), 5 * 60 * 1000);
    timer.unref();
    this.statsTimer = timer;
  }

  stopStatsLogger(): void {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  private logStats(): void {
    if (this.accounts.size === 0) return;
    console.log(`\n===== Account Stats (${new Date().toISOString()}) =====`);
    for (const acct of this.accounts.values()) {
      const available = acct.cooldownUntil <= Date.now();
      console.log(
        `  ${acct.token.email}: ` +
          `available=${available}, ` +
          `requests=${acct.totalRequests}, ` +
          `successes=${acct.totalSuccesses}, ` +
          `failures=${acct.totalFailures}, ` +
          `input_tokens=${acct.totalInputTokens}, ` +
          `output_tokens=${acct.totalOutputTokens}, ` +
          `cache_creation=${acct.totalCacheCreationInputTokens}, ` +
          `cache_read=${acct.totalCacheReadInputTokens}, ` +
          `total_tokens=${acct.totalInputTokens + acct.totalOutputTokens + acct.totalCacheCreationInputTokens + acct.totalCacheReadInputTokens}`,
      );
    }
    console.log(`====================================================\n`);
  }

  get accountCount(): number {
    return this.accounts.size;
  }

  private async refreshAll(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const now = Date.now();
      for (const acct of this.accounts.values()) {
        const expiresAt = new Date(acct.token.expiresAt).getTime();
        if (expiresAt - now <= REFRESH_LEAD_MS) {
          await this.refreshAccount(acct.token.email);
        }
      }
    } finally {
      this.refreshing = false;
    }
  }

  private async performRefresh(acct: AccountState): Promise<boolean> {
    if (acct.refreshing) return false;

    acct.refreshing = true;
    try {
      console.log(`Refreshing token for ${acct.token.email}...`);
      const newToken = await refreshTokensWithRetry(acct.token.refreshToken);
      newToken.email = newToken.email || acct.token.email;
      acct.token = newToken;
      acct.cooldownUntil = 0;
      acct.failureCount = 0;
      acct.lastFailureKind = null;
      acct.lastError = null;
      acct.lastFailureAt = null;
      acct.lastSuccessAt = new Date().toISOString();
      acct.lastRefreshAt = new Date().toISOString();
      saveToken(this.authDir, newToken);
      console.log(`Token refreshed, expires ${newToken.expiresAt}`);
      return true;
    } catch (err: any) {
      this.recordFailure(acct.token.email, "auth", err.message);
      console.error(
        `Token refresh failed for ${acct.token.email}: ${err.message}`,
      );
      return false;
    } finally {
      acct.refreshing = false;
      acct.refreshPromise = null;
    }
  }

  private createAccountState(token: TokenData): AccountState {
    return {
      token,
      cooldownUntil: 0,
      failureCount: 0,
      lastFailureKind: null,
      lastError: null,
      lastFailureAt: null,
      lastSuccessAt: null,
      lastRefreshAt: null,
      totalRequests: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationInputTokens: 0,
      totalCacheReadInputTokens: 0,
      refreshing: false,
      refreshPromise: null,
    };
  }
}
