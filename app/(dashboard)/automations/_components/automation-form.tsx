"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Switch } from "@/components/ui/switch";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
  FieldSet,
  FieldLegend,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type EffortLevel,
  getModels,
  getModes,
  getThoughtLevels,
  getCompatibleProviders,
  getEnabledAgents,
} from "@/lib/sandbox-agent/agent-profiles";
import type { AgentType, ModelParams } from "@/lib/sandbox-agent/types";
import { AlertCircleIcon } from "lucide-react";
import Link from "next/link";

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

type Pool = {
  id: string;
  name: string;
  provider: string;
  activeKeyCount: number;
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
  keyPoolId?: string;
  maxDurationSeconds: number;
  allowPush: boolean;
  allowPrCreate: boolean;
  mode: string;
  modelParams: ModelParams;
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
  pools = [],
  initial,
}: {
  repos: Repo[];
  secrets: Secret[];
  pools?: Pool[];
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
  const [effortLevel, setEffortLevel] = useState<EffortLevel | "">(
    initial?.modelParams?.effortLevel ?? "",
  );
  const [repositoryId, setRepositoryId] = useState(
    initial?.repositoryId || "__none__",
  );
  // Unified credential value: "pool:<id>", "secret:<id>", or "__none__"
  const [credentialValue, setCredentialValue] = useState(() => {
    if (initial?.keyPoolId) return `pool:${initial.keyPoolId}`;
    if (initial?.agentSecretId) return `secret:${initial.agentSecretId}`;
    return "__none__";
  });

  // Review config (continuous mode only)
  const prReviewConfig = initial?.prReviewConfig ?? {};
  const [skipDrafts, setSkipDrafts] = useState(
    (prReviewConfig as Record<string, unknown>).skipDrafts !== false,
  );
  const [skipBots, setSkipBots] = useState(
    (prReviewConfig as Record<string, unknown>).skipBots !== false,
  );
  const [ignorePaths, setIgnorePaths] = useState(
    ((prReviewConfig as Record<string, unknown>).ignorePaths as string[])?.join(
      ", ",
    ) ?? "",
  );

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Dynamic options based on agent type
  const models = useMemo(
    () => getModels(agentType as AgentType),
    [agentType],
  );
  const thoughtLevels = useMemo(
    () => getThoughtLevels(agentType as AgentType),
    [agentType],
  );
  const compatibleProviders = useMemo(
    () => getCompatibleProviders(agentType as AgentType),
    [agentType],
  );
  const filteredSecrets = useMemo(
    () => secrets.filter((s) => compatibleProviders.includes(s.provider as "anthropic" | "openai")),
    [secrets, compatibleProviders],
  );
  const filteredPools = useMemo(
    () => pools.filter((p) => compatibleProviders.includes(p.provider as "anthropic" | "openai")),
    [pools, compatibleProviders],
  );

  // Derived: validate that the selected credential still exists in the filtered lists.
  // Falls back to "__none__" if the item was deleted or filtered out by agent type change.
  const validatedCredentialValue = useMemo(() => {
    if (credentialValue === "__none__") return "__none__";
    if (credentialValue.startsWith("secret:")) {
      const id = credentialValue.slice(7);
      return filteredSecrets.some((s) => s.id === id) ? credentialValue : "__none__";
    }
    if (credentialValue.startsWith("pool:")) {
      const id = credentialValue.slice(5);
      return filteredPools.some((p) => p.id === id) ? credentialValue : "__none__";
    }
    return "__none__";
  }, [credentialValue, filteredSecrets, filteredPools]);

  // Reset model/effort/key when agent type changes if current value is invalid
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
    // Reset credential if it's no longer compatible with the new agent type
    if (validatedCredentialValue !== "__none__") {
      const providers = getCompatibleProviders(newType as AgentType);
      if (validatedCredentialValue.startsWith("secret:")) {
        const selectedSecret = secrets.find((s) => s.id === validatedCredentialValue.slice(7));
        if (selectedSecret && !providers.includes(selectedSecret.provider as "anthropic" | "openai")) {
          setCredentialValue("__none__");
        }
      } else if (validatedCredentialValue.startsWith("pool:")) {
        const selectedPool = pools.find((p) => p.id === validatedCredentialValue.slice(5));
        if (selectedPool && !providers.includes(selectedPool.provider as "anthropic" | "openai")) {
          setCredentialValue("__none__");
        }
      }
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
        events: events
          .split(",")
          .map((e) => e.trim())
          .filter(Boolean),
        branches: branches
          .split(",")
          .map((b) => b.trim())
          .filter(Boolean),
      },
      prompt,
      agentType,
      model: model || undefined,
      repositoryId: repositoryId === "__none__" ? undefined : repositoryId,
      agentSecretId: validatedCredentialValue.startsWith("secret:") ? validatedCredentialValue.slice(7) : undefined,
      keyPoolId: validatedCredentialValue.startsWith("pool:") ? validatedCredentialValue.slice(5) : undefined,
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
      const url = isEdit
        ? `/api/automations/${initial!.id}`
        : "/api/automations";
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
    <form onSubmit={handleSubmit} className="flex max-w-2xl flex-col gap-8">
      {error && (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="name">Name</FieldLabel>
          <Input
            id="name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Review PRs on push"
            required
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="mode">Mode</FieldLabel>
          <Select value={mode} onValueChange={handleModeChange}>
            <SelectTrigger id="mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="oneshot">One-shot (coding task)</SelectItem>
                <SelectItem value="continuous">
                  Continuous (PR review)
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          {mode === "continuous" && (
            <FieldDescription>
              Code review agents run in read-only mode automatically.
            </FieldDescription>
          )}
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="events">GitHub events</FieldLabel>
            <Input
              id="events"
              type="text"
              value={events}
              onChange={(e) => setEvents(e.target.value)}
              placeholder="push, pull_request.opened"
              disabled={mode === "continuous"}
            />
            <FieldDescription>Comma-separated</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="branches">Branch filter</FieldLabel>
            <Input
              id="branches"
              type="text"
              value={branches}
              onChange={(e) => setBranches(e.target.value)}
              placeholder="main, develop"
            />
            <FieldDescription>
              Leave empty for all branches
            </FieldDescription>
          </Field>
        </div>

        <Field>
          <FieldLabel htmlFor="prompt">Instructions</FieldLabel>
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
        </Field>

        <Field>
          <FieldLabel htmlFor="repository">Repository</FieldLabel>
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
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="agentType">Agent</FieldLabel>
            <Select value={agentType} onValueChange={handleAgentTypeChange}>
              <SelectTrigger id="agentType">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {getEnabledAgents().map((a) => (
                    <SelectItem key={a.value} value={a.value}>
                      {a.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="secret">API key</FieldLabel>
            <Select
              value={validatedCredentialValue}
              onValueChange={setCredentialValue}
              disabled={filteredSecrets.length === 0 && filteredPools.length === 0}
            >
              <SelectTrigger id="secret">
                <SelectValue placeholder="Select an API key or pool" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="__none__">
                    {filteredSecrets.length === 0 && filteredPools.length === 0
                      ? "No keys available"
                      : "Select an API key or pool"}
                  </SelectItem>
                </SelectGroup>
                {filteredPools.length > 0 && (
                  <SelectGroup>
                    <SelectLabel className="text-xs text-muted-foreground">Key Pools (auto-rotate)</SelectLabel>
                    {filteredPools.map((p) => (
                      <SelectItem key={`pool:${p.id}`} value={`pool:${p.id}`}>
                        {p.name} ({p.activeKeyCount} keys)
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
                {filteredSecrets.length > 0 && (
                  <SelectGroup>
                    <SelectLabel className="text-xs text-muted-foreground">Individual Keys</SelectLabel>
                    {filteredSecrets.map((s) => (
                      <SelectItem key={`secret:${s.id}`} value={`secret:${s.id}`}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
              </SelectContent>
            </Select>
            {filteredSecrets.length === 0 && filteredPools.length === 0 && (
              <FieldDescription>
                No {compatibleProviders.join("/")} keys found.{" "}
                <Link
                  href="/settings/secrets"
                  className="underline underline-offset-4 hover:text-foreground"
                >
                  Add one
                </Link>
              </FieldDescription>
            )}
          </Field>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          {models.length > 0 && (
            <Field>
              <FieldLabel htmlFor="model">Model</FieldLabel>
              <Select
                value={model || "__default__"}
                onValueChange={(v) => setModel(v === "__default__" ? "" : v)}
              >
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
            </Field>
          )}

          {thoughtLevels && thoughtLevels.length > 0 && (
            <Field>
              <FieldLabel htmlFor="effortLevel">Effort level</FieldLabel>
              <Select
                value={effortLevel || "__default__"}
                onValueChange={(v) =>
                  setEffortLevel(v === "__default__" ? "" : (v as EffortLevel))
                }
              >
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
            </Field>
          )}
        </div>

        {mode === "continuous" && (
          <FieldSet>
            <FieldLegend variant="label">Review settings</FieldLegend>

            <div className="flex items-center gap-6">
              <Field orientation="horizontal">
                <Switch
                  id="skipDrafts"
                  size="sm"
                  checked={skipDrafts}
                  onCheckedChange={setSkipDrafts}
                />
                <FieldLabel htmlFor="skipDrafts">Skip draft PRs</FieldLabel>
              </Field>
              <Field orientation="horizontal">
                <Switch
                  id="skipBots"
                  size="sm"
                  checked={skipBots}
                  onCheckedChange={setSkipBots}
                />
                <FieldLabel htmlFor="skipBots">Skip bot PRs</FieldLabel>
              </Field>
            </div>

            <Field>
              <FieldLabel htmlFor="ignorePaths">Ignore paths</FieldLabel>
              <Input
                id="ignorePaths"
                type="text"
                value={ignorePaths}
                onChange={(e) => setIgnorePaths(e.target.value)}
                placeholder="*.lock, dist/**, docs/**"
              />
              <FieldDescription>
                Comma-separated glob patterns for files to skip in reviews
              </FieldDescription>
            </Field>
          </FieldSet>
        )}
      </FieldGroup>

      <div className="flex gap-3">
        <Button type="submit" disabled={loading}>
          {loading
            ? "Saving..."
            : isEdit
              ? "Update automation"
              : "Create automation"}
        </Button>
        <Button type="button" variant="outline" onClick={() => router.back()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
