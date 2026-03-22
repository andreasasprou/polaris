import { NextResponse } from "next/server";
import { getSessionWithOrgAdmin } from "@/lib/auth/session";
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

export const POST = withEvlog(
  async (
    _req: Request,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const admin = await getSessionWithOrgAdmin();
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
          error:
            server.authType === "oauth"
              ? "Connect this server before testing tools"
              : "This server is missing authentication headers",
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
