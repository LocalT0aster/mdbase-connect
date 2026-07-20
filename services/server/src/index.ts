import { resolve } from "node:path";
import { buildApp } from "./app.js";
import { createDatabase } from "./db.js";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const publicUrl = process.env.PUBLIC_URL ?? `http://${host}:${port}`;
const db = await createDatabase();
const portalDist = process.env.PORTAL_DIST ?? resolve(import.meta.dirname, "../../../apps/portal/dist");
const { app } = await buildApp({
  db,
  publicUrl,
  portalDist,
  devAuth: process.env.MDBASE_CONNECT_DEV_AUTH === "1",
  tailscaleAuth: process.env.MDBASE_CONNECT_TAILSCALE_AUTH === "1",
  allowInsecureManifests: process.env.MDBASE_CONNECT_ALLOW_INSECURE_MANIFESTS === "1"
});

await app.listen({ port, host });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await app.close();
    await db.end();
    process.exit(0);
  });
}
