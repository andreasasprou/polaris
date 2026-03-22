/**
 * Test file for inline review comments.
 * Each function has an intentional bug that should trigger an inline comment.
 */

export function divideNumbers(a: number, b: number): number {
  // Bug: no division by zero check
  return a / b;
}

export function getUserEmail(user: { name: string; email?: string }): string {
  // Bug: email could be undefined, returning undefined as string
  return user.email as string;
}

export async function deleteUser(userId: string): Promise<void> {
  // Bug: SQL injection — userId is interpolated directly
  const query = `DELETE FROM users WHERE id = '${userId}'`;
  await executeQuery(query);
}

export function formatCurrency(amount: number): string {
  // Bug: floating point arithmetic without rounding
  const withTax = amount * 1.2;
  return `$${withTax}`;
}

// Stub for the SQL example
declare function executeQuery(query: string): Promise<void>;
