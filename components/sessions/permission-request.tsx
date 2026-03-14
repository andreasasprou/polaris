"use client";

import { ShieldAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useHitlActions } from "@/app/(dashboard)/sessions/[sessionId]/page";

interface PermissionRequestProps {
  permissionId: string;
  action: string;
  status: "pending" | "accepted" | "rejected";
}

export function PermissionRequest({ permissionId, action, status }: PermissionRequestProps) {
  const hitl = useHitlActions();
  const isPending = status === "pending";

  return (
    <div className="w-full">
      <div
        className={`rounded-md border px-4 py-3 ${
          isPending
            ? "border-amber-500/30 bg-amber-500/5"
            : status === "accepted"
              ? "border-emerald-500/30 bg-emerald-500/5"
              : "border-destructive/30 bg-destructive/5"
        }`}
      >
        <div className="mb-2 flex items-center gap-2">
          <ShieldAlertIcon className="size-4 shrink-0 text-amber-500" />
          <span className="text-sm font-medium text-foreground">Permission Request</span>
        </div>
        <p className="mb-3 text-sm text-foreground/80">{action}</p>
        {isPending && hitl ? (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => hitl.replyPermission(permissionId, "once")}
            >
              Allow Once
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => hitl.replyPermission(permissionId, "always")}
            >
              Always Allow
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => hitl.replyPermission(permissionId, "reject")}
            >
              Reject
            </Button>
          </div>
        ) : (
          <Badge variant={status === "accepted" ? "secondary" : "destructive"}>
            {status === "accepted" ? "Approved" : "Rejected"}
          </Badge>
        )}
      </div>
    </div>
  );
}
