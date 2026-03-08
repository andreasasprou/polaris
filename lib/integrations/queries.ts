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
  const [row] = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, installationId))
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
