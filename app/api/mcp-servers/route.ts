import { NextResponse } from "next/server";
import {
  getSessionWithOrg,
  getSessionWithOrgAdminBySlug,
} from "@/lib/auth/session";
import { findMcpServersByOrg } from "@/lib/mcp-servers/queries";
import { createMcpServer } from "@/lib/mcp-servers/actions";
import {
  getCatalogTemplate,
  resolveCatalogServerUrl,
} from "@/lib/mcp-servers/catalog";
import {
  isValidUrl,
  validateOAuthEndpoints,
} from "@/lib/mcp-servers/url-validation";
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

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ApiError("Invalid JSON body", 400);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError("JSON body must be an object", 400);
  }

  return body as Record<string, unknown>;
}

function readRequiredOrgSlug(body: Record<string, unknown>): string {
  const orgSlug = readTrimmedString(body.orgSlug);
  if (!orgSlug) {
    throw new ApiError("orgSlug is required", 400);
  }
  return orgSlug;
}

export const POST = withEvlog(async (req: Request) => {
  let requestedName: string | null = null;

  try {
    const body = await readJsonObject(req);
    const orgSlug = readRequiredOrgSlug(body);
    const admin = await getSessionWithOrgAdminBySlug(orgSlug);
    if (!admin) {
      return NextResponse.json(
        { error: "Only organization owners and admins can manage MCP servers" },
        { status: 403 },
      );
    }

    const { session, orgId } = admin;
    requestedName = readTrimmedString(body.name);

    const catalogSlug =
      readTrimmedString(body.catalogSlug) ?? "";

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
          readTrimmedString(body.region),
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

    const name = readTrimmedString(body.name);
    if (!name) {
      return NextResponse.json(
        { error: "name is required" },
        { status: 400 },
      );
    }

    const serverUrl = readTrimmedString(body.serverUrl);
    if (!serverUrl || !isValidUrl(serverUrl, { allowLocalDev: true })) {
      return NextResponse.json(
        {
          error:
            "serverUrl must be a valid HTTPS URL (HTTP allowed for localhost). Private/internal hosts are blocked.",
        },
        { status: 400 },
      );
    }

    const transport =
      typeof body.transport === "string"
        ? body.transport
        : "streamable-http";
    if (transport !== "streamable-http" && transport !== "sse") {
      return NextResponse.json(
        { error: `transport must be one of: ${VALID_TRANSPORTS.join(", ")}` },
        { status: 400 },
      );
    }

    const authType = typeof body.authType === "string" ? body.authType : "";
    if (authType !== "static" && authType !== "oauth") {
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
      const clientId = readTrimmedString(body.oauthClientId) ?? "";
      const authorizationEndpoint =
        readTrimmedString(body.oauthAuthorizationEndpoint) ?? "";
      const tokenEndpoint = readTrimmedString(body.oauthTokenEndpoint) ?? "";
      oauthScopes = readTrimmedString(body.oauthScopes);

      if (!clientId) {
        return NextResponse.json(
          { error: "oauthClientId is required for OAuth servers" },
          { status: 400 },
        );
      }

      try {
        await validateOAuthEndpoints(authorizationEndpoint, tokenEndpoint);
      } catch (error) {
        throw new ApiError(
          error instanceof Error ? error.message : "Invalid OAuth endpoints",
          400,
        );
      }

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
            requestedName
              ? `An MCP server named "${requestedName}" already exists`
              : "This MCP server already exists",
        },
        { status: 409 },
      );
    }
    throw err;
  }
});
