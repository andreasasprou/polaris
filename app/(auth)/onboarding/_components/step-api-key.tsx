import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AlertCircleIcon } from "lucide-react";
import { CodexOAuthInstructions } from "@/components/codex-oauth-instructions";

type AgentProvider = "anthropic" | "openai";

export function StepApiKey({
  onContinue,
}: {
  onContinue: (secretId: string) => void;
}) {
  const [provider, setProvider] = useState<AgentProvider>("anthropic");
  const [openaiMode, setOpenaiMode] = useState<"api-key" | "chatgpt-oauth">("api-key");
  const [value, setValue] = useState("");
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleProviderChange(p: AgentProvider) {
    setProvider(p);
    setOpenaiMode("api-key");
    setValue("");
    setError(null);
  }

  async function handleValidate(e: React.FormEvent) {
    e.preventDefault();
    setValidating(true);
    setError(null);

    try {
      const res = await fetch("/api/secrets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          label: "onboarding",
          value: value.trim(),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Invalid credentials");
      }

      const data = await res.json();
      onContinue(data.secret.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Validation failed");
    } finally {
      setValidating(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-medium">Add your AI credentials</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose your AI agent and provide credentials so Polaris can run it.
        </p>
      </div>

      <form onSubmit={handleValidate} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="agent">Agent</Label>
          <Select value={provider} onValueChange={(v) => handleProviderChange(v as AgentProvider)}>
            <SelectTrigger id="agent">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="anthropic">Claude Code (Anthropic)</SelectItem>
                <SelectItem value="openai">Codex (OpenAI)</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        {provider === "openai" ? (
          <Tabs
            value={openaiMode}
            onValueChange={(v) => {
              setOpenaiMode(v as "api-key" | "chatgpt-oauth");
              setValue("");
              setError(null);
            }}
          >
            <TabsList>
              <TabsTrigger value="api-key">API Key</TabsTrigger>
              <TabsTrigger value="chatgpt-oauth">ChatGPT OAuth</TabsTrigger>
            </TabsList>
            <TabsContent value="api-key">
              <div className="flex flex-col gap-2">
                <Label htmlFor="api-key">API key</Label>
                <Input
                  id="api-key"
                  type="password"
                  value={value}
                  onChange={(e) => { setValue(e.target.value); setError(null); }}
                  placeholder="sk-..."
                  required
                  disabled={validating}
                />
              </div>
            </TabsContent>
            <TabsContent value="chatgpt-oauth">
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="oauth-key">Base64 auth.json</Label>
                  <Textarea
                    id="oauth-key"
                    value={value}
                    onChange={(e) => { setValue(e.target.value); setError(null); }}
                    placeholder="Paste base64-encoded auth.json..."
                    className="max-h-32 font-mono text-xs"
                    rows={3}
                    required
                    disabled={validating}
                  />
                </div>
                <CodexOAuthInstructions />
              </div>
            </TabsContent>
          </Tabs>
        ) : (
          <div className="flex flex-col gap-2">
            <Label htmlFor="api-key-anthropic">API key</Label>
            <Input
              id="api-key-anthropic"
              type="password"
              value={value}
              onChange={(e) => { setValue(e.target.value); setError(null); }}
              placeholder="sk-ant-..."
              required
              disabled={validating}
            />
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertCircleIcon className="size-4 shrink-0" />
            {error}
          </div>
        )}

        <Button type="submit" disabled={validating || !value.trim()}>
          {validating ? (
            <>
              <Spinner data-icon="inline-start" />
              Validating...
            </>
          ) : (
            "Validate & save"
          )}
        </Button>
      </form>
    </div>
  );
}
