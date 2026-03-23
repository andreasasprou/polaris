"use client";

import { useMemo, useState } from "react";
import { AlertCircleIcon, RadioTowerIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { OrganizationObservabilitySettings } from "@/lib/observability/org-settings";

const DEFAULT_HOURS = 24;

export function ObservabilitySettingsForm({
  orgSlug,
  initialSettings,
}: {
  orgSlug: string;
  initialSettings: OrganizationObservabilitySettings | null;
}) {
  const initial = initialSettings?.sandboxRawLogs;
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [expiresInHours, setExpiresInHours] = useState(String(DEFAULT_HOURS));
  const [reason, setReason] = useState(initial?.reason ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedSettings, setSavedSettings] = useState(initialSettings);

  const activeUntil = useMemo(() => {
    const value = savedSettings?.sandboxRawLogs.expiresAt;
    return value ? new Date(value).toLocaleString() : null;
  }, [savedSettings]);

  async function handleSave() {
    setSaving(true);
    setError(null);

    try {
      const response = await fetch("/api/observability/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orgSlug,
          enabled,
          expiresInHours: Number.parseInt(expiresInHours, 10) || DEFAULT_HOURS,
          reason,
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error ?? "Failed to update observability settings");
      }

      setSavedSettings(data.settings ?? null);
      if (!enabled) {
        setReason("");
        setExpiresInHours(String(DEFAULT_HOURS));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update observability settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Observability</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Control support-focused sandbox diagnostics and temporary raw log debugging.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <RadioTowerIcon className="size-4" />
            Raw Sandbox Logs
          </CardTitle>
          <CardDescription>
            Enable temporary live raw log debugging for sandbox-managed processes. Structured proxy telemetry remains on regardless.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
            <div className="space-y-1">
              <Label htmlFor="raw-log-toggle" className="text-sm font-medium">
                Enable temporary raw log debugging
              </Label>
              <p className="text-xs text-muted-foreground">
                Use this during incident investigations. Raw logs can contain sensitive agent and tool output.
              </p>
            </div>
            <Switch
              id="raw-log-toggle"
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label="Enable raw sandbox logs"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="expires-in-hours">Auto-disable after hours</Label>
              <Input
                id="expires-in-hours"
                type="number"
                min={1}
                max={168}
                value={expiresInHours}
                onChange={(e) => setExpiresInHours(e.target.value)}
                disabled={!enabled}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="debug-reason">Reason</Label>
              <Input
                id="debug-reason"
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Incident review, support escalation, regression hunt"
                disabled={!enabled}
              />
            </div>
          </div>

          <div className="rounded-lg bg-muted/40 p-4 text-sm">
            <p className="font-medium">
              Current state: {savedSettings?.sandboxRawLogs.enabled ? "Enabled" : "Disabled"}
            </p>
            <p className="mt-1 text-muted-foreground">
              {activeUntil
                ? `Current window ends ${activeUntil}.`
                : "No active raw-log debug window is scheduled."}
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : "Save settings"}
            </Button>
            <p className="text-xs text-muted-foreground">
              Structured proxy diagnostics, process inventory, and teardown artifacts stay available even when this is off.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
