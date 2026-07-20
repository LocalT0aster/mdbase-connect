import type {
  CollectionContractDescriptor,
  CollectionDescription,
  JsonObject,
  RecordResult
} from "@mdbase/connect-protocol";
import type { MdbaseConnect, QueryResult } from "@mdbase/connect";

export const TASKNOTES_TASK_CONTRACT = "tasknotes.task";

export interface TaskFrontmatter extends JsonObject {
  title?: string;
  status?: string;
}

export interface TasknotesContractConfiguration extends JsonObject {
  contract: typeof TASKNOTES_TASK_CONTRACT;
  version: number;
  field_roles: Record<string, string>;
  status: {
    completed_values: string[];
    default?: string;
  };
  priority?: { default?: string };
  archive?: { tags_field?: string; archived_tag?: string };
}

export interface TasknotesContract {
  descriptor: CollectionContractDescriptor;
  configuration: TasknotesContractConfiguration;
  typeName: string;
  pathFolder?: string;
  pathPattern?: string;
}

export interface TaskSummary {
  path: string;
  title: string;
  status?: string;
  completed: boolean;
  frontmatter: TaskFrontmatter;
}

export interface CreateTaskInput {
  title: string;
  path?: string;
  fields?: JsonObject;
  body?: string;
}

export function resolveTasknotesContract(description: CollectionDescription): TasknotesContract {
  const descriptor = description.contracts.find((contract) => contract.id === TASKNOTES_TASK_CONTRACT);
  if (!descriptor) throw new TasknotesContractError("TaskNotes task contract is not available in this collection.");
  const configuration = parseConfiguration(descriptor.configuration);
  const type = description.types.find((candidate) => candidate.name === descriptor.type_name);
  const path = asObject(type?.collection?.path);
  return {
    descriptor,
    configuration,
    typeName: descriptor.type_name,
    pathFolder: stringValue(path?.folder),
    pathPattern: stringValue(path?.pattern)
  };
}

export class TasknotesCollection {
  private contract: TasknotesContract | null = null;

  constructor(private readonly connect: MdbaseConnect<TaskFrontmatter>) {}

  async describe(): Promise<TasknotesContract> {
    this.contract ??= resolveTasknotesContract(await this.connect.describe());
    return this.contract;
  }

  async list(): Promise<TaskSummary[]> {
    const contract = await this.describe();
    const response = await this.connect.query({ types: [contract.typeName] });
    assertValid(response);
    const query = response.result as QueryResult<TaskFrontmatter>;
    return query.results.map((record) => normalizeTask(record.path, record.frontmatter, contract));
  }

  async create(input: CreateTaskInput): Promise<RecordResult<TaskFrontmatter>> {
    const contract = await this.describe();
    const fields: JsonObject = { ...(input.fields ?? {}) };
    setField(fields, roleField(contract, "title", "title"), input.title.trim());
    const defaultStatus = contract.configuration.status.default;
    if (defaultStatus && getField(fields, roleField(contract, "status", "status")) === undefined) {
      setField(fields, roleField(contract, "status", "status"), defaultStatus);
    }
    const response = await this.connect.create({
      type: contract.typeName,
      path: input.path ?? defaultTaskPath(input.title, contract),
      frontmatter: fields,
      body: input.body
    });
    assertValid(response);
    return response.result;
  }

  async setCompleted(path: string, completed: boolean): Promise<RecordResult<TaskFrontmatter>> {
    const contract = await this.describe();
    const read = await this.connect.read({ path });
    assertValid(read);
    const status = completed
      ? contract.configuration.status.completed_values[0]
      : incompleteStatus(contract);
    if (!status) {
      throw new TasknotesContractError("The TaskNotes contract does not define a status for this change.");
    }
    const fields: JsonObject = {};
    setField(fields, roleField(contract, "status", "status"), status);
    const updated = await this.connect.update({
      path,
      fields,
      if_revision: read.result.revision
    });
    assertValid(updated);
    return updated.result;
  }
}

export class TasknotesContractError extends Error {}

function parseConfiguration(value: JsonObject): TasknotesContractConfiguration {
  const roles = asObject(value.field_roles);
  const status = asObject(value.status);
  const completedValues = status?.completed_values;
  if (value.contract !== TASKNOTES_TASK_CONTRACT
      || typeof value.version !== "number"
      || !roles
      || !status
      || !Array.isArray(completedValues)
      || !completedValues.every((item) => typeof item === "string")) {
    throw new TasknotesContractError("The TaskNotes task contract is malformed.");
  }
  return value as TasknotesContractConfiguration;
}

function normalizeTask(path: string, frontmatter: TaskFrontmatter, contract: TasknotesContract): TaskSummary {
  const title = getField(frontmatter, roleField(contract, "title", "title"));
  const status = getField(frontmatter, roleField(contract, "status", "status"));
  return {
    path,
    title: typeof title === "string" && title.length > 0 ? title : path,
    status: typeof status === "string" ? status : undefined,
    completed: typeof status === "string" && contract.configuration.status.completed_values.includes(status),
    frontmatter
  };
}

function roleField(contract: TasknotesContract, role: string, fallback: string): string {
  return contract.configuration.field_roles[role] ?? fallback;
}

function incompleteStatus(contract: TasknotesContract): string | undefined {
  const candidate = contract.configuration.status.default;
  if (candidate && !contract.configuration.status.completed_values.includes(candidate)) return candidate;
  return undefined;
}

function defaultTaskPath(title: string, contract: TasknotesContract): string | undefined {
  if (contract.pathPattern) return undefined;
  const filename = slug(title) || "task";
  const folder = contract.pathFolder?.replace(/^\/+|\/+$/g, "") ?? "tasks";
  return `${folder}/${filename}.md`;
}

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function getField(value: JsonObject, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (!asObject(current)) return undefined;
    current = asObject(current)?.[segment];
  }
  return current;
}

function setField(value: JsonObject, path: string, fieldValue: unknown): void {
  const segments = path.split(".");
  let current = value;
  for (const segment of segments.slice(0, -1)) {
    const child = asObject(current[segment]) ?? {};
    current[segment] = child;
    current = child;
  }
  current[segments.at(-1)!] = fieldValue;
}

function assertValid(value: { valid: boolean; diagnostics: Array<{ message: string }> }): void {
  if (value.valid) return;
  throw new TasknotesContractError(value.diagnostics[0]?.message ?? "Task operation failed.");
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
