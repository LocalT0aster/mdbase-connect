import { randomUUID } from "node:crypto";
import type { DatabasePool } from "./db.js";
import type { WebSocket } from "ws";

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class RelayHub {
  private readonly connectors = new Map<string, WebSocket>();
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly db: DatabasePool) {}

  async attach(connectorId: string, socket: WebSocket): Promise<void> {
    this.connectors.get(connectorId)?.close(4001, "Replaced by a newer connector session");
    this.connectors.set(connectorId, socket);
    await this.db.query("UPDATE connectors SET last_seen_at = now() WHERE id = $1", [connectorId]);
    await this.pushPolicy(connectorId);

    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as {
          type?: string;
          request_id?: string;
          ok?: boolean;
          result?: unknown;
          error?: { code?: string; message?: string };
        };
        if (message.type !== "operation_response" || !message.request_id) return;
        const pending = this.pending.get(message.request_id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.request_id);
        if (message.ok) pending.resolve(message.result);
        else pending.reject(new ConnectorOperationError(
          message.error?.code ?? "connector_operation_failed",
          message.error?.message ?? "Connector operation failed."
        ));
      } catch {
        socket.close(4002, "Invalid relay message");
      }
    });
    socket.once("close", () => {
      if (this.connectors.get(connectorId) === socket) this.connectors.delete(connectorId);
    });
  }

  isConnected(connectorId: string): boolean {
    return this.connectors.get(connectorId)?.readyState === 1;
  }

  async pushPolicy(connectorId: string): Promise<void> {
    const socket = this.connectors.get(connectorId);
    if (!socket || socket.readyState !== 1) return;
    const grants = await this.db.query<{
      id: string;
      application_id: string;
      application_name: string;
      application_homepage: string;
      application_icon: string | null;
      local_id: string;
      collection_name: string;
      operations: string[];
      scope: { contracts: Array<{ id: string; version: number }> };
      created_at: string;
    }>(
      `SELECT g.id, g.application_id, a.name AS application_name,
              a.homepage AS application_homepage, a.icon AS application_icon,
              c.local_id, c.display_name AS collection_name, g.operations, g.scope, g.created_at
       FROM grants g
       JOIN collections c ON c.id = g.collection_id
       JOIN applications a ON a.id = g.application_id
       WHERE c.connector_id = $1 AND g.revoked_at IS NULL`,
      [connectorId]
    );
    socket.send(JSON.stringify({
      type: "policy_snapshot",
      protocol_version: 2,
      grants: grants.rows.map((grant) => ({
        id: grant.id,
        application_id: grant.application_id,
        collection_id: grant.local_id,
        operations: grant.operations,
        scope: grant.scope,
        application_name: grant.application_name,
        application_homepage: grant.application_homepage,
        application_icon: grant.application_icon,
        collection_name: grant.collection_name,
        created_at: grant.created_at
      }))
    }));
  }

  route(input: {
    connectorId: string;
    localCollectionId: string;
    grantId: string;
    applicationId: string;
    operation: string;
    operationInput: unknown;
  }): Promise<unknown> {
    const socket = this.connectors.get(input.connectorId);
    if (!socket || socket.readyState !== 1) {
      return Promise.reject(new RelayUnavailableError());
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Connector operation timed out."));
      }, 30_000);
      this.pending.set(requestId, { resolve, reject, timer });
      socket.send(JSON.stringify({
        type: "operation_request",
        protocol_version: 2,
        request_id: requestId,
        grant_id: input.grantId,
        collection_id: input.localCollectionId,
        application_id: input.applicationId,
        operation: input.operation,
        input: input.operationInput
      }));
    });
  }
}

export class RelayUnavailableError extends Error {
  constructor() {
    super("The computer hosting this collection is offline.");
  }
}

export class ConnectorOperationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}
