"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AlertCircleIcon, CopyIcon, CheckIcon } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const CODEX_AUTH_FILE_CMD = `base64 < ~/.codex/auth.json | tr -d '\\n' | pbcopy`;
const CODEX_AUTH_KEYCHAIN_CMD = `security find-generic-password -s "Codex Auth" -w | base64 | tr -d '\\n' | pbcopy`;

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-6 w-6 shrink-0 p-0 text-muted-foreground hover:text-foreground"
      onClick={handleCopy}
      aria-label={copied ? "Copied" : "Copy command"}
    >
      {copied ? (
        <CheckIcon className="h-3.5 w-3.5" />
      ) : (
        <CopyIcon className="h-3.5 w-3.5" />
      )}
    </Button>
  );
}

function CodexOAuthInstructions() {
  return (
    <div className="rounded-md border border-border bg-muted/50 p-3 text-xs text-muted-foreground">
      <p className="mb-2">
        Run{" "}
        <code className="rounded bg-muted px-1 py-0.5 font-mono">
          codex auth
        </code>{" "}
        first if you haven&apos;t authenticated with ChatGPT, then paste the
        output of one of these commands:
      </p>
      <div className="flex flex-col gap-1.5">
        <div>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
            From file
          </p>
          <div className="flex items-center gap-2 rounded bg-muted px-3 py-2 font-mono">
            <code className="flex-1 select-all break-all text-foreground">
              {CODEX_AUTH_FILE_CMD}
            </code>
            <CopyButton text={CODEX_AUTH_FILE_CMD} />
          </div>
        </div>
        <div>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
            From macOS Keychain
          </p>
          <div className="flex items-center gap-2 rounded bg-muted px-3 py-2 font-mono">
            <code className="flex-1 select-all break-all text-foreground">
              {CODEX_AUTH_KEYCHAIN_CMD}
            </code>
            <CopyButton text={CODEX_AUTH_KEYCHAIN_CMD} />
          </div>
        </div>
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground/70">
        Note: OAuth tokens are single-use. If you use Codex locally after
        saving, you may need to re-export.
      </p>
    </div>
  );
}

type Secret = {
  id: string;
  provider: string;
  label: string;
  createdAt: string;
};

export default function SecretsPage() {
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [provider, setProvider] = useState("anthropic");
  const [openaiMode, setOpenaiMode] = useState<"api-key" | "chatgpt-oauth">(
    "api-key",
  );
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Inline edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [editLoading, setEditLoading] = useState(false);

  const loadSecrets = useCallback(async () => {
    const res = await fetch("/api/secrets");
    const data = await res.json();
    setSecrets(data.secrets ?? []);
  }, []);

  useEffect(() => {
    loadSecrets();
  }, [loadSecrets]);

  // Reset OpenAI mode when switching providers
  useEffect(() => {
    if (provider !== "openai") {
      setOpenaiMode("api-key");
    }
    setValue("");
  }, [provider]);

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
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-medium">API Keys</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage your AI provider API keys. Keys are encrypted at rest.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

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
                onValueChange={(v) =>
                  setOpenaiMode(v as "api-key" | "chatgpt-oauth")
                }
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
                        className="font-mono text-xs"
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
                          className="font-mono text-xs"
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
