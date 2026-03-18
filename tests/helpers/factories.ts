/**
 * Test Data Factories
 *
 * Create test entities with sensible defaults. Uses direct DB inserts
 * via the test-scoped pool to avoid importing action functions
 * (which use the global db singleton).
 */

import { randomUUID } from "node:crypto";
import type { Client } from "pg";

export function testOrgId() {
  return `test-org-${randomUUID().slice(0, 8)}`;
}

export async function createTestInteractiveSession(
  client: Client,
  overrides: {
    organizationId: string;
    agentType?: string;
    status?: string;
    prompt?: string;
  },
) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO interactive_sessions (id, organization_id, created_by, agent_type, status, prompt, epoch)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      overrides.organizationId,
      "test",
      overrides.agentType ?? "claude",
      overrides.status ?? "creating",
      overrides.prompt ?? "test prompt",
      0,
    ],
  );
  return { id };
}

export async function createTestRepository(
  client: Client,
  overrides: {
    organizationId: string;
    owner?: string;
    name?: string;
    installationId?: string;
  },
) {
  const installationId =
    overrides.installationId ?? (await createTestInstallation(client, overrides.organizationId));
  const id = randomUUID();
  await client.query(
    `INSERT INTO repositories (id, organization_id, github_installation_id, owner, name)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      id,
      overrides.organizationId,
      installationId,
      overrides.owner ?? "test-owner",
      overrides.name ?? "test-repo",
    ],
  );
  return { id, installationId };
}

export async function createTestInstallation(
  client: Client,
  organizationId: string,
) {
  const id = randomUUID();
  const installationId = Math.floor(Math.random() * 1_000_000);
  await client.query(
    `INSERT INTO github_installations (id, organization_id, installation_id)
     VALUES ($1, $2, $3)`,
    [id, organizationId, installationId],
  );
  return id;
}

export async function createTestAutomation(
  client: Client,
  overrides: {
    organizationId: string;
    repositoryId?: string;
    name?: string;
    mode?: string;
  },
) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO automations (id, organization_id, name, trigger_type, trigger_config, prompt, agent_type, mode, repository_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      overrides.organizationId,
      overrides.name ?? "Test Automation",
      "github",
      JSON.stringify({ events: ["pull_request.opened"] }),
      "test prompt",
      "claude",
      overrides.mode ?? "continuous",
      overrides.repositoryId ?? null,
    ],
  );
  return { id };
}

export async function createTestAutomationSession(
  client: Client,
  overrides: {
    automationId: string;
    interactiveSessionId: string;
    organizationId: string;
    repositoryId: string;
    scopeKey?: string;
  },
) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO automation_sessions (id, automation_id, interactive_session_id, organization_id, repository_id, scope_key, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      overrides.automationId,
      overrides.interactiveSessionId,
      overrides.organizationId,
      overrides.repositoryId,
      overrides.scopeKey ?? `github-pr:${overrides.repositoryId}:1`,
      JSON.stringify({}),
    ],
  );
  return { id };
}

export async function createTestAutomationRun(
  client: Client,
  overrides: {
    automationId: string;
    organizationId: string;
    automationSessionId?: string;
    interactiveSessionId?: string;
    status?: string;
  },
) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO automation_runs (id, automation_id, organization_id, source, status, automation_session_id, interactive_session_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      overrides.automationId,
      overrides.organizationId,
      "github",
      overrides.status ?? "pending",
      overrides.automationSessionId ?? null,
      overrides.interactiveSessionId ?? null,
    ],
  );
  return { id };
}

export async function getAutomationSessionRow(
  client: Client,
  id: string,
) {
  const result = await client.query(
    `SELECT * FROM automation_sessions WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}
