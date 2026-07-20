# Architecture

## Platform boundary

MDBASE defines the portable collection format and record operations. Connect
provides authorization, routing, discovery, and change delivery for
applications. Domain packages such as `@mdbase/tasknotes` interpret optional
type extensions without adding TaskNotes behavior to the MDBASE specification
or the relay.

Four trust zones make up the local-hosted path:

1. An independently hosted frontend application.
2. A hosted or self-hosted Connect control plane and transient relay.
3. A user-owned connector agent with outbound network connections.
4. User-owned MDBASE collections on the local filesystem.

The connector is the authority for local data and policy. The server routes a
request only when its access token and grant allow the operation. The connector
checks its local policy copy again before it opens a collection.

## Components

- `mdbase-rs` owns collection loading, validation, querying, mutation,
  revisions, and normalized filesystem events.
- `connect-agent` owns collection registration, local policy enforcement, the
  local change journal, activity, and outbound relay connectivity.
- `connect-cli` and the Electron controller use the agent's versioned local
  control socket.
- `connect-server` owns accounts, pairing, app discovery, grants, token
  issuance, audit metadata, and transient request routing.
- `@mdbase/connect` provides OAuth with PKCE, typed operation envelopes,
  collection discovery, and cursor-based subscriptions.
- Domain adapters consume collection contracts. `@mdbase/tasknotes` is the
  first adapter and follows the collection's configured TaskNotes field roles.

## Collection API

Connect protocol 2 exposes these grantable operations:

- `describe`, `changes`
- `read`, `query`, `validate`
- `create`, `update`, `delete`, `rename`

MDBASE operations retain the canonical `{ valid, result, diagnostics }`
envelope. Reads and successful writes carry opaque revisions. Mutations accept
`if_revision`, which allows clients to prevent lost updates without knowing
how a provider constructs its revision token.

`describe` returns the collection's spec version, supported operations, JSON
Schemas, type metadata, `x-*` extensions, discovered contract declarations,
and the current change cursor. It does not return the collection path.

## Change delivery

The engine debounces filesystem notifications and compares a fresh collection
snapshot. Editor-specific write sequences therefore become a single
final-state event when possible. The connector records normalized event
metadata in its local SQLite database with a monotonically increasing cursor.

The public `changes` operation is resumable and paginated. Calling it without
an `after` cursor establishes a subscription at the current point and does not
replay earlier activity. The browser SDK builds an async change stream by
polling pages from that cursor. Expired cursors require a state refresh.

The local journal stores paths, event kinds, revisions, matched types, and
changed-field names. Record snapshots are removed before persistence. The
hosted relay does not persist change events or operation payloads.

## Domain contracts

A type may declare an optional domain contract in an extension such as
`x-tasknotes`. Discovery returns the extension unchanged along with its type
name and version. An adapter can then translate stable domain roles into the
collection's configured field names.

The TaskNotes adapter implements listing, creation, and completion through
generic MDBASE operations. Completion reads the latest revision and submits a
conditional update. This path works while Obsidian is closed. Behaviors that
need a richer runtime, including recurrence expansion and timers, will use
explicit provider actions in a later Connect protocol revision. Generic record
access does not pretend those actions are available.

## Application identity and authorization

Web applications are identified by the exact origin of an HTTPS manifest at
`/.well-known/mdbase-app.json`. Authorization uses short-lived codes and PKCE;
browser applications have no client secret. The user approves concrete
operations for one named collection. Local pause and revocation take effect at
the connector even when cloud policy is stale.

The Electron controller is the primary collection and permission surface. The
portal handles sign-in, pairing, account state, remote approval on trusted
private deployments, and emergency computer revocation.

## Data authority and future hosting

Every collection has one write authority:

- a local connector for the current product;
- a hosted collection provider for the future managed service;
- a self-hosted provider implementing the same Connect API.

Applications discover and use a collection through the same API in each case.
A future desktop mirror consumes the authority's change cursor and writes a
local replica. The first mirror design is one-way from the authority. A
bidirectional filesystem sync engine requires separate conflict, rename,
deletion, and identity semantics and is outside the current foundation.

## Versioning

The MDBASE spec version, Connect protocol version, app manifest version, and
domain contract versions evolve independently. Clients branch on declared
versions and capabilities. Protocol 2 is introduced as one coordinated agent,
server, and SDK release; protocol 1 installations must be upgraded together in
private staging.
