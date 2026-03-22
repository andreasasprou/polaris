import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getSessionWithOrg, hasOrganizationMembership } from "@/lib/auth/session";
import { db } from "@/lib/db";
import {
  member,
  organization,
  session as sessionTable,
} from "@/lib/db/auth-schema";
import { AppSidebar } from "./_components/app-sidebar";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { TooltipProvider } from "@/components/ui/tooltip";

export default async function DashboardLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;

  // 1. Resolve org from slug
  const [org] = await db
    .select({ id: organization.id, metadata: organization.metadata })
    .from(organization)
    .where(eq(organization.slug, orgSlug))
    .limit(1);

  if (!org) {
    notFound();
  }

  // 2. Authenticate user
  const { session, orgId: activeOrgId } = await getSessionWithOrg();

  // 3. Verify membership in this org
  const isMember = await hasOrganizationMembership(session.user.id, org.id);
  if (!isMember) {
    notFound(); // Don't reveal slug existence
  }

  // 4. Sync activeOrganizationId if it differs from the URL's org
  if (activeOrgId !== org.id) {
    await db
      .update(sessionTable)
      .set({ activeOrganizationId: org.id })
      .where(eq(sessionTable.id, session.session.id));
  }

  // 5. Set polaris_org_slug cookie now that the org is validated
  const cookieStore = await cookies();
  cookieStore.set("polaris_org_slug", orgSlug, {
    path: "/",
    httpOnly: false,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365, // 1 year
  });

  // 6. Gate: redirect to onboarding if not yet completed
  const meta = org.metadata
    ? (JSON.parse(org.metadata) as Record<string, unknown>)
    : null;

  if (!meta?.onboardingCompletedAt) {
    const { count } = await import("drizzle-orm");
    const { automations } = await import("@/lib/automations/schema");
    const [result] = await db
      .select({ count: count() })
      .from(automations)
      .where(eq(automations.organizationId, org.id));
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
