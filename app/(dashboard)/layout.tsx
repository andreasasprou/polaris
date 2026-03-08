import { getSessionWithOrg } from "@/lib/auth/session";
import { Sidebar } from "./_components/sidebar";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Ensures user is authenticated and has an active org.
  // Redirects to /login or /onboarding if not.
  await getSessionWithOrg();

  return (
    <div className="flex h-svh">
      <Sidebar />
      <main className="flex-1 overflow-auto p-6">{children}</main>
    </div>
  );
}
