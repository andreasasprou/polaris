"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircleIcon } from "lucide-react";

type EnvVar = {
  id: string;
  key: string;
  createdAt: string;
  updatedAt: string;
};

export default function EnvironmentPage() {
  const [envVars, setEnvVars] = useState<EnvVar[]>([]);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadEnvVars = useCallback(async () => {
    const res = await fetch("/api/sandbox-env-vars");
    const data = await res.json();
    setEnvVars(data.envVars ?? []);
  }, []);

  useEffect(() => {
    loadEnvVars();
  }, [loadEnvVars]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/sandbox-env-vars", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Failed to add variable");
      }

      setKey("");
      setValue("");
      loadEnvVars();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id: string) {
    await fetch(`/api/sandbox-env-vars/${id}`, { method: "DELETE" });
    loadEnvVars();
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Environment Variables</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Variables injected into all sandbox sessions. Values are encrypted at rest.
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
          <CardTitle className="text-sm">Add variable</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreate} className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="key">Name</Label>
                <Input
                  id="key"
                  type="text"
                  value={key}
                  onChange={(e) => setKey(e.target.value.toUpperCase())}
                  placeholder="OPENAI_API_KEY"
                  required
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="value">Value</Label>
                <Input
                  id="value"
                  type="password"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="sk-..."
                  required
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              If a variable with the same name exists, it will be updated.
            </p>
            <div>
              <Button type="submit" disabled={loading}>
                {loading ? "Adding..." : "Add variable"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {envVars.length > 0 && (
        <div className="flex flex-col gap-2">
          {envVars.map((env) => (
            <Card key={env.id}>
              <CardContent className="flex items-center justify-between py-3">
                <div>
                  <p className="text-sm font-medium font-mono">{env.key}</p>
                  <p className="text-xs text-muted-foreground">
                    Updated {new Date(env.updatedAt).toLocaleDateString()}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDelete(env.id)}
                  className="text-destructive hover:text-destructive"
                >
                  Remove
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
