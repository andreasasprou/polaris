"use client";

import { useState, useEffect, useCallback } from "react";

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
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-medium">API Keys</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage your AI provider API keys. Keys are encrypted at rest.
        </p>
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <form onSubmit={handleCreate} className="space-y-4 rounded-lg border border-border p-4">
        <h2 className="font-medium text-sm">Add API key</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor="provider" className="block text-sm font-medium">
              Provider
            </label>
            <select
              id="provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
            </select>
          </div>
          <div>
            <label htmlFor="label" className="block text-sm font-medium">
              Label
            </label>
            <input
              id="label"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="prod"
              required
              className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground"
            />
          </div>
          <div>
            <label htmlFor="value" className="block text-sm font-medium">
              API key
            </label>
            <input
              id="value"
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="sk-..."
              required
              className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground"
            />
          </div>
        </div>
        <button
          type="submit"
          disabled={loading}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {loading ? "Adding..." : "Add key"}
        </button>
      </form>

      {secrets.length > 0 && (
        <div className="space-y-2">
          {secrets.map((secret) => (
            <div
              key={secret.id}
              className="flex items-center justify-between rounded-lg border border-border p-3"
            >
              <div>
                <p className="text-sm font-medium">
                  {secret.provider} — {secret.label}
                </p>
                <p className="text-xs text-muted-foreground">
                  Added {new Date(secret.createdAt).toLocaleDateString()}
                </p>
              </div>
              <button
                onClick={() => handleRevoke(secret.id)}
                className="text-sm text-destructive hover:underline"
              >
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
