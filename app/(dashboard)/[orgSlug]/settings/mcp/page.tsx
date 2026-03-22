"use client";

import { useState, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { AlertCircleIcon, CheckCircleIcon } from "lucide-react";

type McpServer = {
  id: string;
  name: string;
  serverUrl: string;
  transport: string;
  authType: string;
  enabled: boolean;
  connected: boolean;
  oauthClientId: string | null;
  oauthAuthorizationEndpoint: string | null;
  oauthTokenEndpoint: string | null;
  oauthScopes: string | null;
  createdAt: string;
  updatedAt: string;
};

type HeaderRow = { name: string; value: string };

export default function McpServersPage() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Shared form fields
  const [name, setName] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [transport, setTransport] = useState("streamable-http");

  // Static-only fields
  const [headers, setHeaders] = useState<HeaderRow[]>([
    { name: "Authorization", value: "" },
  ]);

  // OAuth-only fields
  const [oauthClientId, setOauthClientId] = useState("");
  const [oauthAuthorizationEndpoint, setOauthAuthorizationEndpoint] =
    useState("");
  const [oauthTokenEndpoint, setOauthTokenEndpoint] = useState("");
  const [oauthScopes, setOauthScopes] = useState("");

  const loadServers = useCallback(async () => {
    const res = await fetch("/api/mcp-servers");
    const data = await res.json();
    setServers(data.servers ?? []);
  }, []);

  useEffect(() => {
    loadServers();

    const params = new URLSearchParams(window.location.search);
    if (params.get("success") === "connected") {
      setSuccess("MCP server connected successfully.");
      window.history.replaceState({}, "", "/settings/mcp");
    }
    const errorParam = params.get("error");
    if (errorParam) {
      setError(errorParam);
      window.history.replaceState({}, "", "/settings/mcp");
    }
  }, [loadServers]);

  function resetForm() {
    setName("");
    setServerUrl("");
    setTransport("streamable-http");
    setHeaders([{ name: "Authorization", value: "" }]);
    setOauthClientId("");
    setOauthAuthorizationEndpoint("");
    setOauthTokenEndpoint("");
    setOauthScopes("");
  }

  async function handleCreate(authType: "static" | "oauth") {
    const headerObj: Record<string, string> = {};
    if (authType === "static") {
      for (const h of headers) {
        if (h.name.trim() && h.value.trim()) {
          headerObj[h.name.trim()] = h.value.trim();
        }
      }
    }

    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await fetch("/api/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          serverUrl,
          transport,
          authType,
          ...(authType === "static"
            ? { headers: headerObj }
            : {
                oauthClientId,
                oauthAuthorizationEndpoint,
                oauthTokenEndpoint,
                oauthScopes: oauthScopes || undefined,
              }),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Failed to add server");
      }

      resetForm();
      loadServers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    await fetch(`/api/mcp-servers/${id}`, { method: "DELETE" });
    loadServers();
  }

  async function handleToggleEnabled(id: string, enabled: boolean) {
    await fetch(`/api/mcp-servers/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    loadServers();
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-medium">MCP Servers</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect external tools to agent sessions. Servers are available to all
          sessions in this workspace.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {success && (
        <Alert>
          <CheckCircleIcon />
          <AlertDescription>{success}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Add server</CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="static">
            <TabsList className="mb-4 w-full">
              <TabsTrigger value="static">Static Headers</TabsTrigger>
              <TabsTrigger value="oauth">OAuth</TabsTrigger>
            </TabsList>

            {/* Shared fields rendered once */}
            <div className="flex flex-col gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="name">Name</Label>
                  <Input
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Sentry Production"
                    required
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="serverUrl">URL</Label>
                  <Input
                    id="serverUrl"
                    value={serverUrl}
                    onChange={(e) => setServerUrl(e.target.value)}
                    placeholder="https://mcp.example.com/sse"
                    required
                  />
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="transport">Transport</Label>
                <select
                  id="transport"
                  value={transport}
                  onChange={(e) => setTransport(e.target.value)}
                  className="h-9 rounded-md border bg-background px-3 text-sm"
                >
                  <option value="streamable-http">Streamable HTTP</option>
                  <option value="sse">SSE</option>
                </select>
              </div>

              {/* Static-only fields */}
              <TabsContent value="static" className="mt-0 flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Label>Headers</Label>
                  {headers.map((h, i) => (
                    <div key={i} className="flex gap-2">
                      <Input
                        value={h.name}
                        onChange={(e) => {
                          const updated = [...headers];
                          updated[i] = { ...updated[i], name: e.target.value };
                          setHeaders(updated);
                        }}
                        placeholder="Header name"
                        className="flex-1"
                      />
                      <Input
                        type="password"
                        value={h.value}
                        onChange={(e) => {
                          const updated = [...headers];
                          updated[i] = {
                            ...updated[i],
                            value: e.target.value,
                          };
                          setHeaders(updated);
                        }}
                        placeholder="Header value"
                        className="flex-1"
                      />
                      {headers.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setHeaders(headers.filter((_, j) => j !== i))
                          }
                        >
                          &times;
                        </Button>
                      )}
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-fit"
                    onClick={() =>
                      setHeaders([...headers, { name: "", value: "" }])
                    }
                  >
                    Add header
                  </Button>
                </div>
                <div>
                  <Button
                    disabled={loading}
                    onClick={() => handleCreate("static")}
                  >
                    {loading ? "Adding..." : "Add server"}
                  </Button>
                </div>
              </TabsContent>

              {/* OAuth-only fields */}
              <TabsContent value="oauth" className="mt-0 flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="oauthClientId">Client ID</Label>
                  <Input
                    id="oauthClientId"
                    value={oauthClientId}
                    onChange={(e) => setOauthClientId(e.target.value)}
                    placeholder="From provider's developer console"
                    required
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="oauthAuthEndpoint">Authorization URL</Label>
                    <Input
                      id="oauthAuthEndpoint"
                      value={oauthAuthorizationEndpoint}
                      onChange={(e) =>
                        setOauthAuthorizationEndpoint(e.target.value)
                      }
                      placeholder="https://sentry.io/oauth/authorize"
                      required
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="oauthTokenEndpoint">Token URL</Label>
                    <Input
                      id="oauthTokenEndpoint"
                      value={oauthTokenEndpoint}
                      onChange={(e) => setOauthTokenEndpoint(e.target.value)}
                      placeholder="https://sentry.io/oauth/token"
                      required
                    />
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="oauthScopes">Scopes (optional)</Label>
                  <Input
                    id="oauthScopes"
                    value={oauthScopes}
                    onChange={(e) => setOauthScopes(e.target.value)}
                    placeholder="openid profile (space-separated)"
                  />
                </div>
                <div>
                  <Button
                    disabled={loading}
                    onClick={() => handleCreate("oauth")}
                  >
                    {loading ? "Adding..." : "Add OAuth server"}
                  </Button>
                </div>
              </TabsContent>
            </div>
          </Tabs>
        </CardContent>
      </Card>

      {servers.length > 0 && (
        <div className="flex flex-col gap-2">
          {servers.map((server) => (
            <Card key={server.id}>
              <CardContent className="flex items-center justify-between py-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{server.name}</p>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      {server.authType === "static" ? "Static" : "OAuth"}
                    </span>
                    {server.authType === "oauth" && (
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${
                          server.connected
                            ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300"
                            : "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300"
                        }`}
                      >
                        {server.connected ? "Connected" : "Not connected"}
                      </span>
                    )}
                  </div>
                  <p className="text-xs font-mono text-muted-foreground truncate max-w-sm">
                    {server.serverUrl}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {server.authType === "oauth" && !server.connected && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        (window.location.href = `/api/mcp-servers/oauth/start?serverId=${server.id}`)
                      }
                    >
                      Connect
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      handleToggleEnabled(server.id, !server.enabled)
                    }
                    className="text-xs"
                  >
                    {server.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDelete(server.id)}
                    className="text-destructive hover:text-destructive"
                  >
                    Remove
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
