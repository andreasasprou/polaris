import {
  isValidUrl,
  safeFetch,
  validateOAuthEndpoints,
} from "./url-validation";

export type DiscoveredOAuthConfig = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
  codeChallengeMethodsSupported?: string[];
};

function isLocalDevUrl(url: URL) {
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1")
  );
}

async function fetchDiscoveryUrl(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const parsed = new URL(url);
  if (isLocalDevUrl(parsed)) {
    return fetch(url, init);
  }
  return safeFetch(url, init);
}

function parseAuthenticateHeader(
  header: string | null,
): { resourceMetadataUrl?: string; scope?: string } {
  if (!header) return {};

  const resourceMetadataMatch = header.match(
    /resource_metadata="([^"]+)"/i,
  );
  const scopeMatch = header.match(/scope="([^"]+)"/i);

  return {
    resourceMetadataUrl: resourceMetadataMatch?.[1],
    scope: scopeMatch?.[1],
  };
}

function getProtectedResourceCandidates(serverUrl: string): string[] {
  const parsed = new URL(serverUrl);
  const path = parsed.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  const candidates = new Set<string>();

  if (path) {
    parsed.pathname = `/.well-known/oauth-protected-resource/${path}`;
    parsed.search = "";
    parsed.hash = "";
    candidates.add(parsed.toString());
  }

  parsed.pathname = "/.well-known/oauth-protected-resource";
  parsed.search = "";
  parsed.hash = "";
  candidates.add(parsed.toString());

  return [...candidates];
}

function getAuthorizationServerMetadataUrl(authServer: string): string {
  const parsed = new URL(authServer);
  const path = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = path
    ? `/.well-known/oauth-authorization-server${path}`
    : "/.well-known/oauth-authorization-server";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetchDiscoveryUrl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function discoverProtectedResourceMetadata(serverUrl: string) {
  try {
    const response = await fetchDiscoveryUrl(serverUrl, {
      method: "GET",
      headers: { Accept: "application/json, text/event-stream" },
      signal: AbortSignal.timeout(5_000),
    });

    const { resourceMetadataUrl } = parseAuthenticateHeader(
      response.headers.get("www-authenticate"),
    );

    if (resourceMetadataUrl && isValidUrl(resourceMetadataUrl, { allowLocalDev: true })) {
      const metadata = await fetchJson(resourceMetadataUrl);
      if (metadata) return metadata;
    }
  } catch {
    // Fall through to well-known probing.
  }

  for (const candidate of getProtectedResourceCandidates(serverUrl)) {
    if (!isValidUrl(candidate, { allowLocalDev: true })) continue;
    const metadata = await fetchJson(candidate);
    if (metadata) return metadata;
  }

  return null;
}

/**
 * Discover OAuth configuration from an MCP server URL.
 * Uses protected resource metadata to discover the authorization server,
 * then loads authorization server metadata for concrete endpoints.
 */
export async function discoverOAuthConfig(
  serverUrl: string,
): Promise<DiscoveredOAuthConfig | null> {
  if (!isValidUrl(serverUrl, { allowLocalDev: true })) {
    return null;
  }

  const resourceMetadata = await discoverProtectedResourceMetadata(serverUrl);
  if (!resourceMetadata) return null;

  const authorizationServers = Array.isArray(resourceMetadata.authorization_servers)
    ? resourceMetadata.authorization_servers.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const authServer = authorizationServers[0];
  if (!authServer || !isValidUrl(authServer, { allowLocalDev: true })) {
    return null;
  }

  const authServerMetadata = await fetchJson(
    getAuthorizationServerMetadataUrl(authServer),
  );
  if (!authServerMetadata) return null;

  const authorizationEndpoint = authServerMetadata.authorization_endpoint;
  const tokenEndpoint = authServerMetadata.token_endpoint;
  if (
    typeof authorizationEndpoint !== "string" ||
    typeof tokenEndpoint !== "string"
  ) {
    return null;
  }

  try {
    await validateOAuthEndpoints(authorizationEndpoint, tokenEndpoint);
  } catch {
    return null;
  }

  return {
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint:
      typeof authServerMetadata.registration_endpoint === "string"
        ? authServerMetadata.registration_endpoint
        : undefined,
    scopesSupported: Array.isArray(authServerMetadata.scopes_supported)
      ? authServerMetadata.scopes_supported.filter(
          (value): value is string => typeof value === "string",
        )
      : undefined,
    codeChallengeMethodsSupported: Array.isArray(
      authServerMetadata.code_challenge_methods_supported,
    )
      ? authServerMetadata.code_challenge_methods_supported.filter(
          (value): value is string => typeof value === "string",
        )
      : undefined,
  };
}
