import { NextResponse } from "next/server";
import { getSessionWithOrgAdminBySlug } from "@/lib/auth/session";
import { updateMcpServerTestResult } from "@/lib/mcp-servers/actions";
import {
  findMcpServerByIdAndOrg,
  getResolvedMcpServerByIdAndOrg,
} from "@/lib/mcp-servers/queries";
import { testMcpServerConnection } from "@/lib/mcp-servers/test-client";
import { withEvlog } from "@/lib/evlog";

function toSafeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Unknown MCP connection error";
  }

  return error.message.slice(0, 500) || "Unknown MCP connection error";
}

function getAuthResolutionError(server: {
  authType: string;
  encryptedAuthConfig: string | null;
}) {
  if (server.authType !== "oauth") {
    return server.encryptedAuthConfig
      ? "Unable to resolve authentication headers for this server"
      : "This server is missing authentication headers";
  }

  return server.encryptedAuthConfig
    ? "Unable to resolve authentication for this server. Reconnect and try again."
    : "Connect this server before testing tools";
}

export const POST = withEvlog(
  async (
    req: Request,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const orgSlug = new URL(req.url).searchParams.get("orgSlug")?.trim() ?? "";
    if (!orgSlug) {
      return NextResponse.json({ error: "orgSlug required" }, { status: 400 });
    }

    const admin = await getSessionWithOrgAdminBySlug(orgSlug);
    if (!admin) {
      return NextResponse.json(
        { error: "Only organization owners and admins can manage MCP servers" },
        { status: 403 },
      );
    }

    const { orgId } = admin;
    const { id } = await params;
    const server = await findMcpServerByIdAndOrg(id, orgId);

    if (!server) {
      return NextResponse.json({ error: "Server not found" }, { status: 404 });
    }

    const resolved = await getResolvedMcpServerByIdAndOrg(id, orgId);
    if (!resolved?.headers) {
      return NextResponse.json(
        {
          error: getAuthResolutionError(server),
        },
        { status: 400 },
      );
    }

    try {
      const tools = await testMcpServerConnection({
        serverUrl: resolved.url,
        transport: resolved.transport ?? server.transport,
        headers: resolved.headers,
      });

      await updateMcpServerTestResult(id, orgId, {
        status: "ok",
        tools,
      });

      return NextResponse.json({ ok: true, tools });
    } catch (error) {
      const message = toSafeErrorMessage(error);
      await updateMcpServerTestResult(id, orgId, {
        status: "error",
        error: message,
        tools: [],
      });

      return NextResponse.json({ error: message }, { status: 502 });
    }
  },
);
