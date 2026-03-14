import { TokenData } from "../auth/types";
import { refreshTokensWithRetry } from "../auth/oauth";
import { saveToken, loadAllTokens } from "../auth/token-storage";

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

export type AccountAvailability =
  | { state: "missing" }
  | { state: "available"; email: string }
  | { state: "cooldown"; email: string; cooldownUntil: number; lastError: string | null };

export class AccountManager {
  private account: AccountState | null = null;
  private authDir: string;
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshing = false;

  constructor(authDir: string) {
    this.authDir = authDir;
  }

  load(): void {
    const tokens = loadAllTokens(this.authDir);
    if (tokens.length > 1) {
      throw new Error(
        `Single-account mode only supports one token in ${this.authDir}; found ${tokens.length}.`
      );
    }

    this.account = tokens[0] ? this.createAccountState(tokens[0]) : null;
    console.log(`Loaded ${this.account ? 1 : 0} account(s)`);
  }

  addAccount(token: TokenData): void {
    if (this.account && this.account.token.email !== token.email) {
      throw new Error(
        `Single-account mode already has ${this.account.token.email}. Remove the existing token before logging into ${token.email}.`
      );
    }

    if (this.account) {
      this.account.token = token;
      this.account.cooldownUntil = 0;
      this.account.failureCount = 0;
      this.account.lastError = null;
      this.account.lastFailureAt = null;
      this.account.lastSuccessAt = new Date().toISOString();
      this.account.lastRefreshAt = new Date().toISOString();
    } else {
      this.account = this.createAccountState(token);
      this.account.lastSuccessAt = new Date().toISOString();
      this.account.lastRefreshAt = new Date().toISOString();
    }

    saveToken(this.authDir, token);
  }

  getNextAccount(): TokenData | null {
    if (!this.account) return null;
    return this.account.cooldownUntil <= Date.now() ? this.account.token : null;
  }

  getAvailability(): AccountAvailability {
    if (!this.account) {
      return { state: "missing" };
    }

    if (this.account.cooldownUntil > Date.now()) {
      return {
        state: "cooldown",
        email: this.account.token.email,
        cooldownUntil: this.account.cooldownUntil,
        lastError: this.account.lastError,
      };
    }

    return { state: "available", email: this.account.token.email };
  }

  recordAttempt(email: string): void {
    const acct = this.getAccountByEmail(email);
    if (acct) {
      acct.totalRequests++;
    }
  }

  recordSuccess(email: string): void {
    const acct = this.getAccountByEmail(email);
    if (!acct) return;

    acct.cooldownUntil = 0;
    acct.failureCount = 0;
    acct.lastError = null;
    acct.lastFailureAt = null;
    acct.lastSuccessAt = new Date().toISOString();
    acct.totalSuccesses++;
  }

  recordFailure(email: string, kind: AccountFailureKind, detail?: string): void {
    const acct = this.getAccountByEmail(email);
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
    const acct = this.getAccountByEmail(email);
    if (!acct) return false;
    if (acct.refreshPromise) {
      return acct.refreshPromise;
    }

    acct.refreshPromise = this.performRefresh(acct);
    return acct.refreshPromise;
  }

  getSnapshots(): AccountSnapshot[] {
    if (!this.account) return [];

    return [{
      email: this.account.token.email,
      available: this.account.cooldownUntil <= Date.now(),
      cooldownUntil: this.account.cooldownUntil,
      failureCount: this.account.failureCount,
      lastError: this.account.lastError,
      lastFailureAt: this.account.lastFailureAt,
      lastSuccessAt: this.account.lastSuccessAt,
      lastRefreshAt: this.account.lastRefreshAt,
      totalRequests: this.account.totalRequests,
      totalSuccesses: this.account.totalSuccesses,
      totalFailures: this.account.totalFailures,
      expiresAt: this.account.token.expiresAt,
      refreshing: this.account.refreshing,
    }];
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
    return this.account ? 1 : 0;
  }

  private async refreshAll(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      if (!this.account) return;

      const expiresAt = new Date(this.account.token.expiresAt).getTime();
      if (expiresAt - Date.now() <= REFRESH_LEAD_MS) {
        await this.refreshAccount(this.account.token.email);
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

  private getAccountByEmail(email: string): AccountState | null {
    if (!this.account || this.account.token.email !== email) return null;
    return this.account;
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
