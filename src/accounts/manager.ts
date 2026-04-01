import { TokenData } from "../auth/types";
import { refreshTokensWithRetry } from "../auth/oauth";
import { saveToken, loadAllTokens } from "../auth/token-storage";
import { getDeviceId } from "../proxy/cloak-utils";

const REFRESH_LEAD_MS = 4 * 60 * 60 * 1000; // 4 hours before expiry
const REFRESH_CHECK_INTERVAL_MS = 60 * 1000; // check every 60s

export type AccountFailureKind = "rate_limit" | "auth" | "forbidden" | "server" | "network";

const FAILURE_BACKOFF: Record<AccountFailureKind, { baseMs: number; maxMs: number }> = {
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

export interface AccountSelection {
  token: TokenData;
  deviceId: string;
  accountUuid: string;
}

export type AccountAvailability =
  | { state: "missing" }
  | { state: "available"; email: string }
  | { state: "cooldown"; email: string; cooldownUntil: number; lastError: string | null };

export class AccountManager {
  private accounts: Map<string, AccountState> = new Map();
  private accountOrder: string[] = []; // emails in insertion order for round-robin
  private lastUsedIndex: number = -1;
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
   * Round-robin account selection. Picks the next available (non-cooldown) account
   * starting from the one after the last used. Returns null if all are in cooldown.
   */
  getNextAccount(): AccountSelection | null {
    const count = this.accountOrder.length;
    if (count === 0) return null;

    const now = Date.now();
    for (let i = 0; i < count; i++) {
      const idx = (this.lastUsedIndex + 1 + i) % count;
      const email = this.accountOrder[idx];
      const acct = this.accounts.get(email)!;
      if (acct.cooldownUntil <= now) {
        this.lastUsedIndex = idx;
        return {
          token: acct.token,
          deviceId: getDeviceId(this.authDir, email),
          accountUuid: acct.token.accountUuid,
        };
      }
    }
    return null;
  }

  getAvailability(): AccountAvailability {
    if (this.accounts.size === 0) {
      return { state: "missing" };
    }

    const now = Date.now();
    let soonestCooldown: AccountState | null = null;

    for (const acct of this.accounts.values()) {
      if (acct.cooldownUntil <= now) {
        return { state: "available", email: acct.token.email };
      }
      if (!soonestCooldown || acct.cooldownUntil < soonestCooldown.cooldownUntil) {
        soonestCooldown = acct;
      }
    }

    return {
      state: "cooldown",
      email: soonestCooldown!.token.email,
      cooldownUntil: soonestCooldown!.cooldownUntil,
      lastError: soonestCooldown!.lastError,
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
    acct.lastError = null;
    acct.lastFailureAt = null;
    acct.lastSuccessAt = new Date().toISOString();
    acct.totalSuccesses++;
  }

  recordFailure(email: string, kind: AccountFailureKind, detail?: string): void {
    const acct = this.accounts.get(email);
    if (!acct) return;

    acct.failureCount++;
    acct.totalFailures++;
    acct.lastFailureAt = new Date().toISOString();
    acct.lastError = detail ? `${kind}: ${detail}` : kind;

    const { baseMs, maxMs } = FAILURE_BACKOFF[kind];
    const cooldownMs = Math.min(baseMs * 2 ** Math.max(0, acct.failureCount - 1), maxMs);
    acct.cooldownUntil = Date.now() + cooldownMs;
    console.log(`Account ${email} cooled down for ${Math.round(cooldownMs / 1000)}s (${kind})`);
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
        expiresAt: acct.token.expiresAt,
        refreshing: acct.refreshing,
      });
    }
    return snapshots;
  }

  startAutoRefresh(): void {
    const timer = setInterval(
      () => this.refreshAll().catch((err) => console.error("Refresh cycle failed:", err.message)),
      REFRESH_CHECK_INTERVAL_MS
    );
    timer.unref();
    this.refreshTimer = timer;
    this.refreshAll().catch((err) => console.error("Initial refresh failed:", err.message));
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
      acct.lastError = null;
      acct.lastFailureAt = null;
      acct.lastSuccessAt = new Date().toISOString();
      acct.lastRefreshAt = new Date().toISOString();
      saveToken(this.authDir, newToken);
      console.log(`Token refreshed, expires ${newToken.expiresAt}`);
      return true;
    } catch (err: any) {
      this.recordFailure(acct.token.email, "auth", err.message);
      console.error(`Token refresh failed for ${acct.token.email}: ${err.message}`);
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
