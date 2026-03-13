import { App } from "octokit";

function getPrivateKey(): string {
  if (process.env.GITHUB_APP_PRIVATE_KEY_B64) {
    return Buffer.from(process.env.GITHUB_APP_PRIVATE_KEY_B64, "base64").toString("utf-8");
  }
  if (process.env.GITHUB_APP_PRIVATE_KEY) {
    return process.env.GITHUB_APP_PRIVATE_KEY;
  }
  throw new Error("Set GITHUB_APP_PRIVATE_KEY_B64 or GITHUB_APP_PRIVATE_KEY");
}

function createApp() {
  return new App({
    appId: process.env.GITHUB_APP_ID!,
    privateKey: getPrivateKey(),
  });
}

async function getInstallationId(owner: string, repo: string): Promise<number> {
  const app = createApp();
  const { data } = await app.octokit.rest.apps.getRepoInstallation({
    owner,
    repo,
  });
  return data.id;
}

export async function getInstallationOctokit(owner: string, repo: string) {
  const app = createApp();
  const installationId = await getInstallationId(owner, repo);
  return app.getInstallationOctokit(installationId);
}

export async function getInstallationToken(
  owner: string,
  repo: string,
): Promise<string> {
  const app = createApp();
  const installationId = await getInstallationId(owner, repo);
  const { data } = await app.octokit.rest.apps.createInstallationAccessToken({
    installation_id: installationId,
    repositories: [repo],
    permissions: { contents: "write", pull_requests: "write" },
  });
  return data.token;
}

export async function createPullRequest(params: {
  owner: string;
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
}) {
  const octokit = await getInstallationOctokit(params.owner, params.repo);

  const pr = await octokit.rest.pulls.create({
    owner: params.owner,
    repo: params.repo,
    head: params.head,
    base: params.base,
    title: params.title,
    body: params.body,
  });

  return {
    number: pr.data.number,
    url: pr.data.html_url,
  };
}

/**
 * Mint a short-lived installation access token from a stored installationId.
 * Used by Trigger.dev tasks to authenticate with GitHub.
 */
export async function mintInstallationToken(
  installationId: number,
  repos?: string[],
  permissions?: Record<string, string>,
): Promise<string> {
  const app = createApp();
  const { data } = await app.octokit.rest.apps.createInstallationAccessToken({
    installation_id: installationId,
    ...(repos ? { repositories: repos } : {}),
    ...(permissions ? { permissions } : {}),
  });
  return data.token;
}

/**
 * Get an Octokit instance for a specific installation ID.
 * Used when we already have the installationId stored in the DB.
 */
export async function getInstallationOctokitById(installationId: number) {
  const app = createApp();
  return app.getInstallationOctokit(installationId);
}

/**
 * Verify a GitHub webhook signature.
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
): boolean {
  const crypto = require("node:crypto") as typeof import("node:crypto");
  const secret = process.env.GITHUB_APP_WEBHOOK_SECRET;
  if (!secret) throw new Error("GITHUB_APP_WEBHOOK_SECRET not configured");

  const expected = `sha256=${crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex")}`;

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}
