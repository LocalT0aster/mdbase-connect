import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type {
  ApplicationRequirements,
  ContractRequirement,
  GrantScope
} from "@mdbase/connect-protocol";
import { z, ZodError } from "zod";
import type { DatabasePool } from "./db.js";
import { fetchManifest } from "./manifest.js";
import { ConnectorOperationError, RelayHub, RelayUnavailableError } from "./relay.js";
import { pkceChallenge, randomToken, safeEqual, tokenHash } from "./security.js";

const OPERATIONS = ["describe", "changes", "read", "query", "validate", "create", "update", "delete", "rename"] as const;
const operationSchema = z.enum(OPERATIONS);
const contractRequirementSchema = z.object({
  id: z.string().trim().min(1).max(100),
  version: z.number().int().positive()
}).strict();

interface BuildOptions {
  db: DatabasePool;
  devAuth?: boolean;
  tailscaleAuth?: boolean;
  publicUrl?: string;
  portalDist?: string;
  allowInsecureManifests?: boolean;
  trustProxy?: boolean;
}

interface User {
  id: string;
  email: string;
  name: string;
}

interface ConnectorIdentity {
  id: string;
  user_id: string;
}

export async function buildApp(options: BuildOptions) {
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
    trustProxy: options.trustProxy ?? options.tailscaleAuth === true,
    bodyLimit: 2 * 1024 * 1024,
    requestTimeout: 35_000
  });
  const publicUrl = options.publicUrl ?? "http://127.0.0.1:8787";
  const relay = new RelayHub(options.db);

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        fontSrc: ["'self'", "data:"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        upgradeInsecureRequests: null
      }
    },
    crossOriginEmbedderPolicy: false
  });
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: "1 minute"
  });
  await app.register(formbody);
  await app.register(cors, { origin: true, credentials: false });
  await app.register(websocket);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send(apiError("invalid_request", error.issues[0]?.message ?? "Invalid request."));
    }
    if (error instanceof RequestValidationError) {
      return reply.code(400).send(apiError("invalid_request", error.message));
    }
    request.log.error(error);
    return reply.code(500).send(apiError("internal_error", "The request could not be completed."));
  });

  app.get("/health", async () => ({ ok: true, service: "mdbase-connect", protocol_version: 2 }));

  app.get("/v1/auth/config", async () => ({
    provider: options.tailscaleAuth ? "tailscale" : options.devAuth ? "development" : "session",
    development_login: options.devAuth === true
  }));

  app.post("/v1/pairing-requests", async (request, reply) => {
    const input = z.object({
      connector_name: z.string().trim().min(1).max(100)
    }).parse(request.body);
    const id = randomUUID();
    const secret = randomToken("pair");
    await options.db.query(
      `INSERT INTO pairing_requests (id, secret_hash, connector_name, expires_at)
       VALUES ($1, $2, $3, now() + interval '10 minutes')`,
      [id, tokenHash(secret), input.connector_name]
    );
    return reply.code(201).send({
      pairing_id: id,
      pairing_secret: secret,
      verification_uri: `${publicUrl}/pair/${id}`,
      expires_in: 600
    });
  });

  app.get("/v1/pairing-requests/:pairingId", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const { pairingId } = z.object({ pairingId: z.uuid() }).parse(request.params);
    const pairing = await options.db.query<{
      id: string;
      connector_name: string;
      approved_at: string | null;
      consumed_at: string | null;
      expires_at: string;
    }>(
      `SELECT id, connector_name, approved_at, consumed_at, expires_at
       FROM pairing_requests WHERE id = $1 AND expires_at > now()`,
      [pairingId]
    );
    if (!pairing.rows[0]) {
      return reply.code(404).send(apiError("pairing_not_found", "Pairing request expired or was not found."));
    }
    return { pairing: pairing.rows[0] };
  });

  app.post("/v1/pairing-requests/:pairingId/approve", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const { pairingId } = z.object({ pairingId: z.uuid() }).parse(request.params);
    const approved = await options.db.query(
      `UPDATE pairing_requests SET user_id = $2, approved_at = now()
       WHERE id = $1 AND approved_at IS NULL AND consumed_at IS NULL AND expires_at > now()
       RETURNING id, connector_name`,
      [pairingId, user.id]
    );
    if (!approved.rows[0]) {
      return reply.code(404).send(apiError("pairing_not_found", "Pairing request expired or was already used."));
    }
    await audit(options.db, user.id, "connector.pairing_approved", pairingId, {
      name: approved.rows[0].connector_name
    });
    return {
      ok: true,
      deep_link: `mdbase-connect://paired?server=${encodeURIComponent(publicUrl)}&pairing_id=${pairingId}`
    };
  });

  app.post("/v1/pairing-requests/:pairingId/exchange", async (request, reply) => {
    const { pairingId } = z.object({ pairingId: z.uuid() }).parse(request.params);
    const secret = bearerToken(request);
    if (!secret) return reply.code(401).send(apiError("invalid_pairing", "Pairing secret required."));
    const pairing = await options.db.query<{
      id: string;
      connector_name: string;
      user_id: string | null;
      approved_at: string | null;
      consumed_at: string | null;
    }>(
      `SELECT id, connector_name, user_id, approved_at, consumed_at
       FROM pairing_requests
       WHERE id = $1 AND secret_hash = $2 AND expires_at > now()`,
      [pairingId, tokenHash(secret)]
    );
    const pending = pairing.rows[0];
    if (!pending) return reply.code(404).send(apiError("pairing_not_found", "Pairing request expired or was not found."));
    if (pending.consumed_at) return reply.code(409).send(apiError("pairing_used", "Pairing request has already been used."));
    if (!pending.approved_at || !pending.user_id) return reply.code(202).send({ status: "pending" });

    const consumed = await options.db.query(
      `UPDATE pairing_requests SET consumed_at = now()
       WHERE id = $1 AND consumed_at IS NULL RETURNING id`,
      [pairingId]
    );
    if (!consumed.rows[0]) return reply.code(409).send(apiError("pairing_used", "Pairing request has already been used."));
    const token = randomToken("con");
    const connector = await options.db.query<{ id: string; name: string }>(
      `INSERT INTO connectors (id, user_id, name, token_hash)
       VALUES ($1, $2, $3, $4) RETURNING id, name`,
      [randomUUID(), pending.user_id, pending.connector_name, tokenHash(token)]
    );
    await audit(options.db, pending.user_id, "connector.created", connector.rows[0].id, {
      name: pending.connector_name,
      pairing_id: pairingId
    });
    return { status: "paired", connector: connector.rows[0], token };
  });

  app.post("/v1/dev/session", async (request, reply) => {
    if (!options.devAuth) return reply.code(404).send({ error: { code: "not_found", message: "Not found." } });
    const input = z.object({ email: z.email(), name: z.string().trim().min(1).max(100) }).parse(request.body);
    const id = randomUUID();
    const user = await options.db.query<User>(
      `INSERT INTO users (id, email, name) VALUES ($1, $2, $3)
       ON CONFLICT(email) DO UPDATE SET name = excluded.name
       RETURNING id, email, name`,
      [id, input.email.toLowerCase(), input.name]
    );
    const token = randomToken("ses");
    await options.db.query(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '30 days')`,
      [randomUUID(), user.rows[0].id, tokenHash(token)]
    );
    reply.setCookie("mdbase_session", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: publicUrl.startsWith("https:"),
      path: "/",
      maxAge: 60 * 60 * 24 * 30
    });
    return { user: user.rows[0] };
  });

  app.post("/v1/logout", async (request, reply) => {
    const token = request.cookies.mdbase_session;
    if (token) await options.db.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash(token)]);
    reply.clearCookie("mdbase_session", { path: "/" });
    return { ok: true };
  });

  app.get("/v1/me", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const connectors = await options.db.query(
      `SELECT c.id, c.name, c.last_seen_at, c.created_at
       FROM connectors c WHERE c.user_id = $1 ORDER BY c.created_at`,
      [user.id]
    );
    const collections = await options.db.query(
      `SELECT col.id, col.connector_id, col.local_id, col.display_name, col.spec_version, col.enabled,
              col.contracts, col.last_seen_at,
              c.name AS connector_name
       FROM collections col JOIN connectors c ON c.id = col.connector_id
       WHERE c.user_id = $1 ORDER BY col.display_name`,
      [user.id]
    );
    const grants = await options.db.query(
      `SELECT g.id, g.operations, g.scope, g.created_at, g.revoked_at, g.collection_id,
              a.id AS application_id, a.name AS application_name, a.homepage, a.icon,
              col.display_name AS collection_name
       FROM grants g
       JOIN applications a ON a.id = g.application_id
       JOIN collections col ON col.id = g.collection_id
       WHERE g.user_id = $1 ORDER BY g.created_at DESC`,
      [user.id]
    );
    const pendingAuthorizations = await options.db.query(
      `SELECT ar.id, ar.requested_operations, ar.expires_at,
              a.id AS application_id, a.name AS application_name, a.homepage, a.icon,
              a.requirements
       FROM authorization_requests ar
       JOIN applications a ON a.id = ar.application_id
       WHERE ar.user_id = $1 AND ar.completed_at IS NULL AND ar.denied_at IS NULL
         AND ar.expires_at > now()
       ORDER BY ar.expires_at`,
      [user.id]
    );
    return {
      user,
      authentication: { provider: options.tailscaleAuth ? "tailscale" : "session" },
      connectors: connectors.rows,
      collections: collections.rows,
      grants: grants.rows,
      pending_authorizations: pendingAuthorizations.rows
    };
  });

  app.post("/v1/connectors", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const input = z.object({ name: z.string().trim().min(1).max(100) }).parse(request.body);
    const token = randomToken("con");
    const connector = await options.db.query<{ id: string; name: string }>(
      `INSERT INTO connectors (id, user_id, name, token_hash)
       VALUES ($1, $2, $3, $4) RETURNING id, name`,
      [randomUUID(), user.id, input.name, tokenHash(token)]
    );
    await audit(options.db, user.id, "connector.created", connector.rows[0].id, { name: input.name });
    return reply.code(201).send({ connector: connector.rows[0], token });
  });

  app.delete("/v1/connectors/:connectorId", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const { connectorId } = z.object({ connectorId: z.uuid() }).parse(request.params);
    const removed = await options.db.query(
      "DELETE FROM connectors WHERE id = $1 AND user_id = $2 RETURNING id",
      [connectorId, user.id]
    );
    if (!removed.rows[0]) return reply.code(404).send(apiError("connector_not_found", "Computer not found."));
    await audit(options.db, user.id, "connector.revoked", connectorId, {});
    return { ok: true };
  });

  app.post("/v1/connectors/sync", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    const input = z.object({
      collections: z.array(z.object({
        id: z.uuid(),
        display_name: z.string().min(1).max(200),
        spec_version: z.string().min(1).max(30),
        enabled: z.boolean(),
        contracts: z.array(contractRequirementSchema).max(100).default([])
      })).max(1_000)
    }).parse(request.body);
    const synchronized = [];
    for (const collection of input.collections) {
      const row = await options.db.query<{ id: string; local_id: string }>(
        `INSERT INTO collections (id, connector_id, local_id, display_name, spec_version, enabled, contracts)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT(connector_id, local_id) DO UPDATE SET
           display_name = excluded.display_name,
           spec_version = excluded.spec_version,
           enabled = excluded.enabled,
           contracts = excluded.contracts,
           last_seen_at = now()
         RETURNING id, local_id`,
        [
          randomUUID(),
          connector.id,
          collection.id,
          collection.display_name,
          collection.spec_version,
          collection.enabled,
          JSON.stringify(collection.contracts)
        ]
      );
      synchronized.push(row.rows[0]);
    }
    await options.db.query("UPDATE connectors SET last_seen_at = now() WHERE id = $1", [connector.id]);
    return { collections: synchronized };
  });

  app.get("/v1/connectors/control", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    const account = await options.db.query<{
      connector_id: string;
      connector_name: string;
      user_name: string;
      user_email: string;
    }>(
      `SELECT c.id AS connector_id, c.name AS connector_name,
              u.name AS user_name, u.email AS user_email
       FROM connectors c JOIN users u ON u.id = c.user_id WHERE c.id = $1`,
      [connector.id]
    );
    const grants = await options.db.query(
      `SELECT g.id, g.application_id, a.name AS application_name,
              a.homepage AS application_homepage, a.icon AS application_icon,
              col.local_id AS collection_id, col.display_name AS collection_name,
              g.operations, g.scope, g.created_at
       FROM grants g
       JOIN applications a ON a.id = g.application_id
       JOIN collections col ON col.id = g.collection_id
       WHERE col.connector_id = $1 AND g.revoked_at IS NULL
       ORDER BY a.name, col.display_name`,
      [connector.id]
    );
    const pendingAuthorizations = await options.db.query(
      `SELECT ar.id, ar.application_id, a.name AS application_name,
              a.homepage AS application_homepage, a.icon AS application_icon,
              ar.requested_operations, ar.expires_at, a.requirements
       FROM authorization_requests ar
       JOIN applications a ON a.id = ar.application_id
       WHERE ar.user_id = $1 AND ar.completed_at IS NULL AND ar.denied_at IS NULL
         AND ar.expires_at > now()
       ORDER BY ar.expires_at`,
      [connector.user_id]
    );
    return {
      configured: true,
      online: true,
      account: account.rows[0],
      grants: grants.rows,
      pending_authorizations: pendingAuthorizations.rows
    };
  });

  app.post("/v1/connectors/apps/discover", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    const input = z.object({ manifest_url: z.url() }).parse(request.body);
    const discovered = await fetchManifest(input.manifest_url, options.allowInsecureManifests);
    const application = await upsertApplication(options.db, discovered);
    await audit(options.db, connector.user_id, "application.discovered", application.id, {
      manifest_url: input.manifest_url,
      connector_id: connector.id
    });
    return { application };
  });

  app.post("/v1/connectors/grants", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    const input = z.object({
      application_id: z.uuid(),
      collection_id: z.uuid(),
      operations: z.array(operationSchema).min(1)
    }).parse(request.body);
    const collection = await options.db.query<{ id: string; contracts: ContractRequirement[] }>(
      `SELECT id, contracts FROM collections WHERE connector_id = $1 AND local_id = $2 AND enabled = true`,
      [connector.id, input.collection_id]
    );
    if (!collection.rows[0]) return reply.code(404).send(apiError("collection_not_found", "Collection is not synchronized yet."));
    const application = await options.db.query<{ id: string; requirements: ApplicationRequirements }>(
      "SELECT id, requirements FROM applications WHERE id = $1",
      [input.application_id]
    );
    if (!application.rows[0]) return reply.code(404).send(apiError("application_not_found", "Application not found."));
    const scope = scopeForRequirements(application.rows[0].requirements);
    if (!contractsSatisfy(collection.rows[0].contracts, scope.contracts)) {
      return reply.code(409).send(apiError(
        "incompatible_collection",
        "This collection does not provide the contracts required by the application."
      ));
    }
    const grant = await createOrUpdateGrant(options.db, {
      userId: connector.user_id,
      applicationId: input.application_id,
      collectionId: collection.rows[0].id,
      operations: input.operations,
      scope
    });
    await relay.pushPolicy(connector.id);
    await audit(options.db, connector.user_id, "grant.created", grant.id, {
      ...input,
      connector_id: connector.id
    });
    return reply.code(201).send({ grant });
  });

  app.patch("/v1/connectors/grants/:grantId", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    const { grantId } = z.object({ grantId: z.uuid() }).parse(request.params);
    const input = z.object({ operations: z.array(operationSchema).min(1) }).parse(request.body);
    const grant = await options.db.query(
      `UPDATE grants SET operations = $3::jsonb
       WHERE id = $1 AND revoked_at IS NULL AND collection_id IN
         (SELECT id FROM collections WHERE connector_id = $2)
       RETURNING id, operations`,
      [grantId, connector.id, JSON.stringify([...new Set(input.operations)])]
    );
    if (!grant.rows[0]) return reply.code(404).send(apiError("grant_not_found", "Active grant not found."));
    await relay.pushPolicy(connector.id);
    await audit(options.db, connector.user_id, "grant.updated", grantId, input);
    return { grant: grant.rows[0] };
  });

  app.delete("/v1/connectors/grants/:grantId", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    const { grantId } = z.object({ grantId: z.uuid() }).parse(request.params);
    const active = await options.db.query(
      `UPDATE grants SET revoked_at = now()
       WHERE id = $1 AND revoked_at IS NULL AND collection_id IN
         (SELECT id FROM collections WHERE connector_id = $2)
       RETURNING id`,
      [grantId, connector.id]
    );
    if (!active.rows[0]) return reply.code(404).send(apiError("grant_not_found", "Active grant not found."));
    await options.db.query("UPDATE access_tokens SET revoked_at = now() WHERE grant_id = $1", [grantId]);
    await options.db.query("UPDATE refresh_tokens SET revoked_at = now() WHERE grant_id = $1", [grantId]);
    await relay.pushPolicy(connector.id);
    await audit(options.db, connector.user_id, "grant.revoked", grantId, { connector_id: connector.id });
    return { ok: true };
  });

  app.post("/v1/connectors/authorization-requests/:requestId/approve", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    const { requestId } = z.object({ requestId: z.uuid() }).parse(request.params);
    const input = z.object({
      collection_id: z.uuid(),
      operations: z.array(operationSchema).min(1)
    }).parse(request.body);
    const collection = await options.db.query<{ id: string }>(
      `SELECT id FROM collections
       WHERE connector_id = $1 AND local_id = $2 AND enabled = true`,
      [connector.id, input.collection_id]
    );
    if (!collection.rows[0]) return reply.code(404).send(apiError("collection_not_found", "Collection is not available on this computer."));
    const result = await approveAuthorization(options.db, relay, {
      requestId,
      userId: connector.user_id,
      connectorId: connector.id,
      collectionId: collection.rows[0].id,
      operations: input.operations,
      source: "connector"
    });
    if (!result) return reply.code(404).send(apiError("authorization_not_found", "Authorization request expired or was not found."));
    return { ok: true };
  });

  app.post("/v1/connectors/authorization-requests/:requestId/deny", async (request, reply) => {
    const connector = await requireConnector(request, reply, options.db);
    if (!connector) return;
    const { requestId } = z.object({ requestId: z.uuid() }).parse(request.params);
    const denied = await denyAuthorization(options.db, {
      requestId,
      userId: connector.user_id,
      connectorId: connector.id,
      source: "connector"
    });
    if (!denied) return reply.code(404).send(apiError("authorization_not_found", "Authorization request expired or was not found."));
    return { ok: true };
  });

  app.get("/v1/relay", { websocket: true }, async (socket, request) => {
    const connector = await connectorFromRequest(request, options.db);
    if (!connector) {
      socket.close(4003, "Invalid connector credential");
      return;
    }
    await relay.attach(connector.id, socket);
  });

  app.post("/v1/apps/discover", async (request, reply) => {
    const input = z.object({ manifest_url: z.url() }).parse(request.body);
    const discovered = await fetchManifest(input.manifest_url, options.allowInsecureManifests);
    const application = await upsertApplication(options.db, discovered);
    await reconcileApplicationGrants(options.db, relay, application);
    return { application };
  });

  app.post("/v1/grants", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const input = z.object({
      application_id: z.uuid(),
      collection_id: z.uuid(),
      operations: z.array(operationSchema).min(1)
    }).parse(request.body);
    const ownership = await options.db.query<{ connector_id: string; contracts: ContractRequirement[] }>(
      `SELECT col.connector_id, col.contracts FROM collections col
       JOIN connectors c ON c.id = col.connector_id
       WHERE col.id = $1 AND c.user_id = $2`,
      [input.collection_id, user.id]
    );
    if (!ownership.rows[0]) return reply.code(404).send(apiError("collection_not_found", "Collection not found."));
    const application = await options.db.query<{ id: string; requirements: ApplicationRequirements }>(
      "SELECT id, requirements FROM applications WHERE id = $1",
      [input.application_id]
    );
    if (!application.rows[0]) return reply.code(404).send(apiError("application_not_found", "Application not found."));
    const scope = scopeForRequirements(application.rows[0].requirements);
    if (!contractsSatisfy(ownership.rows[0].contracts, scope.contracts)) {
      return reply.code(409).send(apiError(
        "incompatible_collection",
        "This collection does not provide the contracts required by the application."
      ));
    }
    const grant = await createOrUpdateGrant(options.db, {
      userId: user.id,
      applicationId: input.application_id,
      collectionId: input.collection_id,
      operations: input.operations,
      scope
    });
    await relay.pushPolicy(ownership.rows[0].connector_id);
    await audit(options.db, user.id, "grant.created", grant.id, input);
    return reply.code(201).send({ grant });
  });

  app.delete("/v1/grants/:grantId", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const { grantId } = z.object({ grantId: z.uuid() }).parse(request.params);
    const active = await options.db.query<{ id: string; connector_id: string }>(
      `SELECT g.id, col.connector_id FROM grants g
       JOIN collections col ON col.id = g.collection_id
       WHERE g.id = $1 AND g.user_id = $2 AND g.revoked_at IS NULL`,
      [grantId, user.id]
    );
    if (!active.rows[0]) return reply.code(404).send(apiError("grant_not_found", "Active grant not found."));
    await options.db.query("UPDATE grants SET revoked_at = now() WHERE id = $1", [grantId]);
    await options.db.query("UPDATE access_tokens SET revoked_at = now() WHERE grant_id = $1", [grantId]);
    await options.db.query("UPDATE refresh_tokens SET revoked_at = now() WHERE grant_id = $1", [grantId]);
    await relay.pushPolicy(active.rows[0].connector_id);
    await audit(options.db, user.id, "grant.revoked", grantId, {});
    return { ok: true };
  });

  app.get("/oauth/authorize", async (request, reply) => {
    const query = z.object({
      client_id: z.uuid(),
      redirect_uri: z.url(),
      code_challenge: z.string().min(43).max(128),
      code_challenge_method: z.literal("S256"),
      state: z.string().max(500).optional(),
      operations: z.string().default("read,query")
    }).parse(request.query);
    const application = await options.db.query<{ id: string; redirect_uris: string[] }>(
      "SELECT id, redirect_uris FROM applications WHERE id = $1",
      [query.client_id]
    );
    if (!application.rows[0] || !application.rows[0].redirect_uris.includes(query.redirect_uri)) {
      return reply.code(400).send(apiError("invalid_client", "Unknown application or redirect URI."));
    }
    const user = await authenticatedUser(request, options.db, options.tailscaleAuth);
    if (!user) {
      const returnTo = `${publicUrl}${request.url}`;
      return reply.redirect(`/login?return_to=${encodeURIComponent(returnTo)}`);
    }
    const requestedOperations = [...new Set(query.operations.split(","))].map((value) => operationSchema.parse(value));
    const authorizationId = randomUUID();
    await options.db.query(
      `INSERT INTO authorization_requests
         (id, user_id, application_id, redirect_uri, state, code_challenge, requested_operations, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now() + interval '10 minutes')`,
      [authorizationId, user.id, query.client_id, query.redirect_uri, query.state ?? null, query.code_challenge, JSON.stringify(requestedOperations)]
    );
    return reply.redirect(`/authorize/${authorizationId}`);
  });

  app.get("/v1/authorization-requests/:requestId", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const { requestId } = z.object({ requestId: z.uuid() }).parse(request.params);
    const authorization = await options.db.query(
      `SELECT ar.id, ar.requested_operations, ar.expires_at,
              a.id AS application_id, a.name AS application_name, a.homepage, a.icon,
              a.requirements
       FROM authorization_requests ar JOIN applications a ON a.id = ar.application_id
       WHERE ar.id = $1 AND ar.user_id = $2 AND ar.expires_at > now()`,
      [requestId, user.id]
    );
    if (!authorization.rows[0]) return reply.code(404).send(apiError("authorization_not_found", "Authorization request expired or was not found."));
    const collections = await options.db.query(
      `SELECT col.id, col.display_name, col.spec_version, col.contracts,
              c.name AS connector_name
       FROM collections col JOIN connectors c ON c.id = col.connector_id
       WHERE c.user_id = $1 AND col.enabled = true ORDER BY col.display_name`,
      [user.id]
    );
    return { authorization: authorization.rows[0], collections: collections.rows };
  });

  app.get("/v1/authorization-requests/:requestId/status", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const { requestId } = z.object({ requestId: z.uuid() }).parse(request.params);
    const authorization = await options.db.query<{
      completed_at: string | null;
      denied_at: string | null;
      expires_at: string;
      application_id: string;
      grant_id: string | null;
      redirect_uri: string;
      state: string | null;
      code_challenge: string;
    }>(
      `SELECT completed_at, denied_at, expires_at, application_id, grant_id,
              redirect_uri, state, code_challenge
       FROM authorization_requests
       WHERE id = $1 AND user_id = $2 AND expires_at > now()`,
      [requestId, user.id]
    );
    const value = authorization.rows[0];
    if (!value) return reply.code(404).send(apiError("authorization_not_found", "Authorization request expired or was not found."));
    if (value.denied_at) {
      return { status: "denied", redirect_uri: deniedAuthorizationRedirect(value) };
    }
    if (value.completed_at && value.grant_id) {
      return {
        status: "approved",
        redirect_uri: await createAuthorizationRedirect(options.db, publicUrl, {
          ...value,
          grant_id: value.grant_id
        })
      };
    }
    return { status: "pending" };
  });

  app.post("/v1/authorization-requests/:requestId/approve", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const { requestId } = z.object({ requestId: z.uuid() }).parse(request.params);
    const input = z.object({ collection_id: z.uuid(), operations: z.array(operationSchema).min(1) }).parse(request.body);
    const collection = await options.db.query<{ connector_id: string }>(
      `SELECT col.connector_id FROM collections col JOIN connectors c ON c.id = col.connector_id
       WHERE col.id = $1 AND c.user_id = $2 AND col.enabled = true`,
      [input.collection_id, user.id]
    );
    if (!collection.rows[0]) return reply.code(404).send(apiError("collection_not_found", "Collection not found."));
    const approved = await approveAuthorization(options.db, relay, {
      requestId,
      userId: user.id,
      connectorId: collection.rows[0].connector_id,
      collectionId: input.collection_id,
      operations: input.operations,
      source: "portal"
    });
    if (!approved) return reply.code(404).send(apiError("authorization_not_found", "Authorization request expired or was not found."));
    return { ok: true };
  });

  app.post("/v1/authorization-requests/:requestId/deny", async (request, reply) => {
    const user = await requireUser(request, reply, options.db, options.tailscaleAuth);
    if (!user) return;
    const { requestId } = z.object({ requestId: z.uuid() }).parse(request.params);
    const denied = await denyAuthorization(options.db, {
      requestId,
      userId: user.id,
      source: "portal"
    });
    if (!denied) return reply.code(404).send(apiError("authorization_not_found", "Authorization request expired or was not found."));
    return { ok: true };
  });

  app.post("/oauth/token", async (request, reply) => {
    const input = z.discriminatedUnion("grant_type", [
      z.object({
        grant_type: z.literal("authorization_code"),
        code: z.string().min(1),
        client_id: z.uuid(),
        redirect_uri: z.url(),
        code_verifier: z.string().min(43).max(128)
      }),
      z.object({
        grant_type: z.literal("refresh_token"),
        refresh_token: z.string().min(1),
        client_id: z.uuid()
      })
    ]).parse(request.body);

    if (input.grant_type === "authorization_code") {
      const code = await options.db.query<{
        id: string;
        grant_id: string;
        application_id: string;
        redirect_uri: string;
        code_challenge: string;
      }>(
        `SELECT id, grant_id, application_id, redirect_uri, code_challenge
         FROM authorization_codes WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()`,
        [tokenHash(input.code)]
      );
      const authorizationCode = code.rows[0];
      if (!authorizationCode
        || authorizationCode.application_id !== input.client_id
        || authorizationCode.redirect_uri !== input.redirect_uri
        || !safeEqual(authorizationCode.code_challenge, pkceChallenge(input.code_verifier))) {
        return reply.code(400).send(apiError("invalid_grant", "Authorization code is invalid or expired."));
      }
      const consumed = await options.db.query(
        "UPDATE authorization_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id",
        [authorizationCode.id]
      );
      if (!consumed.rows[0]) {
        return reply.code(400).send(apiError("invalid_grant", "Authorization code has already been used."));
      }
      return issueApplicationTokens(options.db, authorizationCode.grant_id);
    }

    const refresh = await options.db.query<{ id: string; grant_id: string }>(
      `SELECT rt.id, rt.grant_id
       FROM refresh_tokens rt
       JOIN grants g ON g.id = rt.grant_id
       WHERE rt.token_hash = $1 AND rt.used_at IS NULL AND rt.revoked_at IS NULL
         AND rt.expires_at > now() AND g.revoked_at IS NULL AND g.application_id = $2`,
      [tokenHash(input.refresh_token), input.client_id]
    );
    const current = refresh.rows[0];
    if (!current) {
      return reply.code(400).send(apiError("invalid_grant", "Refresh token is invalid or expired."));
    }
    const rotated = await options.db.query(
      `UPDATE refresh_tokens SET used_at = now()
       WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL RETURNING id`,
      [current.id]
    );
    if (!rotated.rows[0]) {
      return reply.code(400).send(apiError("invalid_grant", "Refresh token has already been used."));
    }
    return issueApplicationTokens(options.db, current.grant_id);
  });

  app.post("/v1/collections/:collectionId/operations/:operation", async (request, reply) => {
    const params = z.object({ collectionId: z.uuid(), operation: operationSchema }).parse(request.params);
    const bearer = bearerToken(request);
    if (!bearer) return reply.code(401).send(apiError("invalid_token", "Bearer token required."));
    const authorized = await options.db.query<{
      grant_id: string;
      application_id: string;
      operations: string[];
      connector_id: string;
      local_id: string;
    }>(
      `SELECT g.id AS grant_id, g.application_id, g.operations, col.connector_id, col.local_id
       FROM access_tokens tok
       JOIN grants g ON g.id = tok.grant_id
       JOIN collections col ON col.id = g.collection_id
       WHERE tok.token_hash = $1 AND tok.expires_at > now() AND tok.revoked_at IS NULL
         AND g.revoked_at IS NULL AND col.id = $2 AND col.enabled = true`,
      [tokenHash(bearer), params.collectionId]
    );
    const grant = authorized.rows[0];
    if (!grant) {
      return reply.code(401).send(apiError("invalid_token", "Access token is invalid or expired."));
    }
    if (!grant.operations.includes(params.operation)) {
      return reply.code(403).send(apiError("insufficient_access", "The application is not allowed to perform this operation."));
    }
    try {
      const result = await relay.route({
        connectorId: grant.connector_id,
        localCollectionId: grant.local_id,
        grantId: grant.grant_id,
        applicationId: grant.application_id,
        operation: params.operation,
        operationInput: request.body ?? {}
      });
      return { ok: true, result };
    } catch (error) {
      if (error instanceof RelayUnavailableError) {
        return reply.code(503).send(apiError("connector_offline", error.message));
      }
      if (error instanceof ConnectorOperationError) {
        const denied = error.code === "access_paused" || error.code === "access_denied";
        return reply.code(denied ? 403 : 502).send(apiError(error.code, error.message));
      }
      throw error;
    }
  });

  if (options.portalDist && existsSync(options.portalDist)) {
    await app.register(fastifyStatic, { root: resolve(options.portalDist), wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && request.headers.accept?.includes("text/html")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send(apiError("not_found", "Not found."));
    });
  }

  return { app, relay };
}

async function upsertApplication(
  db: DatabasePool,
  discovered: Awaited<ReturnType<typeof fetchManifest>>
): Promise<{
  id: string;
  name: string;
  homepage: string;
  icon: string | null;
  redirect_uris: string[];
  canonical_identity: string;
  requirements: ApplicationRequirements;
}> {
  const application = await db.query<{
    id: string;
    name: string;
    homepage: string;
    icon: string | null;
    redirect_uris: string[];
    canonical_identity: string;
    requirements: ApplicationRequirements;
  }>(
    `INSERT INTO applications
       (id, canonical_identity, manifest_url, name, homepage, icon, redirect_uris, requirements)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
     ON CONFLICT(canonical_identity) DO UPDATE SET
       manifest_url = excluded.manifest_url,
       name = excluded.name,
       homepage = excluded.homepage,
       icon = excluded.icon,
       redirect_uris = excluded.redirect_uris,
       requirements = excluded.requirements,
       updated_at = now()
     RETURNING id, name, homepage, icon, redirect_uris, canonical_identity, requirements`,
    [
      randomUUID(),
      discovered.canonicalIdentity,
      discovered.manifestUrl,
      discovered.manifest.name,
      discovered.manifest.homepage,
      discovered.manifest.icon ?? null,
      JSON.stringify(discovered.manifest.redirect_uris),
      JSON.stringify(discovered.manifest.requirements)
    ]
  );
  return application.rows[0];
}

async function createOrUpdateGrant(
  db: DatabasePool,
  input: {
    userId: string;
    applicationId: string;
    collectionId: string;
    operations: string[];
    scope: GrantScope;
  }
): Promise<{ id: string; operations: string[]; scope: GrantScope }> {
  const operations = [...new Set(input.operations)];
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM grants WHERE user_id = $1 AND application_id = $2
     AND collection_id = $3 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [input.userId, input.applicationId, input.collectionId]
  );
  const grant = existing.rows[0]
    ? await db.query<{ id: string; operations: string[]; scope: GrantScope }>(
        `UPDATE grants SET operations = $2::jsonb, scope = $3::jsonb
         WHERE id = $1 RETURNING id, operations, scope`,
        [existing.rows[0].id, JSON.stringify(operations), JSON.stringify(input.scope)]
      )
    : await db.query<{ id: string; operations: string[]; scope: GrantScope }>(
        `INSERT INTO grants (id, user_id, application_id, collection_id, operations, scope)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb) RETURNING id, operations, scope`,
        [
          randomUUID(),
          input.userId,
          input.applicationId,
          input.collectionId,
          JSON.stringify(operations),
          JSON.stringify(input.scope)
        ]
      );
  return grant.rows[0];
}

async function reconcileApplicationGrants(
  db: DatabasePool,
  relay: RelayHub,
  application: { id: string; requirements: ApplicationRequirements }
): Promise<void> {
  const desiredScope = scopeForRequirements(application.requirements);
  const grants = await db.query<{
    id: string;
    user_id: string;
    connector_id: string;
    contracts: ContractRequirement[];
    scope: GrantScope;
  }>(
    `SELECT g.id, g.user_id, col.connector_id, col.contracts, g.scope
     FROM grants g
     JOIN collections col ON col.id = g.collection_id
     WHERE g.application_id = $1 AND g.revoked_at IS NULL`,
    [application.id]
  );
  const changedConnectors = new Set<string>();
  for (const grant of grants.rows) {
    const collectionCompatible = contractsSatisfy(grant.contracts, desiredScope.contracts);
    if (scopesEqual(grant.scope, desiredScope) && collectionCompatible) continue;
    const mayNarrow = desiredScope.contracts.length > 0
      && (grant.scope.contracts.length === 0
        || isContractSubset(desiredScope.contracts, grant.scope.contracts));
    if (mayNarrow && collectionCompatible) {
      await db.query("UPDATE grants SET scope = $2::jsonb WHERE id = $1", [
        grant.id,
        JSON.stringify(desiredScope)
      ]);
      await audit(db, grant.user_id, "grant.scope_reconciled", grant.id, {
        application_id: application.id,
        scope: desiredScope
      });
    } else {
      await db.query("UPDATE grants SET revoked_at = now() WHERE id = $1", [grant.id]);
      await db.query("UPDATE access_tokens SET revoked_at = now() WHERE grant_id = $1", [grant.id]);
      await db.query("UPDATE refresh_tokens SET revoked_at = now() WHERE grant_id = $1", [grant.id]);
      await audit(db, grant.user_id, "grant.revoked_after_manifest_change", grant.id, {
        application_id: application.id,
        previous_scope: grant.scope,
        required_scope: desiredScope
      });
    }
    changedConnectors.add(grant.connector_id);
  }
  for (const connectorId of changedConnectors) await relay.pushPolicy(connectorId);
}

function scopesEqual(left: GrantScope, right: GrantScope): boolean {
  return isContractSubset(left.contracts, right.contracts)
    && isContractSubset(right.contracts, left.contracts);
}

function isContractSubset(
  subset: ContractRequirement[],
  superset: ContractRequirement[]
): boolean {
  const available = new Set(superset.map((contract) => `${contract.id}@${contract.version}`));
  return subset.every((contract) => available.has(`${contract.id}@${contract.version}`));
}

async function approveAuthorization(
  db: DatabasePool,
  relay: RelayHub,
  input: {
    requestId: string;
    userId: string;
    connectorId: string;
    collectionId: string;
    operations: string[];
    source: "connector" | "portal";
  }
): Promise<boolean> {
  const authorization = await db.query<{
    application_id: string;
    requested_operations: string[];
    requirements: ApplicationRequirements;
  }>(
    `SELECT ar.application_id, ar.requested_operations, a.requirements
     FROM authorization_requests ar
     JOIN applications a ON a.id = ar.application_id
     WHERE ar.id = $1 AND ar.user_id = $2 AND ar.completed_at IS NULL AND ar.expires_at > now()`,
    [input.requestId, input.userId]
  );
  const pending = authorization.rows[0];
  if (!pending) return false;
  if (input.operations.some((operation) => !pending.requested_operations.includes(operation))) {
    throw new RequestValidationError("Approved operations must be requested by the application.");
  }
  const collection = await db.query<{ contracts: ContractRequirement[] }>(
    "SELECT contracts FROM collections WHERE id = $1 AND enabled = true",
    [input.collectionId]
  );
  const scope = scopeForRequirements(pending.requirements);
  if (!collection.rows[0] || !contractsSatisfy(collection.rows[0].contracts, scope.contracts)) {
    throw new RequestValidationError(
      "This collection does not provide the contracts required by the application."
    );
  }
  const grantId = randomUUID();
  await db.query(
    `INSERT INTO grants (id, user_id, application_id, collection_id, operations, scope)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
    [
      grantId,
      input.userId,
      pending.application_id,
      input.collectionId,
      JSON.stringify(input.operations),
      JSON.stringify(scope)
    ]
  );
  await db.query(
    "UPDATE authorization_requests SET completed_at = now(), grant_id = $2 WHERE id = $1",
    [input.requestId, grantId]
  );
  await relay.pushPolicy(input.connectorId);
  await audit(db, input.userId, "authorization.approved", input.requestId, {
    connector_id: input.connectorId,
    collection_id: input.collectionId,
    operations: input.operations,
    scope,
    source: input.source
  });
  return true;
}

async function denyAuthorization(
  db: DatabasePool,
  input: {
    requestId: string;
    userId: string;
    connectorId?: string;
    source: "connector" | "portal";
  }
): Promise<boolean> {
  const pending = await db.query<{ id: string }>(
    `UPDATE authorization_requests SET completed_at = now(), denied_at = now()
     WHERE id = $1 AND user_id = $2 AND completed_at IS NULL AND expires_at > now()
     RETURNING id`,
    [input.requestId, input.userId]
  );
  if (!pending.rows[0]) return false;
  await audit(db, input.userId, "authorization.denied", input.requestId, {
    ...(input.connectorId ? { connector_id: input.connectorId } : {}),
    source: input.source
  });
  return true;
}

function deniedAuthorizationRedirect(input: { redirect_uri: string; state: string | null }): string {
  const redirect = new URL(input.redirect_uri);
  redirect.searchParams.set("error", "access_denied");
  if (input.state) redirect.searchParams.set("state", input.state);
  return redirect.href;
}

async function createAuthorizationRedirect(
  db: DatabasePool,
  publicUrl: string,
  input: {
    application_id: string;
    grant_id: string;
    redirect_uri: string;
    state: string | null;
    code_challenge: string;
  }
): Promise<string> {
  const code = randomToken("code");
  await db.query(
    `INSERT INTO authorization_codes
       (id, code_hash, grant_id, application_id, redirect_uri, code_challenge, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + interval '2 minutes')`,
    [randomUUID(), tokenHash(code), input.grant_id, input.application_id, input.redirect_uri, input.code_challenge]
  );
  const redirect = new URL(input.redirect_uri);
  redirect.searchParams.set("code", code);
  if (input.state) redirect.searchParams.set("state", input.state);
  redirect.searchParams.set("iss", publicUrl);
  return redirect.href;
}

async function issueApplicationTokens(db: DatabasePool, grantId: string): Promise<{
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_expires_in: number;
  collection_id: string;
  operations: string[];
  scope: GrantScope;
}> {
  const grant = await db.query<{
    collection_id: string;
    operations: string[];
    scope: GrantScope;
  }>(
    "SELECT collection_id, operations, scope FROM grants WHERE id = $1 AND revoked_at IS NULL",
    [grantId]
  );
  if (!grant.rows[0]) throw new RequestValidationError("The application grant is no longer active.");
  const accessToken = randomToken("mdb");
  const refreshToken = randomToken("ref");
  await db.query(
    `INSERT INTO access_tokens (id, token_hash, grant_id, expires_at)
     VALUES ($1, $2, $3, now() + interval '1 hour')`,
    [randomUUID(), tokenHash(accessToken), grantId]
  );
  await db.query(
    `INSERT INTO refresh_tokens (id, token_hash, grant_id, expires_at)
     VALUES ($1, $2, $3, now() + interval '30 days')`,
    [randomUUID(), tokenHash(refreshToken), grantId]
  );
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_expires_in: 30 * 24 * 60 * 60,
    collection_id: grant.rows[0].collection_id,
    operations: grant.rows[0].operations,
    scope: grant.rows[0].scope
  };
}

function scopeForRequirements(requirements: ApplicationRequirements | null | undefined): GrantScope {
  const contracts = requirements?.contracts ?? [];
  return {
    contracts: [...new Map(contracts.map((contract) => [
      `${contract.id}@${contract.version}`,
      contract
    ])).values()]
  };
}

function contractsSatisfy(
  available: ContractRequirement[] | null | undefined,
  required: ContractRequirement[]
): boolean {
  const present = new Set((available ?? []).map((contract) => `${contract.id}@${contract.version}`));
  return required.every((contract) => present.has(`${contract.id}@${contract.version}`));
}

class RequestValidationError extends Error {}

async function sessionUser(request: FastifyRequest, db: DatabasePool): Promise<User | null> {
  const token = request.cookies.mdbase_session;
  if (!token) return null;
  const user = await db.query<User>(
    `SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [tokenHash(token)]
  );
  return user.rows[0] ?? null;
}

async function tailscaleUser(request: FastifyRequest, db: DatabasePool): Promise<User | null> {
  const loginHeader = request.headers["tailscale-user-login"];
  const nameHeader = request.headers["tailscale-user-name"];
  const login = (Array.isArray(loginHeader) ? loginHeader[0] : loginHeader)?.trim().toLowerCase();
  if (!login || login.length > 320) return null;
  const suppliedName = (Array.isArray(nameHeader) ? nameHeader[0] : nameHeader)?.trim();
  const fallbackName = login.split("@")[0] || login;
  const name = suppliedName && suppliedName.length <= 100 ? suppliedName : fallbackName.slice(0, 100);
  const user = await db.query<User>(
    `INSERT INTO users (id, email, name) VALUES ($1, $2, $3)
     ON CONFLICT(email) DO UPDATE SET name = excluded.name
     RETURNING id, email, name`,
    [randomUUID(), login, name]
  );
  return user.rows[0];
}

async function authenticatedUser(
  request: FastifyRequest,
  db: DatabasePool,
  tailscaleAuth = false
): Promise<User | null> {
  return tailscaleAuth ? tailscaleUser(request, db) : sessionUser(request, db);
}

async function requireUser(
  request: FastifyRequest,
  reply: FastifyReply,
  db: DatabasePool,
  tailscaleAuth = false
): Promise<User | null> {
  const user = await authenticatedUser(request, db, tailscaleAuth);
  if (!user) reply.code(401).send(apiError("not_authenticated", "Sign in to continue."));
  return user;
}

async function connectorFromRequest(request: FastifyRequest, db: DatabasePool): Promise<ConnectorIdentity | null> {
  const token = bearerToken(request);
  if (!token) return null;
  const connector = await db.query<ConnectorIdentity>(
    "SELECT id, user_id FROM connectors WHERE token_hash = $1",
    [tokenHash(token)]
  );
  return connector.rows[0] ?? null;
}

async function requireConnector(
  request: FastifyRequest,
  reply: FastifyReply,
  db: DatabasePool
): Promise<ConnectorIdentity | null> {
  const connector = await connectorFromRequest(request, db);
  if (!connector) reply.code(401).send(apiError("invalid_connector", "Connector credential is invalid."));
  return connector;
}

function bearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  return authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
}

async function audit(
  db: DatabasePool,
  userId: string | null,
  eventType: string,
  subjectId: string | null,
  metadata: unknown
): Promise<void> {
  await db.query(
    `INSERT INTO audit_events (id, user_id, event_type, subject_id, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [randomUUID(), userId, eventType, subjectId, JSON.stringify(metadata)]
  );
}

function apiError(code: string, message: string) {
  return { error: { code, message } };
}
