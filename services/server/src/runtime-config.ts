import type { GitHubAuthConfig } from "./github-auth.js";

export interface RuntimeConfig {
  host: string;
  publicUrl: string;
  devAuth: boolean;
  tailscaleAuth: boolean;
  githubAuth: GitHubAuthConfig | null;
  hostedCollections: boolean;
  trustProxy: boolean;
}

export function validateRuntimeConfig(config: RuntimeConfig): RuntimeConfig {
  const publicUrl = new URL(config.publicUrl);
  const localPublicOrigin = isLoopback(publicUrl.hostname);
  if (publicUrl.username || publicUrl.password || publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) {
    throw new Error("PUBLIC_URL must be an origin without credentials, a path, a query, or a fragment.");
  }
  if (publicUrl.protocol !== "https:" && !localPublicOrigin) {
    throw new Error("PUBLIC_URL must use HTTPS outside loopback development.");
  }
  if (config.devAuth && !localPublicOrigin) {
    throw new Error("Development authentication cannot be enabled on a public origin.");
  }
  const authenticationModes = [config.devAuth, config.tailscaleAuth, Boolean(config.githubAuth)]
    .filter(Boolean).length;
  if (authenticationModes !== 1) {
    throw new Error("Exactly one identity provider must be configured before the server starts.");
  }
  if (config.githubAuth) {
    if (!config.githubAuth.clientId.trim() || !config.githubAuth.clientSecret.trim()) {
      throw new Error("GitHub authentication requires a client ID and client secret.");
    }
    if (config.githubAuth.allowedUserIds.size === 0) {
      throw new Error("GitHub authentication requires at least one allowed user ID.");
    }
    for (const id of config.githubAuth.allowedUserIds) {
      if (!/^[1-9][0-9]*$/.test(id)) {
        throw new Error("GitHub allowed user IDs must be positive numeric IDs.");
      }
    }
  }
  return { ...config, publicUrl: publicUrl.origin };
}

export function runtimeConfigFromEnv(env: NodeJS.ProcessEnv): RuntimeConfig {
  const clientId = env.MDBASE_CONNECT_GITHUB_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.MDBASE_CONNECT_GITHUB_CLIENT_SECRET?.trim() ?? "";
  const allowedUserIds = new Set(
    (env.MDBASE_CONNECT_ALLOWED_GITHUB_USER_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  const githubConfigured = Boolean(clientId || clientSecret || allowedUserIds.size);
  const port = Number(env.PORT ?? 8787);
  const host = env.HOST ?? "127.0.0.1";
  return validateRuntimeConfig({
    host,
    publicUrl: env.PUBLIC_URL ?? `http://${host}:${port}`,
    devAuth: env.MDBASE_CONNECT_DEV_AUTH === "1",
    tailscaleAuth: env.MDBASE_CONNECT_TAILSCALE_AUTH === "1",
    githubAuth: githubConfigured ? { clientId, clientSecret, allowedUserIds } : null,
    hostedCollections: env.MDBASE_CONNECT_HOSTED_COLLECTIONS === "1",
    trustProxy: env.MDBASE_CONNECT_TRUST_PROXY === "1"
  });
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}
