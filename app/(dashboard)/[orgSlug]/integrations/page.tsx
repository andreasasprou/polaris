import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getOrgIdBySlug } from "@/lib/auth/session";
import { findGithubInstallationsByOrg } from "@/lib/integrations/queries";
import {
  findCatalogInstallationsByOrg,
  findCustomMcpServersByOrg,
} from "@/lib/mcp-servers/queries";
import { orgPath } from "@/lib/config/urls";
import { GitHubInstallCard } from "./_components/github-install-card";

export default async function IntegrationsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const orgId = await getOrgIdBySlug(orgSlug);
  if (!orgId) notFound();
  const [installations, mcpInstallations, customMcpServers] = await Promise.all([
    findGithubInstallationsByOrg(orgId),
    findCatalogInstallationsByOrg(orgId),
    findCustomMcpServersByOrg(orgId),
  ]);
  const connectedMcpCount = mcpInstallations.filter(
    (installation) => installation.status !== "not_installed",
  ).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Integrations</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect your tools and services.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <GitHubInstallCard installations={installations} />
        <Link
          href={orgPath(orgSlug, "/integrations/mcp")}
          className="block transition-colors hover:opacity-80"
        >
          <Card className="h-full">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>MCP Marketplace</CardTitle>
                  <CardDescription>
                    {connectedMcpCount > 0 || customMcpServers.length > 0
                      ? `${connectedMcpCount} catalog install${connectedMcpCount === 1 ? "" : "s"}, ${customMcpServers.length} custom`
                      : "No MCP integrations installed"}
                  </CardDescription>
                </div>
                <div
                  className={`size-2.5 rounded-full ${
                    connectedMcpCount > 0 || customMcpServers.length > 0
                      ? "bg-green-500"
                      : "bg-muted"
                  }`}
                />
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">Workspace shared</Badge>
                <Badge variant="outline">OAuth + static</Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                Install marketplace-backed MCP providers and manage custom servers.
              </p>
            </CardContent>
          </Card>
        </Link>
      </div>
    </div>
  );
}
