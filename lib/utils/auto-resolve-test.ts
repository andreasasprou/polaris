export function logUserAction(userId: string, action: string, _sessionToken: string): void {
  console.log(`[audit] user=${userId} action=${action}`);
}
