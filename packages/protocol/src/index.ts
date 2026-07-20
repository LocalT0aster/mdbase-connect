export const CONTROL_PROTOCOL_VERSION = 2 as const;

export type CollectionOperation =
  | "describe"
  | "changes"
  | "read"
  | "query"
  | "validate"
  | "create"
  | "update"
  | "delete"
  | "rename";

export interface MdbaseAppManifest {
  manifest_version: 1;
  name: string;
  homepage: string;
  icon?: string;
  redirect_uris: string[];
}

export interface RelayOperationRequest {
  type: "operation_request";
  protocol_version: 2;
  request_id: string;
  grant_id: string;
  collection_id: string;
  application_id: string;
  operation: CollectionOperation;
  input: unknown;
}

export interface RelayOperationResponse {
  type: "operation_response";
  protocol_version: 2;
  request_id: string;
  ok: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

export interface GrantPolicy {
  id: string;
  application_id: string;
  collection_id: string;
  operations: CollectionOperation[];
  application_name: string;
  application_homepage: string;
  application_icon?: string;
  collection_name: string;
  created_at: string;
}

export interface RelayPolicySnapshot {
  type: "policy_snapshot";
  protocol_version: 2;
  grants: GrantPolicy[];
}

export interface ConnectorCollection {
  id: string;
  display_name: string;
  spec_version: string;
  enabled: boolean;
}

export type JsonObject = Record<string, unknown>;

export interface MdbaseDiagnostic {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  path?: string;
  field?: string;
  type?: string;
  schema_location?: string;
  details?: unknown;
}

export interface MdbaseOperationEnvelope<Result = JsonObject> {
  valid: boolean;
  result: Result;
  diagnostics: MdbaseDiagnostic[];
}

export interface RecordResult<Frontmatter extends JsonObject = JsonObject> {
  path: string;
  frontmatter: Frontmatter;
  raw_frontmatter?: Frontmatter;
  body?: string;
  types: string[];
  revision: string;
}

export interface CollectionTypeDescriptor {
  name: string;
  version?: number;
  description?: string;
  schema: JsonObject;
  collection?: JsonObject;
  lifecycle?: JsonObject;
  extensions: Record<string, unknown>;
}

export interface CollectionContractDescriptor {
  id: string;
  version: number;
  type_name: string;
  extension: string;
  configuration: JsonObject;
}

export interface CollectionDescription {
  protocol_version: 2;
  collection_id: string;
  display_name: string;
  spec_version: string;
  operations: CollectionOperation[];
  change_cursor: number;
  types: CollectionTypeDescriptor[];
  contracts: CollectionContractDescriptor[];
}

export interface CollectionChange {
  cursor: number;
  type: string;
  occurred_at: string;
  payload: JsonObject;
}

export interface CollectionChangesPage {
  events: CollectionChange[];
  cursor: number;
  has_more: boolean;
  reset: boolean;
}
