import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

process.env.NODE_ENV = "test";
const run = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");
const { buildApp } = await import("../services/server/dist/app.js");
const { createDatabase } = await import("../services/server/dist/db.js");
const database = await createDatabase("memory");
const { app } = await buildApp({
  db: database,
  devAuth: true,
  allowInsecureManifests: true,
  publicUrl: "http://127.0.0.1"
});
await app.listen({ host: "127.0.0.1", port: 0 });
const serverAddress = app.server.address();
if (!serverAddress || typeof serverAddress === "string") throw new Error("Server did not open a TCP port");
const serverUrl = `http://127.0.0.1:${serverAddress.port}`;
const scratch = await mkdtemp(join(tmpdir(), "mdbase-connect-e2e-"));
const stateDir = join(scratch, "state");
const collectionPath = join(scratch, "workouts");
const extension = process.platform === "win32" ? ".exe" : "";
const agentBinary = join(repoRoot, "target", "debug", `mdbase-connect-agent${extension}`);
const cliBinary = join(repoRoot, "target", "debug", `mdbase-connect${extension}`);
let agent;
let manifestServer;

try {
  const session = await request("/v1/dev/session", {
    method: "POST",
    body: { name: "MVP User", email: "mvp@example.com" }
  });
  const cookie = session.response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Development session did not set a cookie");
  const connector = await request("/v1/connectors", {
    method: "POST",
    cookie,
    body: { name: "MVP computer" }
  });

  agent = startAgent([]);
  await waitForAgent();
  await run(cliBinary, [
    "--state-dir", stateDir,
    "collection", "create", collectionPath,
    "--name", "Workouts"
  ]);
  await stopAgent(agent);
  agent = startAgent(["--server-url", serverUrl, "--connector-token", connector.body.token]);

  const dashboard = await poll(async () => {
    const current = await request("/v1/me", { cookie });
    return current.body.collections.length ? current.body : null;
  }, "collection metadata did not reach the portal");
  const collection = dashboard.collections[0];

  const manifest = await openManifestServer();
  manifestServer = manifest.server;
  const application = await request("/v1/apps/discover", {
    method: "POST",
    body: { manifest_url: manifest.manifestUrl }
  });
  const appId = application.body.application.id;
  const verifier = "end-to-end-pkce-verifier-with-forty-three-characters";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = await fetch(
    `${serverUrl}/oauth/authorize?client_id=${appId}&redirect_uri=${encodeURIComponent(manifest.redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256&state=e2e&operations=read,query,create`,
    { headers: { cookie }, redirect: "manual" }
  );
  if (authorize.status !== 302) throw new Error(`Authorization start returned HTTP ${authorize.status}`);
  const authorizationId = authorize.headers.get("location")?.split("/").at(-1);
  if (!authorizationId) throw new Error("Authorization request ID missing");
  await poll(async () => {
    const snapshot = await cliJson(["access", "snapshot"]);
    return snapshot.result?.pending_authorizations?.some((pending) => pending.id === authorizationId)
      ? snapshot
      : null;
  }, "authorization request did not reach the local connector controls");
  await cliJson([
    "access", "approve", authorizationId, collection.local_id,
    "--operations", "read,query,create"
  ]);
  const completed = await poll(async () => {
    const current = await request(`/v1/authorization-requests/${authorizationId}/status`, { cookie });
    return current.body.redirect_uri ? current : null;
  }, "approved authorization did not return to the browser");
  const callback = new URL(completed.body.redirect_uri);
  const token = await request("/oauth/token", {
    method: "POST",
    form: {
      grant_type: "authorization_code",
      code: callback.searchParams.get("code"),
      client_id: appId,
      redirect_uri: manifest.redirectUri,
      code_verifier: verifier
    }
  });

  await poll(async () => {
    const response = await rawOperation(collection.id, "create", token.body.access_token, {
      path: "sessions/first.md",
      frontmatter: { title: "First connected workout" },
      body: "Created through the relay."
    });
    return response.status === 200 ? response : null;
  }, "authorized relay create did not reach the connector");
  const read = await rawOperation(collection.id, "read", token.body.access_token, {
    path: "sessions/first.md"
  });
  const readBody = await read.json();
  if (read.status !== 200 || readBody.result?.result?.frontmatter?.title !== "First connected workout") {
    throw new Error(`Unexpected relay read response: ${JSON.stringify(readBody)}`);
  }

  await cliJson(["access", "pause", "true"]);
  const paused = await rawOperation(collection.id, "read", token.body.access_token, {
    path: "sessions/first.md"
  });
  if (paused.status !== 403) throw new Error(`Paused local access returned HTTP ${paused.status}`);
  const localActivity = await cliJson(["activity", "--limit", "20"]);
  if (!localActivity.result.some((entry) => entry.outcome === "denied" && entry.operation === "read")) {
    throw new Error("Paused operation was not recorded in local activity");
  }
  await cliJson(["access", "pause", "false"]);

  const localAccess = await cliJson(["access", "snapshot"]);
  await cliJson(["access", "revoke", localAccess.result.grants[0].id]);
  const revoked = await rawOperation(collection.id, "read", token.body.access_token, {
    path: "sessions/first.md"
  });
  if (revoked.status !== 403) throw new Error(`Revoked token returned HTTP ${revoked.status}`);
  process.stdout.write("MDBASE Connect end-to-end MVP path passed\n");
} finally {
  if (agent) await stopAgent(agent);
  if (manifestServer) await new Promise((resolveClose) => manifestServer.close(resolveClose));
  await app.close();
  await database.end();
  await rm(scratch, { recursive: true, force: true });
}

async function cliJson(args) {
  const result = await run(cliBinary, ["--state-dir", stateDir, "--compact", ...args]);
  const parsed = JSON.parse(result.stdout);
  if (!parsed.ok) throw new Error(`Connector command failed: ${result.stdout}`);
  return parsed;
}

function startAgent(extraArgs) {
  const child = spawn(agentBinary, ["--state-dir", stateDir, ...extraArgs], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => process.stderr.write(`[agent] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[agent] ${chunk}`));
  return child;
}

async function stopAgent(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGINT");
  await new Promise((resolveExit) => child.once("exit", resolveExit));
}

async function waitForAgent() {
  await poll(async () => {
    try {
      await run(cliBinary, ["--state-dir", stateDir, "ping"]);
      return true;
    } catch {
      return null;
    }
  }, "local connector agent did not start");
}

async function request(path, options = {}) {
  const headers = {};
  let body;
  if (options.cookie) headers.cookie = options.cookie;
  if (options.body) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  if (options.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(options.form).toString();
  }
  const response = await fetch(`${serverUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body
  });
  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}: ${JSON.stringify(responseBody)}`);
  return { response, body: responseBody };
}

function rawOperation(collectionId, operation, accessToken, input) {
  return fetch(`${serverUrl}/v1/collections/${collectionId}/operations/${operation}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(input)
  });
}

async function poll(action, failureMessage) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await action();
    if (result) return result;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(failureMessage);
}

async function openManifestServer() {
  const server = createServer((request, response) => {
    const address = server.address();
    const origin = `http://localhost:${address.port}`;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      manifest_version: 1,
      name: "MVP Workout App",
      homepage: origin,
      redirect_uris: [`${origin}/auth/mdbase/callback`]
    }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  const origin = `http://localhost:${address.port}`;
  return {
    server,
    manifestUrl: `${origin}/.well-known/mdbase-app.json`,
    redirectUri: `${origin}/auth/mdbase/callback`
  };
}
