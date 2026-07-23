#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { HttpSyncTransport } from "./index.js";
import {
  DirectoryMirror,
  WritableDirectoryMirror,
  type MirrorStatus
} from "./node.js";
import {
  loadMirrorProfile,
  saveMirrorProfile,
  updateMirrorCredentials,
  type StoredMirrorProfile
} from "./device.js";

const parsed = parseArgs({
  allowPositionals: true,
  options: {
    server: { type: "string" },
    collection: { type: "string" },
    replica: { type: "string" },
    interval: { type: "string", default: "2000" },
    writable: { type: "boolean", default: false },
    "read-only": { type: "boolean", default: false },
    "no-open": { type: "boolean", default: false },
    name: { type: "string" },
    json: { type: "boolean", default: false },
    use: { type: "string" },
    help: { type: "boolean", short: "h" }
  }
});

if (parsed.values.help || parsed.positionals.length === 0) {
  usage();
  process.exit(parsed.values.help ? 0 : 1);
}

const [command, directoryValue] = parsed.positionals;
if (!directoryValue || !["connect", "init", "sync", "watch", "status", "resolve"].includes(command)) {
  usage();
  process.exit(1);
}

const root = resolve(directoryValue);

try {
  if (command === "connect") {
    await connect(root);
  } else if (command === "init") {
    await mkdir(root, { recursive: true });
    const providerUrlValue = required(parsed.values.server, "--server");
    const collectionId = required(parsed.values.collection, "--collection");
    const replicaId = required(parsed.values.replica, "--replica");
    const token = process.env.MDBASE_CONNECT_REPLICA_TOKEN ?? await hiddenTokenPrompt();
    if (token.length < 32) throw new Error("Replica token is missing or invalid.");
    const mode = parsed.values.writable ? "read_write" : "read_only";
    const providerUrl = canonicalProviderUrl(providerUrlValue);
    const transport = new HttpSyncTransport(providerUrl, collectionId, token);
    const session = await transport.openSession();
    if (session.replica_id !== replicaId || session.mode !== mode) {
      throw new Error(`Replica is not the requested ${mode.replace("_", "-")} mirror capability.`);
    }
    await saveMirrorProfile(
      root,
      {
        version: 1,
        provider_url: providerUrl,
        collection_id: collectionId,
        replica_id: replicaId,
        mode
      },
      { access_token: token }
    );
    await initialSync(root);
    process.stdout.write(`Mirror initialized at ${root}\n`);
  } else if (command === "sync") {
    await initialSync(root);
    const configuration = await currentProfile(root);
    printStatus(await mirrorFor(root, configuration).status());
  } else if (command === "resolve") {
    const recordId = parsed.positionals[2];
    const resolution = parsed.values.use;
    if (!recordId || !["local", "remote"].includes(resolution ?? "")) {
      throw new Error("resolve requires a record ID and --use local or --use remote.");
    }
    const configuration = await currentProfile(root);
    if (configuration.profile.mode !== "read_write") throw new Error("This mirror is receive-only.");
    const mirror = mirrorFor(root, configuration);
    await mirror.resolveConflict(recordId, resolution as "local" | "remote");
    process.stdout.write(`Conflict ${recordId} resolved using ${resolution} content.\n`);
  } else if (command === "status") {
    const configuration = await currentProfile(root);
    const status = await mirrorFor(root, configuration).status();
    if (parsed.values.json) {
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    } else {
      printStatus(status);
    }
  } else {
    const interval = Number(parsed.values.interval);
    if (!Number.isInteger(interval) || interval < 250) {
      throw new Error("--interval must be an integer of at least 250 milliseconds.");
    }
    process.stdout.write(`Watching hosted collection into ${root}. Press Ctrl+C to stop.\n`);
    let lastLine = "";
    while (true) {
      try {
        await sync(root);
        const status = await mirrorFor(root, await currentProfile(root)).status();
        const line = statusLine(status);
        if (line !== lastLine) {
          process.stdout.write(`${line}\n`);
          lastLine = line;
        }
      } catch (error) {
        const line = `Offline: ${error instanceof Error ? error.message : String(error)}`;
        if (line !== lastLine) {
          process.stderr.write(`${line}\n`);
          lastLine = line;
        }
      }
      await delay(interval);
    }
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

async function sync(root: string): Promise<void> {
  const configuration = await currentProfile(root);
  await mirrorFor(root, configuration).sync();
}

async function initialSync(root: string): Promise<void> {
  const configuration = await currentProfile(root);
  const mirror = mirrorFor(root, configuration);
  const preview = await mirror.previewInitialization();
  if (preview.collisions.length) {
    throw new Error(
      `Existing files differ from hosted Markdown: ${preview.collisions.join(", ")}. `
      + "Move or reconcile them, then run mdbase-mirror sync."
    );
  }
  if (!preview.already_initialized) {
    const changes = [
      preview.download_documents
        ? `${preview.download_documents} ${preview.download_documents === 1 ? "download" : "downloads"}`
        : null,
      preview.upload_documents
        ? `${preview.upload_documents} ${preview.upload_documents === 1 ? "upload" : "uploads"}`
        : null,
      preview.unchanged_documents
        ? `${preview.unchanged_documents} already matching`
        : null
    ].filter(Boolean).join(", ");
    process.stdout.write(`Folder check complete: ${changes || "empty collection"}.\n`);
  }
  await mirror.sync();
}

function mirrorFor(root: string, configuration: StoredMirrorProfile) {
  const transport = new HttpSyncTransport(
    configuration.profile.provider_url,
    configuration.profile.collection_id,
    configuration.credentials.access_token
  );
  return configuration.profile.mode === "read_write"
    ? new WritableDirectoryMirror(root, configuration.profile.replica_id, transport)
    : new DirectoryMirror(root, configuration.profile.replica_id, transport);
}

async function currentProfile(root: string): Promise<StoredMirrorProfile> {
  let stored = await loadMirrorProfile(root);
  const expiry = stored.profile.access_token_expires_at;
  if (
    stored.profile.control_url
    && stored.profile.enrollment_id
    && stored.credentials.refresh_token
    && expiry
    && Date.parse(expiry) - Date.now() < 24 * 60 * 60 * 1000
  ) {
    const renewed = await mirrorEnrollmentRequest<MirrorExchangeResponse>(
      stored.profile.control_url,
      stored.profile.enrollment_id,
      "renew",
      stored.credentials.refresh_token
    );
    stored = await updateMirrorCredentials(
      root,
      {
        access_token: renewed.token,
        refresh_token: stored.credentials.refresh_token
      },
      renewed.token_expires_at
    );
  }
  return stored;
}

interface MirrorPairingResponse {
  pairing_id: string;
  pairing_secret: string;
  verification_uri: string;
  expires_in: number;
}

interface MirrorExchangeResponse {
  status: "paired";
  replica: {
    id: string;
    collection_id: string;
    name: string;
    mode: "read_only" | "read_write";
  };
  token: string;
  token_expires_at: string;
  sync_url: string;
}

async function connect(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  const controlUrl = canonicalProviderUrl(required(parsed.values.server, "--server"));
  const mode = parsed.values["read-only"] ? "read_only" : "read_write";
  const name = parsed.values.name?.trim() || `${hostname() || "This computer"} mirror`;
  const created = await jsonRequest<MirrorPairingResponse>(
    `${controlUrl}/v1/mirror-pairing-requests`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mirror_name: name,
        mode,
        ...(parsed.values.collection ? { collection_id: parsed.values.collection } : {})
      })
    }
  );
  process.stdout.write(`Approve this folder in your browser:\n${created.verification_uri}\n`);
  if (!parsed.values["no-open"]) openBrowser(created.verification_uri);
  const deadline = Date.now() + created.expires_in * 1_000;
  while (Date.now() < deadline) {
    const response = await fetch(
      `${controlUrl}/v1/mirror-pairing-requests/${encodeURIComponent(created.pairing_id)}/exchange`,
      { method: "POST", headers: { authorization: `Bearer ${created.pairing_secret}` } }
    );
    if (response.status === 202) {
      await delay(1_500);
      continue;
    }
    const exchanged = await responseJson<MirrorExchangeResponse>(response);
    await saveMirrorProfile(
      root,
      {
        version: 1,
        provider_url: canonicalProviderUrl(exchanged.sync_url),
        control_url: controlUrl,
        collection_id: exchanged.replica.collection_id,
        replica_id: exchanged.replica.id,
        mode: exchanged.replica.mode,
        name: exchanged.replica.name,
        enrollment_id: created.pairing_id,
        access_token_expires_at: exchanged.token_expires_at
      },
      {
        access_token: exchanged.token,
        refresh_token: created.pairing_secret
      }
    );
    await initialSync(root);
    process.stdout.write(`Sync connected at ${root}\n`);
    return;
  }
  throw new Error("Browser approval expired. Run the connect command again.");
}

async function mirrorEnrollmentRequest<Result>(
  controlUrl: string,
  enrollmentId: string,
  action: "renew",
  refreshToken: string
): Promise<Result> {
  return jsonRequest<Result>(
    `${canonicalProviderUrl(controlUrl)}/v1/mirror-pairing-requests/${encodeURIComponent(enrollmentId)}/${action}`,
    { method: "POST", headers: { authorization: `Bearer ${refreshToken}` } }
  );
}

async function jsonRequest<Result>(url: string, init: RequestInit): Promise<Result> {
  return responseJson<Result>(await fetch(url, init));
}

async function responseJson<Result>(response: Response): Promise<Result> {
  const value = await response.json().catch(() => null);
  if (!response.ok) {
    const error = value as { error?: { message?: string } } | null;
    throw new Error(error?.error?.message ?? `Request failed with status ${response.status}.`);
  }
  return value as Result;
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin"
    ? { file: "open", args: [url] }
    : process.platform === "win32"
      ? { file: "cmd", args: ["/c", "start", "", url] }
      : { file: "xdg-open", args: [url] };
  const child = spawn(command.file, command.args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

function printStatus(status: MirrorStatus): void {
  process.stdout.write(`${statusLine(status)}\n`);
  for (const conflict of status.conflicts) {
    process.stdout.write(
      `  ${conflict.path ?? conflict.record_id}: ${conflict.message} (${conflict.record_id})\n`
    );
  }
}

function statusLine(status: MirrorStatus): string {
  const lastSync = status.last_synced_at
    ? ` Last synced ${new Date(status.last_synced_at).toLocaleString()}.`
    : "";
  if (status.state === "not_initialized") return "Not synchronized yet.";
  if (status.state === "attention") {
    return `Action needed for ${status.conflicts.length} ${status.conflicts.length === 1 ? "note" : "notes"}.${lastSync}`;
  }
  if (status.state === "changes_waiting") {
    return `${status.pending} ${status.pending === 1 ? "change" : "changes"} waiting to upload.${lastSync}`;
  }
  return `Up to date.${lastSync}`;
}

async function hiddenTokenPrompt(): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    return new Promise((resolveToken, reject) => {
      let value = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { value += chunk; });
      process.stdin.on("end", () => resolveToken(value.trim()));
      process.stdin.on("error", reject);
    });
  }
  process.stdout.write("Replica token (input hidden): ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise((resolveToken, reject) => {
    let value = "";
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("error", onError);
      process.stdout.write("\n");
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolveToken(value);
          return;
        }
        if (character === "\u007f") value = value.slice(0, -1);
        else value += character;
      }
    };
    process.stdin.on("data", onData);
    process.stdin.on("error", onError);
  });
}

function canonicalProviderUrl(value: string): string {
  const url = new URL(value);
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("Provider URL must be an origin without credentials, path, query, or fragment.");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Provider URL must use HTTPS outside loopback development.");
  }
  return url.origin;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required for mirror initialization.`);
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function usage(): void {
  process.stderr.write(`Usage:
  mdbase-mirror connect <directory> --server <connect-origin> [--collection <uuid>] [--name <device>] [--read-only] [--no-open]
  mdbase-mirror init <directory> --server <origin> --collection <uuid> --replica <uuid> [--writable]
  mdbase-mirror sync <directory>
  mdbase-mirror watch <directory> [--interval <milliseconds>]
  mdbase-mirror status <directory> [--json]
  mdbase-mirror resolve <directory> <record-id> --use <local|remote>

The connect command opens a browser for collection approval and keeps credentials
in device-local storage. The manual init command remains available for self-hosted
automation and reads MDBASE_CONNECT_REPLICA_TOKEN when set.
`);
}
