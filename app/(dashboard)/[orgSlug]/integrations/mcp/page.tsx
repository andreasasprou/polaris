import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getOrgIdBySlug } from "@/lib/auth/session";
import { orgPath } from "@/lib/config/urls";
import { findCatalogInstallationsByOrg, findCustomMcpServersByOrg } from "@/lib/mcp-servers/queries";
import { McpStatusBadge } from "./_components/mcp-status-badge";

function badgeLabel(badge: "official" | "verified" | "community") {
  if (badge === "official") return "Official";
  if (badge === "verified") return "Verified";
  return "Community";
}

function ownershipLabel(ownershipModel: "org-shared" | "per-user") {
  return ownershipModel === "org-shared" ? "Workspace shared" : "Per user";
}

export default async function McpMarketplacePage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const orgId = await getOrgIdBySlug(orgSlug);
  if (!orgId) notFound();

  const [installations, customServers] = await Promise.all([
    findCatalogInstallationsByOrg(orgId),
    findCustomMcpServersByOrg(orgId),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-medium">MCP Marketplace</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Install workspace-wide MCP integrations and inspect their current health.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {installations.map((installation) => (
          <Link
            key={installation.template.slug}
            href={orgPath(orgSlug, `/integrations/mcp/${installation.template.slug}`)}
            className="block transition-colors hover:opacity-90"
          >
            <Card className="h-full">
              <CardHeader>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <img
                      src={installation.template.icon}
                      alt={`${installation.template.name} logo`}
                      className="size-10 rounded-lg border bg-background p-2"
                    />
                    <div className="space-y-1">
                      <CardTitle>{installation.template.name}</CardTitle>
                      <CardDescription>
                        {installation.template.description}
                      </CardDescription>
                    </div>
                  </div>
                  <McpStatusBadge status={installation.status} />
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline">
                    {badgeLabel(installation.template.badge)}
                  </Badge>
                  <Badge variant="outline">
                    {ownershipLabel(installation.template.ownershipModel)}
                  </Badge>
                  <Badge variant="outline">
                    {installation.template.authType === "oauth-discovery"
                      ? "OAuth"
                      : "Static headers"}
                  </Badge>
                  <Badge variant="outline">{installation.template.transport}</Badge>
                </div>
                <div className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
                  <p>Category: {installation.template.category}</p>
                  <p>Discovered tools: {installation.toolCount}</p>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}

        <Link
          href={orgPath(orgSlug, "/integrations/mcp/custom")}
          className="block transition-colors hover:opacity-90"
        >
          <Card className="h-full border-dashed">
            <CardHeader>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <CardTitle>Add your own</CardTitle>
                  <CardDescription>
                    Install custom MCP servers that are not in the marketplace.
                  </CardDescription>
                </div>
                <Badge variant="outline">
                  {customServers.length} installed
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Manage custom streamable HTTP or SSE servers with static headers
                or OAuth configuration.
              </p>
            </CardContent>
          </Card>
        </Link>
      </div>
    </div>
  );
}
