import { TokenData } from "../auth/types";
import { refreshTokensWithRetry } from "../auth/oauth";
import { saveToken, loadAllTokens } from "../auth/token-storage";
import { getDeviceId } from "../proxy/cloak-utils";

const REFRESH_LEAD_MS = 4 * 60 * 60 * 1000; // 4 hours before expiry
const REFRESH_CHECK_INTERVAL_MS = 60 * 1000; // check every 60s

export type AccountFailureKind =
  | "rate_limit"
  | "auth"
  | "forbidden"
  | "server"
  | "network";

export type AccountUnavailableReason = AccountFailureKind;

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
  refreshing: boolean;
  refreshPromise: Promise<boolean> | null;
}

export interface AccountSnapshot {
  email: string;
  available: boolean;
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
  expiresAt: string;
  refreshing: boolean;
}

interface AvailableAccount {
  token: TokenData;
  deviceId: string;
  accountUuid: string;
}

export type AccountResult =
  | {
      account: AvailableAccount;
      total: number;
      unavailableReason: "none";
      retryAfterMs: null;
      lastError: null;
    }
  | {
      account: null;
      total: 0;
      unavailableReason: "none";
      retryAfterMs: null;
      lastError: null;
    }
  | {
      account: null;
      total: number;
      unavailableReason: AccountUnavailableReason;
      retryAfterMs: number | null;
      lastError: string | null;
    };

const STICKY_MIN_MS = 20 * 60 * 1000; // 20 minutes
const STICKY_MAX_MS = 60 * 60 * 1000; // 60 minutes

function randomStickyDuration(): number {
  return STICKY_MIN_MS + Math.random() * (STICKY_MAX_MS - STICKY_MIN_MS);
}

const RECOVERABLE_REASON_PRIORITY: Record<
  Exclude<AccountFailureKind, "auth" | "forbidden">,
  number
> = {
  rate_limit: 3,
  server: 2,
  network: 1,
};

const TERMINAL_REASON_PRIORITY: Record<
  Extract<AccountFailureKind, "auth" | "forbidden">,
  number
> = {
  auth: 5,
  forbidden: 4,
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
      return {
        account: null,
        total: 0,
        unavailableReason: "none",
        retryAfterMs: null,
        lastError: null,
      };
    }

    const now = Date.now();

    // Try to keep using the current sticky account
    if (this.lastUsedIndex >= 0 && now < this.stickyUntil) {
      const email = this.accountOrder[this.lastUsedIndex];
      const acct = this.accounts.get(email)!;
      if (acct.cooldownUntil <= now) {
        return {
          account: buildAvailableAccount(this.authDir, email, acct.token),
          total: count,
          unavailableReason: "none",
          retryAfterMs: null,
          lastError: null,
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
          total: count,
          unavailableReason: "none",
          retryAfterMs: null,
          lastError: null,
        };
      }
    }

    const recoverableStates: Array<{
      reason: Exclude<AccountFailureKind, "auth" | "forbidden">;
      remainingMs: number;
      lastError: string | null;
    }> = [];
    const terminalStates: Array<{
      reason: Extract<AccountFailureKind, "auth" | "forbidden">;
      remainingMs: number;
      lastError: string | null;
    }> = [];

    for (const email of this.accountOrder) {
      const acct = this.accounts.get(email)!;
      const reason = acct.lastFailureKind ?? "network";
      const remainingMs = Math.max(0, acct.cooldownUntil - now);
      if (reason === "auth" || reason === "forbidden") {
        terminalStates.push({
          reason,
          remainingMs,
          lastError: acct.lastError,
        });
      } else {
        recoverableStates.push({
          reason,
          remainingMs,
          lastError: acct.lastError,
        });
      }
    }

    if (recoverableStates.length > 0) {
      const best = recoverableStates.reduce((currentBest, candidate) => {
        if (candidate.remainingMs < currentBest.remainingMs) return candidate;
        if (candidate.remainingMs > currentBest.remainingMs) return currentBest;
        return RECOVERABLE_REASON_PRIORITY[candidate.reason] >
          RECOVERABLE_REASON_PRIORITY[currentBest.reason]
          ? candidate
          : currentBest;
      });

      return {
        account: null,
        total: count,
        unavailableReason: best.reason,
        retryAfterMs: best.remainingMs,
        lastError: best.lastError,
      };
    }

    const bestTerminal = terminalStates.reduce((currentBest, candidate) =>
      TERMINAL_REASON_PRIORITY[candidate.reason] >
      TERMINAL_REASON_PRIORITY[currentBest.reason]
        ? candidate
        : currentBest,
    );

    return {
      account: null,
      total: count,
      unavailableReason: bestTerminal.reason,
      retryAfterMs: null,
      lastError: bestTerminal.lastError,
    };
  }

  recordAttempt(email: string): void {
    const acct = this.accounts.get(email);
    if (acct) {
      acct.totalRequests++;
    }
  }

  recordSuccess(email: string): void {
    const acct = this.accounts.get(email);
    if (!acct) return;

    acct.cooldownUntil = 0;
    acct.failureCount = 0;
    acct.lastFailureKind = null;
    acct.lastError = null;
    acct.lastFailureAt = null;
    acct.lastSuccessAt = new Date().toISOString();
    acct.totalSuccesses++;
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
        lastFailureKind: acct.lastFailureKind,
        lastError: acct.lastError,
        lastFailureAt: acct.lastFailureAt,
        lastSuccessAt: acct.lastSuccessAt,
        lastRefreshAt: acct.lastRefreshAt,
        totalRequests: acct.totalRequests,
        totalSuccesses: acct.totalSuccesses,
        totalFailures: acct.totalFailures,
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
      refreshing: false,
      refreshPromise: null,
    };
  }
}
