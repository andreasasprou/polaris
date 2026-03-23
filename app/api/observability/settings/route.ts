import { NextResponse } from "next/server";
import {
  getSessionWithOrg,
  getSessionWithOrgAdminBySlug,
} from "@/lib/auth/session";
import {
  getOrgObservabilitySettings,
  isSandboxRawLogDebugEnabled,
  updateOrgObservabilitySettings,
} from "@/lib/observability/org-settings";
import { withEvlog } from "@/lib/evlog";

const DEFAULT_DEBUG_HOURS = 24;
const MAX_DEBUG_HOURS = 24 * 7;

export const GET = withEvlog(async () => {
  const { orgId } = await getSessionWithOrg();
  const settings = await getOrgObservabilitySettings(orgId);

  return NextResponse.json({
    settings,
    active: isSandboxRawLogDebugEnabled(settings),
  });
});

export const POST = withEvlog(async (req: Request) => {
  const body = await req.json().catch(() => null) as
    | {
        orgSlug?: string;
        enabled?: boolean;
        expiresInHours?: number;
        reason?: string;
      }
    | null;

  const orgSlug = body?.orgSlug?.trim();
  if (!orgSlug) {
    return NextResponse.json({ error: "orgSlug is required" }, { status: 400 });
  }

  const admin = await getSessionWithOrgAdminBySlug(orgSlug);
  if (!admin) {
    return NextResponse.json(
      { error: "Only organization owners and admins can manage observability settings" },
      { status: 403 },
    );
  }

  const enabled = body?.enabled === true;
  const requestedHours = Number.isFinite(body?.expiresInHours)
    ? Number(body?.expiresInHours)
    : DEFAULT_DEBUG_HOURS;
  const expiresInHours = Math.max(1, Math.min(MAX_DEBUG_HOURS, requestedHours));

  const expiresAt = enabled
    ? new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString()
    : null;

  const settings = await updateOrgObservabilitySettings({
    organizationId: admin.orgId,
    enabled,
    expiresAt,
    reason: body?.reason ?? null,
    updatedBy: admin.session.user.id,
  });

  return NextResponse.json({
    settings,
    active: isSandboxRawLogDebugEnabled(settings),
  });
});
