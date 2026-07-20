import { describe, expect, it, vi } from "vitest";
import { resolveTasknotesContract, TasknotesCollection } from "./index.js";

const description = {
  protocol_version: 2 as const,
  collection_id: "collection",
  display_name: "Tasks",
  spec_version: "0.3.0",
  operations: ["describe", "read", "query", "create", "update"] as any,
  change_cursor: 0,
  types: [{
    name: "task",
    schema: { type: "object" },
    collection: { path: { folder: "inbox" } },
    extensions: {}
  }],
  contracts: [{
    id: "tasknotes.task",
    version: 1,
    type_name: "task",
    extension: "x-tasknotes",
    configuration: {
      contract: "tasknotes.task",
      version: 1,
      field_roles: { title: "name", status: "state" },
      status: { completed_values: ["closed"], default: "open" }
    }
  }]
};

describe("TaskNotes contract adapter", () => {
  it("uses declared field roles for create and completion", async () => {
    expect(resolveTasknotesContract(description).pathFolder).toBe("inbox");
    const connect = {
      describe: vi.fn().mockResolvedValue(description),
      query: vi.fn().mockResolvedValue({ valid: true, diagnostics: [], result: { results: [] } }),
      create: vi.fn().mockResolvedValue({
        valid: true,
        diagnostics: [],
        result: { path: "inbox/write-docs.md", frontmatter: {}, types: ["task"], revision: "one" }
      }),
      read: vi.fn().mockResolvedValue({
        valid: true,
        diagnostics: [],
        result: { path: "inbox/write-docs.md", frontmatter: { name: "Write docs", state: "open" }, types: ["task"], revision: "one" }
      }),
      update: vi.fn().mockResolvedValue({
        valid: true,
        diagnostics: [],
        result: { path: "inbox/write-docs.md", frontmatter: { state: "closed" }, types: ["task"], revision: "two" }
      })
    } as any;
    const tasks = new TasknotesCollection(connect);

    await tasks.create({ title: "Write docs" });
    expect(connect.create).toHaveBeenCalledWith(expect.objectContaining({
      path: "inbox/write-docs.md",
      frontmatter: { name: "Write docs", state: "open" }
    }));

    await tasks.setCompleted("inbox/write-docs.md", true);
    expect(connect.update).toHaveBeenCalledWith({
      path: "inbox/write-docs.md",
      fields: { state: "closed" },
      if_revision: "one"
    });
  });
});
