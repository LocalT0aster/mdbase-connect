export const CONTROL_PROTOCOL_VERSION = 1 as const;

export type CollectionOperation =
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
  protocol_version: 1;
  request_id: string;
  grant_id: string;
  collection_id: string;
  application_id: string;
  operation: CollectionOperation;
  input: unknown;
}

export interface RelayOperationResponse {
  type: "operation_response";
  protocol_version: 1;
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
  protocol_version: 1;
  grants: GrantPolicy[];
}

export interface ConnectorCollection {
  id: string;
  display_name: string;
  spec_version: string;
  enabled: boolean;
}
