"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  MoreHorizontalIcon,
  PencilIcon,
  CopyIcon,
  TrashIcon,
  ExternalLinkIcon,
} from "lucide-react";
import type { findAutomationsWithRepoByOrg } from "@/lib/automations/queries";

type AutomationRow = Awaited<
  ReturnType<typeof findAutomationsWithRepoByOrg>
>[number];

export function AutomationsTable({ rows }: { rows: AutomationRow[] }) {
  const router = useRouter();
  const [deleteTarget, setDeleteTarget] = useState<AutomationRow | null>(null);
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());
  const [duplicatingIds, setDuplicatingIds] = useState<Set<string>>(new Set());

  async function handleToggle(id: string, enabled: boolean) {
    setTogglingIds((prev) => new Set(prev).add(id));
    try {
      await fetch(`/api/automations/${id}/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      router.refresh();
    } finally {
      setTogglingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  async function handleDuplicate(row: AutomationRow) {
    const { automation } = row;
    setDuplicatingIds((prev) => new Set(prev).add(automation.id));
    try {
      const body: Record<string, unknown> = {
        name: `${automation.name} (copy)`,
        triggerType: automation.triggerType,
        triggerConfig: automation.triggerConfig,
        prompt: automation.prompt,
        agentType: automation.agentType,
        model: automation.model || undefined,
        agentMode: automation.agentMode || undefined,
        repositoryId: automation.repositoryId || undefined,
        agentSecretId: automation.agentSecretId || undefined,
        maxDurationSeconds: automation.maxDurationSeconds,
        maxConcurrentRuns: automation.maxConcurrentRuns,
        allowPush: automation.allowPush,
        allowPrCreate: automation.allowPrCreate,
        mode: automation.mode,
        modelParams: automation.modelParams,
        prReviewConfig: automation.prReviewConfig,
      };
      await fetch("/api/automations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      router.refresh();
    } finally {
      setDuplicatingIds((prev) => {
        const next = new Set(prev);
        next.delete(automation.id);
        return next;
      });
    }
  }

  async function handleDelete(id: string) {
    await fetch(`/api/automations/${id}`, { method: "DELETE" });
    setDeleteTarget(null);
    router.refresh();
  }

  function formatEvents(config: Record<string, unknown>): string {
    const events = config.events as string[] | undefined;
    if (!events || events.length === 0) return "—";
    if (events.length === 1) return events[0];
    return `${events[0]} +${events.length - 1}`;
  }

  return (
    <TooltipProvider>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-12">Active</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Trigger</TableHead>
            <TableHead>Repository</TableHead>
            <TableHead>Agent</TableHead>
            <TableHead className="w-12">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const { automation } = row;
            const isToggling = togglingIds.has(automation.id);
            const isDuplicating = duplicatingIds.has(automation.id);

            return (
              <TableRow key={automation.id}>
                <TableCell>
                  <Switch
                    size="sm"
                    checked={automation.enabled}
                    disabled={isToggling}
                    onCheckedChange={(checked) =>
                      handleToggle(automation.id, checked)
                    }
                  />
                </TableCell>
                <TableCell>
                  <Link
                    href={`/automations/${automation.id}`}
                    className="flex flex-col gap-0.5 hover:underline"
                  >
                    <span className="font-medium">{automation.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {automation.mode === "continuous"
                        ? "Continuous PR review"
                        : "One-shot task"}
                    </span>
                  </Link>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <Badge variant="secondary">{automation.triggerType}</Badge>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="truncate text-xs text-muted-foreground max-w-[120px]">
                          {formatEvents(automation.triggerConfig)}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        {(
                          (automation.triggerConfig.events as string[]) ?? []
                        ).join(", ") || "No events configured"}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </TableCell>
                <TableCell>
                  {row.repoOwner && row.repoName ? (
                    <span className="text-sm">
                      {row.repoOwner}/{row.repoName}
                    </span>
                  ) : (
                    <span className="text-sm text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <Badge variant="outline">{automation.agentType}</Badge>
                    {automation.model && (
                      <span className="text-xs text-muted-foreground">
                        {automation.model}
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="size-8">
                        <MoreHorizontalIcon />
                        <span className="sr-only">Actions</span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuGroup>
                        <DropdownMenuItem asChild>
                          <Link href={`/automations/${automation.id}`}>
                            <PencilIcon data-icon="inline-start" />
                            Edit
                          </Link>
                        </DropdownMenuItem>
                        <DropdownMenuItem asChild>
                          <Link href={`/automations/${automation.id}/runs`}>
                            <ExternalLinkIcon data-icon="inline-start" />
                            View runs
                          </Link>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={isDuplicating}
                          onSelect={() => handleDuplicate(row)}
                        >
                          <CopyIcon data-icon="inline-start" />
                          {isDuplicating ? "Duplicating..." : "Duplicate"}
                        </DropdownMenuItem>
                      </DropdownMenuGroup>
                      <DropdownMenuSeparator />
                      <DropdownMenuGroup>
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => setDeleteTarget(row)}
                        >
                          <TrashIcon data-icon="inline-start" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete automation</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete &ldquo;{deleteTarget?.automation.name}
              &rdquo; and all its run history. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() =>
                deleteTarget && handleDelete(deleteTarget.automation.id)
              }
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
}
