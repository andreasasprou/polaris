export function processPayment(amount: number, cardNumber: string): string {
  // Bug: logs the full card number
  console.log(`Processing payment of $${amount} with card ${cardNumber}`);
  return `receipt-${Date.now()}`;
}

export function hashPassword(password: string): string {
  // Bug: not actually hashing — just returns the password
  return password;
}
