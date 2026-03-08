"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/client";

type Step = "loading" | "create-org" | "install-github";

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("loading");
  const [orgName, setOrgName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // On mount, check if user already has an org — if so, set it active and redirect
  useEffect(() => {
    async function checkExistingOrgs() {
      try {
        const orgs = await authClient.organization.list();
        if (orgs.data && orgs.data.length > 0) {
          // User already has an org, set it active
          await authClient.organization.setActive({
            organizationId: orgs.data[0].id,
          });
          router.push("/dashboard");
          return;
        }
      } catch {
        // Failed to list orgs, fall through to create
      }
      setStep("create-org");
    }
    checkExistingOrgs();
  }, [router]);

  async function handleCreateOrg(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const slug = orgName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");

      const result = await authClient.organization.create({
        name: orgName,
        slug,
      });

      if (result.error) {
        setError(result.error.message ?? "Failed to create organization");
        return;
      }

      // Set as active org
      await authClient.organization.setActive({
        organizationId: result.data!.id,
      });

      setStep("install-github");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function handleInstallGitHub() {
    window.location.href = "/api/integrations/github/install";
  }

  function handleSkipGitHub() {
    router.push("/dashboard");
  }

  if (step === "loading") {
    return (
      <div className="flex min-h-svh items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-medium">Set up your workspace</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {step === "create-org" && "Create your organization to get started."}
            {step === "install-github" && "Connect your GitHub repositories."}
          </p>
        </div>

        {error && (
          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {step === "create-org" && (
          <form onSubmit={handleCreateOrg} className="space-y-4">
            <div>
              <label
                htmlFor="orgName"
                className="block text-sm font-medium text-foreground"
              >
                Organization name
              </label>
              <input
                id="orgName"
                type="text"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                placeholder="Acme Corp"
                required
                className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <button
              type="submit"
              disabled={loading || !orgName.trim()}
              className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? "Creating..." : "Create organization"}
            </button>
          </form>
        )}

        {step === "install-github" && (
          <div className="space-y-4">
            <button
              onClick={handleInstallGitHub}
              className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Install GitHub App
            </button>
            <button
              onClick={handleSkipGitHub}
              className="w-full rounded-md border border-input px-4 py-2.5 text-sm font-medium text-foreground hover:bg-accent"
            >
              Skip for now
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
