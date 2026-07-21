# @mdbase/connect-sync

Provider-neutral replication protocol and executable reference state machine for
hosted mdbase collections. It models stable record identity, pinned snapshots,
scoped ordered changes, conditional idempotent mutations, conflicts, cursor
reset, revocation, offline queues, and receive-only Markdown mirrors.

The reference authority is intended for contract tests and local development.
The Connect server persists it as a versioned PostgreSQL state document with
optimistic compare-and-swap and exposes the protocol over authenticated HTTP.
That is enough for the tested TaskNotes vertical slice. The production hosted
provider will implement the same `SyncTransport` boundary with normalized
transactional storage and `mdbase-rs` operation execution.
