import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { getOrgIdBySlug } from "@/lib/auth/session";
import { orgPath } from "@/lib/config/urls";
import { findCustomMcpServersByOrg } from "@/lib/mcp-servers/queries";
import { CustomMcpManager } from "../_components/custom-mcp-manager";

function readSearchParam(
  value: string | string[] | undefined,
): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export default async function CustomMcpPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgSlug } = await params;
  const orgId = await getOrgIdBySlug(orgSlug);
  if (!orgId) notFound();

  const [servers, query] = await Promise.all([
    findCustomMcpServersByOrg(orgId),
    searchParams,
  ]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-medium">Custom MCP servers</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage non-marketplace MCP servers for this workspace.
          </p>
        </div>
        <Button variant="outline" asChild>
          <Link href={orgPath(orgSlug, "/integrations/mcp")}>
            Back to marketplace
          </Link>
        </Button>
      </div>

      <CustomMcpManager
        orgSlug={orgSlug}
        servers={servers.map((server) => ({
          id: server.id,
          name: server.name,
          serverUrl: server.serverUrl,
          transport: server.transport,
          authType: server.authType,
          enabled: server.enabled,
          status: server.status,
          connected: server.connected,
          lastTestError: server.lastTestError,
          lastTestedAt: server.lastTestedAt?.toISOString() ?? null,
          lastDiscoveredTools: server.lastDiscoveredTools,
          oauthClientId: server.oauthClientId,
        }))}
        initialError={readSearchParam(query.error)}
        initialSuccess={
          readSearchParam(query.success) === "connected"
            ? "MCP server connected successfully."
            : null
        }
      />
    </div>
  );
}
