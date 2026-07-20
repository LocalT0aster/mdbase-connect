# MDBASE Connect

MDBASE Connect lets user-authorized websites and native applications operate
on a user's local [mdbase](https://mdbase.dev) collections without exposing
collection folders directly to the internet.

This is a functional development MVP. The tested path covers creating a local
collection, pairing an outbound-only connector, discovering an independent web
app, approving exact operations locally or from the authenticated account portal, reading and writing records through
the relay, discovering schemas and TaskNotes contract metadata, receiving
filesystem changes, rejecting stale revisions, pausing access, and immediately
enforcing revocation.

## What is here

- `crates/connect-agent`: Rust background connector, local policy enforcement,
  filesystem watching, and outbound WebSocket relay.
- `crates/connect-cli`: local administration and operation CLI.
- `apps/desktop`: Electron controller for collection registration, application
  access, browser pairing, local activity, tray operation, and launch-at-login.
- `services/server`: Fastify control plane and transient relay backed by
  PostgreSQL.
- `apps/portal`: deliberately small account, computer-recovery, secure pairing,
  and remote approval surface. Routine collection configuration stays in the
  local controller, and there is no developer portal.
- `packages/client`: browser SDK using authorization code + PKCE.
- `packages/protocol`: shared versioned web/relay contracts.
- `packages/tasknotes`: portable TaskNotes contract adapter using configurable
  field roles and generic revision-safe operations.
- `apps/tasknotes`: deliberately small reference frontend for the TaskNotes
  contract.

Collection behavior comes from the active `mdbase-rs` implementation; this
repository does not reimplement the mdbase specification. During v0.3
development the Rust workspace uses the adjacent `../mdbase-rs` checkout.

## Verify the MVP

Prerequisites are a Rust toolchain, Node 22+, and pnpm 10.

```bash
pnpm install
cargo test --workspace
pnpm typecheck
pnpm test
pnpm e2e
```

`pnpm e2e` launches an ephemeral control plane, a real connector agent, a test
web application, and a real mdbase collection. It completes OAuth/PKCE,
approves access through the local control API, discovers a real JSON Schema and
TaskNotes contract, relays create/read/update operations, verifies change
delivery and revision conflicts, exercises the local pause switch, revokes the
grant, and confirms that subsequent requests are rejected and recorded.

To run the desktop controller locally:

```bash
pnpm --filter @mdbase/connect-desktop start
```

## Self-host the development stack

```bash
cp .env.example .env
docker compose up --build
```

Open the desktop app, enter `http://localhost:8787` when prompted, and choose
**Pair this computer**. Sign in and approve the pairing in the browser; no
connector token is shown or copied. See
[`docs/self-hosting.md`](docs/self-hosting.md) for important limitations.

## Security status

The local connector is the final authorization boundary: the server cannot
expand a cached grant, collection paths never leave the machine, connector
tokens are stored encrypted by Electron where the OS supports it, and cloud
tokens are hashed at rest. The service does relay operation payloads in memory,
so it is not yet end-to-end encrypted from app to connector.

Before a public deployment this still needs production identity, TLS and secret
management, rate limiting, code signing and automatic updates, backup/restore,
abuse controls, and a resolved payload-encryption threat model. Development
email login must never be exposed publicly.

See [`docs/architecture.md`](docs/architecture.md) and
[`docs/mvp.md`](docs/mvp.md) for the trust model and acceptance path.
