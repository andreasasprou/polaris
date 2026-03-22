"use client";

import { useState } from "react";
import { CircleHelpIcon, CheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useHitlActions } from "@/app/(dashboard)/[orgSlug]/sessions/[sessionId]/page";

interface QuestionRequestProps {
  questionId: string;
  prompt: string;
  options: string[];
  status: "pending" | "answered" | "rejected";
  response?: string;
}

export function QuestionRequest({
  questionId,
  prompt,
  options,
  status,
  response,
}: QuestionRequestProps) {
  const hitl = useHitlActions();
  const [selected, setSelected] = useState<string[]>([]);
  const isPending = status === "pending";

  return (
    <div className="w-full">
      <div
        className={`rounded-md border px-4 py-3 ${
          isPending
            ? "animate-attention-pulse border-blue-500/30 bg-blue-500/5"
            : status === "answered"
              ? "border-emerald-500/30 bg-emerald-500/5"
              : "border-border bg-muted/30"
        }`}
      >
        <div className="mb-2 flex items-center gap-2">
          <CircleHelpIcon className="size-4 shrink-0 text-blue-500" />
          <span className="text-sm font-medium text-foreground">Question</span>
        </div>
        <p className="mb-3 text-sm font-medium text-foreground">{prompt}</p>
        {isPending && hitl ? (
          <>
            {options.length > 0 && (
              <div className="mb-3 flex flex-col gap-1.5">
                {options.map((option) => {
                  const isSelected = selected.includes(option);
                  return (
                    <button
                      key={option}
                      onClick={() => {
                        if (isSelected) {
                          setSelected(selected.filter((s) => s !== option));
                        } else {
                          setSelected([...selected, option]);
                        }
                      }}
                      className={`flex items-start gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                        isSelected
                          ? "border-primary/50 bg-primary/10"
                          : "border-border bg-muted/30 hover:bg-muted/50"
                      }`}
                    >
                      <div
                        className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm border text-[10px] ${
                          isSelected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border"
                        }`}
                      >
                        {isSelected && <CheckIcon className="size-3" />}
                      </div>
                      <span>{option}</span>
                    </button>
                  );
                })}
              </div>
            )}
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => hitl.replyQuestion(questionId, [selected])}
                disabled={options.length > 0 && selected.length === 0}
              >
                Submit
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => hitl.rejectQuestion(questionId)}
              >
                Skip
              </Button>
            </div>
          </>
        ) : (
          <Badge variant={status === "answered" ? "secondary" : "outline"}>
            {status === "answered" ? `Answered: ${response ?? ""}` : "Skipped"}
          </Badge>
        )}
      </div>
    </div>
  );
}
