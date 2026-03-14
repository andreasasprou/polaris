"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircleIcon } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getEnabledAgents } from "@/lib/sandbox-agent/agent-profiles";

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

const AGENT_TYPES = getEnabledAgents();

export default function NewSessionPage() {
  const router = useRouter();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [agentType, setAgentType] = useState("claude");
  const [repositoryId, setRepositoryId] = useState("__none__");
  const [agentSecretId, setAgentSecretId] = useState("__none__");
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
          repositoryId: repositoryId === "__none__" ? undefined : repositoryId,
          agentSecretId: agentSecretId === "__none__" ? undefined : agentSecretId,
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
    <div className="mx-auto max-w-xl flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-medium">New Session</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Start an interactive agent session.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Session Configuration</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="agent">Agent</Label>
              <Select value={agentType} onValueChange={setAgentType}>
                <SelectTrigger id="agent">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {AGENT_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="repository">
                Repository{" "}
                <span className="font-normal text-muted-foreground">
                  (optional)
                </span>
              </Label>
              <Select value={repositoryId} onValueChange={setRepositoryId}>
                <SelectTrigger id="repository">
                  <SelectValue placeholder="No repository" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="__none__">No repository</SelectItem>
                    {repos.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.owner}/{r.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="apiKey">
                API Key{" "}
                <span className="font-normal text-muted-foreground">
                  (optional — falls back to env)
                </span>
              </Label>
              <Select value={agentSecretId} onValueChange={setAgentSecretId}>
                <SelectTrigger id="apiKey">
                  <SelectValue placeholder="Use environment default" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="__none__">Use environment default</SelectItem>
                    {secrets.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.label} ({s.provider})
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="prompt">Prompt</Label>
              <Textarea
                id="prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={6}
                placeholder="What do you want the agent to do?"
                required
              />
            </div>

            {error && (
              <Alert variant="destructive">
                <AlertCircleIcon />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <Button
              type="submit"
              disabled={submitting || !prompt.trim()}
              className="w-full"
            >
              {submitting ? "Starting..." : "Start Session"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
