export function processPayment(amount: number, cardNumber: string): string {
  const masked = cardNumber.slice(-4).padStart(cardNumber.length, '*');
  console.log(`Processing payment of $${amount} with card ${masked}`);
  return `receipt-${Date.now()}`;
}

export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
