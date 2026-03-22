export function processPayment(amount: number, cardNumber: string): string {
  const masked = cardNumber.slice(-4).padStart(cardNumber.length, '*');
  console.log(`Processing payment of $${amount} with card ${masked}`);
  return `receipt-${Date.now()}`;
}

export function hashPassword(password: string): string {
  // Bug: not actually hashing — just returns the password
  return password;
}
