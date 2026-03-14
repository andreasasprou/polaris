"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

type Installation = {
  id: string;
  installationId: number;
  accountLogin: string | null;
  accountType: string | null;
  createdAt: Date;
};

export function GitHubInstallCard({
  installations,
}: {
  installations: Installation[];
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>GitHub</CardTitle>
            <CardDescription>
              {installations.length > 0
                ? `${installations.length} installation${installations.length === 1 ? "" : "s"} connected`
                : "Not connected"}
            </CardDescription>
          </div>
          <div
            className={`size-2.5 rounded-full ${installations.length > 0 ? "bg-green-500" : "bg-muted"}`}
          />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {installations.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
            {installations.map((inst) => (
              <li key={inst.id}>
                {inst.accountLogin ?? `Installation ${inst.installationId}`}
                <span className="ml-1 text-xs">({inst.accountType})</span>
              </li>
            ))}
          </ul>
        )}

        <div>
          <Button variant="outline" size="sm" asChild>
            <a href="/api/integrations/github/install">
              {installations.length > 0 ? "Add another" : "Install GitHub App"}
            </a>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
