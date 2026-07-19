import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createDatabase } from "./db.js";
import { pkceChallenge } from "./security.js";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
});

describe("MDBASE Connect server", () => {
  it("runs the discovery, consent, token, and offline operation path", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const { app } = await buildApp({
      db,
      devAuth: true,
      publicUrl: "http://connect.test",
      allowInsecureManifests: true
    });
    resources.push(() => app.close());

    const session = await app.inject({
      method: "POST",
      url: "/v1/dev/session",
      payload: { name: "Callum", email: "callum@example.com" }
    });
    expect(session.statusCode).toBe(200);
    const setCookie = session.headers["set-cookie"]!;
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];

    const pairingStarted = await app.inject({
      method: "POST",
      url: "/v1/pairing-requests",
      payload: { connector_name: "Browser-paired computer" }
    });
    expect(pairingStarted.statusCode).toBe(201);
    const pairing = pairingStarted.json();
    const pairingApproved = await app.inject({
      method: "POST",
      url: `/v1/pairing-requests/${pairing.pairing_id}/approve`,
      headers: { cookie }
    });
    expect(pairingApproved.statusCode).toBe(200);
    expect(pairingApproved.json().deep_link).toContain("mdbase-connect://paired");
    const pairingExchanged = await app.inject({
      method: "POST",
      url: `/v1/pairing-requests/${pairing.pairing_id}/exchange`,
      headers: { authorization: `Bearer ${pairing.pairing_secret}` }
    });
    expect(pairingExchanged.statusCode).toBe(200);
    expect(pairingExchanged.json().token).toMatch(/^con_/);

    const connectorResponse = await app.inject({
      method: "POST",
      url: "/v1/connectors",
      headers: { cookie },
      payload: { name: "Home computer" }
    });
    expect(connectorResponse.statusCode).toBe(201);
    const connector = connectorResponse.json();
    const localCollectionId = "125cc8cf-dad5-4fc9-b0bc-a1c92e99f3ed";
    const synchronized = await app.inject({
      method: "POST",
      url: "/v1/connectors/sync",
      headers: { authorization: `Bearer ${connector.token}` },
      payload: {
        collections: [{
          id: localCollectionId,
          display_name: "Workouts",
          spec_version: "0.3.0",
          enabled: true
        }]
      }
    });
    expect(synchronized.statusCode).toBe(200);
    const collectionId = synchronized.json().collections[0].id as string;

    const manifestServer = await startManifestServer();
    resources.push(manifestServer.close);
    const discovered = await app.inject({
      method: "POST",
      url: "/v1/apps/discover",
      payload: { manifest_url: manifestServer.manifestUrl }
    });
    expect(discovered.statusCode).toBe(200);
    const applicationId = discovered.json().application.id as string;

    const verifier = "local-connector-verifier-that-is-long-enough-00001";
    const state = "test-state";
    const authorize = await app.inject({
      method: "GET",
      url: `/oauth/authorize?client_id=${applicationId}&redirect_uri=${encodeURIComponent(manifestServer.redirectUri)}&code_challenge=${pkceChallenge(verifier)}&code_challenge_method=S256&state=${state}&operations=read,query`,
      headers: { cookie }
    });
    expect(authorize.statusCode).toBe(302);
    const requestId = authorize.headers.location!.split("/").at(-1)!;

    const pending = await app.inject({
      method: "GET",
      url: `/v1/authorization-requests/${requestId}`,
      headers: { cookie }
    });
    expect(pending.statusCode).toBe(200);
    expect(pending.json().authorization.application_name).toBe("Workout Tracker");

    const localControl = await app.inject({
      method: "GET",
      url: "/v1/connectors/control",
      headers: { authorization: `Bearer ${connector.token}` }
    });
    expect(localControl.statusCode).toBe(200);
    expect(localControl.json().pending_authorizations[0].application_name).toBe("Workout Tracker");

    const approved = await app.inject({
      method: "POST",
      url: `/v1/connectors/authorization-requests/${requestId}/approve`,
      headers: { authorization: `Bearer ${connector.token}` },
      payload: { collection_id: localCollectionId, operations: ["read", "query"] }
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toEqual({ ok: true });

    const completed = await app.inject({
      method: "GET",
      url: `/v1/authorization-requests/${requestId}/status`,
      headers: { cookie }
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().status).toBe("approved");
    const redirect = new URL(completed.json().redirect_uri);
    expect(redirect.searchParams.get("state")).toBe(state);

    const token = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        code: redirect.searchParams.get("code")!,
        client_id: applicationId,
        redirect_uri: manifestServer.redirectUri,
        code_verifier: verifier
      }).toString()
    });
    expect(token.statusCode).toBe(200);
    expect(token.json().collection_id).toBe(collectionId);
    expect(token.json().operations).toEqual(["read", "query"]);

    const operation = await app.inject({
      method: "POST",
      url: `/v1/collections/${collectionId}/operations/query`,
      headers: { authorization: `Bearer ${token.json().access_token}` },
      payload: { types: ["workout"] }
    });
    expect(operation.statusCode).toBe(503);
    expect(operation.json().error.code).toBe("connector_offline");

    const deniedState = "denied-state";
    const deniedAuthorization = await app.inject({
      method: "GET",
      url: `/oauth/authorize?client_id=${applicationId}&redirect_uri=${encodeURIComponent(manifestServer.redirectUri)}&code_challenge=${pkceChallenge(verifier)}&code_challenge_method=S256&state=${deniedState}&operations=read`,
      headers: { cookie }
    });
    const deniedRequestId = deniedAuthorization.headers.location!.split("/").at(-1)!;
    const denied = await app.inject({
      method: "POST",
      url: `/v1/connectors/authorization-requests/${deniedRequestId}/deny`,
      headers: { authorization: `Bearer ${connector.token}` }
    });
    expect(denied.statusCode).toBe(200);
    expect(denied.json()).toEqual({ ok: true });
    const deniedStatus = await app.inject({
      method: "GET",
      url: `/v1/authorization-requests/${deniedRequestId}/status`,
      headers: { cookie }
    });
    const deniedRedirect = new URL(deniedStatus.json().redirect_uri);
    expect(deniedStatus.json().status).toBe("denied");
    expect(deniedRedirect.searchParams.get("error")).toBe("access_denied");
    expect(deniedRedirect.searchParams.get("state")).toBe(deniedState);

    const dashboard = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().collections[0].display_name).toBe("Workouts");
    expect(dashboard.json().grants[0].application_name).toBe("Workout Tracker");
  });
});

async function startManifestServer(): Promise<{
  manifestUrl: string;
  redirectUri: string;
  close(): Promise<void>;
}> {
  const server = createServer((request, response) => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Manifest server is not listening.");
    const origin = `http://localhost:${address.port}`;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      manifest_version: 1,
      name: "Workout Tracker",
      homepage: origin,
      redirect_uris: [`${origin}/auth/mdbase/callback`]
    }));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Manifest server is not listening.");
  const origin = `http://localhost:${address.port}`;
  return {
    manifestUrl: `${origin}/.well-known/mdbase-app.json`,
    redirectUri: `${origin}/auth/mdbase/callback`,
    close: () => new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
  };
}
