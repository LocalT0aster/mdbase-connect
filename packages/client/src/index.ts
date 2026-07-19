export type MdbaseOperation = "read" | "query" | "validate" | "create" | "update" | "delete" | "rename";

export interface MdbaseConnectOptions {
  serverUrl: string;
  manifestUrl?: string;
  redirectUri?: string;
  storage?: Storage;
}

interface Application {
  id: string;
  name: string;
  homepage: string;
}

interface StoredAuthorization {
  verifier: string;
  state: string;
  clientId: string;
  redirectUri: string;
}

interface StoredToken {
  accessToken: string;
  collectionId: string;
  operations: MdbaseOperation[];
  expiresAt: number;
}

export class MdbaseConnect {
  private readonly serverUrl: string;
  private readonly manifestUrl: string;
  private readonly redirectUri: string;
  private readonly storage: Storage;
  private application: Application | null = null;

  constructor(options: MdbaseConnectOptions) {
    this.serverUrl = stripTrailingSlash(options.serverUrl);
    this.manifestUrl = options.manifestUrl ?? new URL("/.well-known/mdbase-app.json", location.origin).href;
    this.redirectUri = options.redirectUri ?? location.href.split(/[?#]/)[0];
    this.storage = options.storage ?? sessionStorage;
  }

  async discover(): Promise<Application> {
    if (this.application) return this.application;
    const response = await fetch(`${this.serverUrl}/v1/apps/discover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest_url: this.manifestUrl })
    });
    const body = await response.json();
    if (!response.ok) throw new MdbaseConnectError(body?.error?.code ?? "discovery_failed", body?.error?.message ?? "Application discovery failed.");
    this.application = body.application;
    return this.application!;
  }

  async authorize(operations: MdbaseOperation[] = ["read", "query"]): Promise<never> {
    const application = await this.discover();
    const { verifier, challenge } = await createPkce();
    const state = randomBase64Url(24);
    const pending: StoredAuthorization = {
      verifier,
      state,
      clientId: application.id,
      redirectUri: this.redirectUri
    };
    this.storage.setItem(this.pendingKey(), JSON.stringify(pending));
    const authorize = new URL(`${this.serverUrl}/oauth/authorize`);
    authorize.searchParams.set("client_id", application.id);
    authorize.searchParams.set("redirect_uri", this.redirectUri);
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("operations", [...new Set(operations)].join(","));
    location.assign(authorize.href);
    return new Promise<never>(() => undefined);
  }

  async completeAuthorization(callbackUrl = location.href): Promise<{
    collectionId: string;
    operations: MdbaseOperation[];
  }> {
    const callback = new URL(callbackUrl);
    const code = callback.searchParams.get("code");
    const state = callback.searchParams.get("state");
    const pending = parseStored<StoredAuthorization>(this.storage.getItem(this.pendingKey()));
    if (!code || !state || !pending || state !== pending.state) {
      throw new MdbaseConnectError("invalid_callback", "Authorization callback is missing or does not match this browser session.");
    }
    const response = await fetch(`${this.serverUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: pending.clientId,
        redirect_uri: pending.redirectUri,
        code_verifier: pending.verifier
      })
    });
    const body = await response.json();
    if (!response.ok) throw new MdbaseConnectError(body?.error?.code ?? "token_exchange_failed", body?.error?.message ?? "Authorization could not be completed.");
    const token: StoredToken = {
      accessToken: body.access_token,
      collectionId: body.collection_id,
      operations: body.operations,
      expiresAt: Date.now() + body.expires_in * 1_000
    };
    this.storage.setItem(this.tokenKey(), JSON.stringify(token));
    this.storage.removeItem(this.pendingKey());
    return { collectionId: token.collectionId, operations: token.operations };
  }

  connection(): { collectionId: string; operations: MdbaseOperation[] } | null {
    const token = this.currentToken();
    return token ? { collectionId: token.collectionId, operations: token.operations } : null;
  }

  disconnect(): void {
    this.storage.removeItem(this.tokenKey());
    this.storage.removeItem(this.pendingKey());
  }

  read(input: unknown): Promise<unknown> { return this.operation("read", input); }
  query(input: unknown): Promise<unknown> { return this.operation("query", input); }
  create(input: unknown): Promise<unknown> { return this.operation("create", input); }
  update(input: unknown): Promise<unknown> { return this.operation("update", input); }
  delete(input: unknown): Promise<unknown> { return this.operation("delete", input); }
  rename(input: unknown): Promise<unknown> { return this.operation("rename", input); }
  validate(input: unknown = {}): Promise<unknown> { return this.operation("validate", input); }

  async operation(operation: MdbaseOperation, input: unknown): Promise<unknown> {
    const token = this.currentToken();
    if (!token) throw new MdbaseConnectError("not_authorized", "Connect this application before accessing a collection.");
    if (!token.operations.includes(operation)) {
      throw new MdbaseConnectError("insufficient_access", `This connection does not allow ${operation}.`);
    }
    const response = await fetch(
      `${this.serverUrl}/v1/collections/${encodeURIComponent(token.collectionId)}/operations/${operation}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.accessToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(input ?? {})
      }
    );
    const body = await response.json();
    if (!response.ok) throw new MdbaseConnectError(body?.error?.code ?? "operation_failed", body?.error?.message ?? "Collection operation failed.");
    return body.result;
  }

  private currentToken(): StoredToken | null {
    const token = parseStored<StoredToken>(this.storage.getItem(this.tokenKey()));
    if (!token || token.expiresAt <= Date.now()) {
      this.storage.removeItem(this.tokenKey());
      return null;
    }
    return token;
  }

  private pendingKey() { return `mdbase-connect:pending:${this.serverUrl}:${this.manifestUrl}`; }
  private tokenKey() { return `mdbase-connect:token:${this.serverUrl}:${this.manifestUrl}`; }
}

export class MdbaseConnectError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomBase64Url(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: bytesToBase64Url(new Uint8Array(digest)) };
}

function randomBase64Url(size: number): string {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function parseStored<T>(value: string | null): T | null {
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

