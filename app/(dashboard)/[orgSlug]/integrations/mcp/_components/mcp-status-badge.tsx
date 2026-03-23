import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { McpInstallStatus } from "@/lib/mcp-servers/types";

const statusConfig: Record<
  McpInstallStatus,
  { label: string; variant: "outline" | "secondary" | "destructive"; className?: string }
> = {
  not_installed: {
    label: "Not installed",
    variant: "outline",
  },
  needs_auth: {
    label: "Needs auth",
    variant: "secondary",
    className:
      "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
  },
  misconfigured: {
    label: "Misconfigured",
    variant: "destructive",
  },
  connected: {
    label: "Connected",
    variant: "secondary",
    className:
      "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  },
};

export function McpStatusBadge({ status }: { status: McpInstallStatus }) {
  const config = statusConfig[status];

  return (
    <Badge variant={config.variant} className={cn(config.className)}>
      {config.label}
    </Badge>
  );
}
