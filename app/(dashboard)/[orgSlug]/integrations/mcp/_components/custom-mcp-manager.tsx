"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircleIcon, CheckCircleIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { McpStatusBadge } from "./mcp-status-badge";
import { McpToolsList } from "./mcp-tools-list";

type ClientTool = {
  name: string;
  description?: string | null;
  inputSchema?: Record<string, unknown> | null;
};

type CustomServer = {
  id: string;
  name: string;
  serverUrl: string;
  transport: string;
  authType: string;
  enabled: boolean;
  status: "needs_auth" | "misconfigured" | "connected";
  connected: boolean;
  lastTestError: string | null;
  lastTestedAt: string | null;
  lastDiscoveredTools: ClientTool[] | null;
  oauthClientId: string | null;
};

type Banner =
  | {
      kind: "success" | "error";
      message: string;
    }
  | null;

type HeaderRow = { name: string; value: string };

function formatTimestamp(value: string | null) {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

async function readApiError(response: Response) {
  const payload = (await response.json().catch(() => null)) as
    | { error?: string }
    | null;
  return payload?.error ?? "Request failed";
}

function toHeaderObject(rows: HeaderRow[]) {
  return Object.fromEntries(
    rows
      .map((row) => [row.name.trim(), row.value.trim()] as const)
      .filter(([name, value]) => !!name && !!value),
  );
}

export function CustomMcpManager({
  servers,
  initialError,
  initialSuccess,
}: {
  servers: CustomServer[];
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
  const [submittingStatic, setSubmittingStatic] = useState(false);
  const [submittingOAuth, setSubmittingOAuth] = useState(false);
  const [discoveringOAuth, setDiscoveringOAuth] = useState(false);
  const [busyServerId, setBusyServerId] = useState<string | null>(null);

  const [staticName, setStaticName] = useState("");
  const [staticUrl, setStaticUrl] = useState("");
  const [staticTransport, setStaticTransport] = useState("streamable-http");
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>([
    { name: "Authorization", value: "" },
  ]);

  const [oauthName, setOauthName] = useState("");
  const [oauthUrl, setOauthUrl] = useState("");
  const [oauthTransport, setOauthTransport] = useState("streamable-http");
  const [oauthClientId, setOauthClientId] = useState("");
  const [oauthAuthorizationEndpoint, setOauthAuthorizationEndpoint] =
    useState("");
  const [oauthTokenEndpoint, setOauthTokenEndpoint] = useState("");
  const [oauthScopes, setOauthScopes] = useState("");

  async function handleStaticCreate() {
    setSubmittingStatic(true);
    setBanner(null);

    try {
      const response = await fetch("/api/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: staticName,
          serverUrl: staticUrl,
          transport: staticTransport,
          authType: "static",
          headers: toHeaderObject(headerRows),
        }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response));
      }

      setStaticName("");
      setStaticUrl("");
      setStaticTransport("streamable-http");
      setHeaderRows([{ name: "Authorization", value: "" }]);
      setBanner({
        kind: "success",
        message: "Custom MCP server installed.",
      });
      router.refresh();
    } catch (error) {
      setBanner({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed to create MCP server",
      });
    } finally {
      setSubmittingStatic(false);
    }
  }

  async function handleOAuthCreate() {
    setSubmittingOAuth(true);
    setBanner(null);

    try {
      const response = await fetch("/api/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: oauthName,
          serverUrl: oauthUrl,
          transport: oauthTransport,
          authType: "oauth",
          oauthClientId,
          oauthAuthorizationEndpoint,
          oauthTokenEndpoint,
          oauthScopes: oauthScopes || undefined,
        }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response));
      }

      const payload = (await response.json()) as { server: { id: string } };
      window.location.href = `/api/mcp-servers/oauth/start?serverId=${payload.server.id}`;
    } catch (error) {
      setBanner({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed to create MCP server",
      });
      setSubmittingOAuth(false);
    }
  }

  async function handleDiscoverOAuth() {
    setDiscoveringOAuth(true);
    setBanner(null);

    try {
      const response = await fetch("/api/mcp-servers/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverUrl: oauthUrl }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response));
      }

      const payload = (await response.json()) as {
        config: {
          authorizationEndpoint: string;
          tokenEndpoint: string;
        };
      };

      setOauthAuthorizationEndpoint(payload.config.authorizationEndpoint);
      setOauthTokenEndpoint(payload.config.tokenEndpoint);
      setBanner({
        kind: "success",
        message: "OAuth metadata discovered.",
      });
    } catch (error) {
      setBanner({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed to discover OAuth metadata",
      });
    } finally {
      setDiscoveringOAuth(false);
    }
  }

  async function handleToggleEnabled(server: CustomServer) {
    setBusyServerId(server.id);
    setBanner(null);

    try {
      const response = await fetch(`/api/mcp-servers/${server.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !server.enabled }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response));
      }

      setBanner({
        kind: "success",
        message: server.enabled ? "Server disabled." : "Server enabled.",
      });
      router.refresh();
    } catch (error) {
      setBanner({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed to update server",
      });
    } finally {
      setBusyServerId(null);
    }
  }

  async function handleRemove(server: CustomServer) {
    if (!window.confirm(`Remove ${server.name}?`)) {
      return;
    }

    setBusyServerId(server.id);
    setBanner(null);

    try {
      const response = await fetch(`/api/mcp-servers/${server.id}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error(await readApiError(response));
      }

      setBanner({
        kind: "success",
        message: "Server removed.",
      });
      router.refresh();
    } catch (error) {
      setBanner({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed to remove server",
      });
    } finally {
      setBusyServerId(null);
    }
  }

  async function handleTest(server: CustomServer) {
    setBusyServerId(server.id);
    setBanner(null);

    try {
      const response = await fetch(`/api/mcp-servers/${server.id}/test`, {
        method: "POST",
      });

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
        message: error instanceof Error ? error.message : "Failed to test server",
      });
      router.refresh();
    } finally {
      setBusyServerId(null);
    }
  }

  async function handleConnect(server: CustomServer) {
    window.location.href = `/api/mcp-servers/oauth/start?serverId=${server.id}`;
  }

  return (
    <div className="space-y-6">
      {banner ? (
        <Alert variant={banner.kind === "error" ? "destructive" : "default"}>
          {banner.kind === "error" ? <AlertCircleIcon /> : <CheckCircleIcon />}
          <AlertDescription>{banner.message}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Add your own MCP server</CardTitle>
          <CardDescription>
            Create custom workspace-wide MCP entries for providers outside the
            marketplace.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="static">
            <TabsList className="mb-4 w-full">
              <TabsTrigger value="static">Static headers</TabsTrigger>
              <TabsTrigger value="oauth">OAuth</TabsTrigger>
            </TabsList>

            <TabsContent value="static" className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="static-name">Name</Label>
                  <Input
                    id="static-name"
                    value={staticName}
                    onChange={(event) => setStaticName(event.target.value)}
                    placeholder="Internal Metrics"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="static-url">Server URL</Label>
                  <Input
                    id="static-url"
                    value={staticUrl}
                    onChange={(event) => setStaticUrl(event.target.value)}
                    placeholder="https://mcp.example.com/mcp"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="static-transport">Transport</Label>
                <select
                  id="static-transport"
                  value={staticTransport}
                  onChange={(event) => setStaticTransport(event.target.value)}
                  className="h-9 rounded-md border bg-background px-3 text-sm"
                >
                  <option value="streamable-http">Streamable HTTP</option>
                  <option value="sse">SSE</option>
                </select>
              </div>

              <div className="space-y-2">
                <Label>Headers</Label>
                {headerRows.map((row, index) => (
                  <div key={index} className="flex gap-2">
                    <Input
                      value={row.name}
                      onChange={(event) =>
                        setHeaderRows((current) =>
                          current.map((entry, currentIndex) =>
                            currentIndex === index
                              ? { ...entry, name: event.target.value }
                              : entry,
                          ),
                        )
                      }
                      placeholder="Header name"
                    />
                    <Input
                      type="password"
                      value={row.value}
                      onChange={(event) =>
                        setHeaderRows((current) =>
                          current.map((entry, currentIndex) =>
                            currentIndex === index
                              ? { ...entry, value: event.target.value }
                              : entry,
                          ),
                        )
                      }
                      placeholder="Header value"
                    />
                    {headerRows.length > 1 ? (
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() =>
                          setHeaderRows((current) =>
                            current.filter((_, currentIndex) => currentIndex !== index),
                          )
                        }
                      >
                        Remove
                      </Button>
                    ) : null}
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    setHeaderRows((current) => [...current, { name: "", value: "" }])
                  }
                >
                  Add header
                </Button>
              </div>

              <Button onClick={handleStaticCreate} disabled={submittingStatic}>
                {submittingStatic ? "Creating..." : "Create static server"}
              </Button>
            </TabsContent>

            <TabsContent value="oauth" className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="oauth-name">Name</Label>
                  <Input
                    id="oauth-name"
                    value={oauthName}
                    onChange={(event) => setOauthName(event.target.value)}
                    placeholder="Vendor MCP"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="oauth-url">Server URL</Label>
                  <Input
                    id="oauth-url"
                    value={oauthUrl}
                    onChange={(event) => setOauthUrl(event.target.value)}
                    placeholder="https://mcp.example.com/mcp"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="oauth-transport">Transport</Label>
                <select
                  id="oauth-transport"
                  value={oauthTransport}
                  onChange={(event) => setOauthTransport(event.target.value)}
                  className="h-9 rounded-md border bg-background px-3 text-sm"
                >
                  <option value="streamable-http">Streamable HTTP</option>
                  <option value="sse">SSE</option>
                </select>
              </div>

              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <Label htmlFor="oauth-client-id">Client ID</Label>
                  <Input
                    id="oauth-client-id"
                    value={oauthClientId}
                    onChange={(event) => setOauthClientId(event.target.value)}
                    placeholder="OAuth client ID"
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleDiscoverOAuth}
                  disabled={discoveringOAuth}
                >
                  {discoveringOAuth ? "Discovering..." : "Auto-discover"}
                </Button>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="oauth-auth-endpoint">Authorization endpoint</Label>
                  <Input
                    id="oauth-auth-endpoint"
                    value={oauthAuthorizationEndpoint}
                    onChange={(event) =>
                      setOauthAuthorizationEndpoint(event.target.value)
                    }
                    placeholder="https://provider.example.com/oauth/authorize"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="oauth-token-endpoint">Token endpoint</Label>
                  <Input
                    id="oauth-token-endpoint"
                    value={oauthTokenEndpoint}
                    onChange={(event) => setOauthTokenEndpoint(event.target.value)}
                    placeholder="https://provider.example.com/oauth/token"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="oauth-scopes">Scopes</Label>
                <Input
                  id="oauth-scopes"
                  value={oauthScopes}
                  onChange={(event) => setOauthScopes(event.target.value)}
                  placeholder="openid profile"
                />
              </div>

              <Button onClick={handleOAuthCreate} disabled={submittingOAuth}>
                {submittingOAuth ? "Starting OAuth..." : "Create and connect"}
              </Button>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <div className="space-y-4">
        {servers.map((server) => (
          <Card key={server.id}>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <CardTitle>{server.name}</CardTitle>
                    <McpStatusBadge status={server.status} />
                    <Badge variant="outline">
                      {server.authType === "oauth" ? "OAuth" : "Static"}
                    </Badge>
                    <Badge variant="outline">{server.transport}</Badge>
                    {!server.enabled ? <Badge variant="outline">Disabled</Badge> : null}
                  </div>
                  <CardDescription className="break-all font-mono text-xs">
                    {server.serverUrl}
                  </CardDescription>
                </div>
                <div className="flex flex-wrap gap-2">
                  {server.authType === "oauth" && !server.connected ? (
                    <Button
                      onClick={() => handleConnect(server)}
                      disabled={busyServerId === server.id}
                    >
                      Connect
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    onClick={() => handleTest(server)}
                    disabled={
                      busyServerId === server.id ||
                      (server.authType === "oauth" && !server.connected)
                    }
                  >
                    {busyServerId === server.id ? "Working..." : "Test tools"}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => handleToggleEnabled(server)}
                    disabled={busyServerId === server.id}
                  >
                    {server.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => handleRemove(server)}
                    disabled={busyServerId === server.id}
                    className="text-destructive hover:text-destructive"
                  >
                    Remove
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Last test
                  </p>
                  <p className="mt-1 text-sm">{formatTimestamp(server.lastTestedAt)}</p>
                </div>
                {server.lastTestError ? (
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Last error
                    </p>
                    <p className="mt-1 text-sm text-destructive">
                      {server.lastTestError}
                    </p>
                  </div>
                ) : null}
              </div>
              <McpToolsList tools={server.lastDiscoveredTools} />
            </CardContent>
          </Card>
        ))}

        {servers.length === 0 ? (
          <Card>
            <CardContent className="py-8">
              <p className="text-sm text-muted-foreground">
                No custom MCP servers installed yet.
              </p>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
