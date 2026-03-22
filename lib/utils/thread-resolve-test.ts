export function createAuthHeader(token: string): string {
  return `Bearer ${token}`;
}
