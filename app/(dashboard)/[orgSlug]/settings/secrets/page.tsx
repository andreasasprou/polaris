"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AlertCircleIcon, ChevronDownIcon, ChevronRightIcon, RefreshCwIcon } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { CodexOAuthInstructions } from "@/components/codex-oauth-instructions";

type Secret = {
  id: string;
  provider: string;
  label: string;
  createdAt: string;
};

type Pool = {
  id: string;
  name: string;
  provider: string;
  activeKeyCount: number;
  createdAt: string;
};

type PoolMember = {
  id: string;
  secretId: string;
  enabled: boolean;
  lastSelectedAt: string | null;
  secretLabel: string;
  secretProvider: string;
  secretRevokedAt: string | null;
};

export default function SecretsPage() {
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [pools, setPools] = useState<Pool[]>([]);
  const [provider, setProvider] = useState("anthropic");
  const [openaiMode, setOpenaiMode] = useState<"api-key" | "chatgpt-oauth">("api-key");
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Inline edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editLoading, setEditLoading] = useState(false);

  // Pool creation state
  const [showPoolForm, setShowPoolForm] = useState(false);
  const [poolName, setPoolName] = useState("");
  const [poolProvider, setPoolProvider] = useState("anthropic");
  const [poolLoading, setPoolLoading] = useState(false);

  // Pool expansion state
  const [expandedPoolId, setExpandedPoolId] = useState<string | null>(null);
  const [poolMembers, setPoolMembers] = useState<PoolMember[]>([]);

  // Add-to-pool state
  const [addingToPoolId, setAddingToPoolId] = useState<string | null>(null);
  const [addSecretId, setAddSecretId] = useState("");

  const loadSecrets = useCallback(async () => {
    const res = await fetch("/api/secrets");
    const data = await res.json();
    setSecrets(data.secrets ?? []);
  }, []);

  const loadPools = useCallback(async () => {
    const res = await fetch("/api/key-pools");
    const data = await res.json();
    setPools(data.pools ?? []);
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only data load
  useEffect(() => {
    loadSecrets();
    loadPools();
  }, []); // stable callbacks, mount-only

  useEffect(() => {
    if (provider !== "openai") setOpenaiMode("api-key");
    setValue("");
  }, [provider]);

  async function loadPoolMembers(poolId: string) {
    const res = await fetch(`/api/key-pools/${poolId}`);
    const data = await res.json();
    setPoolMembers(data.members ?? []);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/secrets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, label, value }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Failed to create secret");
      }
      setLabel("");
      setValue("");
      loadSecrets();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function handleUpdate(id: string) {
    setEditLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/secrets/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: editValue }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Failed to update secret");
      }
      setEditingId(null);
      setEditValue("");
      loadSecrets();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setEditLoading(false);
    }
  }

  async function handleRevoke(id: string) {
    await fetch(`/api/secrets/${id}`, { method: "DELETE" });
    loadSecrets();
    loadPools(); // Refresh pool counts
  }

  async function handleCreatePool(e: React.FormEvent) {
    e.preventDefault();
    setPoolLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/key-pools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: poolName, provider: poolProvider }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Failed to create pool");
      }
      setPoolName("");
      setShowPoolForm(false);
      loadPools();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setPoolLoading(false);
    }
  }

  async function handleDeletePool(poolId: string) {
    setError(null);
    const res = await fetch(`/api/key-pools/${poolId}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json();
      setError(data.error ?? "Failed to delete pool");
      return;
    }
    if (expandedPoolId === poolId) setExpandedPoolId(null);
    loadPools();
  }

  async function handleAddToPool(poolId: string) {
    setError(null);
    const res = await fetch(`/api/key-pools/${poolId}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secretId: addSecretId }),
    });
    if (!res.ok) {
      const data = await res.json();
      setError(data.error ?? "Failed to add key to pool");
      return;
    }
    setAddSecretId("");
    setAddingToPoolId(null);
    loadPoolMembers(poolId);
    loadPools();
  }

  async function handleRemoveFromPool(poolId: string, secretId: string) {
    setError(null);
    const res = await fetch(`/api/key-pools/${poolId}/members/${secretId}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to remove key from pool");
      return;
    }
    loadPoolMembers(poolId);
    loadPools();
  }

  async function handleToggleMember(poolId: string, secretId: string, enabled: boolean) {
    setError(null);
    const res = await fetch(`/api/key-pools/${poolId}/members/${secretId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to update pool member");
      return;
    }
    loadPoolMembers(poolId);
    loadPools();
  }

  function togglePool(poolId: string) {
    if (expandedPoolId === poolId) {
      setExpandedPoolId(null);
    } else {
      setExpandedPoolId(poolId);
      setPoolMembers([]); // Clear stale members from previously expanded pool
      loadPoolMembers(poolId);
    }
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-medium">API Keys</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage your AI provider API keys and key pools. Keys are encrypted at rest.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Key Pools Section */}
      {(pools.length > 0 || showPoolForm) && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <RefreshCwIcon className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-medium">Key Pools</h2>
            <span className="text-xs text-muted-foreground">
              Rotate across multiple keys automatically
            </span>
          </div>

          {pools.map((pool) => (
            <Card key={pool.id}>
              <CardContent className="py-3">
                <div
                  className="flex cursor-pointer items-center justify-between"
                  onClick={() => togglePool(pool.id)}
                >
                  <div className="flex items-center gap-2">
                    {expandedPoolId === pool.id ? (
                      <ChevronDownIcon className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronRightIcon className="h-4 w-4 text-muted-foreground" />
                    )}
                    <div>
                      <p className="text-sm font-medium">{pool.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {pool.provider} &middot; {pool.activeKeyCount} active {pool.activeKeyCount === 1 ? "key" : "keys"}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeletePool(pool.id);
                    }}
                  >
                    Delete
                  </Button>
                </div>

                {expandedPoolId === pool.id && (
                  <div className="mt-3 flex flex-col gap-2 border-t pt-3">
                    {poolMembers.length === 0 && (
                      <p className="text-xs text-muted-foreground">No keys in this pool yet.</p>
                    )}
                    {poolMembers.map((member) => (
                      <div
                        key={member.secretId}
                        className="flex items-center justify-between rounded border px-3 py-2"
                      >
                        <div className="flex items-center gap-3">
                          <Switch
                            checked={member.enabled && !member.secretRevokedAt}
                            disabled={!!member.secretRevokedAt}
                            onCheckedChange={(enabled) =>
                              handleToggleMember(pool.id, member.secretId, enabled)
                            }
                          />
                          <div>
                            <p className="text-sm">
                              {member.secretLabel}
                              {member.secretRevokedAt && (
                                <span className="ml-2 text-xs text-destructive">(revoked)</span>
                              )}
                            </p>
                            {member.lastSelectedAt && (
                              <p className="text-xs text-muted-foreground">
                                Last used {new Date(member.lastSelectedAt).toLocaleString()}
                              </p>
                            )}
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRemoveFromPool(pool.id, member.secretId)}
                        >
                          Remove
                        </Button>
                      </div>
                    ))}

                    {addingToPoolId === pool.id ? (
                      <div className="flex items-center gap-2">
                        <Select value={addSecretId} onValueChange={setAddSecretId}>
                          <SelectTrigger className="flex-1">
                            <SelectValue placeholder="Select a key..." />
                          </SelectTrigger>
                          <SelectContent>
                            {secrets
                              .filter((s) => s.provider === pool.provider)
                              .filter((s) => !poolMembers.some((m) => m.secretId === s.id))
                              .map((s) => (
                                <SelectItem key={s.id} value={s.id}>
                                  {s.label}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                        <Button
                          size="sm"
                          disabled={!addSecretId}
                          onClick={() => handleAddToPool(pool.id)}
                        >
                          Add
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => { setAddingToPoolId(null); setAddSecretId(""); }}
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-fit"
                        onClick={() => { setAddingToPoolId(pool.id); setAddSecretId(""); }}
                      >
                        Add key to pool
                      </Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}

          {showPoolForm && (
            <Card>
              <CardContent className="py-3">
                <form onSubmit={handleCreatePool} className="flex flex-col gap-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="pool-name">Pool name</Label>
                      <Input
                        id="pool-name"
                        value={poolName}
                        onChange={(e) => setPoolName(e.target.value)}
                        placeholder="Production Claude Keys"
                        required
                      />
                    </div>
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="pool-provider">Provider</Label>
                      <Select value={poolProvider} onValueChange={setPoolProvider}>
                        <SelectTrigger id="pool-provider">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="anthropic">Anthropic</SelectItem>
                          <SelectItem value="openai">OpenAI</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" disabled={poolLoading}>
                      {poolLoading ? "Creating..." : "Create pool"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => { setShowPoolForm(false); setPoolName(""); }}
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-2">
        {!showPoolForm && (
          <Button variant="outline" size="sm" onClick={() => setShowPoolForm(true)}>
            Create key pool
          </Button>
        )}
      </div>

      {/* Add API Key Form */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Add API key</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreate} className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="provider">Provider</Label>
                <Select value={provider} onValueChange={setProvider}>
                  <SelectTrigger id="provider">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="anthropic">Anthropic</SelectItem>
                      <SelectItem value="openai">OpenAI</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="label">Label</Label>
                <Input
                  id="label"
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="prod"
                  required
                />
              </div>
            </div>

            {provider === "openai" ? (
              <Tabs
                value={openaiMode}
                onValueChange={(v) => setOpenaiMode(v as "api-key" | "chatgpt-oauth")}
              >
                <TabsList>
                  <TabsTrigger value="api-key">API Key</TabsTrigger>
                  <TabsTrigger value="chatgpt-oauth">ChatGPT OAuth</TabsTrigger>
                </TabsList>
                <TabsContent value="api-key">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="value">API key</Label>
                    <Input
                      id="value"
                      type="password"
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                      placeholder="sk-..."
                      required
                    />
                  </div>
                </TabsContent>
                <TabsContent value="chatgpt-oauth">
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="value-oauth">Base64 auth.json</Label>
                      <Textarea
                        id="value-oauth"
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        placeholder="Paste base64-encoded auth.json..."
                        className="max-h-32 font-mono text-xs"
                        rows={3}
                        required
                      />
                    </div>
                    <CodexOAuthInstructions />
                  </div>
                </TabsContent>
              </Tabs>
            ) : (
              <div className="flex flex-col gap-2">
                <Label htmlFor="value">API key</Label>
                <Input
                  id="value"
                  type="password"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="sk-ant-..."
                  required
                />
              </div>
            )}

            <div>
              <Button type="submit" disabled={loading}>
                {loading ? "Adding..." : "Add key"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Individual Keys List */}
      {secrets.length > 0 && (
        <div className="flex flex-col gap-2">
          {secrets.map((secret) => (
            <Card key={secret.id}>
              <CardContent className="flex flex-col gap-3 py-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">
                      {secret.provider} — {secret.label}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Added {new Date(secret.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    {editingId !== secret.id && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setEditingId(secret.id);
                          setEditValue("");
                          setError(null);
                        }}
                      >
                        Update
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRevoke(secret.id)}
                      className="text-destructive hover:text-destructive"
                    >
                      Revoke
                    </Button>
                  </div>
                </div>

                {editingId === secret.id && (
                  <div className="flex flex-col gap-3 border-t pt-3">
                    {secret.provider === "openai" ? (
                      <>
                        <Textarea
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          placeholder="Paste API key (sk-...) or base64 auth.json"
                          className="max-h-32 font-mono text-xs"
                          rows={3}
                        />
                        <CodexOAuthInstructions />
                      </>
                    ) : (
                      <>
                        <Input
                          type="password"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          placeholder="sk-ant-..."
                        />
                        <p className="text-xs text-muted-foreground">
                          Get your API key from the{" "}
                          <a
                            href="https://console.anthropic.com/settings/keys"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline hover:text-foreground"
                          >
                            Anthropic Console
                          </a>
                          .
                        </p>
                      </>
                    )}
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        disabled={editLoading || !editValue}
                        onClick={() => handleUpdate(secret.id)}
                      >
                        {editLoading ? "Saving..." : "Save"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEditingId(null);
                          setEditValue("");
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
