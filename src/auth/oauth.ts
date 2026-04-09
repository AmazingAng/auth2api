import { PKCECodes, TokenData } from "./types";
import { timeout } from "../utils/common";

const AUTH_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REDIRECT_URI = "http://localhost:54545/callback";
const SCOPE = "org:create_api_key user:profile user:inference";

export function generateAuthURL(state: string, pkce: PKCECodes): string {
  // Use URLSearchParams for standard params, but handle scope separately
  // because Anthropic's OAuth server expects unencoded colons in scope values
  const params = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: "S256",
    state,
  });
  // Append scope with colons unencoded (matching Go's url.Values behavior)
  const scopeEncoded = SCOPE.split(" ")
    .map((s) => encodeURIComponent(s).replace(/%3A/gi, ":"))
    .join("+");
  return `${AUTH_URL}?${params.toString()}&scope=${scopeEncoded}`;
}

export async function exchangeCodeForTokens(
  code: string,
  returnedState: string,
  expectedState: string,
  pkce: PKCECodes,
): Promise<TokenData> {
  if (returnedState !== expectedState) {
    throw new Error("OAuth state mismatch — possible CSRF attack");
  }

  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: pkce.codeVerifier,
      state: expectedState,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token exchange failed (${resp.status}): ${text}`);
  }

  const data: any = await resp.json();
  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    email: data.account?.email_address || "unknown",
    expiresAt,
    accountUuid: data.account?.uuid || "",
  };
}

export async function refreshTokens(refreshToken: string): Promise<TokenData> {
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token refresh failed (${resp.status}): ${text}`);
  }

  const data: any = await resp.json();
  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    email: data.account?.email_address || "unknown",
    expiresAt,
    accountUuid: data.account?.uuid || "",
  };
}

export async function refreshTokensWithRetry(
  refreshToken: string,
  maxRetries = 3,
): Promise<TokenData> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await refreshTokens(refreshToken);
    } catch (err) {
      if (attempt >= maxRetries) throw err;
      await timeout(attempt * 1000);
    }
  }
}
