import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exchangeGitHubCode,
  externalUserId,
  GitHubIdentityError,
  type GitHubAuthConfig
} from "./github-auth.js";

afterEach(() => vi.restoreAllMocks());

const config: GitHubAuthConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  allowedUserIds: new Set(["12558714"])
};

describe("GitHub identity exchange", () => {
  it("uses PKCE for the code exchange and returns a stable identity", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "temporary-token" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 12558714,
        login: "callumalpass",
        name: "Callum",
        email: null
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));

    await expect(exchangeGitHubCode(config, {
      code: "one-time-code",
      codeVerifier: "pkce-verifier",
      redirectUri: "https://connect.example/auth/github/callback"
    })).resolves.toEqual({
      id: "12558714",
      login: "callumalpass",
      name: "Callum",
      email: null
    });

    const tokenRequest = fetchMock.mock.calls[0];
    expect(tokenRequest[0]).toBe("https://github.com/login/oauth/access_token");
    const body = new URLSearchParams(String(tokenRequest[1]?.body));
    expect(body.get("code_verifier")).toBe("pkce-verifier");
    expect(body.get("client_secret")).toBe("client-secret");
    const profileHeaders = new Headers(fetchMock.mock.calls[1][1]?.headers);
    expect(profileHeaders.get("authorization")).toBe("Bearer temporary-token");
  });

  it("rejects failed token exchanges and malformed identities", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(
      JSON.stringify({ error: "bad_verification_code" }),
      { status: 401, headers: { "content-type": "application/json" } }
    ));
    await expect(exchangeGitHubCode(config, {
      code: "bad-code",
      codeVerifier: "pkce-verifier",
      redirectUri: "https://connect.example/auth/github/callback"
    })).rejects.toBeInstanceOf(GitHubIdentityError);

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "temporary-token" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "12558714", login: "callumalpass" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    await expect(exchangeGitHubCode(config, {
      code: "one-time-code",
      codeVerifier: "pkce-verifier",
      redirectUri: "https://connect.example/auth/github/callback"
    })).rejects.toBeInstanceOf(GitHubIdentityError);
  });
});

describe("external user IDs", () => {
  it("are stable, provider-scoped UUIDs", () => {
    const first = externalUserId("github", "12558714");
    expect(first).toBe(externalUserId("github", "12558714"));
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first).not.toBe(externalUserId("another-provider", "12558714"));
  });
});
