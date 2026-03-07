export function mapProjectToRepo(projectSlug: string) {
  // Replace with your actual project-to-repo mapping
  const mapping: Record<string, { owner: string; repo: string; baseBranch: string }> = {
    // "nova-api": { owner: "your-org", repo: "nova", baseBranch: "main" },
  };

  const entry = mapping[projectSlug];
  if (!entry) {
    throw new Error(`No repo mapping for Sentry project: ${projectSlug}`);
  }

  return entry;
}
