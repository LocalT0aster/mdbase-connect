import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { z } from "zod";

const manifestSchema = z.object({
  manifest_version: z.literal(1),
  name: z.string().trim().min(1).max(100),
  homepage: z.url(),
  icon: z.url().optional(),
  redirect_uris: z.array(z.url()).min(1).max(10),
  requirements: z.object({
    contracts: z.array(z.object({
      id: z.string().trim().min(1).max(100).regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
      version: z.number().int().positive()
    }).strict()).max(20).refine(
      (contracts) => new Set(contracts.map((contract) => `${contract.id}@${contract.version}`)).size === contracts.length,
      "Contract requirements must be unique."
    )
  }).strict().default({ contracts: [] })
}).strict();

export type AppManifest = z.infer<typeof manifestSchema>;

export async function fetchManifest(source: string, allowInsecure = false): Promise<{
  manifest: AppManifest;
  manifestUrl: string;
  canonicalIdentity: string;
}> {
  const url = new URL(source);
  const developmentOrigin = allowInsecure && url.protocol === "http:" && isLoopbackName(url.hostname);
  if (url.protocol !== "https:" && !developmentOrigin) {
    throw new Error("Application manifests must use HTTPS.");
  }
  await assertPublicHost(url.hostname, allowInsecure);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, {
      redirect: "error",
      signal: controller.signal,
      headers: { accept: "application/json" }
    });
    if (!response.ok) throw new Error(`Manifest returned HTTP ${response.status}.`);
    const length = Number(response.headers.get("content-length") ?? "0");
    if (length > 65_536) throw new Error("Application manifest is too large.");
    const sourceText = await response.text();
    if (sourceText.length > 65_536) throw new Error("Application manifest is too large.");
    const manifest = manifestSchema.parse(JSON.parse(sourceText));
    validateManifestOrigins(url, manifest, developmentOrigin);
    return {
      manifest,
      manifestUrl: url.href,
      canonicalIdentity: `web:${url.origin}`
    };
  } finally {
    clearTimeout(timeout);
  }
}

function validateManifestOrigins(source: URL, manifest: AppManifest, developmentOrigin: boolean): void {
  const homepage = new URL(manifest.homepage);
  if (homepage.origin !== source.origin) throw new Error("Manifest homepage must use the manifest origin.");
  for (const redirect of manifest.redirect_uris) {
    const redirectUrl = new URL(redirect);
    if (redirectUrl.origin !== source.origin) {
      throw new Error("Redirect URIs must use the manifest origin.");
    }
    if (redirectUrl.protocol !== "https:" && !developmentOrigin) {
      throw new Error("Redirect URIs must use HTTPS.");
    }
  }
  if (manifest.icon && new URL(manifest.icon).origin !== source.origin) {
    throw new Error("Manifest icons must use the manifest origin.");
  }
}

async function assertPublicHost(hostname: string, allowPrivate: boolean): Promise<void> {
  if (allowPrivate) return;
  if (isIP(hostname)) throw new Error("Application manifests cannot use IP-literal hosts.");
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("Application manifest host does not resolve to a public address.");
  }
}

function isLoopbackName(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function isPrivateAddress(address: string): boolean {
  const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isPrivateAddress(mapped);
  if (isIP(address) === 4) {
    const [first, second] = address.split(".").map(Number);
    return first === 0
      || first === 10
      || first === 127
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && [0, 2, 168].includes(second))
      || (first === 198 && [18, 19, 51].includes(second))
      || (first === 203 && second === 0)
      || first >= 224;
  }
  const normalized = address.toLowerCase();
  return normalized === "::"
    || normalized === "::1"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || /^fe[89ab]/.test(normalized)
    || normalized.startsWith("ff")
    || normalized.startsWith("2001:db8:");
}
