import Link from "next/link";
import { getSessionWithOrg } from "@/lib/auth/session";
import { findAutomationsByOrg } from "@/lib/automations/queries";

export default async function AutomationsPage() {
  const { orgId } = await getSessionWithOrg();
  const automations = await findAutomationsByOrg(orgId);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-medium">Automations</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Configure agent workflows triggered by events.
          </p>
        </div>
        <Link
          href="/automations/new"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          New automation
        </Link>
      </div>

      {automations.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <p className="text-sm text-muted-foreground">
            No automations yet. Create one to get started.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {automations.map((automation) => (
            <Link
              key={automation.id}
              href={`/automations/${automation.id}`}
              className="block rounded-lg border border-border p-4 hover:bg-accent/50 transition-colors"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div
                    className={`h-2.5 w-2.5 rounded-full ${
                      automation.enabled ? "bg-green-500" : "bg-muted"
                    }`}
                  />
                  <div>
                    <p className="font-medium">{automation.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {automation.triggerType} trigger
                    </p>
                  </div>
                </div>
                <span className="text-xs text-muted-foreground">
                  {automation.agentType}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
