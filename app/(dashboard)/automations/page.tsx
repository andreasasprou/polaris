import Link from "next/link";
import { getSessionWithOrg } from "@/lib/auth/session";
import { findAutomationsByOrg } from "@/lib/automations/queries";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default async function AutomationsPage() {
  const { orgId } = await getSessionWithOrg();
  const automations = await findAutomationsByOrg(orgId);

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
          <Link href="/automations/new">New automation</Link>
        </Button>
      </div>

      {automations.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-8 text-center">
            <p className="text-sm text-muted-foreground">
              No automations yet. Create one to get started.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {automations.map((automation) => (
            <Link
              key={automation.id}
              href={`/automations/${automation.id}`}
              className="block transition-colors hover:bg-accent/50"
            >
              <Card>
                <CardContent className="flex items-center justify-between py-4">
                  <div className="flex items-center gap-3">
                    <div
                      className={`size-2.5 rounded-full ${
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
                  <Badge variant="secondary">{automation.agentType}</Badge>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
