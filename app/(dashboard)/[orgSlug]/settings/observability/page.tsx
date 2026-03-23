import { getOrgIdBySlug } from "@/lib/auth/session";
import { getOrgObservabilitySettings } from "@/lib/observability/org-settings";
import { ObservabilitySettingsForm } from "./settings-form";

export default async function ObservabilitySettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const orgId = await getOrgIdBySlug(orgSlug);
  const settings = orgId
    ? await getOrgObservabilitySettings(orgId)
    : null;

  return (
    <ObservabilitySettingsForm
      orgSlug={orgSlug}
      initialSettings={settings}
    />
  );
}
