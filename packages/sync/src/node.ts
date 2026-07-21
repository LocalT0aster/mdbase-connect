import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { stringify } from "yaml";
import type { JsonObject, SyncRecord } from "@mdbase/connect-protocol";
import type { SyncTransport } from "./index.js";
import { SyncError } from "./index.js";

interface MirrorEntry {
  path: string;
  revision: string;
  hash: string;
}

interface MirrorState {
  protocol_version: 1;
  replica_id: string;
  scope_epoch: number;
  cursor: number;
  records: Record<string, MirrorEntry>;
}

/** Receive-only materialization of a sync replica into ordinary Markdown files. */
export class DirectoryMirror<Frontmatter extends JsonObject = JsonObject> {
  private readonly root: string;
  private readonly statePath: string;

  constructor(
    root: string,
    private readonly replicaId: string,
    private readonly transport: SyncTransport<Frontmatter>
  ) {
    this.root = resolve(root);
    this.statePath = join(this.root, ".mdbase", "connect-sync.json");
  }

  async sync(): Promise<void> {
    const state = await this.readState();
    if (!state) {
      await this.rebuild();
      return;
    }
    await this.assertUndiverged(state);
    while (true) {
      const page = await this.transport.changes(state.cursor, 200);
      if (page.scope_epoch !== state.scope_epoch || page.reset_required) {
        await this.rebuild(state);
        return;
      }
      for (const event of page.events) {
        if (event.type === "put") await this.put(state, event.record);
        else await this.remove(state, event.record_id, event.previous_path);
      }
      state.cursor = page.cursor;
      await this.writeState(state);
      if (!page.has_more) return;
    }
  }

  private async rebuild(prior?: MirrorState): Promise<void> {
    const session = await this.transport.openSession();
    if (session.replica_id !== this.replicaId || session.mode !== "read_only") {
      throw new SyncError("invalid_mirror_session", "Filesystem mirrors require their own read-only replica.");
    }
    const state: MirrorState = {
      protocol_version: 1,
      replica_id: this.replicaId,
      scope_epoch: session.scope_epoch,
      cursor: session.head,
      records: {}
    };
    let page: string | undefined;
    do {
      const snapshot = await this.transport.snapshot(session.snapshot_id, page);
      for (const record of snapshot.records) await this.put(state, record, prior);
      page = snapshot.next_page;
    } while (page);
    if (prior) {
      for (const [recordId, entry] of Object.entries(prior.records)) {
        if (!state.records[recordId]) await this.remove(prior, recordId, entry.path);
      }
    }
    await this.writeState(state);
  }

  private async put(
    state: MirrorState,
    record: SyncRecord<Frontmatter>,
    managedState: MirrorState | undefined = state
  ): Promise<void> {
    const path = this.safePath(record.path);
    const document = markdown(record);
    const existing = await readOptional(path);
    const prior = managedState?.records[record.record_id];
    if (existing !== null && existing !== document) {
      if (!prior || prior.path !== record.path || digest(existing) !== prior.hash) {
        throw new MirrorDivergenceError(record.record_id, record.path);
      }
    }
    if (prior && prior.path !== record.path) {
      await this.remove(managedState!, record.record_id, prior.path);
    }
    await mkdir(dirname(path), { recursive: true });
    await atomicWrite(path, document);
    state.records[record.record_id] = {
      path: record.path,
      revision: record.revision,
      hash: digest(document)
    };
  }

  private async remove(state: MirrorState, recordId: string, pathValue: string): Promise<void> {
    const entry = state.records[recordId];
    const path = this.safePath(entry?.path ?? pathValue);
    const existing = await readOptional(path);
    if (existing !== null && entry && digest(existing) !== entry.hash) {
      throw new MirrorDivergenceError(recordId, entry.path);
    }
    if (existing !== null) await unlink(path);
    delete state.records[recordId];
  }

  private safePath(relative: string): string {
    if (relative.startsWith("/") || relative.includes("\\") || relative.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new SyncError("invalid_path", "Mirror received an unsafe record path.");
    }
    const path = resolve(this.root, relative);
    if (path !== this.root && !path.startsWith(`${this.root}${sep}`)) {
      throw new SyncError("path_traversal", "Mirror path escaped its collection root.");
    }
    return path;
  }

  private async readState(): Promise<MirrorState | null> {
    const value = await readOptional(this.statePath);
    if (value === null) return null;
    try {
      const state = JSON.parse(value) as MirrorState;
      if (state.protocol_version !== 1 || state.replica_id !== this.replicaId) throw new Error();
      return state;
    } catch {
      throw new SyncError("invalid_mirror_state", "Mirror metadata is corrupt or belongs to another replica.");
    }
  }

  private async writeState(state: MirrorState): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    await atomicWrite(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  private async assertUndiverged(state: MirrorState): Promise<void> {
    for (const [recordId, entry] of Object.entries(state.records)) {
      const value = await readOptional(this.safePath(entry.path));
      if (value === null || digest(value) !== entry.hash) {
        throw new MirrorDivergenceError(recordId, entry.path);
      }
    }
  }
}

export class MirrorDivergenceError extends SyncError {
  constructor(public readonly recordId: string, public readonly path: string) {
    super("mirror_diverged", `Local edits at ${path} must be resolved before the mirror can continue.`);
  }
}

function markdown(record: SyncRecord): string {
  const yaml = stringify(record.frontmatter, { lineWidth: 0 }).trimEnd();
  const body = record.body ? `\n${record.body.replace(/^\n/, "")}` : "";
  return `---\n${yaml}\n---\n${body}`;
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(path: string, value: string): Promise<void> {
  const temporary = `${path}.mdbase-${randomUUID()}.tmp`;
  await writeFile(temporary, value, { mode: 0o600 });
  await rename(temporary, path);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
