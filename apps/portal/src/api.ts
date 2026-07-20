export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(response.status, body?.error?.message ?? `Request failed with HTTP ${response.status}.`);
  }
  return body as T;
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export interface DashboardData {
  user: { id: string; name: string; email: string };
  authentication: { provider: "tailscale" | "session" };
  connectors: Array<{ id: string; name: string; last_seen_at: string | null; created_at: string }>;
  collections: Array<{
    id: string;
    connector_id: string;
    local_id: string;
    connector_name: string;
    display_name: string;
    spec_version: string;
    enabled: boolean;
    last_seen_at: string;
  }>;
  grants: Array<{
    id: string;
    operations: string[];
    created_at: string;
    revoked_at: string | null;
    collection_id: string;
    collection_name: string;
    application_id: string;
    application_name: string;
    homepage: string;
    icon: string | null;
  }>;
  pending_authorizations: PendingAuthorization[];
}

export interface PendingAuthorization {
  id: string;
  requested_operations: string[];
  expires_at: string;
  application_id: string;
  application_name: string;
  homepage: string;
  icon: string | null;
}

export interface AvailableCollection {
  id: string;
  connector_name: string;
  display_name: string;
  spec_version: string;
}
