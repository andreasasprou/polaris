import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { CheckCircleIcon, GithubIcon } from "lucide-react";

export function StepGitHub({
  onContinue,
  createNew,
}: {
  onContinue: () => void;
  createNew?: boolean;
}) {
  const [connected, setConnected] = useState(false);
  const [checking, setChecking] = useState(!createNew);

  useEffect(() => {
    // Skip status check when creating a new org — the org doesn't exist yet
    if (createNew) return;

    async function checkInstallation() {
      try {
        const res = await fetch("/api/integrations/github/status");
        if (res.ok) {
          const data = await res.json();
          setConnected(data.installed === true);
        }
      } catch {
        // Not connected
      } finally {
        setChecking(false);
      }
    }
    checkInstallation();
  }, [createNew]);

  function handleInstall() {
    // Save wizard state before redirecting
    localStorage.setItem("polaris_onboarding_step", "3");
    const installUrl = createNew
      ? "/api/integrations/github/install?create=true"
      : "/api/integrations/github/install";
    window.location.href = installUrl;
  }

  if (checking) {
    return (
      <div className="flex flex-col gap-6">
        <div>
          <h2 className="text-xl font-medium">Connect GitHub</h2>
          <p className="mt-1 text-sm text-muted-foreground">Checking connection...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-medium">Connect GitHub</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Polaris needs access to your repositories to run agents and create pull requests.
        </p>
      </div>

      {connected ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-4 py-3">
            <CheckCircleIcon className="size-5 text-green-500" />
            <p className="text-sm font-medium">GitHub connected</p>
          </div>
          <Button onClick={onContinue}>Continue</Button>
        </div>
      ) : (
        <Button onClick={handleInstall}>
          <GithubIcon data-icon="inline-start" />
          Install GitHub App
        </Button>
      )}
    </div>
  );
}
