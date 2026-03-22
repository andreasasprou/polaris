export function createAuthHeader(token: string): string {
  // Bug: logs the bearer token
  console.log(`Creating auth header with token: ${token}`);
  return `Bearer ${token}`;
}
