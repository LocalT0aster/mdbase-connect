import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryHostedAuthority } from "./index.js";
import { DirectoryMirror, MirrorDivergenceError } from "./node.js";

describe("receive-only Markdown mirror", () => {
  it("materializes stable records, renames them, and pauses on local divergence", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-sync-mirror-"));
    try {
      const hosted = new MemoryHostedAuthority();
      const writer = hosted.registerReplica({ name: "Writer", mode: "read_write", allowedTypes: ["task"] });
      const mirrorId = hosted.registerReplica({ name: "Laptop mirror", mode: "read_only" });
      const recordId = crypto.randomUUID();
      const created = await hosted.transport(writer).mutate({
        mutation_id: crypto.randomUUID(), replica_id: writer, scope_epoch: 1,
        operation: "create", record_id: recordId,
        input: { path: "tasks/one.md", frontmatter: { type: "task", title: "One" }, body: "Hello", types: ["task"] },
        created_at: new Date().toISOString()
      });
      if (created.status !== "applied" || !created.record) throw new Error("create failed");
      const mirror = new DirectoryMirror(root, mirrorId, hosted.transport(mirrorId));
      await mirror.sync();
      expect(await readFile(join(root, "tasks/one.md"), "utf8")).toContain("title: One");
      await hosted.transport(writer).mutate({
        mutation_id: crypto.randomUUID(), replica_id: writer, scope_epoch: 1,
        operation: "rename", record_id: recordId, base_revision: created.record.revision,
        input: { path: "tasks/renamed.md" }, created_at: new Date().toISOString()
      });
      await mirror.sync();
      await expect(readFile(join(root, "tasks/one.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(join(root, "tasks/renamed.md"), "local edit\n");
      const latest = (await hosted.transport(mirrorId).snapshot((await hosted.transport(mirrorId).openSession()).snapshot_id)).records[0];
      await hosted.transport(writer).mutate({
        mutation_id: crypto.randomUUID(), replica_id: writer, scope_epoch: 1,
        operation: "update", record_id: recordId, base_revision: latest.revision,
        input: { patch: { title: "Remote edit" } }, created_at: new Date().toISOString()
      });
      await expect(mirror.sync()).rejects.toBeInstanceOf(MirrorDivergenceError);
      expect(await readFile(join(root, "tasks/renamed.md"), "utf8")).toBe("local edit\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects a locally deleted managed file even when the authority is unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-sync-mirror-"));
    try {
      const hosted = new MemoryHostedAuthority();
      const writer = hosted.registerReplica({ name: "Writer", mode: "read_write", allowedTypes: ["task"] });
      const mirrorId = hosted.registerReplica({ name: "Laptop mirror", mode: "read_only" });
      await hosted.transport(writer).mutate({
        mutation_id: crypto.randomUUID(), replica_id: writer, scope_epoch: 1,
        operation: "create", record_id: crypto.randomUUID(),
        input: { path: "tasks/one.md", frontmatter: { type: "task", title: "One" }, types: ["task"] },
        created_at: new Date().toISOString()
      });
      const mirror = new DirectoryMirror(root, mirrorId, hosted.transport(mirrorId));
      await mirror.sync();
      await unlink(join(root, "tasks/one.md"));
      await expect(mirror.sync()).rejects.toBeInstanceOf(MirrorDivergenceError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects corrupt or cross-replica mirror metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "mdbase-sync-mirror-"));
    try {
      const hosted = new MemoryHostedAuthority();
      const mirrorId = hosted.registerReplica({ name: "Laptop mirror", mode: "read_only" });
      const mirror = new DirectoryMirror(root, mirrorId, hosted.transport(mirrorId));
      await mirror.sync();
      await writeFile(join(root, ".mdbase/connect-sync.json"), JSON.stringify({ protocol_version: 1, replica_id: "another" }));
      await expect(mirror.sync()).rejects.toMatchObject({ code: "invalid_mirror_state" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
