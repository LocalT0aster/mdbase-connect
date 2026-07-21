import { createHash } from "node:crypto";

export interface GitHubIdentity {
  id: string;
  login: string;
  name: string | null;
  email: string | null;
}

export interface GitHubCodeExchange {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface GitHubAuthConfig {
  clientId: string;
  clientSecret: string;
  allowedUserIds: ReadonlySet<string>;
  exchangeCode?: (input: GitHubCodeExchange) => Promise<GitHubIdentity>;
}

export class GitHubIdentityError extends Error {}

export async function exchangeGitHubCode(
  config: GitHubAuthConfig,
  input: GitHubCodeExchange
): Promise<GitHubIdentity> {
  if (config.exchangeCode) return config.exchangeCode(input);

  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "mdbase-connect"
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier
    })
  });
  const tokenBody = await responseJson(tokenResponse);
  const accessToken = stringProperty(tokenBody, "access_token");
  if (!tokenResponse.ok || !accessToken) {
    throw new GitHubIdentityError("GitHub did not accept the authorization code.");
  }

  const profileResponse = await fetch("https://api.github.com/user", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": "mdbase-connect",
      "x-github-api-version": "2022-11-28"
    }
  });
  const profile = await responseJson(profileResponse);
  const id = numberProperty(profile, "id");
  const login = stringProperty(profile, "login");
  if (!profileResponse.ok || !id || !Number.isSafeInteger(id) || id <= 0 || !login) {
    throw new GitHubIdentityError("GitHub did not return a valid user identity.");
  }
  return {
    id: String(id),
    login,
    name: nullableStringProperty(profile, "name"),
    email: nullableStringProperty(profile, "email")
  };
}

export function externalUserId(provider: string, subject: string): string {
  const bytes = createHash("sha256").update(`${provider}\0${subject}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new GitHubIdentityError("GitHub returned an unreadable response.");
  }
}

function stringProperty(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "string" && property.length > 0 ? property : null;
}

function nullableStringProperty(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "string" && property.length > 0 ? property : null;
}

function numberProperty(value: unknown, key: string): number | null {
  if (!value || typeof value !== "object") return null;
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "number" ? property : null;
}
