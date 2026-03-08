import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { member, session as sessionTable } from "@/lib/db/auth-schema";
import { eq } from "drizzle-orm";
import { Sidebar } from "./_components/sidebar";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth.api.getSession({
    headers: await headers(),
  }).catch(() => null);

  if (!session) {
    redirect("/login");
  }

  // If logged in but no active org, try to auto-set one via direct DB update
  if (!session.session.activeOrganizationId) {
    const memberships = await db
      .select()
      .from(member)
      .where(eq(member.userId, session.user.id))
      .limit(1);

    if (memberships.length > 0) {
      // Set the active org directly in the session
      await db
        .update(sessionTable)
        .set({ activeOrganizationId: memberships[0].organizationId })
        .where(eq(sessionTable.id, session.session.id));
      // Redirect to refresh the session
      redirect("/dashboard");
    } else {
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
