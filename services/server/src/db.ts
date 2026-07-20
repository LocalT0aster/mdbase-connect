import pg, { type Pool, type QueryResult, type QueryResultRow } from "pg";

export interface DatabasePool {
  query<R extends QueryResultRow = any>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
  end(): Promise<void>;
}

export async function createDatabase(databaseUrl = process.env.DATABASE_URL): Promise<DatabasePool> {
  let pool: DatabasePool;
  if (!databaseUrl || databaseUrl === "memory") {
    const { newDb } = await import("pg-mem");
    const memory = newDb({ autoCreateForeignKeyIndices: true });
    const adapter = memory.adapters.createPg();
    pool = new adapter.Pool() as unknown as DatabasePool;
  } else {
    pool = new pg.Pool({ connectionString: databaseUrl }) as Pool;
  }
  await migrate(pool);
  return pool;
}

export async function migrate(db: DatabasePool): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY,
      email text NOT NULL UNIQUE,
      name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS connectors (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name text NOT NULL,
      token_hash text NOT NULL UNIQUE,
      last_seen_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS collections (
      id uuid PRIMARY KEY,
      connector_id uuid NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
      local_id uuid NOT NULL,
      display_name text NOT NULL,
      spec_version text NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      contracts jsonb NOT NULL DEFAULT '[]'::jsonb,
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(connector_id, local_id)
    );
    CREATE TABLE IF NOT EXISTS applications (
      id uuid PRIMARY KEY,
      canonical_identity text NOT NULL UNIQUE,
      manifest_url text NOT NULL,
      name text NOT NULL,
      homepage text NOT NULL,
      icon text,
      redirect_uris jsonb NOT NULL,
      requirements jsonb NOT NULL DEFAULT '{"contracts":[]}'::jsonb,
      first_seen_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS grants (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      collection_id uuid NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      operations jsonb NOT NULL,
      scope jsonb NOT NULL DEFAULT '{"contracts":[]}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS authorization_requests (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      grant_id uuid REFERENCES grants(id) ON DELETE CASCADE,
      redirect_uri text NOT NULL,
      state text,
      code_challenge text NOT NULL,
      requested_operations jsonb NOT NULL,
      expires_at timestamptz NOT NULL,
      completed_at timestamptz,
      denied_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS pairing_requests (
      id uuid PRIMARY KEY,
      secret_hash text NOT NULL UNIQUE,
      connector_name text NOT NULL,
      user_id uuid REFERENCES users(id) ON DELETE CASCADE,
      approved_at timestamptz,
      consumed_at timestamptz,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS authorization_codes (
      id uuid PRIMARY KEY,
      code_hash text NOT NULL UNIQUE,
      grant_id uuid NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
      application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      redirect_uri text NOT NULL,
      code_challenge text NOT NULL,
      expires_at timestamptz NOT NULL,
      used_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS access_tokens (
      id uuid PRIMARY KEY,
      token_hash text NOT NULL UNIQUE,
      grant_id uuid NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id uuid PRIMARY KEY,
      token_hash text NOT NULL UNIQUE,
      grant_id uuid NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL,
      used_at timestamptz,
      revoked_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id uuid PRIMARY KEY,
      user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      event_type text NOT NULL,
      subject_id text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  const authorizationColumns = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'authorization_requests'`
  );
  if (!authorizationColumns.rows.some((column) => column.column_name === "denied_at")) {
    await db.query("ALTER TABLE authorization_requests ADD COLUMN denied_at timestamptz");
  }
  if (!authorizationColumns.rows.some((column) => column.column_name === "grant_id")) {
    await db.query("ALTER TABLE authorization_requests ADD COLUMN grant_id uuid REFERENCES grants(id) ON DELETE CASCADE");
  }
  await ensureColumn(
    db,
    "collections",
    "contracts",
    "ALTER TABLE collections ADD COLUMN contracts jsonb NOT NULL DEFAULT '[]'::jsonb"
  );
  await ensureColumn(
    db,
    "applications",
    "requirements",
    "ALTER TABLE applications ADD COLUMN requirements jsonb NOT NULL DEFAULT '{\"contracts\":[]}'::jsonb"
  );
  await ensureColumn(
    db,
    "grants",
    "scope",
    "ALTER TABLE grants ADD COLUMN scope jsonb NOT NULL DEFAULT '{\"contracts\":[]}'::jsonb"
  );
}

async function ensureColumn(
  db: DatabasePool,
  table: string,
  column: string,
  statement: string
): Promise<void> {
  const result = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column]
  );
  if (!result.rows[0]) await db.query(statement);
}
