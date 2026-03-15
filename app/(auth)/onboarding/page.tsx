"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/client";
import { StepIndicator } from "./_components/step-indicator";
import { StepIntent, type Intent } from "./_components/step-intent";
import { StepGitHub } from "./_components/step-github";
import { StepApiKey } from "./_components/step-api-key";
import { StepRepo } from "./_components/step-repo";

const STORAGE_KEY = "polaris_onboarding";

type WizardState = {
  step: number;
  intents: Intent[];
  secretId: string | null;
};

function loadState(): WizardState {
  if (typeof window === "undefined") {
    return { step: 1, intents: [], secretId: null };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return JSON.parse(raw) as WizardState;
    }
  } catch {
    // Corrupted state, start fresh
  }
  return { step: 1, intents: [], secretId: null };
}

function saveState(state: WizardState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function clearState() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem("polaris_onboarding_step");
}

export default function OnboardingPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<WizardState>({ step: 1, intents: [], secretId: null });

  useEffect(() => {
    async function init() {
      // Check if user already has an org with completed onboarding
      try {
        // Use the session's active org if available, otherwise pick the first
        const session = await authClient.getSession();
        const activeOrgId = session.data?.session?.activeOrganizationId;

        const orgs = await authClient.organization.list();
        if (orgs.data && orgs.data.length > 0) {
          const orgToCheck = activeOrgId
            ? orgs.data.find((o) => o.id === activeOrgId) ?? orgs.data[0]
            : orgs.data[0];

          // Only set active if not already the right org
          if (orgToCheck.id !== activeOrgId) {
            await authClient.organization.setActive({
              organizationId: orgToCheck.id,
            });
          }

          // Check if onboarding is complete
          const res = await fetch("/api/onboarding/status");
          if (res.ok) {
            const data = await res.json();
            if (data.completed) {
              clearState();
              router.push("/dashboard");
              return;
            }
          }
        }
      } catch {
        // No orgs or error — continue with onboarding
      }

      // Restore wizard state from localStorage
      const saved = loadState();

      // Check if we're returning from GitHub redirect
      const redirectStep = localStorage.getItem("polaris_onboarding_step");
      if (redirectStep) {
        saved.step = Number(redirectStep);
        localStorage.removeItem("polaris_onboarding_step");
      }

      setState(saved);
      saveState(saved);
      setLoading(false);
    }
    init();
  }, [router]);

  function updateState(partial: Partial<WizardState>) {
    setState((prev) => {
      const next = { ...prev, ...partial };
      saveState(next);
      return next;
    });
  }

  if (loading) {
    return (
      <div className="flex min-h-svh items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="mb-8">
          <StepIndicator step={state.step} />
        </div>

        {state.step === 1 && (
          <StepIntent
            selected={state.intents}
            onSelect={(intents) => updateState({ intents })}
            onContinue={() => updateState({ step: 2 })}
          />
        )}

        {state.step === 2 && (
          <StepGitHub
            onContinue={() => updateState({ step: 3 })}
          />
        )}

        {state.step === 3 && (
          <StepApiKey
            onContinue={(secretId) => updateState({ step: 4, secretId })}
          />
        )}

        {state.step === 4 && (
          state.secretId ? (
            <StepRepo
              intents={state.intents}
              secretId={state.secretId}
              onComplete={() => {
                clearState();
                router.push("/dashboard");
              }}
            />
          ) : (
            <StepApiKey onContinue={(secretId) => updateState({ step: 4, secretId })} />
          )
        )}
      </div>
    </div>
  );
}
