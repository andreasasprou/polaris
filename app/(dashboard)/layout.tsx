import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { Sidebar } from "./_components/sidebar";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const hdrs = await headers();
  const session = await auth.api.getSession({
    headers: hdrs,
  }).catch(() => null);

  if (!session) {
    redirect("/login");
  }

  // If logged in but no active org, try to auto-set one
  if (!session.session.activeOrganizationId) {
    const orgs = await auth.api.listOrganizations({
      headers: hdrs,
    }).catch(() => null);

    if (orgs && orgs.length > 0) {
      await auth.api.setActiveOrganization({
        headers: hdrs,
        body: { organizationId: orgs[0].id },
      });
      // Refresh the page to pick up the active org
      redirect(hdrs.get("x-url") ?? "/dashboard");
    } else {
      // No orgs at all — redirect to onboarding
      redirect("/onboarding");
    }
  }

  return (
    <div className="flex h-svh">
      <Sidebar />
      <main className="flex-1 overflow-auto p-6">{children}</main>
    </div>
  );
}
