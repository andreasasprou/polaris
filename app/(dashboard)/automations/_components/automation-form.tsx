"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Repo = {
  id: string;
  owner: string;
  name: string;
  defaultBranch: string;
};

type Secret = {
  id: string;
  provider: string;
  label: string;
};

type AutomationData = {
  id?: string;
  name: string;
  triggerType: string;
  triggerConfig: Record<string, unknown>;
  prompt: string;
  agentType: string;
  model: string;
  repositoryId: string;
  agentSecretId: string;
  maxDurationSeconds: number;
  allowPush: boolean;
  allowPrCreate: boolean;
};

export function AutomationForm({
  repos,
  secrets,
  initial,
}: {
  repos: Repo[];
  secrets: Secret[];
  initial?: AutomationData;
}) {
  const router = useRouter();
  const isEdit = !!initial?.id;

  const [name, setName] = useState(initial?.name ?? "");
  const [triggerType] = useState(initial?.triggerType ?? "github");
  const [events, setEvents] = useState(
    (initial?.triggerConfig?.events as string[])?.join(", ") ?? "push",
  );
  const [branches, setBranches] = useState(
    (initial?.triggerConfig?.branches as string[])?.join(", ") ?? "main",
  );
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [agentType, setAgentType] = useState(initial?.agentType ?? "claude");
  const [repositoryId, setRepositoryId] = useState(initial?.repositoryId ?? "");
  const [agentSecretId, setAgentSecretId] = useState(initial?.agentSecretId ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const body = {
      name,
      triggerType,
      triggerConfig: {
        events: events.split(",").map((e) => e.trim()).filter(Boolean),
        branches: branches.split(",").map((b) => b.trim()).filter(Boolean),
      },
      prompt,
      agentType,
      repositoryId: repositoryId || undefined,
      agentSecretId: agentSecretId || undefined,
    };

    try {
      const url = isEdit ? `/api/automations/${initial!.id}` : "/api/automations";
      const method = isEdit ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Failed to save automation");
      }

      router.push("/automations");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-2xl">
      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div>
        <label htmlFor="name" className="block text-sm font-medium">
          Name
        </label>
        <input
          id="name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Review PRs on push"
          required
          className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="events" className="block text-sm font-medium">
            GitHub events
          </label>
          <input
            id="events"
            type="text"
            value={events}
            onChange={(e) => setEvents(e.target.value)}
            placeholder="push, pull_request.opened"
            className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <p className="mt-1 text-xs text-muted-foreground">Comma-separated</p>
        </div>
        <div>
          <label htmlFor="branches" className="block text-sm font-medium">
            Branch filter
          </label>
          <input
            id="branches"
            type="text"
            value={branches}
            onChange={(e) => setBranches(e.target.value)}
            placeholder="main, develop"
            className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Leave empty for all branches
          </p>
        </div>
      </div>

      <div>
        <label htmlFor="prompt" className="block text-sm font-medium">
          Instructions
        </label>
        <textarea
          id="prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Review the code changes and create a PR with improvements..."
          required
          rows={6}
          className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="repository" className="block text-sm font-medium">
            Repository
          </label>
          <select
            id="repository"
            value={repositoryId}
            onChange={(e) => setRepositoryId(e.target.value)}
            className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="">Select a repository</option>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.owner}/{r.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="secret" className="block text-sm font-medium">
            API key
          </label>
          <select
            id="secret"
            value={agentSecretId}
            onChange={(e) => setAgentSecretId(e.target.value)}
            className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="">Select an API key</option>
            {secrets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.provider} — {s.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label htmlFor="agentType" className="block text-sm font-medium">
          Agent
        </label>
        <select
          id="agentType"
          value={agentType}
          onChange={(e) => setAgentType(e.target.value)}
          className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        >
          <option value="claude">Claude Code</option>
          <option value="codex">Codex</option>
        </select>
      </div>

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={loading}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {loading ? "Saving..." : isEdit ? "Update automation" : "Create automation"}
        </button>
        <button
          type="button"
          onClick={() => router.back()}
          className="rounded-md border border-input px-4 py-2 text-sm font-medium hover:bg-accent"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
