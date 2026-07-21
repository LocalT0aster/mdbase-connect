# Private Render deployment

The repository includes a Render Blueprint for a single-user, relay-only
deployment at `connect.mdbase.dev`. It creates one Singapore web service and
one private PostgreSQL database. Hosted collection routes and public
registration remain unavailable.

## Before creating the Blueprint

Create a GitHub OAuth app with these exact values:

- Application name: `mdbase connect`
- Homepage URL: `https://connect.mdbase.dev`
- Authorization callback URL:
  `https://connect.mdbase.dev/auth/github/callback`
- Device flow: disabled

Keep the client secret out of the repository. GitHub usernames can change, so
the deployment allowlist uses numeric GitHub account IDs. The initial allowed
ID for `callumalpass` is `12558714`.

## Create the services

In Render, choose **New → Blueprint**, select
`mdbase-dev/mdbase-connect`, and use the repository's `render.yaml`. Confirm
the paid web-service and database plans. Render asks for three values during
the initial creation:

- `MDBASE_CONNECT_GITHUB_CLIENT_ID`
- `MDBASE_CONNECT_GITHUB_CLIENT_SECRET`
- `MDBASE_CONNECT_ALLOWED_GITHUB_USER_IDS` (`12558714` initially)

The Blueprint runs migrations before each deployment, waits for `/ready`, and
deploys commits only after GitHub checks pass. Keep the web service at one
instance: relay connections and in-flight request coordination are currently
process-local.

## Attach the domain

Render lists the DNS target for `connect.mdbase.dev` after service creation.
Create the corresponding `connect` CNAME at the DNS provider. If the provider
offers HTTP proxying, leave it disabled until Render has verified the domain
and issued its certificate.

The generated `onrender.com` hostname remains useful for initial diagnostics,
but GitHub sign-in is intentionally bound to `https://connect.mdbase.dev`.

## Verify the deployment

1. Confirm `/health` and `/ready` both return HTTP 200.
2. Open `/login` and sign in with the allowlisted GitHub account.
3. Confirm `/dashboard` shows the expected GitHub username.
4. Pair a fresh desktop installation against `https://connect.mdbase.dev`.
5. Approve a test app, perform one encrypted read and write, then revoke it.
6. Confirm the revoked grant cannot reconnect or refresh.

## Operations

Render manages database snapshots and point-in-time recovery according to the
selected PostgreSQL plan. Before inviting another user or enabling hosted
collections, perform and document a restore drill, add external monitoring,
and decide how security and abuse reports will be handled.

Do not set `MDBASE_CONNECT_HOSTED_COLLECTIONS=1` for the initial deployment.
That mode introduces stored encrypted collection state and a larger operational
and recovery surface.
