export interface PKCECodes {
  codeVerifier: string;
  codeChallenge: string;
}

export interface TokenData {
  accessToken: string;
  refreshToken: string;
  email: string;
  expiresAt: string; // ISO 8601
  accountUuid: string; // from OAuth token response: data.account.uuid
}

export interface TokenStorage {
  access_token: string;
  refresh_token: string;
  last_refresh: string;
  email: string;
  type: "claude";
  expired: string; // ISO 8601
  account_uuid?: string;
}
