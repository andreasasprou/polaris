import type { McpIntegrationTemplate } from "./catalog";

/** Decrypted auth config for static-header servers. */
export type StaticAuthConfig = {
  headers: Record<string, string>;
};

/** Decrypted auth config for OAuth servers (runtime tokens only). */
export type OAuthAuthConfig = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix epoch seconds
};

export type AuthConfig = StaticAuthConfig | OAuthAuthConfig;

/** SDK-ready format — goes into sessionInit.mcpServers */
export type McpServerEntry = {
  name: string;
  url: string;
  transport?: "streamable-http" | "sse";
  headers?: Record<string, string>;
};

export type McpTestStatus = "ok" | "error";

export type McpDiscoveredTool = {
  name: string;
  description?: string | null;
  inputSchema?: Record<string, unknown> | null;
};

export type McpInstallStatus =
  | "not_installed"
  | "needs_auth"
  | "misconfigured"
  | "connected";

export type McpServerStatus = Exclude<McpInstallStatus, "not_installed">;

export type McpServerListItem = {
  id: string;
  name: string;
  serverUrl: string;
  transport: string;
  authType: string;
  enabled: boolean;
  catalogSlug: string | null;
  oauthClientId: string | null;
  oauthAuthorizationEndpoint: string | null;
  oauthTokenEndpoint: string | null;
  oauthScopes: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastTestStatus: McpTestStatus | null;
  lastTestError: string | null;
  lastTestedAt: Date | null;
  lastDiscoveredTools: McpDiscoveredTool[] | null;
  connected: boolean;
  status: McpServerStatus;
};

export type CatalogInstallationView = {
  template: McpIntegrationTemplate;
  available: boolean;
  unavailableReason: string | null;
  server: McpServerListItem | null;
  status: McpInstallStatus;
  toolCount: number;
  lastTestedAt: Date | null;
  lastTestError: string | null;
  discoveredTools: McpDiscoveredTool[] | null;
};
