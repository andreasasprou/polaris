export type McpCatalogBadge = "official" | "verified" | "community";
export type McpOwnershipModel = "org-shared" | "per-user";

export type McpRegionOption = {
  label: string;
  value: string;
  url: string;
};

type McpCatalogTemplateBase = {
  slug: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  badge: McpCatalogBadge;
  transport: "streamable-http" | "sse";
  docsUrl?: string;
  websiteUrl?: string;
  ownershipModel: McpOwnershipModel;
  permissionSummary: string;
};

export type McpOAuthDiscoveryTemplate = McpCatalogTemplateBase & {
  authType: "oauth-discovery";
  serverUrl: string;
  oauthClientId: string;
  scopes?: string;
};

export type McpStaticHeadersTemplate = McpCatalogTemplateBase & {
  authType: "static-headers";
  serverUrl: string | null;
  requiredHeaders: string[];
  regionOptions?: McpRegionOption[];
};

export type McpIntegrationTemplate =
  | McpOAuthDiscoveryTemplate
  | McpStaticHeadersTemplate;

export type CatalogAvailability = {
  available: boolean;
  unavailableReason: string | null;
};

export const MCP_CATALOG: McpIntegrationTemplate[] = [
  {
    slug: "sentry",
    name: "Sentry",
    description:
      "Retrieve detailed issue data, full stack traces, and search/filter issues. Analyze errors and debug production problems.",
    icon: "/integrations/sentry.svg",
    category: "Monitoring & Analytics",
    badge: "official",
    serverUrl: "https://mcp.sentry.dev/mcp",
    transport: "streamable-http",
    authType: "oauth-discovery",
    oauthClientId:
      process.env.SENTRY_MCP_CLIENT_ID ??
      process.env.NEXT_PUBLIC_SENTRY_MCP_CLIENT_ID ??
      "",
    scopes: "org:read project:write team:write event:write",
    docsUrl: "https://docs.sentry.io/product/sentry-mcp/",
    websiteUrl: "https://sentry.io",
    ownershipModel: "org-shared",
    permissionSummary:
      "Read and search issues, view stack traces, manage project settings",
  },
  {
    slug: "datadog",
    name: "Datadog",
    description:
      "Retrieve telemetry insights and manage Datadog platform features including incidents, monitors, logs, dashboards, metrics, traces, hosts, and more.",
    icon: "/integrations/datadog.svg",
    category: "Monitoring & Analytics",
    badge: "official",
    serverUrl: null,
    transport: "streamable-http",
    authType: "static-headers",
    requiredHeaders: ["DD-API-KEY", "DD-APPLICATION-KEY"],
    regionOptions: [
      { label: "US1", value: "us1", url: "https://app.datadoghq.com/mcp" },
      { label: "US3", value: "us3", url: "https://us3.datadoghq.com/mcp" },
      { label: "US5", value: "us5", url: "https://us5.datadoghq.com/mcp" },
      { label: "EU", value: "eu", url: "https://app.datadoghq.eu/mcp" },
      { label: "AP1", value: "ap1", url: "https://ap1.datadoghq.com/mcp" },
      { label: "AP2", value: "ap2", url: "https://ap2.datadoghq.com/mcp" },
      {
        label: "US1-FED",
        value: "us1-fed",
        url: "https://app.ddog-gov.com/mcp",
      },
    ],
    docsUrl: "https://docs.datadoghq.com/integrations/mcp/",
    websiteUrl: "https://www.datadoghq.com",
    ownershipModel: "org-shared",
    permissionSummary: "Read logs, metrics, traces, monitors, and dashboards",
  },
];

export function getCatalogTemplate(
  slug: string,
): McpIntegrationTemplate | undefined {
  return MCP_CATALOG.find((template) => template.slug === slug);
}

export function getCatalogTemplateAvailability(
  template: McpIntegrationTemplate,
): CatalogAvailability {
  if (template.authType === "oauth-discovery" && !template.oauthClientId) {
    return {
      available: false,
      unavailableReason: `${template.name} OAuth is not configured in this environment.`,
    };
  }

  return {
    available: true,
    unavailableReason: null,
  };
}

export function resolveCatalogServerUrl(
  template: McpIntegrationTemplate,
  region?: string | null,
): string {
  if (template.serverUrl) return template.serverUrl;

  if (template.authType !== "static-headers" || !template.regionOptions?.length) {
    throw new Error(`Template "${template.slug}" does not define a server URL`);
  }

  const option = template.regionOptions.find((entry) => entry.value === region);
  if (!option) {
    throw new Error(
      `Region is required for template "${template.slug}" and must be one of: ${template.regionOptions.map((entry) => entry.value).join(", ")}`,
    );
  }

  return option.url;
}
