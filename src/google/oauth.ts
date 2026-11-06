import {
  CodeChallengeMethod,
  OAuth2Client,
  type Credentials,
} from "google-auth-library";
import type { Config } from "../config.js";
import { YtError } from "../errors.js";

export const ANALYTICS_SCOPE = "https://www.googleapis.com/auth/yt-analytics.readonly";
/** Needed for everything except analytics. */
export const REQUIRED_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.force-ssl",
];
/** youtube.upload: uploads. youtube: channel, playlists, thumbnails, metadata. force-ssl: comments, captions, deletes. yt-analytics: reports. */
export const YOUTUBE_SCOPES = [...REQUIRED_SCOPES, ANALYTICS_SCOPE];
export const IDENTITY_SCOPES = ["openid", "email", "profile"];

export function googleClient(cfg: Config, redirectUri?: string): OAuth2Client {
  const { clientId, clientSecret } = cfg.google;
  if (!clientId || !clientSecret) {
    throw new YtError(
      "not_configured",
      "Google OAuth client is not configured.",
      {
        hint: "Run `npx @joinhackyard/youtube-channel-mcp setup` in a terminal (it walks you through creating a free Desktop-app OAuth client in Google Cloud), or set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.",
      },
    );
  }
  return new OAuth2Client({ clientId, clientSecret, redirectUri });
}

export function authUrl(
  client: OAuth2Client,
  opts: {
    scopes: string[];
    state: string;
    challenge: string;
    loginHint?: string;
    consent?: boolean;
  },
): string {
  return client.generateAuthUrl({
    access_type: "offline",
    prompt:
      opts.consent === false ? "select_account" : "consent select_account",
    scope: opts.scopes,
    state: opts.state,
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: opts.challenge,
    include_granted_scopes: false,
    login_hint: opts.loginHint,
  });
}

export async function exchangeCode(
  client: OAuth2Client,
  code: string,
  verifier: string,
): Promise<Credentials> {
  try {
    const { tokens } = await client.getToken({ code, codeVerifier: verifier });
    return tokens;
  } catch (e) {
    throw new YtError(
      "auth_expired",
      `Google sign-in failed: ${(e as Error).message}`,
      { hint: "Start the sign-in again." },
    );
  }
}

export async function identityFromIdToken(
  client: OAuth2Client,
  idToken: string | null | undefined,
  audience: string,
): Promise<{ email: string; name?: string; emailVerified: boolean } | null> {
  if (!idToken) return null;
  const ticket = await client.verifyIdToken({
    idToken,
    audience,
  });
  const p = ticket.getPayload();
  if (!p?.email) return null;
  return {
    email: p.email.toLowerCase(),
    name: p.name,
    emailVerified: Boolean(p.email_verified),
  };
}

export function grantedScopes(tokens: Credentials): string[] {
  return (tokens.scope ?? "").split(/\s+/).filter(Boolean);
}

export function missingYoutubeScopes(scopes: string[]): string[] {
  return REQUIRED_SCOPES.filter((s) => !scopes.includes(s));
}
