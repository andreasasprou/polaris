import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrgIdBySlug } from "@/lib/auth/session";
import { findAutomationsWithRepoByOrg } from "@/lib/automations/queries";
import { orgPath } from "@/lib/config/urls";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { PlusIcon, ZapIcon } from "lucide-react";
import { AutomationsTable } from "./_components/automations-table";

export default async function AutomationsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const orgId = await getOrgIdBySlug(orgSlug);
  if (!orgId) notFound();
  const rows = await findAutomationsWithRepoByOrg(orgId);
  const op = (path: string) => orgPath(orgSlug, path);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-medium">Automations</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Configure agent workflows triggered by events.
          </p>
        </div>
        <Button asChild>
          <Link href={op("/automations/new")}>
            <PlusIcon data-icon="inline-start" />
            New automation
          </Link>
        </Button>
      </div>

      {rows.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ZapIcon />
            </EmptyMedia>
            <EmptyTitle>No automations yet</EmptyTitle>
            <EmptyDescription>
              Create your first automation to run agent workflows on GitHub
              events like pushes and pull requests.
            </EmptyDescription>
          </EmptyHeader>
          <Button asChild>
            <Link href={op("/automations/new")}>
              <PlusIcon data-icon="inline-start" />
              New automation
            </Link>
          </Button>
        </Empty>
      ) : (
        <AutomationsTable rows={rows} />
      )}
    </div>
  );
}
