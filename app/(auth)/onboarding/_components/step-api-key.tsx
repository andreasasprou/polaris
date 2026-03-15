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
import {
  CheckCircleIcon,
  AlertCircleIcon,
  CopyIcon,
  CheckIcon,
} from "lucide-react";

type AgentProvider = "anthropic" | "openai";

const CODEX_AUTH_FILE_CMD = `base64 < ~/.codex/auth.json | tr -d '\\n'`;
const CODEX_AUTH_KEYCHAIN_CMD = `security find-generic-password -s "Codex Auth" -w | base64 | tr -d '\\n'`;

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="size-6 shrink-0 p-0 text-muted-foreground hover:text-foreground"
      onClick={handleCopy}
      aria-label={copied ? "Copied" : "Copy command"}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  );
}

export function StepApiKey({
  onContinue,
}: {
  onContinue: (secretId: string) => void;
}) {
  const [provider, setProvider] = useState<AgentProvider>("anthropic");
  const [openaiMode, setOpenaiMode] = useState<"api-key" | "chatgpt-oauth">("api-key");
  const [value, setValue] = useState("");
  const [validating, setValidating] = useState(false);
  const [validated, setValidated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secretId, setSecretId] = useState<string | null>(null);

  function handleProviderChange(p: AgentProvider) {
    setProvider(p);
    setOpenaiMode("api-key");
    setValue("");
    setValidated(false);
    setError(null);
    setSecretId(null);
  }

  async function handleValidate(e: React.FormEvent) {
    e.preventDefault();
    setValidating(true);
    setError(null);
    setValidated(false);

    try {
      // Create the secret (validation happens server-side)
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
      setSecretId(data.secret.id);
      setValidated(true);
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
              setValidated(false);
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
                  onChange={(e) => { setValue(e.target.value); setValidated(false); setError(null); }}
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
                    onChange={(e) => { setValue(e.target.value); setValidated(false); setError(null); }}
                    placeholder="Paste base64-encoded auth.json..."
                    className="font-mono text-xs"
                    rows={3}
                    required
                    disabled={validating}
                  />
                </div>
                <div className="rounded-md border border-border bg-muted/50 p-3 text-xs text-muted-foreground">
                  <p className="mb-2">
                    Run{" "}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono">codex auth</code>{" "}
                    first, then paste the output of:
                  </p>
                  <div className="flex flex-col gap-1.5">
                    <div>
                      <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">From file</p>
                      <div className="flex items-center gap-2 rounded bg-muted px-3 py-2 font-mono">
                        <code className="flex-1 select-all break-all text-foreground">{CODEX_AUTH_FILE_CMD}</code>
                        <CopyButton text={CODEX_AUTH_FILE_CMD} />
                      </div>
                    </div>
                    <div>
                      <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">From macOS Keychain</p>
                      <div className="flex items-center gap-2 rounded bg-muted px-3 py-2 font-mono">
                        <code className="flex-1 select-all break-all text-foreground">{CODEX_AUTH_KEYCHAIN_CMD}</code>
                        <CopyButton text={CODEX_AUTH_KEYCHAIN_CMD} />
                      </div>
                    </div>
                  </div>
                </div>
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
              onChange={(e) => { setValue(e.target.value); setValidated(false); setError(null); }}
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

        {validated ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 rounded-md bg-green-500/10 px-3 py-2 text-sm text-green-500">
              <CheckCircleIcon className="size-4 shrink-0" />
              Credentials validated
            </div>
            <Button type="button" onClick={() => secretId && onContinue(secretId)}>
              Continue
            </Button>
          </div>
        ) : (
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
        )}
      </form>
    </div>
  );
}
