import type {
  CollectionChange,
  CollectionChangesPage,
  CollectionDescription,
  CollectionOperation,
  JsonObject,
  MdbaseOperationEnvelope,
  RecordResult
} from "@mdbase/connect-protocol";

export type {
  CollectionChange,
  CollectionChangesPage,
  CollectionContractDescriptor,
  CollectionDescription,
  CollectionOperation as MdbaseOperation,
  CollectionTypeDescriptor,
  JsonObject,
  MdbaseDiagnostic,
  MdbaseOperationEnvelope,
  RecordResult
} from "@mdbase/connect-protocol";

export interface MdbaseConnectOptions {
  serverUrl: string;
  manifestUrl?: string;
  redirectUri?: string;
  storage?: Storage;
}

export interface ReadInput {
  path: string;
}

export interface QueryInput {
  types?: string[];
  where?: unknown;
  order_by?: unknown;
  limit?: number;
  offset?: number;
  include_body?: boolean;
  [key: string]: unknown;
}

export interface QueryResult<Record extends JsonObject = JsonObject> {
  results: Array<RecordResult<Record> & JsonObject>;
  meta?: {
    total_count: number;
    has_more: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface CreateInput<Frontmatter extends JsonObject = JsonObject> {
  path?: string;
  type?: string;
  frontmatter: Partial<Frontmatter> & JsonObject;
  body?: string;
  if_revision?: string;
}

export interface UpdateInput<Frontmatter extends JsonObject = JsonObject> {
  path: string;
  fields: Partial<Frontmatter> & JsonObject;
  body?: string;
  if_revision?: string;
}

export interface DeleteInput {
  path: string;
  check_backlinks?: boolean;
  if_revision?: string;
}

export interface DeleteResult {
  path: string;
  deleted: boolean;
  broken_links?: Array<{ path: string }>;
}

export interface RenameInput {
  from: string;
  to: string;
  update_refs?: boolean;
  if_revision?: string;
}

export interface RenameResult extends RecordResult {
  from: string;
  to: string;
  references_updated?: JsonObject[];
}

export interface ChangesInput {
  after?: number;
  limit?: number;
}

export interface WatchOptions {
  cursor?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
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
  operations: CollectionOperation[];
  expiresAt: number;
}

const DEFAULT_OPERATIONS: CollectionOperation[] = ["describe", "changes", "read", "query"];

export class MdbaseConnect<Frontmatter extends JsonObject = JsonObject> {
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
    if (!response.ok) throw apiError(body, "discovery_failed", "Application discovery failed.");
    this.application = body.application;
    return this.application!;
  }

  async authorize(operations: CollectionOperation[] = DEFAULT_OPERATIONS): Promise<never> {
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
    operations: CollectionOperation[];
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
    if (!response.ok) throw apiError(body, "token_exchange_failed", "Authorization could not be completed.");
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

  connection(): { collectionId: string; operations: CollectionOperation[] } | null {
    const token = this.currentToken();
    return token ? { collectionId: token.collectionId, operations: token.operations } : null;
  }

  disconnect(): void {
    this.storage.removeItem(this.tokenKey());
    this.storage.removeItem(this.pendingKey());
  }

  describe(): Promise<CollectionDescription> {
    return this.operation("describe", {});
  }

  changes(input: ChangesInput = {}): Promise<CollectionChangesPage> {
    return this.operation("changes", input);
  }

  read(input: ReadInput): Promise<MdbaseOperationEnvelope<RecordResult<Frontmatter>>> {
    return this.operation("read", input);
  }

  query(input: QueryInput = {}): Promise<MdbaseOperationEnvelope<QueryResult<Frontmatter>>> {
    return this.operation("query", input);
  }

  create(input: CreateInput<Frontmatter>): Promise<MdbaseOperationEnvelope<RecordResult<Frontmatter>>> {
    return this.operation("create", input);
  }

  update(input: UpdateInput<Frontmatter>): Promise<MdbaseOperationEnvelope<RecordResult<Frontmatter>>> {
    return this.operation("update", input);
  }

  delete(input: DeleteInput): Promise<MdbaseOperationEnvelope<DeleteResult>> {
    return this.operation("delete", input);
  }

  rename(input: RenameInput): Promise<MdbaseOperationEnvelope<RenameResult>> {
    return this.operation("rename", input);
  }

  validate(input: JsonObject = {}): Promise<MdbaseOperationEnvelope> {
    return this.operation("validate", input);
  }

  async *watch(options: WatchOptions = {}): AsyncGenerator<CollectionChange> {
    let cursor = options.cursor;
    if (cursor === undefined) cursor = (await this.changes()).cursor;
    const pollInterval = Math.max(100, options.pollIntervalMs ?? 1_000);
    while (!options.signal?.aborted) {
      const page = await this.changes({ after: cursor, limit: 200 });
      if (page.reset) {
        throw new MdbaseConnectError(
          "change_cursor_reset",
          "The collection change cursor expired. Refresh collection state before subscribing again."
        );
      }
      for (const event of page.events) yield event;
      cursor = page.cursor;
      if (!page.has_more) await abortableDelay(pollInterval, options.signal);
    }
  }

  async operation<Result>(operation: CollectionOperation, input: unknown): Promise<Result> {
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
    if (!response.ok) throw apiError(body, "operation_failed", "Collection operation failed.");
    return body.result as Result;
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

function apiError(body: any, fallbackCode: string, fallbackMessage: string): MdbaseConnectError {
  return new MdbaseConnectError(
    body?.error?.code ?? fallbackCode,
    body?.error?.message ?? fallbackMessage
  );
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

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, milliseconds);
    signal?.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}
