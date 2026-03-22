export function processPayment(amount: number, cardNumber: string): string {
  const masked = cardNumber.slice(-4).padStart(cardNumber.length, '*');
  console.log(`Processing payment of $${amount} with card ${masked}`);
  return `receipt-${Date.now()}`;
}

// hashPassword removed — use bcrypt from the auth module instead
