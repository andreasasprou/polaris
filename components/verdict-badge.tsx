import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const verdictConfig: Record<
  string,
  { label: string; variant: "secondary" | "destructive"; className?: string }
> = {
  APPROVE: {
    label: "Approve",
    variant: "secondary",
    className:
      "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  },
  ATTENTION: {
    label: "Attention",
    variant: "secondary",
    className:
      "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
  },
  BLOCK: {
    label: "Block",
    variant: "destructive",
  },
};

export function VerdictBadge({ verdict }: { verdict: string }) {
  const config = verdictConfig[verdict] ?? {
    label: verdict,
    variant: "secondary" as const,
  };
  return (
    <Badge variant={config.variant} className={cn(config.className)}>
      {config.label}
    </Badge>
  );
}
