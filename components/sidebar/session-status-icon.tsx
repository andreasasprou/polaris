import { CheckIcon, XCircleIcon, SquareIcon } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

type SessionStatusIconProps = {
  status: string;
  needsAttention?: boolean;
  className?: string;
};

function PulsingDot({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block size-2 rounded-full animate-pulse",
        className,
      )}
    />
  );
}

function StaticDot({ className }: { className?: string }) {
  return (
    <span
      className={cn("inline-block size-2 rounded-full", className)}
    />
  );
}

export function SessionStatusIcon({
  status,
  needsAttention,
  className,
}: SessionStatusIconProps) {
  // needsAttention overrides active status with amber indicator
  if (needsAttention && (status === "active" || status === "idle")) {
    return (
      <span className={cn("flex items-center justify-center size-4", className)}>
        <PulsingDot className="bg-amber-500" />
      </span>
    );
  }

  switch (status) {
    case "creating":
    case "snapshotting":
      return <Spinner className={cn("size-3.5 text-muted-foreground", className)} />;

    case "active":
      return (
        <span className={cn("flex items-center justify-center size-4", className)}>
          <PulsingDot className="bg-emerald-500" />
        </span>
      );

    case "idle":
    case "hibernated":
      return (
        <span className={cn("flex items-center justify-center size-4", className)}>
          <StaticDot className="bg-muted-foreground" />
        </span>
      );

    case "completed":
      return (
        <CheckIcon
          className={cn("size-3.5 text-emerald-500", className)}
        />
      );

    case "failed":
      return (
        <XCircleIcon
          className={cn("size-3.5 text-destructive", className)}
        />
      );

    case "stopped":
      return (
        <SquareIcon
          className={cn("size-3.5 text-muted-foreground", className)}
        />
      );

    default:
      return (
        <span className={cn("flex items-center justify-center size-4", className)}>
          <StaticDot className="bg-muted-foreground" />
        </span>
      );
  }
}
