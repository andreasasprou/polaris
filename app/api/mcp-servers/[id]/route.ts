import { NextResponse } from "next/server";
import { getSessionWithOrg } from "@/lib/auth/session";
import {
  deleteMcpServer,
  updateMcpServerEnabled,
  updateMcpServerHeaders,
} from "@/lib/mcp-servers/actions";
import { findMcpServerByIdAndOrg } from "@/lib/mcp-servers/queries";
import { withEvlog } from "@/lib/evlog";

export const DELETE = withEvlog(
  async (
    _req: Request,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const { orgId } = await getSessionWithOrg();
    const { id } = await params;

    await deleteMcpServer(id, orgId);
    return NextResponse.json({ ok: true });
  },
);

export const PATCH = withEvlog(
  async (
    req: Request,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const { orgId } = await getSessionWithOrg();
    const { id } = await params;
    const body = await req.json();

    if (typeof body.enabled !== "boolean" && !body.headers) {
      return NextResponse.json(
        { error: "No valid fields to update" },
        { status: 400 },
      );
    }

    if (typeof body.enabled === "boolean") {
      await updateMcpServerEnabled(id, orgId, body.enabled);
    }

    if (body.headers && typeof body.headers === "object") {
      const server = await findMcpServerByIdAndOrg(id, orgId);
      if (!server) {
        return NextResponse.json(
          { error: "Server not found" },
          { status: 404 },
        );
      }
      if (server.authType !== "static") {
        return NextResponse.json(
          { error: "Headers can only be updated on static-auth servers" },
          { status: 400 },
        );
      }
      await updateMcpServerHeaders(id, orgId, body.headers);
    }

    return NextResponse.json({ ok: true });
  },
);
