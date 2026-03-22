import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const statusConfig: Record<
  string,
  { className: string; label?: string; isLive?: boolean }
> = {
  pending: {
    className: "border-border text-muted-foreground bg-transparent",
  },
  creating: {
    className:
      "border-status-active/30 text-status-active bg-status-active-dim",
    label: "creating...",
    isLive: true,
  },
  running: {
    className:
      "border-status-active/20 text-status-active bg-status-active-dim",
    isLive: true,
  },
  active: {
    className:
      "border-status-active/20 text-status-active bg-status-active-dim",
    isLive: true,
  },
  idle: {
    className: "border-border text-muted-foreground bg-transparent",
  },
  snapshotting: {
    className: "border-status-info/30 text-status-info bg-status-info-dim",
    label: "saving...",
    isLive: true,
  },
  hibernated: {
    className: "border-border text-muted-foreground bg-muted/50",
  },
  succeeded: {
    className:
      "border-status-success/20 text-status-success bg-status-success-dim",
  },
  completed: {
    className:
      "border-status-success/20 text-status-success bg-status-success-dim",
  },
  failed: {
    className:
      "border-status-error/20 text-status-error bg-status-error-dim",
  },
  cancelled: {
    className: "border-border text-muted-foreground bg-muted/50",
  },
  stopped: {
    className: "border-border text-muted-foreground bg-transparent",
  },
};

const defaultConfig = {
  className: "border-border text-muted-foreground bg-transparent",
};

export function StatusBadge({ status }: { status: string }) {
  const config = statusConfig[status] ?? defaultConfig;

  return (
    <Badge variant="outline" className={cn(config.className)}>
      {config.isLive && (
        <span className="size-1.5 rounded-full bg-current animate-pulse" />
      )}
      {config.label ?? status}
    </Badge>
  );
}
