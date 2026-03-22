"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircleIcon, CheckCircleIcon, ExternalLinkIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { McpStatusBadge } from "./mcp-status-badge";
import { McpToolsList } from "./mcp-tools-list";

type ClientTool = {
  name: string;
  description?: string | null;
  inputSchema?: Record<string, unknown> | null;
};

type CatalogTemplate = {
  slug: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  badge: "official" | "verified" | "community";
  transport: "streamable-http" | "sse";
  docsUrl?: string;
  websiteUrl?: string;
  ownershipModel: "org-shared" | "per-user";
  permissionSummary: string;
  authType: "oauth-discovery" | "static-headers";
  serverUrl: string | null;
  oauthClientId?: string;
  scopes?: string;
  requiredHeaders?: string[];
  regionOptions?: Array<{ label: string; value: string; url: string }>;
};

type InstalledServer = {
  id: string;
  enabled: boolean;
  transport: string;
  serverUrl: string;
  status: "needs_auth" | "misconfigured" | "connected";
  lastTestError: string | null;
  lastTestedAt: string | null;
  lastDiscoveredTools: ClientTool[] | null;
};

type Banner =
  | {
      kind: "success" | "error";
      message: string;
    }
  | null;

type AcknowledgementAction =
  | "oauth-install"
  | "oauth-connect"
  | "static-install"
  | "toggle-enable";

function badgeLabel(badge: CatalogTemplate["badge"]) {
  if (badge === "official") return "Official";
  if (badge === "verified") return "Verified";
  return "Community";
}

function ownershipLabel(ownershipModel: CatalogTemplate["ownershipModel"]) {
  return ownershipModel === "org-shared" ? "Workspace shared" : "Per user";
}

function formatTimestamp(value: string | null) {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

function getOwnershipNotice(template: CatalogTemplate) {
  return template.ownershipModel === "org-shared"
    ? `Enabling ${template.name} makes one shared connection available to everyone in this workspace. Use a service account when possible.`
    : `Enabling ${template.name} uses a personal connection tied to your account.`;
}

function getAcknowledgementActionLabel(action: AcknowledgementAction) {
  switch (action) {
    case "oauth-install":
      return "Enable and connect";
    case "oauth-connect":
      return "Continue to connect";
    case "static-install":
      return "Install integration";
    case "toggle-enable":
      return "Enable integration";
  }
}

async function readApiError(response: Response) {
  const payload = (await response.json().catch(() => null)) as
    | { error?: string }
    | null;
  return payload?.error ?? "Request failed";
}

export function CatalogInstallPanel({
  orgSlug,
  template,
  server,
  status,
  initialError,
  initialSuccess,
}: {
  orgSlug: string;
  template: CatalogTemplate;
  server: InstalledServer | null;
  status: "not_installed" | "needs_auth" | "misconfigured" | "connected";
  initialError: string | null;
  initialSuccess: string | null;
}) {
  const router = useRouter();
  const [banner, setBanner] = useState<Banner>(
    initialError
      ? { kind: "error", message: initialError }
      : initialSuccess
        ? { kind: "success", message: initialSuccess }
        : null,
  );
  const [isInstalling, setIsInstalling] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isToggling, setIsToggling] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [selectedRegion, setSelectedRegion] = useState(
    template.regionOptions?.[0]?.value ?? "",
  );
  const [headerValues, setHeaderValues] = useState<Record<string, string>>(
    Object.fromEntries((template.requiredHeaders ?? []).map((name) => [name, ""])),
  );
  const [pendingAcknowledgement, setPendingAcknowledgement] =
    useState<AcknowledgementAction | null>(null);
  const [hasAcknowledged, setHasAcknowledged] = useState(false);

  const activeTools = server?.lastDiscoveredTools ?? null;

  async function handleOAuthInstall() {
    setIsInstalling(true);
    setBanner(null);

    try {
      const response = await fetch("/api/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgSlug, catalogSlug: template.slug }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response));
      }

      const payload = (await response.json()) as { server: { id: string } };
      window.location.href = `/api/mcp-servers/oauth/start?serverId=${payload.server.id}&orgSlug=${encodeURIComponent(orgSlug)}`;
    } catch (error) {
      setBanner({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed to install integration",
      });
      setIsInstalling(false);
    }
  }

  async function handleConnect() {
    if (!server) return;
    window.location.href = `/api/mcp-servers/oauth/start?serverId=${server.id}&orgSlug=${encodeURIComponent(orgSlug)}`;
  }

  async function handleStaticInstall() {
    setIsInstalling(true);
    setBanner(null);

    try {
      const response = await fetch("/api/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orgSlug,
          catalogSlug: template.slug,
          region: selectedRegion,
          headers: headerValues,
        }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response));
      }

      setBanner({
        kind: "success",
        message: `${template.name} installed successfully.`,
      });
      router.refresh();
    } catch (error) {
      setBanner({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed to install integration",
      });
    } finally {
      setIsInstalling(false);
    }
  }

  async function handleTest() {
    if (!server) return;

    setIsTesting(true);
    setBanner(null);

    try {
      const response = await fetch(
        `/api/mcp-servers/${server.id}/test?orgSlug=${encodeURIComponent(orgSlug)}`,
        {
        method: "POST",
        },
      );

      if (!response.ok) {
        throw new Error(await readApiError(response));
      }

      const payload = (await response.json()) as { tools?: ClientTool[] };
      setBanner({
        kind: "success",
        message:
          payload.tools && payload.tools.length > 0
            ? `Discovered ${payload.tools.length} tool${payload.tools.length === 1 ? "" : "s"}.`
            : "Connected successfully, but the server did not advertise any tools.",
      });
      router.refresh();
    } catch (error) {
      setBanner({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed to test tools",
      });
      router.refresh();
    } finally {
      setIsTesting(false);
    }
  }

  async function handleToggleEnabled() {
    if (!server) return;

    setIsToggling(true);
    setBanner(null);

    try {
      const response = await fetch(
        `/api/mcp-servers/${server.id}?orgSlug=${encodeURIComponent(orgSlug)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: !server.enabled }),
        },
      );

      if (!response.ok) {
        throw new Error(await readApiError(response));
      }

      setBanner({
        kind: "success",
        message: server.enabled ? "Integration disabled." : "Integration enabled.",
      });
      router.refresh();
    } catch (error) {
      setBanner({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed to update integration",
      });
    } finally {
      setIsToggling(false);
    }
  }

  async function handleRemove() {
    if (!server || !window.confirm(`Remove ${template.name} from this workspace?`)) {
      return;
    }

    setIsRemoving(true);
    setBanner(null);

    try {
      const response = await fetch(
        `/api/mcp-servers/${server.id}?orgSlug=${encodeURIComponent(orgSlug)}`,
        {
          method: "DELETE",
        },
      );

      if (!response.ok) {
        throw new Error(await readApiError(response));
      }

      setBanner({
        kind: "success",
        message: `${template.name} removed.`,
      });
      router.refresh();
    } catch (error) {
      setBanner({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed to remove integration",
      });
    } finally {
      setIsRemoving(false);
    }
  }

  async function runAcknowledgedAction(action: AcknowledgementAction) {
    if (action === "oauth-install") {
      await handleOAuthInstall();
      return;
    }

    if (action === "oauth-connect") {
      await handleConnect();
      return;
    }

    if (action === "static-install") {
      await handleStaticInstall();
      return;
    }

    await handleToggleEnabled();
  }

  async function handleAcknowledgementConfirm() {
    if (!pendingAcknowledgement) return;

    const action = pendingAcknowledgement;
    setPendingAcknowledgement(null);
    setHasAcknowledged(false);
    await runAcknowledgedAction(action);
  }

  function openAcknowledgement(action: AcknowledgementAction) {
    setPendingAcknowledgement(action);
    setHasAcknowledged(false);
  }

  return (
    <div className="space-y-6">
      <Dialog
        open={pendingAcknowledgement !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingAcknowledgement(null);
            setHasAcknowledged(false);
          }
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Confirm shared integration access</DialogTitle>
            <DialogDescription>
              Review the workspace access and permissions before continuing.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-lg border bg-muted/30 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Permissions
              </p>
              <p className="mt-1 text-sm">{template.permissionSummary}</p>
            </div>
            <div className="rounded-lg border bg-muted/30 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Credential ownership
              </p>
              <p className="mt-1 text-sm">{getOwnershipNotice(template)}</p>
            </div>
            <label className="flex items-start gap-3 rounded-lg border p-3 text-sm">
              <input
                type="checkbox"
                checked={hasAcknowledged}
                onChange={(event) => setHasAcknowledged(event.target.checked)}
                className="mt-0.5 size-4 rounded border"
              />
              <span>I understand and want to enable this integration.</span>
            </label>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setPendingAcknowledgement(null);
                setHasAcknowledged(false);
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleAcknowledgementConfirm}
              disabled={!hasAcknowledged}
            >
              {pendingAcknowledgement
                ? getAcknowledgementActionLabel(pendingAcknowledgement)
                : "Continue"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <img
                  src={template.icon}
                  alt={`${template.name} logo`}
                  className="size-10 rounded-lg border bg-background p-2"
                />
                <div>
                  <CardTitle className="text-2xl">{template.name}</CardTitle>
                  <CardDescription>{template.description}</CardDescription>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <McpStatusBadge status={status} />
                <Badge variant="outline">{badgeLabel(template.badge)}</Badge>
                <Badge variant="outline">{ownershipLabel(template.ownershipModel)}</Badge>
                <Badge variant="outline">
                  {template.authType === "oauth-discovery" ? "OAuth" : "Static headers"}
                </Badge>
                <Badge variant="outline">{template.transport}</Badge>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {template.websiteUrl ? (
                <Button variant="outline" size="sm" asChild>
                  <a href={template.websiteUrl} target="_blank" rel="noreferrer">
                    Website
                    <ExternalLinkIcon className="ml-1 size-4" />
                  </a>
                </Button>
              ) : null}
              {template.docsUrl ? (
                <Button variant="outline" size="sm" asChild>
                  <a href={template.docsUrl} target="_blank" rel="noreferrer">
                    Docs
                    <ExternalLinkIcon className="ml-1 size-4" />
                  </a>
                </Button>
              ) : null}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {banner ? (
            <Alert variant={banner.kind === "error" ? "destructive" : "default"}>
              {banner.kind === "error" ? <AlertCircleIcon /> : <CheckCircleIcon />}
              <AlertDescription>{banner.message}</AlertDescription>
            </Alert>
          ) : null}

          {server?.lastTestError && status === "misconfigured" && !banner ? (
            <Alert variant="destructive">
              <AlertCircleIcon />
              <AlertDescription>{server.lastTestError}</AlertDescription>
            </Alert>
          ) : null}

          <div className="grid gap-4 rounded-lg border bg-muted/20 p-4 sm:grid-cols-2">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Permissions
              </p>
              <p className="mt-1 text-sm">{template.permissionSummary}</p>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Last test
              </p>
              <p className="mt-1 text-sm">{formatTimestamp(server?.lastTestedAt ?? null)}</p>
            </div>
          </div>

          {template.authType === "oauth-discovery" ? (
            <div className="flex flex-wrap gap-2">
              {!server ? (
                <Button
                  onClick={() => openAcknowledgement("oauth-install")}
                  disabled={isInstalling}
                >
                  {isInstalling ? "Starting OAuth..." : "Enable and connect"}
                </Button>
              ) : (
                <>
                  <Button onClick={() => openAcknowledgement("oauth-connect")}>
                    {status === "needs_auth" ? "Connect" : "Reconnect"}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={handleTest}
                    disabled={isTesting || status === "needs_auth"}
                  >
                    {isTesting ? "Testing..." : "Test tools"}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      server.enabled
                        ? handleToggleEnabled()
                        : openAcknowledgement("toggle-enable")
                    }
                    disabled={isToggling}
                  >
                    {isToggling
                      ? "Saving..."
                      : server.enabled
                        ? "Disable"
                        : "Enable"}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={handleRemove}
                    disabled={isRemoving}
                    className="text-destructive hover:text-destructive"
                  >
                    {isRemoving ? "Removing..." : "Remove"}
                  </Button>
                </>
              )}
            </div>
          ) : !server ? (
            <div className="space-y-4 rounded-lg border p-4">
              {template.regionOptions?.length ? (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="region">Region</Label>
                  <select
                    id="region"
                    value={selectedRegion}
                    onChange={(event) => setSelectedRegion(event.target.value)}
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                  >
                    {template.regionOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              {(template.requiredHeaders ?? []).map((headerName) => (
                <div key={headerName} className="flex flex-col gap-2">
                  <Label htmlFor={headerName}>{headerName}</Label>
                  <Input
                    id={headerName}
                    type="password"
                    value={headerValues[headerName] ?? ""}
                    onChange={(event) =>
                      setHeaderValues((current) => ({
                        ...current,
                        [headerName]: event.target.value,
                      }))
                    }
                    placeholder={headerName}
                  />
                </div>
              ))}

              <Button
                onClick={() => openAcknowledgement("static-install")}
                disabled={isInstalling}
              >
                {isInstalling ? "Installing..." : "Install integration"}
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-lg border bg-muted/20 p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Endpoint
                </p>
                <p className="mt-1 break-all font-mono text-sm">{server.serverUrl}</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  Reconfigure by removing and reinstalling this integration.
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={handleTest} disabled={isTesting}>
                  {isTesting ? "Testing..." : "Test tools"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() =>
                    server.enabled
                      ? handleToggleEnabled()
                      : openAcknowledgement("toggle-enable")
                  }
                  disabled={isToggling}
                >
                  {isToggling
                    ? "Saving..."
                    : server.enabled
                      ? "Disable"
                      : "Enable"}
                </Button>
                <Button
                  variant="ghost"
                  onClick={handleRemove}
                  disabled={isRemoving}
                  className="text-destructive hover:text-destructive"
                >
                  {isRemoving ? "Removing..." : "Remove"}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Discovered tools</CardTitle>
          <CardDescription>
            Cached from the latest successful MCP handshake.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <McpToolsList tools={activeTools} />
        </CardContent>
      </Card>
    </div>
  );
}
