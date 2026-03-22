import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { getOrgIdBySlug } from "@/lib/auth/session";
import { orgPath } from "@/lib/config/urls";
import { findCatalogInstallationBySlugAndOrg } from "@/lib/mcp-servers/queries";
import { CatalogInstallPanel } from "../_components/catalog-install-panel";

function readSearchParam(
  value: string | string[] | undefined,
): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export default async function CatalogIntegrationPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgSlug, slug } = await params;
  const orgId = await getOrgIdBySlug(orgSlug);
  if (!orgId) notFound();

  const installation = await findCatalogInstallationBySlugAndOrg(slug, orgId);
  if (!installation) notFound();

  const query = await searchParams;
  const error = readSearchParam(query.error);
  const success = readSearchParam(query.success);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-medium">{installation.template.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Marketplace integration details and installation status.
          </p>
        </div>
        <Button variant="outline" asChild>
          <Link href={orgPath(orgSlug, "/integrations/mcp")}>
            Back to marketplace
          </Link>
        </Button>
      </div>

      <CatalogInstallPanel
        orgSlug={orgSlug}
        template={installation.template}
        status={installation.status}
        server={
          installation.server
            ? {
                id: installation.server.id,
                enabled: installation.server.enabled,
                transport: installation.server.transport,
                serverUrl: installation.server.serverUrl,
                status: installation.server.status,
                lastTestError: installation.server.lastTestError,
                lastTestedAt:
                  installation.server.lastTestedAt?.toISOString() ?? null,
                lastDiscoveredTools: installation.server.lastDiscoveredTools,
              }
            : null
        }
        initialError={error}
        initialSuccess={
          success === "connected"
            ? `${installation.template.name} connected successfully.`
            : null
        }
      />
    </div>
  );
}
