import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getSessionWithOrg } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { organization } from "@/lib/db/auth-schema";
import { AppSidebar } from "./_components/app-sidebar";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { TooltipProvider } from "@/components/ui/tooltip";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Ensures user is authenticated and has an active org.
  // Redirects to /login or /onboarding if not.
  const { orgId } = await getSessionWithOrg();

  // Gate: redirect to onboarding if not yet completed
  const [org] = await db
    .select({ metadata: organization.metadata })
    .from(organization)
    .where(eq(organization.id, orgId))
    .limit(1);

  const meta = org?.metadata
    ? (JSON.parse(org.metadata) as Record<string, unknown>)
    : null;

  // Only gate new orgs — if the org has automations or runs, treat as complete
  // This prevents forcing legacy orgs (created before onboarding) through the wizard
  if (!meta?.onboardingCompletedAt) {
    // Check if this org has any automations — if so, it's a legacy org, skip gating
    const { count } = await import("drizzle-orm");
    const { automations } = await import("@/lib/automations/schema");
    const [result] = await db
      .select({ count: count() })
      .from(automations)
      .where(eq(automations.organizationId, orgId));
    if ((result?.count ?? 0) === 0) {
      redirect("/onboarding");
    }
  }

  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 !h-4" />
          </header>
          <div className="relative min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-6">
            {children}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}
