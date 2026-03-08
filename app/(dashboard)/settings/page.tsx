import Link from "next/link";

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-medium">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage your workspace settings.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 max-w-2xl">
        <Link
          href="/settings/secrets"
          className="block rounded-lg border border-border p-4 hover:bg-accent/50 transition-colors"
        >
          <h3 className="font-medium">API Keys</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage your AI provider API keys.
          </p>
        </Link>
      </div>
    </div>
  );
}
