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
