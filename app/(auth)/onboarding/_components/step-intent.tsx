import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  GitPullRequestIcon,
  ZapIcon,
  MessageSquareIcon,
  CompassIcon,
} from "lucide-react";

export type Intent =
  | "pr-review"
  | "coding-tasks"
  | "chat"
  | "exploring";

const INTENTS = [
  {
    value: "pr-review" as const,
    icon: GitPullRequestIcon,
    label: "AI code review on PRs",
    description: "Automatically review every pull request with severity-rated findings",
  },
  {
    value: "coding-tasks" as const,
    icon: ZapIcon,
    label: "Automate coding tasks",
    description: "Trigger agents from pushes, webhooks, or schedules to generate PRs",
  },
  {
    value: "chat" as const,
    icon: MessageSquareIcon,
    label: "Chat with an agent",
    description: "Start interactive sessions to explore and modify your codebase",
  },
  {
    value: "exploring" as const,
    icon: CompassIcon,
    label: "Just exploring",
    description: "Look around and set up later",
  },
];

export function StepIntent({
  selected,
  onSelect,
  onContinue,
}: {
  selected: Intent[];
  onSelect: (intents: Intent[]) => void;
  onContinue: () => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-medium">What do you want to do with Polaris?</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Select all that apply. We&apos;ll set things up for you.
        </p>
      </div>

      <ToggleGroup
        type="multiple"
        value={selected}
        onValueChange={(v) => onSelect(v as Intent[])}
        className="flex flex-col gap-2"
      >
        {INTENTS.map((intent) => (
          <ToggleGroupItem
            key={intent.value}
            value={intent.value}
            className="flex h-auto w-full items-start justify-start gap-3 rounded-lg border border-border px-4 py-3 text-left data-[state=on]:border-primary data-[state=on]:bg-primary/5"
          >
            <intent.icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">{intent.label}</p>
              <p className="text-xs text-muted-foreground">{intent.description}</p>
            </div>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <Button onClick={onContinue} disabled={selected.length === 0}>
        Continue
      </Button>
    </div>
  );
}
