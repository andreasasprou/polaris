import { NextResponse } from "next/server";
import { getSessionWithOrg, getSessionWithOrgAdmin } from "@/lib/auth/session";
import { findMcpServersByOrg } from "@/lib/mcp-servers/queries";
import { createMcpServer } from "@/lib/mcp-servers/actions";
import {
  getCatalogTemplate,
  resolveCatalogServerUrl,
} from "@/lib/mcp-servers/catalog";
import { isValidUrl, validateServerFetchUrl } from "@/lib/mcp-servers/url-validation";
import { withEvlog } from "@/lib/evlog";

export const GET = withEvlog(async () => {
  const { orgId } = await getSessionWithOrg();
  const servers = await findMcpServersByOrg(orgId);
  return NextResponse.json({ servers });
});

const VALID_TRANSPORTS = ["streamable-http", "sse"] as const;
const VALID_AUTH_TYPES = ["static", "oauth"] as const;

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function normalizeHeaders(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ApiError(
      "headers must be an object of header names to values",
      400,
    );
  }

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (typeof value !== "string") {
      throw new ApiError(`Header "${name}" must be a string`, 400);
    }
    const trimmedName = name.trim();
    const trimmedValue = value.trim();
    if (!trimmedName || !trimmedValue) continue;
    headers[trimmedName] = trimmedValue;
  }

  return headers;
}

async function validateOAuthEndpoints(
  authorizationEndpoint: string,
  tokenEndpoint: string,
) {
  if (!isValidUrl(authorizationEndpoint)) {
    throw new ApiError(
      "oauthAuthorizationEndpoint must be a valid HTTPS URL (private/internal hosts blocked)",
      400,
    );
  }

  if (!(await validateServerFetchUrl(tokenEndpoint))) {
    throw new ApiError(
      "oauthTokenEndpoint must be a valid HTTPS URL that does not resolve to a private/internal address",
      400,
    );
  }
}

export const POST = withEvlog(async (req: Request) => {
  const admin = await getSessionWithOrgAdmin();
  if (!admin) return NextResponse.json({ error: "Only organization owners and admins can manage MCP servers" }, { status: 403 });
  const { session, orgId } = admin;
  const body = await req.json();

  try {
    const catalogSlug =
      typeof body.catalogSlug === "string" ? body.catalogSlug.trim() : "";

    if (catalogSlug) {
      const template = getCatalogTemplate(catalogSlug);
      if (!template) {
        return NextResponse.json(
          { error: `Unknown catalog slug: ${catalogSlug}` },
          { status: 400 },
        );
      }

      let serverUrl: string;
      try {
        serverUrl = resolveCatalogServerUrl(
          template,
          typeof body.region === "string" ? body.region.trim() : null,
        );
      } catch (error) {
        return NextResponse.json(
          {
            error:
              error instanceof Error
                ? error.message
                : "Invalid catalog configuration",
          },
          { status: 400 },
        );
      }

      let authConfig: { headers: Record<string, string> } | undefined;
      if (template.authType === "static-headers") {
        const headers = normalizeHeaders(body.headers);
        const missingHeaders = template.requiredHeaders.filter(
          (headerName) => !headers[headerName],
        );
        if (missingHeaders.length > 0) {
          return NextResponse.json(
            {
              error: `Missing required headers: ${missingHeaders.join(", ")}`,
            },
            { status: 400 },
          );
        }
        authConfig = { headers };
      } else if (!template.oauthClientId) {
        return NextResponse.json(
          {
            error: `${template.name} OAuth is not configured in this environment`,
          },
          { status: 500 },
        );
      }

      const server = await createMcpServer({
        organizationId: orgId,
        name: template.name,
        serverUrl,
        transport: template.transport,
        authType: template.authType === "static-headers" ? "static" : "oauth",
        authConfig,
        catalogSlug: template.slug,
        oauthClientId:
          template.authType === "oauth-discovery"
            ? template.oauthClientId
            : null,
        oauthScopes:
          template.authType === "oauth-discovery"
            ? template.scopes ?? null
            : null,
        createdBy: session.user.id,
      });

      return NextResponse.json({ server }, { status: 201 });
    }

    const name = body.name?.trim();
    if (!name) {
      return NextResponse.json(
        { error: "name is required" },
        { status: 400 },
      );
    }

    const serverUrl = body.serverUrl?.trim();
    if (!serverUrl || !isValidUrl(serverUrl, { allowLocalDev: true })) {
      return NextResponse.json(
        {
          error:
            "serverUrl must be a valid HTTPS URL (HTTP allowed for localhost). Private/internal hosts are blocked.",
        },
        { status: 400 },
      );
    }

    const transport = body.transport ?? "streamable-http";
    if (!VALID_TRANSPORTS.includes(transport)) {
      return NextResponse.json(
        { error: `transport must be one of: ${VALID_TRANSPORTS.join(", ")}` },
        { status: 400 },
      );
    }

    const authType = body.authType;
    if (!VALID_AUTH_TYPES.includes(authType)) {
      return NextResponse.json(
        { error: `authType must be one of: ${VALID_AUTH_TYPES.join(", ")}` },
        { status: 400 },
      );
    }

    let authConfig:
      | {
          headers: Record<string, string>;
        }
      | undefined;
    let oauthClientId: string | null = null;
    let oauthAuthorizationEndpoint: string | null = null;
    let oauthTokenEndpoint: string | null = null;
    let oauthScopes: string | null = null;

    if (authType === "static") {
      const headers = normalizeHeaders(body.headers);
      if (Object.keys(headers).length === 0) {
        return NextResponse.json(
          {
            error: "headers are required for static auth (at least one header)",
          },
          { status: 400 },
        );
      }
      authConfig = { headers };
    }

    if (authType === "oauth") {
      const clientId = body.oauthClientId?.trim() ?? "";
      const authorizationEndpoint =
        body.oauthAuthorizationEndpoint?.trim() ?? "";
      const tokenEndpoint = body.oauthTokenEndpoint?.trim() ?? "";
      oauthScopes = body.oauthScopes?.trim() || null;

      if (!clientId) {
        return NextResponse.json(
          { error: "oauthClientId is required for OAuth servers" },
          { status: 400 },
        );
      }

      await validateOAuthEndpoints(authorizationEndpoint, tokenEndpoint);

      oauthClientId = clientId;
      oauthAuthorizationEndpoint = authorizationEndpoint;
      oauthTokenEndpoint = tokenEndpoint;
    }

    const server = await createMcpServer({
      organizationId: orgId,
      name,
      serverUrl,
      transport,
      authType,
      authConfig,
      oauthClientId,
      oauthAuthorizationEndpoint,
      oauthTokenEndpoint,
      oauthScopes,
      createdBy: session.user.id,
    });

    return NextResponse.json({ server }, { status: 201 });
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (
      err instanceof Error &&
      err.message.includes("idx_mcp_servers_catalog_slug")
    ) {
      return NextResponse.json(
        { error: "This integration is already installed for the workspace" },
        { status: 409 },
      );
    }
    if (err instanceof Error && err.message.includes("unique")) {
      return NextResponse.json(
        {
          error:
            typeof body.name === "string" && body.name.trim()
              ? `An MCP server named "${body.name.trim()}" already exists`
              : "This MCP server already exists",
        },
        { status: 409 },
      );
    }
    throw err;
  }
});
