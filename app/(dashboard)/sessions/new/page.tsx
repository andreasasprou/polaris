"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

type Repo = {
  id: string;
  owner: string;
  name: string;
};

type Secret = {
  id: string;
  provider: string;
  label: string;
};

const AGENT_TYPES = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "opencode", label: "OpenCode" },
  { value: "amp", label: "Amp" },
];

export default function NewSessionPage() {
  const router = useRouter();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [agentType, setAgentType] = useState("claude");
  const [repositoryId, setRepositoryId] = useState("");
  const [agentSecretId, setAgentSecretId] = useState("");
  const [prompt, setPrompt] = useState("");

  useEffect(() => {
    fetch("/api/repositories")
      .then((r) => r.json())
      .then((data) => setRepos(data.repositories ?? []))
      .catch(() => {});

    fetch("/api/secrets")
      .then((r) => r.json())
      .then((data) => setSecrets(data.secrets ?? []))
      .catch(() => {});
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch("/api/interactive-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentType,
          repositoryId: repositoryId || undefined,
          agentSecretId: agentSecretId || undefined,
          prompt,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Failed to create session");
      }

      const data = await res.json();
      router.push(`/sessions/${data.session.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div>
        <h1 className="text-2xl font-medium">New Session</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Start an interactive agent session.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Agent type */}
        <div>
          <label className="mb-1 block text-sm font-medium">Agent</label>
          <select
            value={agentType}
            onChange={(e) => setAgentType(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          >
            {AGENT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>

        {/* Repository (optional) */}
        <div>
          <label className="mb-1 block text-sm font-medium">
            Repository{" "}
            <span className="font-normal text-muted-foreground">
              (optional)
            </span>
          </label>
          <select
            value={repositoryId}
            onChange={(e) => setRepositoryId(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          >
            <option value="">No repository</option>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.owner}/{r.name}
              </option>
            ))}
          </select>
        </div>

        {/* API Key (optional) */}
        <div>
          <label className="mb-1 block text-sm font-medium">
            API Key{" "}
            <span className="font-normal text-muted-foreground">
              (optional — falls back to env)
            </span>
          </label>
          <select
            value={agentSecretId}
            onChange={(e) => setAgentSecretId(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          >
            <option value="">Use environment default</option>
            {secrets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} ({s.provider})
              </option>
            ))}
          </select>
        </div>

        {/* Prompt */}
        <div>
          <label className="mb-1 block text-sm font-medium">Prompt</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={6}
            placeholder="What do you want the agent to do?"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground"
            required
          />
        </div>

        {error && (
          <p className="text-sm text-red-600">{error}</p>
        )}

        <button
          type="submit"
          disabled={submitting || !prompt.trim()}
          className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {submitting ? "Starting..." : "Start Session"}
        </button>
      </form>
    </div>
  );
}
