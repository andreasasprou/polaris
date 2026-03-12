import { Badge } from "@/components/ui/badge";

const statusVariants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "outline",
  creating: "outline",
  resuming: "outline",
  running: "default",
  active: "default",
  warm: "default",
  succeeded: "secondary",
  completed: "secondary",
  failed: "destructive",
  cancelled: "secondary",
  stopped: "secondary",
  idle: "outline",
  suspended: "outline",
  hibernating: "outline",
  hibernated: "secondary",
};

const statusLabels: Record<string, string> = {
  idle: "paused",
  stopped: "paused",
  warm: "active",
  suspended: "paused",
  hibernating: "saving...",
  hibernated: "hibernated",
  resuming: "resuming...",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={statusVariants[status] ?? "secondary"}>
      {statusLabels[status] ?? status}
    </Badge>
  );
}
