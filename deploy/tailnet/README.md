# Tailnet staging deployment

This deployment keeps PostgreSQL, MDBASE Connect, and the example frontend on
host loopback. Tailscale Serve is the only ingress and supplies HTTPS for the
browser-facing URLs.

The Connect container uses host networking so server-side application manifest
discovery can reach a frontend served on the same Tailscale node. It still binds
only to `127.0.0.1:8787`. PostgreSQL and the frontend bind only to loopback as
well.

## Required files

Install this directory at `/opt/mdbase-connect`, add the built frontend under
`workout-dist`, and load an image named `mdbase-connect-server:staging`.
Create a root-readable `.env` containing:

```dotenv
POSTGRES_PASSWORD=<random password>
PUBLIC_URL=https://<tailscale-dns-name>
```

The frontend's `/.well-known/mdbase-app.json` must use its actual tailnet HTTPS
homepage and callback URL.

## Start

```sh
docker compose --env-file .env -f compose.yml up -d
tailscale serve --bg --https=443 http://127.0.0.1:8787
tailscale serve --bg --https=8443 http://127.0.0.1:8788
```

Install the backup service and timer in `/etc/systemd/system`, then enable the
timer with `systemctl enable --now mdbase-connect-backup.timer`.

`MDBASE_CONNECT_DEV_AUTH` and insecure manifests are enabled here for private
staging only. Replace them with production authentication and strict HTTPS
manifest validation before exposing the service beyond a tailnet.
