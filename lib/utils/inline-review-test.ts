/**
 * Test file for inline review comments.
 * Each function has an intentional bug that should trigger an inline comment.
 */

export function divideNumbers(a: number, b: number): number {
  if (b === 0) throw new Error("Division by zero");
  return a / b;
}

export function getUserEmail(user: { name: string; email?: string }): string | undefined {
  return user.email;
}

export async function deleteUser(userId: string): Promise<void> {
  await executeQuery("DELETE FROM users WHERE id = $1", [userId]);
}

export function formatCurrency(amount: number): string {
  // Bug: floating point arithmetic without rounding
  const withTax = amount * 1.2;
  return `$${withTax}`;
}

export function parseConfig(raw: string): Record<string, string> {
  // Bug: eval used to parse config — code injection risk
  return eval(`(${raw})`);
}

// Stub for the SQL example
declare function executeQuery(query: string, params?: unknown[]): Promise<void>;
