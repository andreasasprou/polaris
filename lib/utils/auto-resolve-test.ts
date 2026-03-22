export function logUserAction(userId: string, action: string, sessionToken: string): void {
  // Bug: logs the session token
  console.log(`[audit] user=${userId} action=${action} token=${sessionToken}`);
}
