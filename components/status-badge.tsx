import { Badge } from "@/components/ui/badge";

const statusVariants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "outline",
  creating: "outline",
  running: "default",
  active: "default",
  succeeded: "secondary",
  completed: "secondary",
  failed: "destructive",
  cancelled: "secondary",
  stopped: "secondary",
  idle: "outline",
  snapshotting: "outline",
  hibernated: "secondary",
};

const statusLabels: Record<string, string> = {
  idle: "idle",
  stopped: "stopped",
  snapshotting: "saving...",
  hibernated: "hibernated",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={statusVariants[status] ?? "secondary"}>
      {statusLabels[status] ?? status}
    </Badge>
  );
}
