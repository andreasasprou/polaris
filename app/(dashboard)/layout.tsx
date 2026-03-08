import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { Sidebar } from "./_components/sidebar";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Proxy handles redirect for unauthenticated users.
  // This is a best-effort session fetch for rendering.
  const session = await auth.api.getSession({
    headers: await headers(),
  }).catch(() => null);

  return (
    <div className="flex h-svh">
      <Sidebar />
      <main className="flex-1 overflow-auto p-6">{children}</main>
    </div>
  );
}
