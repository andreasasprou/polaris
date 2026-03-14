import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Spinner } from "@/components/ui/spinner";
import {
  CheckIcon,
  ChevronsUpDownIcon,
  GitPullRequestIcon,
  ZapIcon,
  MessageSquareIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Intent } from "./step-intent";

type Repo = {
  installationId: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
};

const INTENT_LABELS = {
  "pr-review": { icon: GitPullRequestIcon, label: "PR Review Bot" },
  "coding-tasks": { icon: ZapIcon, label: "Coding Task Automation" },
  "chat": { icon: MessageSquareIcon, label: "Interactive Session" },
} as const;

export function StepRepo({
  intents,
  secretId,
  onComplete,
}: {
  intents: Intent[];
  secretId: string;
  onComplete: () => void;
}) {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(true);
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(null);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchRepos() {
      try {
        const res = await fetch("/api/integrations/github/repos");
        if (res.ok) {
          const data = await res.json();
          setRepos(data.repos ?? []);
        } else {
          setError("Failed to load repositories");
        }
      } catch {
        setError("Failed to load repositories");
      } finally {
        setLoadingRepos(false);
      }
    }
    fetchRepos();
  }, []);

  // Filter intents that produce automations (not "chat" or "exploring")
  const automationIntents = intents.filter(
    (i) => i === "pr-review" || i === "coding-tasks",
  );
  const hasSessionIntent = intents.includes("chat");

  async function handleCreate() {
    if (!selectedRepo) return;
    setCreating(true);
    setError(null);

    try {
      const res = await fetch("/api/onboarding/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intents,
          repositoryFullName: selectedRepo.fullName,
          secretId,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Failed to complete setup");
      }

      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setCreating(false);
    }
  }

  if (loadingRepos) {
    return (
      <div className="flex flex-col gap-6">
        <div>
          <h2 className="text-xl font-medium">Choose a repository</h2>
          <p className="mt-1 text-sm text-muted-foreground">Loading your repositories...</p>
        </div>
        <div className="flex justify-center py-8">
          <Spinner className="size-6" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-medium">Choose a repository</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick a repo to get started. You can add more from the Automations page later.
        </p>
      </div>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between font-normal"
          >
            {selectedRepo ? selectedRepo.fullName : "Search repositories..."}
            <ChevronsUpDownIcon className="opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
          <Command>
            <CommandInput placeholder="Search repositories..." />
            <CommandList>
              <CommandEmpty>No repositories found.</CommandEmpty>
              <CommandGroup>
                {repos.map((repo) => (
                  <CommandItem
                    key={repo.fullName}
                    value={repo.fullName}
                    onSelect={() => {
                      setSelectedRepo(repo);
                      setOpen(false);
                    }}
                  >
                    {repo.fullName}
                    <CheckIcon
                      className={cn(
                        "ml-auto",
                        selectedRepo?.fullName === repo.fullName
                          ? "opacity-100"
                          : "opacity-0",
                      )}
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {selectedRepo && (automationIntents.length > 0 || hasSessionIntent) && (
        <div className="rounded-lg border border-border p-4">
          <p className="mb-3 text-sm font-medium">
            We&apos;ll set up the following for you:
          </p>
          <div className="flex flex-col gap-2">
            {automationIntents.map((intent) => {
              const config = INTENT_LABELS[intent];
              return (
                <div key={intent} className="flex items-center gap-2 text-sm text-muted-foreground">
                  <config.icon className="size-4 shrink-0" />
                  <span>{config.label}</span>
                  <span className="text-xs">on {selectedRepo.fullName}</span>
                </div>
              );
            })}
            {hasSessionIntent && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <MessageSquareIcon className="size-4 shrink-0" />
                <span>Quick-start session card on dashboard</span>
              </div>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <Button onClick={handleCreate} disabled={!selectedRepo || creating}>
        {creating ? (
          <>
            <Spinner data-icon="inline-start" />
            Setting up...
          </>
        ) : (
          "Create & go to dashboard"
        )}
      </Button>
    </div>
  );
}
