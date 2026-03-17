import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { githubInstallations, repositories } from "./schema";

export async function findGithubInstallationsByOrg(organizationId: string) {
  return db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.organizationId, organizationId));
}

export async function findGithubInstallationByInstallationId(installationId: number) {
  const rows = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, installationId))
    .limit(2);
  if (rows.length !== 1) return null;
  return rows[0] ?? null;
}

export async function findGithubInstallationsByInstallationId(
  installationId: number,
) {
  return db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, installationId));
}

export async function findGithubInstallationById(id: string) {
  const [row] = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.id, id))
    .limit(1);
  return row ?? null;
}

export async function findGithubInstallationByIdAndOrg(
  id: string,
  organizationId: string,
) {
  const [row] = await db
    .select()
    .from(githubInstallations)
    .where(
      and(
        eq(githubInstallations.id, id),
        eq(githubInstallations.organizationId, organizationId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function findRepositoriesByOrg(organizationId: string) {
  return db
    .select()
    .from(repositories)
    .where(eq(repositories.organizationId, organizationId));
}

export async function findRepositoryById(id: string) {
  const [row] = await db
    .select()
    .from(repositories)
    .where(eq(repositories.id, id))
    .limit(1);
  return row ?? null;
}

export async function findRepositoryByIdAndOrg(
  id: string,
  organizationId: string,
) {
  const [row] = await db
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.id, id),
        eq(repositories.organizationId, organizationId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function findRepositoryByOwnerName(
  organizationId: string,
  owner: string,
  name: string,
) {
  const [row] = await db
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.organizationId, organizationId),
        eq(repositories.owner, owner),
        eq(repositories.name, name),
      ),
    )
    .limit(1);
  return row ?? null;
}
