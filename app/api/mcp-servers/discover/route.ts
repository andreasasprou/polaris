import { NextResponse } from "next/server";
import { getSessionWithOrgAdmin } from "@/lib/auth/session";
import { discoverOAuthConfig } from "@/lib/mcp-servers/discovery";
import { isValidUrl } from "@/lib/mcp-servers/url-validation";
import { withEvlog } from "@/lib/evlog";

export const POST = withEvlog(async (req: Request) => {
  const admin = await getSessionWithOrgAdmin();
  if (!admin) {
    return NextResponse.json(
      { error: "Only organization owners and admins can manage MCP servers" },
      { status: 403 },
    );
  }

  const body = await req.json();
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
