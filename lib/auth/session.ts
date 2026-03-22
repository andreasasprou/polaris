import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  member,
  session as sessionTable,
} from "@/lib/db/auth-schema";
import { and, eq } from "drizzle-orm";

/**
 * Get the current session with a guaranteed active organization ID.
 * Falls back to querying the DB directly if Better Auth returns stale data.
 * Redirects to /login if not authenticated, /onboarding if no org.
 */
export async function getSessionWithOrg() {
  const session = await auth.api
    .getSession({ headers: await headers() })
    .catch(() => null);

  if (!session) {
    redirect("/login");
  }

  let activeOrgId = session.session.activeOrganizationId;

  if (!activeOrgId) {
    // Check DB directly
    const [dbSession] = await db
      .select({ activeOrganizationId: sessionTable.activeOrganizationId })
      .from(sessionTable)
      .where(eq(sessionTable.id, session.session.id))
      .limit(1);

    if (dbSession?.activeOrganizationId) {
      activeOrgId = dbSession.activeOrganizationId;
    } else {
      // Find user's membership and set it
      const memberships = await db
        .select()
        .from(member)
        .where(eq(member.userId, session.user.id))
        .limit(1);

      if (memberships.length > 0) {
        await db
          .update(sessionTable)
          .set({ activeOrganizationId: memberships[0].organizationId })
          .where(eq(sessionTable.id, session.session.id));
        activeOrgId = memberships[0].organizationId;
      } else {
        redirect("/onboarding");
      }
    }
  }

  return { session, orgId: activeOrgId };
}

/**
 * Require the current user to be an owner or admin of the active org.
 * Returns the session + orgId, or throws a 403 RequestError.
 */
export async function requireOrgAdmin() {
  const { session, orgId } = await getSessionWithOrg();

  const [membership] = await db
    .select({ role: member.role })
    .from(member)
    .where(
      and(
        eq(member.userId, session.user.id),
        eq(member.organizationId, orgId),
      ),
    )
    .limit(1);

  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
    const { RequestError } = await import("@/lib/errors/request-error");
    throw new RequestError("Only organization owners and admins can manage MCP servers", 403);
  }

  return { session, orgId };
}

export async function hasOrganizationMembership(
  userId: string,
  organizationId: string,
) {
  const [membership] = await db
    .select({ id: member.id })
    .from(member)
    .where(
      and(
        eq(member.userId, userId),
        eq(member.organizationId, organizationId),
      ),
    )
    .limit(1);

  return membership != null;
}
