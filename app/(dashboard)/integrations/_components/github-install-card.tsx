"use client";

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
    <div className="rounded-lg border border-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium">GitHub</h3>
          <p className="text-sm text-muted-foreground">
            {installations.length > 0
              ? `${installations.length} installation${installations.length === 1 ? "" : "s"} connected`
              : "Not connected"}
          </p>
        </div>
        <div
          className={`h-2.5 w-2.5 rounded-full ${installations.length > 0 ? "bg-green-500" : "bg-muted"}`}
        />
      </div>

      {installations.length > 0 && (
        <ul className="space-y-1 text-sm text-muted-foreground">
          {installations.map((inst) => (
            <li key={inst.id}>
              {inst.accountLogin ?? `Installation ${inst.installationId}`}
              <span className="ml-1 text-xs">({inst.accountType})</span>
            </li>
          ))}
        </ul>
      )}

      <a
        href="/api/integrations/github/install"
        className="inline-block rounded-md border border-input px-3 py-1.5 text-sm font-medium hover:bg-accent"
      >
        {installations.length > 0 ? "Add another" : "Install GitHub App"}
      </a>
    </div>
  );
}
