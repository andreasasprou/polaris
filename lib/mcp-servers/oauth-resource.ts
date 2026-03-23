export function getCanonicalMcpResource(serverUrl: string): string {
  const resourceUrl = new URL(serverUrl);
  resourceUrl.hash = "";
  return resourceUrl.toString();
}

export function createMcpOAuthTokenParams(
  serverUrl: string,
  params: Record<string, string>,
): URLSearchParams {
  const searchParams = new URLSearchParams(params);
  searchParams.set("resource", getCanonicalMcpResource(serverUrl));
  return searchParams;
}
