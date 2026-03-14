"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import {
  getModels,
  getModes,
  getThoughtLevels,
} from "@/lib/sandbox-agent/agent-profiles";
import type { AgentType } from "@/lib/sandbox-agent/types";

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
  agentMode: string;
  repositoryId: string;
  agentSecretId: string;
  maxDurationSeconds: number;
  allowPush: boolean;
  allowPrCreate: boolean;
  mode: string;
  modelParams: Record<string, unknown>;
  prReviewConfig: Record<string, unknown>;
};

const CONTINUOUS_EVENTS = [
  "pull_request.opened",
  "pull_request.synchronize",
  "pull_request.ready_for_review",
  "pull_request.reopened",
];

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
  const [mode, setMode] = useState(initial?.mode ?? "oneshot");
  const [events, setEvents] = useState(
    (initial?.triggerConfig?.events as string[])?.join(", ") ?? "push",
  );
  const [branches, setBranches] = useState(
    (initial?.triggerConfig?.branches as string[])?.join(", ") ?? "main",
  );
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [agentType, setAgentType] = useState(initial?.agentType ?? "claude");
  const [model, setModel] = useState(initial?.model ?? "");
  const [effortLevel, setEffortLevel] = useState(
    (initial?.modelParams?.effortLevel as string) ?? "",
  );
  const [repositoryId, setRepositoryId] = useState(initial?.repositoryId || "__none__");
  const [agentSecretId, setAgentSecretId] = useState(initial?.agentSecretId || "__none__");

  // Review config (continuous mode only)
  const prReviewConfig = initial?.prReviewConfig ?? {};
  const [skipDrafts, setSkipDrafts] = useState(
    (prReviewConfig as Record<string, unknown>).skipDrafts !== false,
  );
  const [skipBots, setSkipBots] = useState(
    (prReviewConfig as Record<string, unknown>).skipBots !== false,
  );
  const [ignorePaths, setIgnorePaths] = useState(
    ((prReviewConfig as Record<string, unknown>).ignorePaths as string[])?.join(", ") ?? "",
  );

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Dynamic options based on agent type
  const models = useMemo(() => getModels(agentType as AgentType), [agentType]);
  const thoughtLevels = useMemo(() => getThoughtLevels(agentType as AgentType), [agentType]);

  // Reset model/effort when agent type changes if current value is invalid
  const handleAgentTypeChange = (newType: string) => {
    setAgentType(newType);
    const newModels = getModels(newType as AgentType);
    if (model && newModels.length > 0 && !newModels.includes(model)) {
      setModel("");
    }
    const newLevels = getThoughtLevels(newType as AgentType);
    if (effortLevel && (!newLevels || !newLevels.includes(effortLevel))) {
      setEffortLevel("");
    }
  };

  const handleModeChange = (newMode: string) => {
    setMode(newMode);
    if (newMode === "continuous") {
      setEvents(CONTINUOUS_EVENTS.join(", "));
    }
  };

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const body: Record<string, unknown> = {
      name,
      triggerType,
      triggerConfig: {
        events: events.split(",").map((e) => e.trim()).filter(Boolean),
        branches: branches.split(",").map((b) => b.trim()).filter(Boolean),
      },
      prompt,
      agentType,
      model: model || undefined,
      repositoryId: repositoryId === "__none__" ? undefined : repositoryId,
      agentSecretId: agentSecretId === "__none__" ? undefined : agentSecretId,
      mode,
      modelParams: effortLevel ? { effortLevel } : {},
    };

    if (mode === "continuous") {
      body.prReviewConfig = {
        skipDrafts,
        skipBots,
        ignorePaths: ignorePaths
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean),
      };
    }

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
    <form onSubmit={handleSubmit} className="flex max-w-2xl flex-col gap-6">
      {error && (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-2">
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Review PRs on push"
          required
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="mode">Mode</Label>
        <Select value={mode} onValueChange={handleModeChange}>
          <SelectTrigger id="mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="oneshot">One-shot (coding task)</SelectItem>
              <SelectItem value="continuous">Continuous (PR review)</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        {mode === "continuous" && (
          <p className="text-xs text-muted-foreground">
            Code review agents run in read-only mode automatically.
          </p>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="events">GitHub events</Label>
          <Input
            id="events"
            type="text"
            value={events}
            onChange={(e) => setEvents(e.target.value)}
            placeholder="push, pull_request.opened"
            disabled={mode === "continuous"}
          />
          <p className="text-xs text-muted-foreground">Comma-separated</p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="branches">Branch filter</Label>
          <Input
            id="branches"
            type="text"
            value={branches}
            onChange={(e) => setBranches(e.target.value)}
            placeholder="main, develop"
          />
          <p className="text-xs text-muted-foreground">
            Leave empty for all branches
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="prompt">Instructions</Label>
        <Textarea
          id="prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={
            mode === "continuous"
              ? "Review this PR for bugs, security issues, and design problems..."
              : "Review the code changes and create a PR with improvements..."
          }
          required
          rows={6}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="repository">Repository</Label>
          <Select value={repositoryId} onValueChange={setRepositoryId}>
            <SelectTrigger id="repository">
              <SelectValue placeholder="Select a repository" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="__none__">Select a repository</SelectItem>
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
          <Label htmlFor="secret">API key</Label>
          <Select value={agentSecretId} onValueChange={setAgentSecretId}>
            <SelectTrigger id="secret">
              <SelectValue placeholder="Select an API key" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="__none__">Select an API key</SelectItem>
                {secrets.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.provider} — {s.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="agentType">Agent</Label>
        <Select value={agentType} onValueChange={handleAgentTypeChange}>
          <SelectTrigger id="agentType">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="claude">Claude Code</SelectItem>
              <SelectItem value="codex">Codex</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {models.length > 0 && (
          <div className="flex flex-col gap-2">
            <Label htmlFor="model">Model</Label>
            <Select value={model || "__default__"} onValueChange={(v) => setModel(v === "__default__" ? "" : v)}>
              <SelectTrigger id="model">
                <SelectValue placeholder="Default" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="__default__">Default</SelectItem>
                  {models.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        )}

        {thoughtLevels && thoughtLevels.length > 0 && (
          <div className="flex flex-col gap-2">
            <Label htmlFor="effortLevel">Effort level</Label>
            <Select value={effortLevel || "__default__"} onValueChange={(v) => setEffortLevel(v === "__default__" ? "" : v)}>
              <SelectTrigger id="effortLevel">
                <SelectValue placeholder="Default" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="__default__">Default</SelectItem>
                  {thoughtLevels.map((l) => (
                    <SelectItem key={l} value={l}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {mode === "continuous" && (
        <fieldset className="flex flex-col gap-4 rounded-md border p-4">
          <legend className="px-2 text-sm font-medium">Review settings</legend>

          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={skipDrafts}
                onChange={(e) => setSkipDrafts(e.target.checked)}
                className="rounded"
              />
              Skip draft PRs
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={skipBots}
                onChange={(e) => setSkipBots(e.target.checked)}
                className="rounded"
              />
              Skip bot PRs
            </label>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="ignorePaths">Ignore paths</Label>
            <Input
              id="ignorePaths"
              type="text"
              value={ignorePaths}
              onChange={(e) => setIgnorePaths(e.target.value)}
              placeholder="*.lock, dist/**, docs/**"
            />
            <p className="text-xs text-muted-foreground">
              Comma-separated glob patterns for files to skip in reviews
            </p>
          </div>
        </fieldset>
      )}

      <div className="flex gap-3">
        <Button type="submit" disabled={loading}>
          {loading ? "Saving..." : isEdit ? "Update automation" : "Create automation"}
        </Button>
        <Button type="button" variant="outline" onClick={() => router.back()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
