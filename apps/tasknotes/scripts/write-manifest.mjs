import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const origin = (process.env.TASKNOTES_APP_ORIGIN ?? "http://localhost:5179").replace(/\/$/, "");
const target = resolve(import.meta.dirname, "..", "public", ".well-known", "mdbase-app.json");
await mkdir(resolve(target, ".."), { recursive: true });
await writeFile(target, JSON.stringify({
  manifest_version: 1,
  name: "TaskNotes",
  homepage: origin,
  redirect_uris: [`${origin}/`]
}, null, 2));
