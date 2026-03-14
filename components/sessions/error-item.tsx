"use client";

import { AlertCircleIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

interface ErrorItemProps {
  message: string;
  code?: string;
}

export function ErrorItem({ message, code }: ErrorItemProps) {
  return (
    <div className="w-full">
      <Alert variant="destructive">
        <AlertCircleIcon />
        <AlertTitle>Error{code ? ` (${code})` : ""}</AlertTitle>
        <AlertDescription>{message}</AlertDescription>
      </Alert>
    </div>
  );
}
