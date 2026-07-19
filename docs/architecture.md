# Architecture

## Product boundary

MDBASE Connect has four trust zones:

1. An independently hosted frontend application.
2. The hosted or self-hosted Connect control plane and transient relay.
3. A user-owned connector agent that makes only outbound cloud connections.
4. User-owned mdbase collections on the local filesystem.

The Electron controller is the primary configuration and permission interface.
It manages collections, applications, grants, pending authorization requests,
connection state, and local activity through the agent's local control socket.
The online portal is intentionally limited to sign-in, computer pairing,
account state, and emergency computer revocation. The local agent remains the
final enforcement point and can pause access independently of the cloud.

## Components

- `connect-agent` owns local collection registration, operation execution,
  policy caching, filesystem watching, and relay connectivity.
- `connect-cli` and the Electron app use the same per-user local control
  socket. Neither implements collection semantics.
- `connect-server` owns accounts, browser-mediated device pairing, application
  discovery, synchronized grants, token issuance, audit metadata, and request
  routing. Connector-authenticated control endpoints let the local client
  change a user's cloud state without exposing account credentials to it.
- `@mdbase/connect` implements authorization-code plus PKCE and the public
  collection API for browser applications.
- `mdbase-rs` remains the collection engine.

## Application identity

Web applications are identified by their exact HTTPS origin and may publish
`/.well-known/mdbase-app.json`. Application records are discovered
dynamically; developers do not need a developer portal for the MVP.

## Data boundary

The cloud stores account, connector, collection-display, application, grant,
and audit metadata. It does not store local collection paths or record
contents. Payload visibility and end-to-end encryption must be resolved in the
threat model before a public beta.

The desktop app stores its connector credential using Electron `safeStorage`
when the operating system supports it. Pairing uses a short-lived request and
secret: approval happens in the signed-in browser and the credential is issued
only when the originating desktop app exchanges that secret. A custom
`mdbase-connect:` link returns focus to the app but never contains the
credential.

## Local control protocol

The Electron main process and CLI communicate with the agent over a Unix
domain socket on macOS/Linux or a per-user named pipe on Windows. The protocol
uses newline-delimited JSON request/response envelopes and is versioned
independently from the mdbase collection specification.

Local collection registration and activity history remain useful while the
cloud is unavailable. The agent caches synchronized grant policy for
enforcement; the cloud may route only the operations present in that policy,
and the agent rechecks every operation before touching the filesystem.
