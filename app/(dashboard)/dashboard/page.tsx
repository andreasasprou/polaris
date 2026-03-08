import { headers } from "next/headers";
import { auth } from "@/lib/auth";

export default async function DashboardPage() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-medium">Dashboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Welcome back, {session?.user.name ?? "there"}.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-border p-4">
          <p className="text-sm text-muted-foreground">Active Automations</p>
          <p className="mt-1 text-2xl font-semibold">0</p>
        </div>
        <div className="rounded-lg border border-border p-4">
          <p className="text-sm text-muted-foreground">Runs Today</p>
          <p className="mt-1 text-2xl font-semibold">0</p>
        </div>
        <div className="rounded-lg border border-border p-4">
          <p className="text-sm text-muted-foreground">PRs Created</p>
          <p className="mt-1 text-2xl font-semibold">0</p>
        </div>
      </div>
    </div>
  );
}
