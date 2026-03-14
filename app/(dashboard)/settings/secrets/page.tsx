"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircleIcon, CopyIcon, CheckIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const CODEX_AUTH_COMMAND = `base64 < ~/.codex/auth.json | tr -d '\\n'`;

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
      className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
      onClick={handleCopy}
    >
      {copied ? (
        <CheckIcon className="h-3.5 w-3.5" />
      ) : (
        <CopyIcon className="h-3.5 w-3.5" />
      )}
    </Button>
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
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSecrets = useCallback(async () => {
    const res = await fetch("/api/secrets");
    const data = await res.json();
    setSecrets(data.secrets ?? []);
  }, []);

  useEffect(() => {
    loadSecrets();
  }, [loadSecrets]);

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
            <div className="grid gap-4 sm:grid-cols-3">
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
            </div>
            {provider === "openai" && (
              <Collapsible>
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="text-xs text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground"
                  >
                    Using ChatGPT OAuth instead of an API key?
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="mt-2 rounded-md border border-border bg-muted/50 p-3 text-xs text-muted-foreground">
                    <p className="mb-2">
                      You can authenticate Codex with your ChatGPT account
                      instead of an API key. Run{" "}
                      <code className="rounded bg-muted px-1 py-0.5 font-mono">
                        codex auth
                      </code>{" "}
                      locally, then paste the output of:
                    </p>
                    <div className="flex items-center gap-2 rounded bg-muted px-3 py-2 font-mono">
                      <code className="flex-1 select-all text-foreground">
                        {CODEX_AUTH_COMMAND}
                      </code>
                      <CopyButton text={CODEX_AUTH_COMMAND} />
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>
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
              <CardContent className="flex items-center justify-between py-3">
                <div>
                  <p className="text-sm font-medium">
                    {secret.provider} — {secret.label}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Added {new Date(secret.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleRevoke(secret.id)}
                  className="text-destructive hover:text-destructive"
                >
                  Revoke
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
