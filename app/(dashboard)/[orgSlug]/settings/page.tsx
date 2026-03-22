import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { orgPath } from "@/lib/config/urls";

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const op = (path: string) => orgPath(orgSlug, path);
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-medium">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage your workspace settings.
        </p>
      </div>

      <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
        <Link href={op("/settings/secrets")} className="block transition-colors hover:opacity-80">
          <Card>
            <CardHeader>
              <CardTitle>API Keys</CardTitle>
              <CardDescription>
                Manage your AI provider API keys.
              </CardDescription>
            </CardHeader>
          </Card>
        </Link>
        <Link href={op("/settings/environment")} className="block transition-colors hover:opacity-80">
          <Card>
            <CardHeader>
              <CardTitle>Environment Variables</CardTitle>
              <CardDescription>
                Variables injected into all sandbox sessions.
              </CardDescription>
            </CardHeader>
          </Card>
        </Link>
        <Link href={op("/settings/mcp")} className="block transition-colors hover:opacity-80">
          <Card>
            <CardHeader>
              <CardTitle>MCP Servers</CardTitle>
              <CardDescription>
                Connect external tools to agent sessions.
              </CardDescription>
            </CardHeader>
          </Card>
        </Link>
      </div>
    </div>
  );
}
