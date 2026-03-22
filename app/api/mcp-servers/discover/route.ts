import { NextResponse } from "next/server";
import { getSessionWithOrgAdminBySlug } from "@/lib/auth/session";
import { discoverOAuthConfig } from "@/lib/mcp-servers/discovery";
import { isValidUrl } from "@/lib/mcp-servers/url-validation";
import { withEvlog } from "@/lib/evlog";

async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return null;
    }
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

export const POST = withEvlog(async (req: Request) => {
  const body = await readJsonObject(req);
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const orgSlug =
    typeof body.orgSlug === "string" ? body.orgSlug.trim() : "";
  if (!orgSlug) {
    return NextResponse.json({ error: "orgSlug is required" }, { status: 400 });
  }

  const admin = await getSessionWithOrgAdminBySlug(orgSlug);
  if (!admin) {
    return NextResponse.json(
      { error: "Only organization owners and admins can manage MCP servers" },
      { status: 403 },
    );
  }

  const serverUrl =
    typeof body.serverUrl === "string" ? body.serverUrl.trim() : "";

  if (!serverUrl || !isValidUrl(serverUrl, { allowLocalDev: true })) {
    return NextResponse.json(
      {
        error:
          "serverUrl must be a valid HTTPS URL (HTTP allowed for localhost). Private/internal hosts are blocked.",
      },
      { status: 400 },
    );
  }

  const config = await discoverOAuthConfig(serverUrl);
  if (!config) {
    return NextResponse.json(
      { error: "No OAuth metadata discovered for this server" },
      { status: 404 },
    );
  }

  return NextResponse.json({ config });
});
